"""
Local BookNLP server for VAE's mechanical (non-LLM) character/dialogue
attribution pass — see the plan this implements:
~/.claude/plans/declarative-plotting-flamingo.md ("BookNLP mechanical pass
(Slice 1)").

Implements the contract worker/_shared/booknlp-client.js expects:

    GET  /health
    -> {"ok": bool, "status": "ok"|"loading", "model": str, "ready": bool}

    GET  /pipeline
    -> {"providers": {}}   (stub — see server.py's align-server twin for why)

    POST /process
    JSON body: {"book_id": str, "chapters": [{"index": int, "title": str,
                                               "text": str}, ...]}
    -> streamed NDJSON, one row per chapter as it completes, then "done":
         {"status": "chunk", "chapter_index": int,
          "characters": [{"id": str, "name": str, "gender": str,
                           "mention_count": int, "quote_count": int,
                           "has_proper_name": bool}, ...],
          "lines": [{"kind": "narration"|"dialogue", "text": str,
                      "character_id"?: str,
                      "low_confidence_speaker"?: bool,
                      "confidence_reason"?: "singleton"|"pronoun"}, ...],
          "meta": {"character_count": int, "quote_count": int,
                   "low_confidence_count": int, "elapsed_s": float}}
         {"status": "error", "chapter_index": int, "error": str}  (one bad
          chapter must not abort the whole book — same philosophy as
          local-align-server's per-window error handling)
         {"status": "done", "chapter_count": int}

BookNLP does the same job an LLM extraction pass does for character/dialogue/
narration splitting and speaker attribution — via coreference resolution +
a small BERT classifier, not a language model call — so this is a genuinely
mechanical (deterministic-ish, zero-LLM-cost) alternative/precursor to that
LLM pass. Confirmed via VoxNovel (github.com/DrewThomasson/VoxNovel) and this
project owner's own sibling project (milkman-audiobook-maker), whose
backend/headless_voxnovel.py this module's parsing logic mirrors.

Two real environment issues found and fixed while building this (both
confirmed via a local validation spike, not assumed):

1. BookNLP's own model-download bootstrap
   (english_booknlp.py's `urllib.request.urlretrieve` against
   people.ischool.berkeley.edu) fails outright on this machine with
   `SSL: CERTIFICATE_VERIFY_FAILED` — the MDM-intercepted TLS root CA isn't
   in Python's default (certifi) trust store, same underlying cause as
   local-align-server's UV_SYSTEM_CERTS=1 need, but `uv`'s flag only covers
   `uv`'s OWN network calls (installing packages), not arbitrary code
   running INSIDE an installed package. `truststore.inject_into_ssl()`
   (below) makes the stdlib `ssl` module validate against the OS trust
   store directly (Security.framework on macOS) instead of certifi's
   public-CA-only bundle — that's the general fix, not a one-off hack.

2. BookNLP's bundled BERT checkpoints were saved back when
   transformers' `BertEmbeddings.position_ids` buffer was PERSISTENT (so
   it's baked into the checkpoint's state_dict); the transformers version
   installable today registers it non-persistent, so `torch.load`'s default
   strict key-matching rejects the checkpoint as having an "unexpected key"
   — even though position_ids is just a derived `torch.arange(seq_len)`
   buffer with no learned weights, safe to ignore. BookNLP calls
   `load_state_dict` directly with no `strict=` kwarg to override, so this
   patches `nn.Module.load_state_dict` process-wide to default `strict=False`
   instead of vendoring a forked copy of BookNLP's tagger modules.

Run:  cd scripts/local-booknlp-server && source .venv/bin/activate && python server.py
Then: add http://127.0.0.1:7862 as a connection in Settings > Backends.
"""
from __future__ import annotations

import csv
import json
import logging
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Iterator

import truststore

truststore.inject_into_ssl()

import torch  # noqa: E402  (must follow truststore injection above)

# See module docstring, fix #2 — safe to ignore a stale `position_ids`
# buffer key mismatch against BookNLP's older bundled BERT checkpoints.
_orig_load_state_dict = torch.nn.Module.load_state_dict


