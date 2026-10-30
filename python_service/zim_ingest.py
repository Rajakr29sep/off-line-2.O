"""ZIM knowledge-pack ingestion: ZIM entries -> cleaned text -> article-aware chunks -> ChromaDB."""
import hashlib
import re
import sqlite3
import threading
import time
from pathlib import Path

from bs4 import BeautifulSoup
from libzim.reader import Archive

CHUNK_CHARS = 900
CHUNK_OVERLAP = 150
MIN_ARTICLE_CHARS = 120
EMBED_BATCH = 32


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def validate_zim(path: Path) -> dict:
    """Open the archive header only (no full read) and return metadata. Raises ValueError if invalid."""
    with open(path, "rb") as f:
        if f.read(4) != b"ZIM\x04":
            raise ValueError("Not a ZIM file (bad magic number).")
    try:
        archive = Archive(str(path))
    except Exception as exc:
        raise ValueError(f"ZIM archive could not be opened: {exc}") from exc
    meta = {}
    for key in ("Title", "Description", "Language", "Creator", "Date", "Name"):
        try:
            meta[key.lower()] = bytes(archive.get_metadata(key)).decode("utf-8", "replace")
        except Exception:
            pass
    meta["entry_count"] = archive.all_entry_count
    meta["article_count"] = archive.article_count
    return meta


def clean_html(raw: bytes) -> str:
    soup = BeautifulSoup(raw, "html.parser")
    for tag in soup(["head", "script", "style", "noscript", "nav", "header", "footer", "table", "sup", "figure"]):
        tag.decompose()
    for h in soup.find_all("h1"):
        h.decompose()  # title is stored separately as metadata
    text = soup.get_text("\n")
    text = text.replace(" ", " ").replace("�", "'")
    text = re.sub(r"[ \t]+", " ", text)
    lines = [ln.strip() for ln in text.split("\n")]
    # Drop provenance boilerplate ("Source: <doc> (<file>), page N") - it is kept as metadata instead.
    text = "\n".join(ln for ln in lines if ln and not re.match(r"^Source: .*page \d+$", ln))
    return re.sub(r"\n{2,}", "\n", text).strip()


def chunk_article(text: str):
    """Paragraph-aware chunks that never cross article boundaries."""
    paras = [p for p in text.split("\n") if p.strip()]
    chunks, cur = [], ""
    for p in paras:
        if len(cur) + len(p) + 1 <= CHUNK_CHARS:
            cur = f"{cur}\n{p}" if cur else p
            continue
        if cur:
            chunks.append(cur)
            cur = cur[-CHUNK_OVERLAP:] + "\n" + p if len(p) < CHUNK_CHARS else ""
        while len(p) > CHUNK_CHARS:
            chunks.append(p[:CHUNK_CHARS])
            p = p[CHUNK_CHARS - CHUNK_OVERLAP:]
        if not cur:
            cur = p
    if cur.strip():
        chunks.append(cur)
    return chunks


class SourceRegistry:
    """KnowledgeSource table (id, filename, size, status, articleCount, indexedAt, ...)."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.lock = threading.Lock()
        with self._conn() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS knowledge_sources (
                id TEXT PRIMARY KEY, filename TEXT NOT NULL, title TEXT, size INTEGER, sha256 TEXT UNIQUE,
                status TEXT NOT NULL, article_count INTEGER DEFAULT 0, articles_total INTEGER DEFAULT 0,
                articles_processed INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0, error TEXT,
                created_at TEXT, indexed_at TEXT)""")

    def _conn(self):
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    def all(self):
        with self._conn() as c:
            return [dict(r) for r in c.execute("SELECT * FROM knowledge_sources ORDER BY created_at")]

    def get(self, sid):
        with self._conn() as c:
            r = c.execute("SELECT * FROM knowledge_sources WHERE id=?", (sid,)).fetchone()
            return dict(r) if r else None

    def by_sha(self, sha):
        with self._conn() as c:
            r = c.execute("SELECT * FROM knowledge_sources WHERE sha256=?", (sha,)).fetchone()
            return dict(r) if r else None

    def create(self, sid, filename, size, sha, title):
        with self.lock, self._conn() as c:
            c.execute("INSERT INTO knowledge_sources (id, filename, title, size, sha256, status, created_at) VALUES (?,?,?,?,?,?,?)",
                      (sid, filename, title, size, sha, "queued", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))

    def update(self, sid, **fields):
        if not fields:
            return
        cols = ", ".join(f"{k}=?" for k in fields)
        with self.lock, self._conn() as c:
            c.execute(f"UPDATE knowledge_sources SET {cols} WHERE id=?", (*fields.values(), sid))

    def delete(self, sid):
        with self.lock, self._conn() as c:
            c.execute("DELETE FROM knowledge_sources WHERE id=?", (sid,))


def ingest_zim(path: Path, source_id: str, registry: SourceRegistry, collection, embed_fn):
    """Stream entries one at a time (never loads the whole archive), embed in batches, store with metadata."""
    try:
        registry.update(source_id, status="indexing", error=None)
        archive = Archive(str(path))
        total = archive.all_entry_count
        registry.update(source_id, articles_total=total)
        # Remove any partial data from a previous failed attempt (idempotent re-index).
        existing = collection.get(where={"source_id": source_id}, include=[])
        if existing["ids"]:
            collection.delete(ids=existing["ids"])

        batch_ids, batch_docs, batch_meta = [], [], []
        articles = chunks_total = 0

        def flush():
            nonlocal batch_ids, batch_docs, batch_meta
            if batch_ids:
                # Title is embedded with the chunk (helps topical match) but only the clean chunk is stored.
                vectors = embed_fn([f"search_document: {m['title']}\n{d}" for d, m in zip(batch_docs, batch_meta)])
                collection.add(ids=batch_ids, documents=batch_docs, metadatas=batch_meta, embeddings=vectors)
                batch_ids, batch_docs, batch_meta = [], [], []

        for i in range(total):
            entry = archive.get_entry_by_id(i)
            if entry.is_redirect:
                continue
            item = entry.get_item()
            if not item.mimetype.startswith("text/html") or entry.path in ("index", "mainPage"):
                continue
            raw = bytes(item.content)
            source_page = re.search(rb"name='source-page' content='(\d+)'", raw)
            source_file = re.search(rb"name='source-file' content='([^']+)'", raw)
            text = clean_html(raw)
            if len(text) < MIN_ARTICLE_CHARS:
                continue
            articles += 1
            for n, chunk in enumerate(chunk_article(text)):
                batch_ids.append(f"{source_id}:{entry.path}:{n}")
                batch_docs.append(chunk)
                batch_meta.append({
                    "source_id": source_id, "zim_file": path.name, "title": entry.title or entry.path,
                    "path": entry.path, "chunk": n,
                    "origin_file": source_file.group(1).decode() if source_file else "",
                    "origin_page": int(source_page.group(1)) if source_page else 0,
                })
                chunks_total += 1
                if len(batch_ids) >= EMBED_BATCH:
                    flush()
            if i % 20 == 0:
                registry.update(source_id, articles_processed=i + 1, article_count=articles, chunk_count=chunks_total)
        flush()
        registry.update(source_id, status="ready", articles_processed=total, article_count=articles,
                        chunk_count=chunks_total, indexed_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    except Exception as exc:  # report, never crash the service
        registry.update(source_id, status="error", error=str(exc)[:500])
