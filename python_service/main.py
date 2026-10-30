"""
OfflineAid AI service (FastAPI).

Pipeline: question -> normalise -> nomic-embed-text (Ollama) -> ChromaDB retrieval
          -> Llama 3.2 3B (Ollama) -> grounded answer + validated citations.

Everything runs locally. There is NO cloud fallback: if Ollama or a model is
missing, endpoints report it and /ask returns 503 (or a clearly labelled cached
demo answer when one exists).
"""
import json
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import List, Optional

import chromadb
import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

import voice
from zim_ingest import SourceRegistry, file_sha256, ingest_zim, validate_zim

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
ZIM_DIR = DATA_DIR / "zim"
CHROMA_DIR = DATA_DIR / "chroma"
CACHE_FILE = DATA_DIR / "ai_cache" / "demo_answers.json"

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
LLM_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2:3b")
EMBED_MODEL = os.getenv("OLLAMA_EMBEDDING_MODEL", "nomic-embed-text")
TOP_K = int(os.getenv("RAG_TOP_K", "2"))
CONTEXT_CHARS = int(os.getenv("RAG_CONTEXT_CHARS", "550"))  # per passage sent to the LLM (CPU latency)
MAX_TOKENS = int(os.getenv("RAG_MAX_TOKENS", "130"))
# Cosine distance above which retrieval is treated as "weak" (calibrated on the demo pack, see README).
MAX_DISTANCE = float(os.getenv("RAG_MAX_DISTANCE", "0.45"))
MAX_UPLOAD_BYTES = int(os.getenv("ZIM_MAX_UPLOAD_MB", "2048")) * 1024 * 1024
KEEP_ALIVE = os.getenv("OLLAMA_KEEP_ALIVE", "30m")
DISCLAIMER = "General emergency guidance only. Contact local emergency services whenever possible."
NOT_FOUND = "Not found in the loaded knowledge pack."

for d in (ZIM_DIR, CHROMA_DIR, CACHE_FILE.parent):
    d.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="OfflineAid AI service", docs_url=None, redoc_url=None)
chroma = chromadb.PersistentClient(path=str(CHROMA_DIR), settings=chromadb.Settings(anonymized_telemetry=False))
collection = chroma.get_or_create_collection("offlineaid_knowledge", metadata={"hnsw:space": "cosine"})
registry = SourceRegistry(DATA_DIR / "knowledge_sources.db")
http = httpx.Client(timeout=httpx.Timeout(120.0, connect=3.0))
state = {"startup_check": None, "warm": False}


# ---------------------------------------------------------------- Ollama helpers
def _model_present(names: List[str], wanted: str) -> bool:
    wanted_full = wanted if ":" in wanted else f"{wanted}:latest"
    return wanted in names or wanted_full in names


def ollama_status() -> dict:
    try:
        r = http.get(f"{OLLAMA_URL}/api/tags", timeout=3.0)
        r.raise_for_status()
        names = [m["name"] for m in r.json().get("models", [])]
    except Exception as exc:
        return {"reachable": False, "error": type(exc).__name__, "llm_available": False, "embedding_available": False}
    return {
        "reachable": True, "models": names,
        "llm_available": _model_present(names, LLM_MODEL),
        "embedding_available": _model_present(names, EMBED_MODEL),
    }


def embed(texts: List[str]) -> List[List[float]]:
    r = http.post(f"{OLLAMA_URL}/api/embed", json={"model": EMBED_MODEL, "input": texts, "keep_alive": KEEP_ALIVE})
    if r.status_code != 200:
        raise RuntimeError(f"Embedding failed ({r.status_code}): {r.text[:200]}")
    return r.json()["embeddings"]


def _chat_body(prompt: str, system: str, stream: bool) -> dict:
    return {
        "model": LLM_MODEL, "stream": stream, "keep_alive": KEEP_ALIVE,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        "options": {"temperature": 0.1, "num_ctx": 2048, "num_predict": MAX_TOKENS},
    }


def generate(prompt: str, system: str) -> dict:
    r = http.post(f"{OLLAMA_URL}/api/chat", json=_chat_body(prompt, system, False))
    if r.status_code != 200:
        raise RuntimeError(f"Generation failed ({r.status_code}): {r.text[:200]}")
    return r.json()


def generate_stream(prompt: str, system: str):
    with http.stream("POST", f"{OLLAMA_URL}/api/chat", json=_chat_body(prompt, system, True)) as r:
        if r.status_code != 200:
            raise RuntimeError(f"Generation failed ({r.status_code})")
        for line in r.iter_lines():
            if line:
                yield json.loads(line)