def _lenient_load_state_dict(self, state_dict, strict=True, *a, **kw):
    return _orig_load_state_dict(self, state_dict, strict=False, *a, **kw)


torch.nn.Module.load_state_dict = _lenient_load_state_dict

from booknlp.booknlp import BookNLP  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from pydantic import BaseModel  # noqa: E402

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("local-booknlp-server")

# "small" (not BookNLP's own "big" default) — a real validation spike on this
# machine measured ~1s of CPU inference per ~300-token chapter with "small"
# (extrapolates to roughly 10-20s for a typical few-thousand-word light-novel
# chapter), fast enough for a per-chapter background pass; "big" is a
# meaningfully heavier BERT stack for marginal accuracy gain on this kind of
# text. Override via BOOKNLP_MODEL if better accuracy is worth the wait.
MODEL_SIZE = os.environ.get("BOOKNLP_MODEL", "small")
PIPELINE = os.environ.get("BOOKNLP_PIPELINE", "entity,quote,supersense,event,coref")

app = FastAPI()
# Same reasoning as local-align-server's identical block: the web client is a
# different origin than this server by browser rules even on localhost —
# without this, web/src/backends/health.js's GET /health poll fails as a
# CORS error before the response body is ever readable.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

booknlp = None
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


@app.on_event("startup")
def load_model():
    global booknlp
    log.info("loading BookNLP (model=%s, pipeline=%s) on %s...", MODEL_SIZE, PIPELINE, DEVICE)
    t0 = time.time()
    booknlp = BookNLP("en", {"pipeline": PIPELINE, "model": MODEL_SIZE})
    log.info("BookNLP ready in %.1fs", time.time() - t0)


@app.get("/health")
def health():
    ready = booknlp is not None
    return {
        "ok": ready,
        "status": "ok" if ready else "loading",
        "device": DEVICE,
        "model": MODEL_SIZE,
        "ready": ready,
    }


@app.get("/pipeline")
def pipeline():
    # Stub so web/src/backends/health.js's checkPipeline() doesn't 404 against
    # this server once it's added as a connection — same as align-server.
    return {"providers": {}}


# ── TSV parsing (mirrors milkman-audiobook-maker/backend/headless_voxnovel.py's
#    pandas-based parsing, minus the pandas dependency — plain csv.DictReader
#    is enough for the handful of columns this needs) ─────────────────────────

# he/him/his -> male, she/her/hers -> female — same coverage as VoxNovel's own
# gender heuristic (backend/headless_voxnovel.py's get_gender), applied to
# BookNLP's own `prop`-tagged pronoun mentions instead of an nltk POS tag (no
# nltk model download needed for something this simple).
_MALE_PRONOUNS = {"he", "him", "his", "himself"}
_FEMALE_PRONOUNS = {"she", "her", "hers", "herself"}


def _read_tsv(path: Path) -> list[dict]:
    """Real quote-mark WORDS are common token values in BookNLP's own output
    (a token whose `word` is literally `"`) — Python csv's default dialect
    treats a field that STARTS with `"` as an opening quote with no closing
    pair, silently swallowing every subsequent tab-separated column into that
    one field until it finds another `"` somewhere later to close it,
    corrupting the row (confirmed against a real chapter: byte_offset ended
    up holding what should have been the POS_tag two columns over).
    QUOTE_NONE disables that interpretation entirely — every `"`/`'` is just
    a literal character, which is what these TSVs actually are (never
    RFC-4180 quoted fields to begin with). Matches milkman-audiobook-maker's
    own fix for exactly this file (headless_voxnovel.py's `quoting=3`)."""
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f, delimiter="\t", quoting=csv.QUOTE_NONE))


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "character"


