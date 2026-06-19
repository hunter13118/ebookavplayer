"""Tests for imaging banner notifications."""
from __future__ import annotations

import os
import tempfile
import importlib


def _fresh():
    d = tempfile.mkdtemp()
    os.environ["DATA_DIR"] = d
    from server.playback import library as L
    importlib.reload(L)
    from server.images import notify as N
    importlib.reload(N)
    return L, N


def test_push_banner_dedupes():
    L, N = _fresh()
    bid = "test-book"
    L.write_status(bid, title="Test")
    N.push_banner(bid, "info", "gemini_image_fallback", "trying next model")
    N.push_banner(bid, "info", "gemini_image_fallback", "trying next model again")
    banners = N.read_banners(bid)
    assert len(banners) == 1
    assert banners[0]["code"] == "gemini_image_fallback"


def test_imaging_sink_events():
    L, N = _fresh()
    bid = "art-book"
    L.write_status(bid, title="Art")
    sink = N.ImagingBannerSink(bid)
    sink("gemini_fallback", from_model="m1", to_model="m2")
    sink("gemini_exhausted")
    sink("local_sd_start")
    sink("imaging_zero")
    codes = {b["code"] for b in N.read_banners(bid)}
    assert "gemini_image_fallback" in codes
    assert "gemini_image_exhausted" in codes
    assert "local_sd" in codes
    assert "imaging_zero" in codes


def test_analysis_event_banners():
    L, N = _fresh()
    bid = "analysis-banner"
    L.write_status(bid, title="Analyze")
    N.push_analysis_event(bid, "gemini_text_fallback", from_model="a", to_model="b")
    N.push_analysis_event(bid, "gemini_text_exhausted", quota=True)
    N.push_analysis_event(bid, "freemium_extract_start")
    N.push_analysis_event(bid, "extract_pin_locked", provider="groq")
    codes = {b["code"] for b in N.read_banners(bid)}
    assert "gemini_text_fallback" in codes
    assert "gemini_text_exhausted" in codes
    assert "freemium_extract" in codes
    assert "extract_pin_locked" in codes