def warm_up():
    """Load both models and prime Ollama's prompt cache with the real system prompt,
    so the first demo question is not a cold start (measured: ~16 s cold vs ~9 s warm)."""
    try:
        embed(["search_query: warm up"])
        generate(build_prompt("What should I do?", [{"meta": {"title": "Warm-up"}, "text": "Stay calm."}]), SYSTEM_PROMPT)
        state["warm"] = True
    except Exception:
        state["warm"] = False


@app.on_event("startup")
def startup_check():
    status = ollama_status()
    state["startup_check"] = {**status, "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if not status["reachable"]:
        print(f"[AI] WARNING: Ollama not reachable at {OLLAMA_URL}. AI answers are unavailable (no cloud fallback).")
    else:
        for label, ok, model in (("LLM", status["llm_available"], LLM_MODEL), ("Embedding", status["embedding_available"], EMBED_MODEL)):
            print(f"[AI] {label} model {model}: {'available' if ok else 'MISSING - run: ollama pull ' + model}")
        if status["llm_available"] and status["embedding_available"]:
            threading.Thread(target=warm_up, daemon=True).start()
    # Resume interrupted indexing jobs; auto-register the bundled demo pack if nothing is indexed.
    for src in registry.all():
        if src["status"] in ("queued", "indexing"):
            start_ingest(src["id"], ZIM_DIR / src["filename"])
    bundled = ZIM_DIR / "offlineaid_emergency_en.zim"
    if bundled.exists() and not registry.all() and status.get("embedding_available"):
        register_and_index(bundled)


# ---------------------------------------------------------------- Sources
def start_ingest(source_id: str, path: Path):
    threading.Thread(target=ingest_zim, args=(path, source_id, registry, collection, embed), daemon=True).start()


def register_and_index(path: Path) -> dict:
    meta = validate_zim(path)
    sha = file_sha256(path)
    dup = registry.by_sha(sha)
    if dup:
        return {**dup, "duplicate": True}
    sid = f"zim-{uuid.uuid4().hex[:10]}"
    registry.create(sid, path.name, path.stat().st_size, sha, meta.get("title") or path.stem)
    start_ingest(sid, path)
    return registry.get(sid)


@app.get("/sources")
def list_sources():
    return {"sources": registry.all(), "total_chunks": collection.count()}


@app.get("/sources/{source_id}")
def source_status(source_id: str):
    src = registry.get(source_id)
    if not src:
        raise HTTPException(404, "Unknown source.")
    return src


@app.post("/sources/upload")
async def upload_source(file: UploadFile = File(...)):
    name = Path(file.filename or "").name
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,120}\.zim", name):
        raise HTTPException(400, "File must be a .zim with a simple filename (letters, digits, . _ -).")
    target = ZIM_DIR / name
    if target.exists():
        raise HTTPException(409, "A knowledge pack with this filename already exists.")
    tmp = ZIM_DIR / f".upload-{uuid.uuid4().hex}"
    size = 0
    try:
        with open(tmp, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "ZIM file exceeds the upload size limit.")
                out.write(chunk)
        try:
            validate_zim(tmp)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        dup = registry.by_sha(file_sha256(tmp))
        if dup:
            raise HTTPException(409, f"This knowledge pack is already indexed as '{dup['filename']}'.")
        shutil.move(str(tmp), target)
    finally:
        if tmp.exists():
            tmp.unlink()
    return register_and_index(target)


@app.post("/sources/{source_id}/reindex")
def reindex(source_id: str):
    src = registry.get(source_id)
    if not src:
        raise HTTPException(404, "Unknown source.")
    if src["status"] == "indexing":
        raise HTTPException(409, "Already indexing.")
    registry.update(source_id, status="queued")
    start_ingest(source_id, ZIM_DIR / src["filename"])
    return registry.get(source_id)


@app.delete("/sources/{source_id}")
def remove_source(source_id: str):
    src = registry.get(source_id)
    if not src:
        raise HTTPException(404, "Unknown source.")
    if src["status"] == "indexing":
        raise HTTPException(409, "Cannot remove while indexing.")
    ids = collection.get(where={"source_id": source_id}, include=[])["ids"]
    for start in range(0, len(ids), 500):
        collection.delete(ids=ids[start:start + 500])
    registry.delete(source_id)
    return {"removed": source_id, "chunks_removed": len(ids)}


# ---------------------------------------------------------------- Ask
class AskRequest(BaseModel):
    question: str = Field(min_length=2, max_length=1000)
    allow_cached: bool = True


def normalise(q: str) -> str:
    q = re.sub(r"\s+", " ", q).strip()
    return q[0].upper() + q[1:] if q else q