def _verbatim_span(text: str, tokens: list[dict]) -> str:
    """Reconstruct the ORIGINAL text spanning a contiguous run of tokens by
    slicing the source string at BookNLP's own byte_onset/byte_offset columns
    — reproducing the exact original substring (quote marks, contractions,
    spacing all exactly as written), unlike joining `.tokens`' `word` column
    back together with ad-hoc punctuation-spacing fixups (VoxNovel/milkman's
    approach — lossy for contractions/possessives). Every line this server
    emits is verbatim EPUB text for exactly this reason: mechanical-script.js
    (the sibling non-BookNLP mechanical pass) makes the same guarantee, and
    the reader is built to expect it.

    NOTE: despite the `byte_` column names, these offsets index the source by
    CHARACTER (Unicode code point), not by UTF-8 byte — verified against real
    output: a chapter with a single curly apostrophe before "Badlands" sliced
    `raw_bytes[:offset]` to "...Badlan" (two bytes short, the exact drift of
    one 3-byte U+2019 counted as one), while `text[:offset]` yields the
    correct "...Badlands". This originally sliced `raw_bytes` and decoded with
    errors="replace", so every multibyte char (smart quotes, em-dashes)
    shifted the window left and could land mid-character, emitting U+FFFD and
    cutting words in half (`Comin�` / `� right up`). Slicing the
    decoded `str` by character index is exact for BMP text, identical to the
    old behaviour for pure ASCII (char index == byte index there, so no
    regression), and can never split mid-character."""
    if not tokens:
        return ""
    onset = tokens[0]["byte_onset"]
    offset = tokens[-1]["byte_offset"]
    return text[onset:offset].strip()


_QUOTE_CHARS = "\"“”"


def _strip_enclosing_quotes(s: str) -> str:
    """A quote span's byte-slice includes its own opening/closing quote
    marks — but the reader (web/src/reader/paragraphs.js's
    segmentsToTokens) unconditionally wraps any kind:"dialogue" line's text
    in curly quotes with no existing-quote check, so leaving them in here
    double-renders ("“like this,”" instead of "like this,"). Stripping them
    matches the same "dialogue text never includes its own quote marks"
    convention mechanical-script.js's quote-splitter also follows."""
    s = s.strip()
    if s and s[0] in _QUOTE_CHARS:
        s = s[1:]
    if s and s[-1] in _QUOTE_CHARS:
        s = s[:-1]
    return s.strip()


