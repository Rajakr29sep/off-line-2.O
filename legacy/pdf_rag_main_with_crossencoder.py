import hashlib
import os
import re
from pathlib import Path
from typing import Dict, List

import chromadb
import fitz
import ollama
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from chromadb.utils.embedding_functions import OllamaEmbeddingFunction
from langchain_community.document_loaders import PyMuPDFLoader
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter
from sentence_transformers import CrossEncoder

BASE_DIR = Path(__file__).resolve().parent.parent
KNOWLEDGE_DIR = BASE_DIR / "knowledge_base"
CHROMA_DIR = BASE_DIR / "demo-rag-chroma"
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
LLM_MODEL = os.getenv("LLM_MODEL", "llama3.2:3b")
EMBED_MODEL = os.getenv("EMBED_MODEL", "nomic-embed-text:latest")
RERANK_MODEL = os.getenv("RERANK_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2")
TESSDATA_DIR = Path(os.getenv("TESSDATA_PREFIX", r"C:\Program Files\Tesseract-OCR\tessdata"))

TOPICS: Dict[str, str] = {
    "General disaster safety": "disaster_safety.pdf",
    "Crowd safety": "crowd_safety.pdf",
    "Earthquake rescue": "earthquake_rescue.pdf",
    "First aid and ambulance": "first_aid.pdf",
    "Flood rescue": "flood_rescue.pdf",
    "Flood risk mitigation": "flood_risk_mitigation.pdf",
}

app = FastAPI(title="Offline Disaster Assistance RAG API")


class IndexRequest(BaseModel):
    topic: str
    force_reindex: bool = False


class ChatRequest(BaseModel):
    topic: str
    question: str = Field(min_length=1, max_length=5000)


def get_embedding_function():
    return OllamaEmbeddingFunction(url=f"{OLLAMA_URL}/api/embeddings", model_name=EMBED_MODEL)


client = chromadb.PersistentClient(path=str(CHROMA_DIR))
embedding_function = get_embedding_function()
reranker = None


def get_reranker():
    global reranker
    if reranker is None:
        reranker = CrossEncoder(RERANK_MODEL)
    return reranker


def collection_name_for(topic: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", topic.lower()).strip("_")
    return f"disaster_{slug}"[:60]


def get_collection(topic: str):
    return client.get_or_create_collection(
        name=collection_name_for(topic),
        embedding_function=embedding_function,
        metadata={"topic": topic},
    )


def fingerprint(path: Path) -> str:
    stat = path.stat()
    return hashlib.sha256(f"{path.name}:{stat.st_size}:{stat.st_mtime_ns}".encode()).hexdigest()[:16]


def extract_pdf_pages(pdf_path: Path) -> List[Document]:
    normal_pages = PyMuPDFLoader(str(pdf_path)).load()
    by_page = {int(doc.metadata.get("page", i)): doc for i, doc in enumerate(normal_pages)}
    output = []
    with fitz.open(str(pdf_path)) as pdf:
        for page_number, page in enumerate(pdf):
            original = by_page.get(page_number)
            text = original.page_content.strip() if original else ""
            if not text:
                if not TESSDATA_DIR.exists():
                    raise RuntimeError(
                        f"OCR language-data folder not found: {TESSDATA_DIR}. "
                        "Install Tesseract and set TESSDATA_PREFIX to its tessdata directory."
                    )
                if not (TESSDATA_DIR / "eng.traineddata").exists():
                    raise RuntimeError(
                        f"English OCR data missing: {TESSDATA_DIR / 'eng.traineddata'}"
                    )
                os.environ["TESSDATA_PREFIX"] = str(TESSDATA_DIR)
                try:
                    text_page = page.get_textpage_ocr(
                        language="eng", dpi=200, full=True, tessdata=str(TESSDATA_DIR)
                    )
                    text = page.get_text(textpage=text_page).strip()
                except Exception as exc:
                    raise RuntimeError(
                        "OCR failed. Verify Tesseract and eng.traineddata. "
                        f"Original error: {exc}"
                    ) from exc
            output.append(Document(page_content=text, metadata={"page": page_number}))
    return output


def index_pdf(topic: str, force_reindex: bool = False):
    if topic not in TOPICS:
        raise HTTPException(status_code=400, detail="Unknown topic.")
    pdf_path = KNOWLEDGE_DIR / TOPICS[topic]
    if not pdf_path.is_file():
        raise HTTPException(status_code=404, detail=f"PDF not found: {pdf_path}")

    collection = get_collection(topic)
    current_fingerprint = fingerprint(pdf_path)
    metadata = collection.metadata or {}
    if not force_reindex and collection.count() > 0 and metadata.get("file_fingerprint") == current_fingerprint:
        return {"topic": topic, "chunks": collection.count(), "status": "already indexed"}

    pages = extract_pdf_pages(pdf_path)
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=700, chunk_overlap=120,
        separators=["\n\n", "\n", ". ", "? ", "! ", " ", ""]
    )
    chunks = [d for d in splitter.split_documents(pages) if d.page_content.strip()]
    if not chunks:
        raise HTTPException(status_code=422, detail=f"No readable text extracted from {pdf_path.name}.")

    if collection.count():
        old_ids = collection.get().get("ids", [])
        if old_ids:
            collection.delete(ids=old_ids)

    ids, texts, metas = [], [], []
    for i, doc in enumerate(chunks):
        ids.append(f"{current_fingerprint}_{i}")
        texts.append(doc.page_content)
        metas.append({
            "topic": topic, "source_file": pdf_path.name,
            "page": int(doc.metadata.get("page", 0)) + 1,
            "chunk": i, "file_fingerprint": current_fingerprint
        })
    for start in range(0, len(ids), 48):
        collection.add(ids=ids[start:start+48], documents=texts[start:start+48], metadatas=metas[start:start+48])
    collection.modify(metadata={"topic": topic, "file_fingerprint": current_fingerprint})
    return {"topic": topic, "chunks": len(chunks), "status": "indexed"}