def load_cache() -> dict:
    try:
        return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def cached_answer(question: str) -> Optional[dict]:
    key = re.sub(r"[^a-z0-9 ]", "", question.lower()).strip()
    hit = load_cache().get(key)
    if hit:
        return {**hit, "cached": True, "cache_note": "CACHED ANSWER - validated earlier on this laptop; live model unavailable."}
    return None


SYSTEM_PROMPT = (
    "You are OfflineAid, an offline emergency-guidance assistant. Answer ONLY from the numbered SOURCES. "
    "Write at most 5 short, actionable bullet points (under 20 words each). Start directly with the first bullet - no introduction. "
    "End each bullet with the source number(s) it came from, like [1] or [2][3]. "
    "Do not use outside knowledge. Do not invent phone numbers, places or facts not present in the SOURCES. "
    f"If the SOURCES do not answer the question, reply exactly: {NOT_FOUND}"
)


def retrieve(question: str, t0: float):
    """Embed + vector search. Returns (strong_hits, timing, best_distance)."""
    qvec = embed([f"search_query: {question}"])[0]
    t_embed = time.perf_counter()
    res = collection.query(query_embeddings=[qvec], n_results=min(TOP_K, collection.count()),
                           include=["documents", "metadatas", "distances"])
    t_retrieve = time.perf_counter()
    hits = [{"text": d, "meta": m, "distance": round(dist, 4)}
            for d, m, dist in zip(res["documents"][0], res["metadatas"][0], res["distances"][0])]
    strong = [h for h in hits if h["distance"] <= MAX_DISTANCE]
    timing = {"embed_ms": round((t_embed - t0) * 1000), "retrieve_ms": round((t_retrieve - t_embed) * 1000)}
    return strong, timing, (hits[0]["distance"] if hits else None)


def build_prompt(question: str, strong: list) -> str:
    context = "\n\n".join(f"[{i}] {h['meta']['title']}\n{h['text'][:CONTEXT_CHARS]}" for i, h in enumerate(strong, start=1))
    return f"SOURCES:\n{context}\n\nQUESTION: {question}\n\nAnswer using only the SOURCES, citing [n] numbers."


def finalise(answer: str, strong: list) -> dict:
    """Validate citations: keep only [n] that refer to passages we actually supplied; never invent sources."""
    answer = answer.strip()
    cited = sorted({int(n) for n in re.findall(r"\[(\d+)\]", answer)})
    valid = [n for n in cited if 1 <= n <= len(strong)]
    answer = re.sub(r"\[(\d+)\]", lambda m: m.group(0) if int(m.group(1)) in valid else "", answer)
    not_found = NOT_FOUND.lower().rstrip(".") in answer.lower()
    used = valid or ([] if not_found else list(range(1, len(strong) + 1)))
    sources = []
    for n in used:
        h, m = strong[n - 1], strong[n - 1]["meta"]
        sources.append({
            "n": n, "title": m["title"], "zim_file": m["zim_file"], "path": m["path"],
            "origin_file": m.get("origin_file") or None, "origin_page": m.get("origin_page") or None,
            "excerpt": re.sub(r"\s+", " ", h["text"])[:280], "distance": h["distance"],
        })
    return {"answer": answer, "grounded": bool(sources) and not not_found, "citations_explicit": bool(valid),
            "sources": sources, "disclaimer": DISCLAIMER, "model": LLM_MODEL, "cached": False}


def preflight(question: str, allow_cached: bool):
    status = ollama_status()
    if not (status["reachable"] and status["llm_available"] and status["embedding_available"]):
        cached = cached_answer(question) if allow_cached else None
        if cached:
            return cached
        raise HTTPException(503, "Local AI unavailable: Ollama or a required model is not running. No online fallback is used.")
    if collection.count() == 0:
        raise HTTPException(409, "No knowledge pack is indexed yet. Upload or index a ZIM file first.")
    return None


def not_found_response(timing, best, t0):
    return {"answer": NOT_FOUND, "grounded": False, "sources": [], "disclaimer": DISCLAIMER, "best_distance": best,
            "model": LLM_MODEL, "cached": False, "timing": {**timing, "total_ms": round((time.perf_counter() - t0) * 1000)}}