def _process_chapter_text(text: str, book_id: str, chapter_index: int, work_dir: Path) -> dict:
    """Run BookNLP on one chapter's text and shape its raw TSV output into
    this server's line-level contract. Returns a dict ready to become one
    NDJSON "chunk" row (see module docstring)."""
    chapter_dir = work_dir / f"ch{chapter_index}"
    chapter_dir.mkdir(parents=True, exist_ok=True)
    txt_path = chapter_dir / "chapter.txt"
    raw_bytes = text.encode("utf-8")
    txt_path.write_bytes(raw_bytes)

    out_dir = chapter_dir / "out"
    run_id = f"{_slugify(book_id)}_ch{chapter_index}"
    booknlp.process(str(txt_path), str(out_dir), run_id)

    tokens = _read_tsv(out_dir / f"{run_id}.tokens")
    quotes = _read_tsv(out_dir / f"{run_id}.quotes")
    entities = _read_tsv(out_dir / f"{run_id}.entities")
    for row in tokens:
        row["token_ID_within_document"] = int(row["token_ID_within_document"])
        row["byte_onset"] = int(row["byte_onset"])
        row["byte_offset"] = int(row["byte_offset"])
    for row in quotes:
        row["quote_start"] = int(row["quote_start"])
        row["quote_end"] = int(row["quote_end"])
    tokens.sort(key=lambda r: r["token_ID_within_document"])
    quotes.sort(key=lambda r: r["quote_start"])

    # Per-COREF aggregates across the WHOLE chapter (both narration mentions
    # in .entities and quote-attribution mentions in .quotes) — a much larger
    # sample than any single quote's own mention_phrase, so a character whose
    # name is established anywhere in the chapter is recognized even when a
    # LATER quote only re-attributes them by pronoun ("she said" after "Mira
    # said" already appeared earlier). Mirrors VoxNovel/milkman's own
    # aggregate-then-lookup approach (headless_voxnovel.py's character_info).
    clusters: dict[str, dict] = {}

    def cluster(coref: str) -> dict:
        return clusters.setdefault(coref, {
            "names": {}, "pronouns": {}, "mention_count": 0, "quote_count": 0,
        })

    for row in entities:
        c = cluster(row["COREF"])
        c["mention_count"] += 1
        mention = row["text"]
        if row["prop"] == "PRON":
            key = mention.lower()
            c["pronouns"][key] = c["pronouns"].get(key, 0) + 1
        elif row["prop"] == "PROP":
            c["names"][mention] = c["names"].get(mention, 0) + 1
    for row in quotes:
        cluster(row["char_id"])["quote_count"] += 1

    def resolve_name(c: dict) -> str | None:
        return max(c["names"].items(), key=lambda kv: kv[1])[0] if c["names"] else None

    def resolve_gender(c: dict) -> str:
        best, best_n = "unknown", 0
        for pron, n in c["pronouns"].items():
            if n <= best_n:
                continue
            if pron in _MALE_PRONOUNS:
                best, best_n = "male", n
            elif pron in _FEMALE_PRONOUNS:
                best, best_n = "female", n
        return best

    # Only clusters that actually speak become playback "characters" — a
    # mentioned-but-silent entity (a place, an offscreen name-drop) has no
    # dialogue and needs no voice.
    speaking_ids = sorted({row["char_id"] for row in quotes})
    char_by_coref: dict[str, dict] = {}
    characters_out = []
    for coref in speaking_ids:
        c = cluster(coref)
        name = resolve_name(c)
        has_proper_name = name is not None
        # "unnamed-<coref>" deliberately matches character-reconcile.js's
        # PLACEHOLDER_PATTERNS ("unnamed") — an unnamed BookNLP character gets
        # the SAME automatic best-match-against-known-characters heuristic
        # the LLM extraction path already relies on for its own placeholder
        # characters, for free, no new reconciliation logic needed here.
        char_id = _slugify(name) if has_proper_name else f"unnamed-{coref}"
        display_name = name or f"Unnamed Character {coref}"
        char_by_coref[coref] = {"id": char_id, "name": display_name}
        characters_out.append({
            "id": char_id,
            "name": display_name,
            "gender": resolve_gender(c),
            "mention_count": c["mention_count"],
            "quote_count": c["quote_count"],
            "has_proper_name": has_proper_name,
        })

    # ── Walk the document once, alternating narration gaps and quote spans ──
    # Alias the chapter text under a name the inner closures don't shadow —
    # emit_narration / the quote loop both bind a local `text` for each line.
    src_text = text
    tokens_by_id = {row["token_ID_within_document"]: row for row in tokens}
    max_token_id = tokens[-1]["token_ID_within_document"] if tokens else -1
    lines = []
    low_confidence_count = 0
    cursor = 0  # next unconsumed token id

    def emit_narration(start_tok: int, end_tok_exclusive: int):
        """Sub-split a narration gap into one line per sentence, using
        BookNLP's own `sentence_ID` grouping (document-wide, not reset per
        paragraph — confirmed against real output) instead of re-running a
        separate sentence splitter over already-tokenized text."""
        span_tokens = [tokens_by_id[t] for t in range(start_tok, end_tok_exclusive) if t in tokens_by_id]
        if not span_tokens:
            return
        current_sentence = None
        group: list[dict] = []
        for tok in span_tokens:
            sid = tok["sentence_ID"]
            if current_sentence is not None and sid != current_sentence and group:
                line_text = _verbatim_span(src_text, group)
                if line_text:
                    lines.append({"kind": "narration", "text": line_text})
                group = []
            current_sentence = sid
            group.append(tok)
        if group:
            line_text = _verbatim_span(src_text, group)
            if line_text:
                lines.append({"kind": "narration", "text": line_text})

    for q in quotes:
        if q["quote_start"] > cursor:
            emit_narration(cursor, q["quote_start"])
        quote_tokens = [tokens_by_id[t] for t in range(q["quote_start"], q["quote_end"] + 1) if t in tokens_by_id]
        text = _strip_enclosing_quotes(_verbatim_span(src_text, quote_tokens))
        if text:
            coref = q["char_id"]
            info = char_by_coref.get(coref)
            c = clusters.get(coref, {"quote_count": 0, "names": {}})
            line = {"kind": "dialogue", "text": text, "character_id": info["id"] if info else f"unnamed-{coref}"}
            # Confidence proxy (no real per-quote score exists in BookNLP's
            # output — see this project's plan doc for why): flag when this
            # speaker was only ever quoted once in the whole chapter
            # (VoxNovel/milkman's own "singleton -> Unknown" signal), or when
            # no mention of them ANYWHERE in the chapter was ever a proper
            # name (BookNLP resolved the pronoun chain but we never actually
            # learned who they are).
            if c["quote_count"] == 1:
                line["low_confidence_speaker"] = True
                line["confidence_reason"] = "singleton"
                low_confidence_count += 1
            elif info and not any(ch["id"] == info["id"] and ch["has_proper_name"] for ch in characters_out):
                line["low_confidence_speaker"] = True
                line["confidence_reason"] = "pronoun"
                low_confidence_count += 1
            lines.append(line)
        cursor = q["quote_end"] + 1

    if cursor <= max_token_id:
        emit_narration(cursor, max_token_id + 1)

    return {
        "characters": characters_out,
        "lines": lines,
        "meta": {
            "character_count": len(characters_out),
            "quote_count": len(quotes),
            "low_confidence_count": low_confidence_count,
        },
    }


