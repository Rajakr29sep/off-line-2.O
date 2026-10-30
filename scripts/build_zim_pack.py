"""
Build the OfflineAid emergency knowledge pack (a standard .zim file) from the
project's existing disaster-guidance PDFs.

Each PDF page becomes one HTML article in the ZIM, titled "<document> - page N",
so citations can point back to the exact source page. Scanned pages are OCR'd
with Tesseract (same approach as the original PDF pipeline).

Usage:
  python scripts/build_zim_pack.py --pdf-dir knowledge_base --out data/zim/offlineaid_emergency_en.zim
"""
import argparse
import html
import os
import re
import shutil
from datetime import date
from pathlib import Path

import fitz
from libzim.writer import Creator, Hint, Item, StringProvider

DOC_TITLES = {
    "disaster_safety.pdf": "NDMA Disaster Do's and Don'ts",
    "crowd_safety.pdf": "NIDM Management of Crowd at Large Congregations",
    "earthquake_rescue.pdf": "Earthquake Preparedness and Response",
    "first_aid.pdf": "WHO Prehospital Emergency Care Pocket Reference",
    "flood_rescue.pdf": "Flood Preparedness and Response",
    "flood_risk_mitigation.pdf": "NIDM Flood Risk Mitigation and Management",
}
TESSDATA = Path(os.getenv("TESSDATA_PREFIX", r"C:\Program Files\Tesseract-OCR\tessdata"))


class Article(Item):
    def __init__(self, path, title, content):
        super().__init__()
        self.path, self.title, self.content = path, title, content

    def get_path(self):
        return self.path

    def get_title(self):
        return self.title

    def get_mimetype(self):
        return "text/html"

    def get_contentprovider(self):
        return StringProvider(self.content)

    def get_hints(self):
        return {Hint.FRONT_ARTICLE: True}


def page_text(page):
    text = page.get_text().strip()
    if len(text) < 50 and (TESSDATA / "eng.traineddata").exists():
        os.environ["TESSDATA_PREFIX"] = str(TESSDATA)
        tp = page.get_textpage_ocr(language="eng", dpi=200, full=True, tessdata=str(TESSDATA))
        text = page.get_text(textpage=tp).strip()
    text = text.replace("\uf0b7", "•").replace("\u2022", "•")
    text = re.sub(r"[ \t]+", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text)


def to_html(title, text, doc_title, source_file, page_no):
    paras = "".join(f"<p>{html.escape(p.strip()).replace(chr(10), ' ')}</p>"
                    for p in re.split(r"\n\s*\n", text) if p.strip())
    return (f"<!DOCTYPE html><html><head><meta charset='utf-8'><title>{html.escape(title)}</title>"
            f"<meta name='source-file' content='{html.escape(source_file)}'>"
            f"<meta name='source-page' content='{page_no}'></head><body>"
            f"<h1>{html.escape(title)}</h1><p><em>Source: {html.escape(doc_title)} ({html.escape(source_file)}), page {page_no}</em></p>"
            f"{paras}</body></html>")


def main():
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf-dir", default=str(root / "knowledge_base"))
    ap.add_argument("--out", default=str(root / "data" / "zim" / "offlineaid_emergency_en.zim"))
    args = ap.parse_args()
    pdf_dir, out = Path(args.pdf_dir), Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()

    index_links = []
    total = 0
    with Creator(str(out)).config_indexing(True, "eng") as creator:
        creator.set_mainpath("index")
        for meta, value in {
            "Name": "offlineaid_emergency_en", "Title": "OfflineAid Emergency Guidance",
            "Description": "Disaster preparedness, first aid and flood/earthquake guidance (NDMA, NIDM, WHO PDFs)",
            "Language": "eng", "Creator": "NDMA / NIDM / WHO", "Publisher": "OfflineAid",
            "Date": date.today().isoformat(), "Tags": "disaster;first-aid;offline",
        }.items():
            creator.add_metadata(meta, value)
        for pdf in sorted(pdf_dir.glob("*.pdf")):
            doc_title = DOC_TITLES.get(pdf.name, pdf.stem.replace("_", " ").title())
            with fitz.open(str(pdf)) as d:
                for i, page in enumerate(d, start=1):
                    text = page_text(page)
                    if len(text) < 80:
                        continue
                    title = f"{doc_title} - page {i}"
                    path = f"{pdf.stem}/page_{i:03d}"
                    creator.add_item(Article(path, title, to_html(title, text, doc_title, pdf.name, i)))
                    index_links.append((path, title))
                    total += 1
            print(f"{pdf.name}: done")
        links = "".join(f"<li><a href='{p}'>{html.escape(t)}</a></li>" for p, t in index_links)
        creator.add_item(Article("index", "OfflineAid Emergency Guidance",
                                 f"<!DOCTYPE html><html><body><h1>OfflineAid Emergency Guidance</h1><ul>{links}</ul></body></html>"))
    print(f"Wrote {out} with {total} articles ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