@app.post("/ask")
def ask(req: AskRequest):
    t0 = time.perf_counter()
    question = normalise(req.question)
    cached = preflight(question, req.allow_cached)
    if cached:
        return cached
    strong, timing, best = retrieve(question, t0)
    if not strong:
        return not_found_response(timing, best, t0)
    t_gen0 = time.perf_counter()
    try:
        out = generate(build_prompt(question, strong), SYSTEM_PROMPT)
    except Exception as exc:
        cached = cached_answer(question) if req.allow_cached else None
        if cached:
            return cached
        raise HTTPException(503, f"Local model failed: {exc}")
    t_gen = time.perf_counter()
    result = finalise(out["message"]["content"], strong)
    result["timing"] = {**timing, "generate_ms": round((t_gen - t_gen0) * 1000), "total_ms": round((t_gen - t0) * 1000),
                        "prompt_tokens": out.get("prompt_eval_count"), "eval_tokens": out.get("eval_count"),
                        "load_ms": round(out.get("load_duration", 0) / 1e6)}
    return result


@app.post("/ask/stream")
def ask_stream(req: AskRequest):
    """NDJSON stream: {type:retrieved} -> {type:token}* -> {type:done, ...validated result}."""
    t0 = time.perf_counter()
    question = normalise(req.question)
    cached = preflight(question, req.allow_cached)

    def events():
        if cached:
            yield json.dumps({"type": "done", **cached}) + "\n"
            return
        strong, timing, best = retrieve(question, t0)
        if not strong:
            yield json.dumps({"type": "done", **not_found_response(timing, best, t0)}) + "\n"
            return
        yield json.dumps({"type": "retrieved", "count": len(strong), "titles": [h["meta"]["title"] for h in strong]}) + "\n"
        parts, first_ms, final = [], None, {}
        try:
            for chunk in generate_stream(build_prompt(question, strong), SYSTEM_PROMPT):
                piece = chunk.get("message", {}).get("content", "")
                if piece:
                    if first_ms is None:
                        first_ms = round((time.perf_counter() - t0) * 1000)
                    parts.append(piece)
                    yield json.dumps({"type": "token", "text": piece}) + "\n"
                if chunk.get("done"):
                    final = chunk
        except Exception as exc:
            cached2 = cached_answer(question) if req.allow_cached else None
            if cached2:
                yield json.dumps({"type": "done", **cached2}) + "\n"
            else:
                yield json.dumps({"type": "error", "error": f"Local model failed: {exc}"}) + "\n"
            return
        result = finalise("".join(parts), strong)
        result["timing"] = {**timing, "first_token_ms": first_ms, "total_ms": round((time.perf_counter() - t0) * 1000),
                            "prompt_tokens": final.get("prompt_eval_count"), "eval_tokens": final.get("eval_count")}
        yield json.dumps({"type": "done", **result}) + "\n"

    return StreamingResponse(events(), media_type="application/x-ndjson")


@app.post("/chat")  # backwards-compatible alias for the original UI contract
def chat(payload: dict):
    q = str(payload.get("question", "")).strip()
    if not q:
        raise HTTPException(400, "Question cannot be empty.")
    return ask(AskRequest(question=q))


@app.post("/voice/transcribe")
async def voice_transcribe(audio: UploadFile = File(...)):
    if not voice.status()["stt"]:
        raise HTTPException(503, "Local speech-to-text is not installed. Type your question instead.")
    data = await audio.read()
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(413, "Recording too long.")
    try:
        out = voice.transcribe(data)
    except Exception as exc:
        raise HTTPException(422, f"Could not transcribe audio: {type(exc).__name__}")
    if not out["text"]:
        raise HTTPException(422, "No speech detected. Try again closer to the microphone.")
    return out


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


@app.post("/voice/speak")
def voice_speak(req: SpeakRequest):
    if not voice.status()["tts"]:
        raise HTTPException(503, "Local text-to-speech is not installed.")
    return Response(voice.synthesize(req.text), media_type="audio/wav")


@app.get("/health")
def health():
    status = ollama_status()
    sources = registry.all()
    ready = [s for s in sources if s["status"] == "ready"]
    overall = "ok" if status["reachable"] and status["llm_available"] and status["embedding_available"] and ready else "degraded"
    return {
        "status": overall, "service": "fastapi",
        "ollama": {"url": OLLAMA_URL, "reachable": status["reachable"]},
        "llm": {"model": LLM_MODEL, "available": status["llm_available"], "warm": state["warm"]},
        "embedding": {"model": EMBED_MODEL, "available": status["embedding_available"]},
        "index": {"chunks": collection.count(), "sources_ready": len(ready), "sources_total": len(sources),
                  "indexing": [s["id"] for s in sources if s["status"] in ("queued", "indexing")]},
        "retrieval": {"top_k": TOP_K, "max_distance": MAX_DISTANCE, "context_chars": CONTEXT_CHARS, "max_tokens": MAX_TOKENS, "reranker": None},
        "voice": voice.status(),
        "startup_check": state["startup_check"],
    }
