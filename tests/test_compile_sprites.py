"""Compile-time sprite resolution."""
import os
import tempfile

from server.analyze.schema import AnalysisCharacter, AnalysisLine, AnalysisScene, BookAnalysis
from server.playback.compile import compile_book
from server.playback.sprites import resolve_expression_sprite


def test_resolve_expression_sprite_from_media():
    media = {"expressions": {"mei:angry": "/media/b/anime/char_mei_angry.png"}}
    assert resolve_expression_sprite("mei", "angry", media) is None  # file missing
    assert resolve_expression_sprite("mei", "normal", media) is None


def test_compile_sets_sprite_url_from_expression(tmp_path):
    d = tempfile.mkdtemp()
    os.environ["DATA_DIR"] = d
    media_root = os.path.join(d, "media", "bk", "semi-real")
    os.makedirs(media_root, exist_ok=True)
    base = os.path.join(media_root, "char_mei.png")
    angry = os.path.join(media_root, "char_mei_angry.png")
    open(base, "wb").write(b"x")
    open(angry, "wb").write(b"x")
    analysis = BookAnalysis(
        book_id="bk",
        title="T",
        characters=[AnalysisCharacter(id="mei", name="Mei", importance="primary")],
        scenes=[AnalysisScene(
            id="s1", chapter=1, title="One",
            present_character_ids=["mei"],
            lines=[AnalysisLine(character_id="mei", text="Stop!", kind="dialogue", expression="angry")],
        )],
    )
    book = compile_book(
        analysis,
        media={
            "characters": {"mei": "/media/bk/semi-real/char_mei.png"},
            "expressions": {"mei:angry": "/media/bk/semi-real/char_mei_angry.png"},
        },
    )
    line = book.scenes[0].lines[0]
    assert line.sprite_url.endswith("char_mei_angry.png")
