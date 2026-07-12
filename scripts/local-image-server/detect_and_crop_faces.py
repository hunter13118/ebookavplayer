#!/usr/bin/env python3
"""
Detect anime-style character faces in an image and crop each to a clean
head+upper-body reference — useful for group illustrations (EPUB plates,
covers) where you want a per-character crop suitable as an IP-Adapter
reference image, rather than a whole multi-character scene.

Uses lbpcascade_animeface (nagadomi) — a lightweight Haar/LBP cascade
purpose-trained on anime-style faces. General face detectors (trained on
photographic faces) perform poorly on anime art's exaggerated proportions
(huge eyes, tiny nose/mouth, different structure) — this is a small,
dependency-light, no-GPU-needed classifier built specifically for this.

Usage:
    python3 detect_and_crop_faces.py input.jpg output_dir/
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

CASCADE_PATH = Path(__file__).parent / "models" / "lbpcascade_animeface.xml"


def _detect_faces_in_array(img, *, min_neighbors: int = 4, min_size: int = 48):
    """Shared detection core — takes an already-decoded BGR array (cv2.imread
    or cv2.imdecode both produce this shape), so callers can go file-path or
    in-memory bytes (see detect_faces / detect_faces_from_bytes below).

    min_neighbors/min_size default to the conservative values tuned for
    cropping real plates (false positives there waste storage and create
    clutter in the crop catalog). server.py's output quality-gate
    (_face_count) calls this with lower, more sensitive values instead —
    that check's false-positive cost is one extra ~90s regeneration attempt,
    which is cheap next to shipping a broken "character sheet" grid
    artifact, so it's worth trading precision for recall there. Confirmed
    live: default settings only found 1 face in an image that was visibly a
    12-tile grid (each tile a tightly-cropped, non-canonical close-up the
    cascade wasn't trained to recognize) — lower thresholds recovered 2-3 of
    those tiles on a similar real example without adding any false
    positives on genuine single-portrait examples.
    """
    if img is None:
        raise ValueError("could not decode image")
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    cascade = cv2.CascadeClassifier(str(CASCADE_PATH))
    faces = cascade.detectMultiScale(
        gray, scaleFactor=1.05, minNeighbors=min_neighbors, minSize=(min_size, min_size),
    )
    return img, faces


def detect_faces(image_path: str):
    return _detect_faces_in_array(cv2.imread(image_path))


def detect_faces_from_bytes(image_bytes: bytes, *, min_neighbors: int = 4, min_size: int = 48):
    """In-memory variant for server.py's /crop_faces endpoint — no temp file
    needed, an EPUB-extracted plate never touches disk."""
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    return _detect_faces_in_array(
        cv2.imdecode(arr, cv2.IMREAD_COLOR), min_neighbors=min_neighbors, min_size=min_size,
    )



def _crop_is_text_heavy(crop_bgr, *, min_words: int = 5) -> bool:
    """True if the crop has enough confidently-OCR'd words that it's more
    likely a title-card/caption banner than a clean face reference. Root
    cause of a real, severe bug: light-novel EPUBs often have a "character
    introduction" plate — name banner + a 2-3 sentence description over a
    small decorative portrait. The face cascade can land on that small
    portrait, and crop_upper_body's expansion around a small face sweeps in
    most of the surrounding banner/text. That text-and-banner image then
    gets used as an IP-Adapter reference — and IP-Adapter faithfully
    reproduces its busy, repetitive layout, which is what a "character
    sheet" tiled-grid generation artifact actually was in practice
    (confirmed live: the exact crops behind several real broken generations
    were title cards, not faces).

    Word count, not text-area coverage, turned out to be the reliable
    signal: a stylized decorative title font (e.g. "HELEN" as a name
    headline) often isn't legible enough for Tesseract to read at all, so
    area-of-recognized-text undercounts a title card's actual "text-heavy"-
    ness. But the body-text paragraph underneath is normal-weight and reads
    fine, and real face crops essentially never contain 5+ legible words —
    checked against real examples: two actual title-card crops OCR'd at
    16 and 11 confident words respectively, a real face crop at 0.

    Runs Tesseract on just the crop (small, fast) — fails open (returns
    False) if pytesseract/tesseract isn't available, so this is a pure
    quality improvement, never a hard dependency.
    """
    try:
        import pytesseract
    except ImportError:
        return False
    h, w = crop_bgr.shape[:2]
    if h == 0 or w == 0:
        return False
    gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    try:
        ocr = pytesseract.image_to_data(gray, output_type=pytesseract.Output.DICT)
    except Exception:
        return False
    word_count = 0
    n = len(ocr.get("text", []))
    for i in range(n):
        text = (ocr["text"][i] or "").strip()
        conf = float(ocr.get("conf", ["-1"] * n)[i] or -1)
        if not text or conf < 40:
            continue
        word_count += 1
        if word_count >= min_words:
            return True
    return False


def crop_faces_from_bytes(image_bytes: bytes, *, max_faces: int | None = None):
    """Detect + crop every face in an image, left-to-right — returns
    (crops, bboxes), parallel lists: PNG-encoded bytes and the detector's
    raw [x,y,w,h] box, one pair per detected character. Text-heavy crops
    (title-card/caption banners, see _crop_is_text_heavy) are silently
    skipped rather than returned — a bad reference is worse than no
    reference. The bbox lets a caller de-duplicate against faces already
    identified another way (e.g. OCR name-caption pairing — see server.py's
    /ocr_faces) by IoU overlap, instead of re-cropping/re-identifying the
    same face twice. Used by both the CLI (main, below) and server.py's
    /crop_faces HTTP endpoint."""
    img, faces = detect_faces_from_bytes(image_bytes)
    faces = sorted(faces, key=lambda f: f[0])
    if max_faces is not None:
        faces = faces[:max_faces]
    crops = []
    bboxes = []
    for box in faces:
        crop = crop_upper_body(img, box)
        if _crop_is_text_heavy(crop):
            continue
        ok, encoded = cv2.imencode(".png", crop)
        if not ok:
            continue
        crops.append(encoded.tobytes())
        x, y, w, h = box
        bboxes.append([int(x), int(y), int(w), int(h)])
    return crops, bboxes


def crop_upper_body(img, face_box, *, body_height_mult: float = 4.0, width_mult: float = 2.2):
    """Expand a face bbox to head+upper-body framing, clamped to image bounds.

    IP-Adapter references work better with head+shoulders than a tight
    face-only crop (see docs/LOCAL_IMAGE_GEN.md) — this over-crops downward
    from the detected face box rather than just returning the raw box.
    """
    h_img, w_img = img.shape[:2]
    x, y, w, h = face_box
    cx = x + w / 2
    new_w = w * width_mult
    new_h = h * body_height_mult
    x0 = max(0, int(cx - new_w / 2))
    x1 = min(w_img, int(cx + new_w / 2))
    y0 = max(0, int(y - h * 0.3))  # small margin above the head
    y1 = min(h_img, int(y0 + new_h))
    return img[y0:y1, x0:x1]


def crop_named_faces_from_bytes(image_bytes: bytes):
    """Some illustration plates caption characters' names directly on the
    image (a group shot with each figure labeled) — this pairs each detected
    name with its nearest detected face and crops that face, so a captioned
    plate can be mapped straight to the right character profiles instead of
    relying on a single whole-plate match. Returns a list of
    {label, crop_png_bytes, bbox} — one entry per face that got paired with a
    confident nearby label; unlabeled faces and unpaired labels are omitted
    (this is deliberately conservative, same "don't guess" spirit as the LLM
    matching pass — a wrong crop-to-name pairing is worse than no pairing).

    Requires the system `tesseract` binary (brew install tesseract) — see
    server.py's /ocr_faces endpoint.
    """
    import pytesseract

    img, faces = detect_faces_from_bytes(image_bytes)
    if len(faces) == 0:
        return []

    h_img, w_img = img.shape[:2]
    # OCR on grayscale, upscaled 2x — small captions on a scanned/rendered
    # plate are often below tesseract's reliable minimum text height.
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    scale = 2
    gray = cv2.resize(gray, (w_img * scale, h_img * scale), interpolation=cv2.INTER_CUBIC)
    ocr = pytesseract.image_to_data(gray, output_type=pytesseract.Output.DICT)

    # Group adjacent, similarly-positioned, capitalized words into label
    # phrases (character names are often 1-3 words, e.g. "Elara Vance") —
    # tesseract returns one box per word, not per phrase.
    words = []
    n = len(ocr.get("text", []))
    for i in range(n):
        text = (ocr["text"][i] or "").strip()
        conf = float(ocr.get("conf", ["-1"] * n)[i] or -1)
        if not text or conf < 40 or not text[:1].isalpha():
            continue
        words.append({
            "text": text,
            "x": ocr["left"][i] / scale,
            "y": ocr["top"][i] / scale,
            "w": ocr["width"][i] / scale,
            "h": ocr["height"][i] / scale,
            "line": (ocr["block_num"][i], ocr["par_num"][i], ocr["line_num"][i]),
        })

    labels = []
    cur = None
    for w in sorted(words, key=lambda w: (w["line"], w["x"])):
        if cur and w["line"] == cur["line"] and (w["x"] - (cur["x"] + cur["w"])) < w["h"] * 2:
            cur["text"] += f" {w['text']}"
            cur["w"] = (w["x"] + w["w"]) - cur["x"]
        else:
            if cur:
                labels.append(cur)
            cur = dict(w)
    if cur:
        labels.append(cur)
    # Drop obvious non-name junk: single letters, all-digits, very long lines
    # (narrative prose leaking in from a text-heavy plate, not a caption).
    labels = [l for l in labels if 2 <= len(l["text"]) <= 40 and not l["text"].isdigit()]
    if not labels:
        return []

    def centroid(box):
        x, y, w, h = box
        return (x + w / 2, y + h / 2)

    def label_centroid(l):
        return (l["x"] + l["w"] / 2, l["y"] + l["h"] / 2)

    diag = (w_img ** 2 + h_img ** 2) ** 0.5
    max_dist = diag * 0.25  # a caption belongs to a face reasonably near it, not anywhere on the plate

    results = []
    used_labels = set()
    for box in sorted(faces, key=lambda f: f[0]):
        fx, fy = centroid(box)
        best = None
        best_dist = max_dist
        for idx, l in enumerate(labels):
            if idx in used_labels:
                continue
            lx, ly = label_centroid(l)
            dist = ((fx - lx) ** 2 + (fy - ly) ** 2) ** 0.5
            if dist < best_dist:
                best = idx
                best_dist = dist
        if best is None:
            continue
        used_labels.add(best)
        crop = crop_upper_body(img, box)
        # Higher min_words than crop_faces_from_bytes's default (5) — a
        # name-caption crop legitimately has a word or two of nearby text
        # most of the time, that alone isn't a red flag. Still rejects the
        # severe case (a title-card banner where the paired "name" IS the
        # card's own headline, with a full description paragraph alongside).
        if _crop_is_text_heavy(crop, min_words=8):
            continue
        ok, encoded = cv2.imencode(".png", crop)
        if not ok:
            continue
        x, y, w, h = box
        results.append({
            "label": labels[best]["text"],
            "crop_png_bytes": encoded.tobytes(),
            "bbox": [int(x), int(y), int(w), int(h)],
        })
    return results


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: detect_and_crop_faces.py input.jpg output_dir/")
        return 2
    input_path, out_dir = sys.argv[1], Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    img, faces = detect_faces(input_path)
    print(f"detected {len(faces)} face(s)")
    faces = sorted(faces, key=lambda f: f[0])  # left-to-right, stable/predictable ordering
    for i, box in enumerate(faces):
        x, y, w, h = box
        crop = crop_upper_body(img, box)
        out_path = out_dir / f"character-{i}.png"
        cv2.imwrite(str(out_path), crop)
        print(f"  face {i}: bbox=({x},{y},{w},{h}) -> {out_path} ({crop.shape[1]}x{crop.shape[0]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
