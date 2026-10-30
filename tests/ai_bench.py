"""Benchmark the four demo questions + unrelated questions against the local AI service (streaming endpoint).
Usage: python tests/ai_bench.py [--save-cache]
--save-cache stores grounded answers as clearly-labelled fallback answers in data/ai_cache/demo_answers.json."""
import json, re, sys, time
from pathlib import Path
import httpx

URL = "http://127.0.0.1:8000/ask/stream"
DEMO = ["What should I do during an earthquake?", "What should I do if a building catches fire?",
        "What precautions should I take during a flood?", "What are the basic first-aid steps for an injured person?"]
UNRELATED = ["Who won the 2018 FIFA World Cup?", "How do I bake a chocolate cake?"]
cache = {}
rows = []
for q in DEMO + UNRELATED:
    t0 = time.perf_counter(); first = None; done = None
    with httpx.stream("POST", URL, json={"question": q, "allow_cached": False}, timeout=180) as r:
        for line in r.iter_lines():
            if not line: continue
            ev = json.loads(line)
            if ev["type"] == "token" and first is None: first = time.perf_counter() - t0
            if ev["type"] in ("done", "error"): done = ev
    total = time.perf_counter() - t0
    ok = done.get("grounded") if q in DEMO else (not done.get("grounded") and "Not found" in done.get("answer", ""))
    rows.append((q, first, total, done.get("grounded"), [s["title"] for s in done.get("sources", [])], ok))
    print(f"\n=== {q}\nfirst words {first and round(first,1)} s | total {round(total,1)} s | grounded={done.get('grounded')} | {'PASS' if ok else 'FAIL'}")
    print("sources:", [(s['title'], s['zim_file']) for s in done.get("sources", [])])
    print(done.get("answer", done.get("error")))
    if q in DEMO and done.get("grounded"):
        key = re.sub(r"[^a-z0-9 ]", "", q.lower()).strip()
        cache[key] = {k: done[k] for k in ("answer", "grounded", "sources", "disclaimer", "model")}
        cache[key]["validated_at"] = time.strftime("%Y-%m-%d %H:%M")
print("\nSUMMARY")
for q, f, t, g, s, ok in rows:
    print(f"{'PASS' if ok else 'FAIL'} | first {f and round(f,1)}s | total {round(t,1)}s | {'<10s' if t < 10 else '>=10s'} | {q}")
if "--save-cache" in sys.argv:
    p = Path(__file__).resolve().parent.parent / "data" / "ai_cache" / "demo_answers.json"
    p.write_text(json.dumps(cache, indent=2), encoding="utf-8")
    print("cached", len(cache), "answers ->", p)