class ChapterIn(BaseModel):
    index: int
    title: str = ""
    text: str


class ProcessRequest(BaseModel):
    book_id: str
    chapters: list[ChapterIn]


def _process_stream(req: ProcessRequest) -> Iterator[str]:
    with tempfile.TemporaryDirectory(prefix="booknlp-") as work_dir_s:
        work_dir = Path(work_dir_s)
        for chapter in req.chapters:
            t0 = time.time()
            log.info(
                "processing %s chapter %s/%s (%r, %d chars)...",
                req.book_id, chapter.index, len(req.chapters), chapter.title, len(chapter.text),
            )
            try:
                result = _process_chapter_text(chapter.text, req.book_id, chapter.index, work_dir)
                elapsed = time.time() - t0
                result["meta"]["elapsed_s"] = round(elapsed, 2)
                log.info(
                    "  -> %s chapter %s: %d character(s), %d quote(s) (%d low-confidence) in %.1fs",
                    req.book_id, chapter.index, result["meta"]["character_count"],
                    result["meta"]["quote_count"], result["meta"]["low_confidence_count"], elapsed,
                )
                yield json.dumps({"status": "chunk", "chapter_index": chapter.index, **result}) + "\n"
            except Exception as e:  # one bad chapter must not abort the whole book
                log.exception("BookNLP failed on %s chapter %s", req.book_id, chapter.index)
                yield json.dumps({"status": "error", "chapter_index": chapter.index, "error": str(e)}) + "\n"
        yield json.dumps({"status": "done", "chapter_count": len(req.chapters)}) + "\n"


@app.post("/process")
async def process_book(req: ProcessRequest):
    log.info("received %s (%d chapter(s))", req.book_id, len(req.chapters))
    return StreamingResponse(_process_stream(req), media_type="application/x-ndjson")


if __name__ == "__main__":
    import uvicorn

    # 0.0.0.0 (not 127.0.0.1) so a phone/other LAN device can reach this via
    # vite.config.js's /booknlp-proxy — same reasoning as local-align-server.
    host = os.environ.get("BOOKNLP_SERVER_HOST", "0.0.0.0")
    port = int(os.environ.get("BOOKNLP_SERVER_PORT", "7862"))
    log.info("starting on %s:%s (set BOOKNLP_SERVER_HOST=127.0.0.1 to restrict to this machine only)", host, port)
    uvicorn.run(app, host=host, port=port)
