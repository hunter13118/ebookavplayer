"""Edge TTS contract — mirrors the parallel-reader's test_edge_tts_api.py.

Verifies the module's shape/signature WITHOUT hitting the network (the Bing
endpoint is unreachable in CI/sandbox). Live synthesis is a host check.
"""
import inspect

from server.audio import edge_tts


def test_synthesize_signature():
    sig = inspect.signature(edge_tts.synthesize_edge_mp3)
    params = list(sig.parameters)
    assert params[0] == "text"
    assert "voice" in params
    assert "rate" in params and "pitch" in params


def test_empty_text_returns_empty_without_network():
    # empty/whitespace short-circuits before importing/calling edge_tts
    import asyncio
    out = asyncio.run(edge_tts.synthesize_edge_mp3("   "))
    assert out == b""


def test_defaults_present():
    assert edge_tts.DEFAULT_VOICE
    assert edge_tts.NARRATOR_VOICE_M and edge_tts.NARRATOR_VOICE_F