def retrieve(topic: str, question: str):
    collection = get_collection(topic)
    if collection.count() == 0:
        index_pdf(topic)
    count = collection.count()
    if count == 0:
        return []
    result = collection.query(
        query_texts=[question],
        n_results=min(8, count),
        include=["documents", "metadatas", "distances"]
    )
    docs = result.get("documents", [[]])[0] or []
    metas = result.get("metadatas", [[]])[0] or []
    if not docs:
        return []
    ranked = get_reranker().rank(question, docs, top_k=min(4, len(docs)))
    output = []
    for row in ranked:
        i = int(row["corpus_id"])
        meta = metas[i] if i < len(metas) else {}
        output.append({
            "text": docs[i],
            "source_file": meta.get("source_file", TOPICS[topic]),
            "page": meta.get("page", "?")
        })
    return output


def answer_question(topic: str, question: str, contexts: list):
    source_text = "\n\n".join(
        f"[Source: {item['source_file']}, page {item['page']}]\n{item['text']}"
        for item in contexts
    )
    prompt = f"""You are a careful, source-grounded disaster assistance assistant.
Selected topic: {topic}
Use only the excerpts below. If they do not answer the question, say the local documents do not provide enough information.
Give calm, concise, practical steps. Do not invent emergency numbers, shelter locations, live alerts, or real-time incident updates.
For immediate danger, advise contacting local emergency services. You are not a substitute for emergency responders or medical professionals.
End with a short Sources line.

SOURCE EXCERPTS:
{source_text}

QUESTION:
{question}"""
    response = ollama.chat(
        model=LLM_MODEL,
        messages=[
            {"role": "system", "content": "Answer accurately and do not fabricate emergency information."},
            {"role": "user", "content": prompt}
        ],
        stream=False,
        options={"temperature": 0.2}
    )
    return response["message"]["content"]


@app.get("/health")
def health():
    return {"status": "ok", "llm_model": LLM_MODEL, "embedding_model": EMBED_MODEL}


@app.post("/index")
def index(request: IndexRequest):
    return index_pdf(request.topic, request.force_reindex)


@app.post("/chat")
def chat(request: ChatRequest):
    if request.topic not in TOPICS:
        raise HTTPException(status_code=400, detail="Unknown topic.")
    question = request.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")
    contexts = retrieve(request.topic, question)
    if not contexts:
        return {"answer": "I couldn't find relevant information in the selected PDF. Try another question or topic.", "sources": []}
    answer = answer_question(request.topic, question, contexts)
    sources = []
    seen = set()
    for item in contexts:
        key = (item["source_file"], item["page"])
        if key not in seen:
            seen.add(key)
            sources.append({"source_file": key[0], "page": key[1]})
    return {"answer": answer, "sources": sources}
