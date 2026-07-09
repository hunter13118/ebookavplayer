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


def _detect_faces_in_array(img):
    """Shared detection core — takes an already-decoded BGR array (cv2.imread
    or cv2.imdecode both produce this shape), so callers can go file-path or
    in-memory bytes (see detect_faces / detect_faces_from_bytes below)."""
    if img is None:
        raise ValueError("could not decode image")
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    cascade = cv2.CascadeClassifier(str(CASCADE_PATH))
    faces = cascade.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=4, minSize=(48, 48))
    return img, faces


def detect_faces(image_path: str):
    return _detect_faces_in_array(cv2.imread(image_path))


def detect_faces_from_bytes(image_bytes: bytes):
    """In-memory variant for server.py's /crop_faces endpoint — no temp file
    needed, an EPUB-extracted plate never touches disk."""
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    return _detect_faces_in_array(cv2.imdecode(arr, cv2.IMREAD_COLOR))


def crop_faces_from_bytes(image_bytes: bytes, *, max_faces: int | None = None):
    """Detect + crop every face in an image, left-to-right — returns a list
    of PNG-encoded bytes, one per detected character. Used by both the CLI
    (main, below) and server.py's /crop_faces HTTP endpoint."""
    img, faces = detect_faces_from_bytes(image_bytes)
    faces = sorted(faces, key=lambda f: f[0])
    if max_faces is not None:
        faces = faces[:max_faces]
    crops = []
    for box in faces:
        crop = crop_upper_body(img, box)
        ok, encoded = cv2.imencode(".png", crop)
        if not ok:
            continue
        crops.append(encoded.tobytes())
    return crops


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
