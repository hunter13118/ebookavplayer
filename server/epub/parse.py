"""EPUB ingest (Brief step 1): structure -> chapters, text, embedded images.

Uses the stdlib zipfile + a tiny HTML stripper so it works without heavy deps;
if `ebooklib`/`beautifulsoup4` are installed they are used for robustness.
Embedded images are returned as raw bytes to feed Gemini as visual reference
(common in light novels — Brief step 3).
"""
from __future__ import annotations

import html
import os
import re
import zipfile
from dataclasses import dataclass, field


@dataclass
class Chapter:
    index: int
    title: str
    text: str


@dataclass
class ParsedBook:
    book_id: str
    title: str = ""
    author: str = ""
    chapters: list[Chapter] = field(default_factory=list)
    images: list[bytes] = field(default_factory=list)

    @property
    def body_text(self) -> str:
        return "\n\n".join(
            f"## Chapter {c.index}: {c.title}\n{c.text}" for c in self.chapters)


_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"[ \t　]+")
_NL = re.compile(r"\n{3,}")


def _strip_html(raw: str) -> str:
    # Prefer BeautifulSoup if present (handles entities/scripts cleanly).
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(raw, "html.parser")
        for t in soup(["script", "style"]):
            t.decompose()
        # paragraph breaks
        for br in soup.find_all(["p", "br", "div", "h1", "h2", "h3"]):
            br.append("\n")
        text = soup.get_text()
    except Exception:
        text = _TAG.sub("", raw)
        text = html.unescape(text)
    text = _WS.sub(" ", text)
    text = _NL.sub("\n\n", text)
    return text.strip()


def _title_from(raw: str, fallback: str) -> str:
    m = re.search(r"<title[^>]*>(.*?)</title>", raw, re.I | re.S)
    if m:
        t = _strip_html(m.group(1)).strip()
        if t:
            return t[:80]
    m = re.search(r"<h[12][^>]*>(.*?)</h[12]>", raw, re.I | re.S)
    if m:
        t = _strip_html(m.group(1)).strip()
        if t:
            return t[:80]
    return fallback


def parse_epub(path: str, book_id: str | None = None) -> ParsedBook:
    book_id = book_id or os.path.splitext(os.path.basename(path))[0]
    book = ParsedBook(book_id=book_id)
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        # metadata from the OPF
        opf = next((n for n in names if n.endswith(".opf")), None)
        if opf:
            meta = z.read(opf).decode("utf-8", "ignore")
            mt = re.search(r"<dc:title[^>]*>(.*?)</dc:title>", meta, re.I | re.S)
            ma = re.search(r"<dc:creator[^>]*>(.*?)</dc:creator>", meta, re.I | re.S)
            if mt:
                book.title = _strip_html(mt.group(1))[:120]
            if ma:
                book.author = _strip_html(ma.group(1))[:120]
        # content documents, in archive order (good enough for MVP; spine
        # ordering is a host refinement)
        docs = [n for n in names
                if n.lower().endswith((".xhtml", ".html", ".htm"))]
        idx = 0
        for n in docs:
            raw = z.read(n).decode("utf-8", "ignore")
            text = _strip_html(raw)
            if len(text) < 40:        # skip nav/cover stubs
                continue
            idx += 1
            book.chapters.append(
                Chapter(index=idx, title=_title_from(raw, f"Chapter {idx}"),
                        text=text))
        # embedded images for visual reference (cap to keep request small)
        imgs = [n for n in names
                if n.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))]
        for n in imgs[:8]:
            try:
                book.images.append(z.read(n))
            except KeyError:
                pass
    if not book.title:
        book.title = book_id
    return book
