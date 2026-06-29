"""Tests for art compare backup timing."""
from __future__ import annotations

from pathlib import Path

from server.analyze.schema import AnalysisCharacter, AnalysisScene, BookAnalysis
from server.images.generate import regen_targets
from server.images.versions import asset_filename, backup_media_asset, commit_media_asset, prev_filename, prev_public_url


def test_regen_targets_selected_character():
    a = BookAnalysis(
        book_id="t",
        title="T",
        characters=[AnalysisCharacter(id="mei", name="Mei", importance="primary")],
        scenes=[AnalysisScene(id="s1", chapter=1, title="One")],
    )
    targets = regen_targets(a, scope="selected", character_ids=["mei"])
    assert ("characters", "mei") in targets


def test_regen_targets_insert_scope():
    from server.analyze.schema import AnalysisLine
    a = BookAnalysis(
        book_id="t",
        title="T",
        characters=[AnalysisCharacter(id="mei", name="Mei", importance="primary")],
        scenes=[
            AnalysisScene(
                id="s1",
                chapter=1,
                title="One",
                present_character_ids=["mei"],
                lines=[
                    AnalysisLine(
                        character_id="mei",
                        text="A dramatic moment here for sure.",
                        kind="dialogue",
                        expression="angry",
                        visual_moment=True,
                    ),
                ],
            ),
        ],
    )
    targets = regen_targets(a, scope="inserts", insert_line_indices=[0])
    assert targets == [("inserts", "0")]


def test_backup_before_overwrite(tmp_path):
    book_id = "bk"
    style = "semi-real"
    media = tmp_path / "media"
    path = media / book_id / style
    path.mkdir(parents=True)
    live = path / "char_mei.png"
    live.write_bytes(b"OLD")
    backup_media_asset(media, book_id, style, "characters", "mei")
    live.write_bytes(b"NEW")
    prev = path / prev_filename("characters", "mei")
    assert prev.read_bytes() == b"OLD"
    assert live.read_bytes() == b"NEW"
    assert prev_public_url(book_id, style, "characters", "mei").endswith("char_mei.prev.png")


def test_backup_insert_before_overwrite(tmp_path):
    book_id = "bk"
    style = "semi-real"
    media = tmp_path / "media"
    path = media / book_id / style
    path.mkdir(parents=True)
    live = path / "insert_3.png"
    live.write_bytes(b"OLD")
    backup_media_asset(media, book_id, style, "inserts", "3")
    live.write_bytes(b"NEW")
    prev = path / prev_filename("inserts", "3")
    assert prev.read_bytes() == b"OLD"
    assert asset_filename("inserts", "3") == "insert_3.png"


def test_commit_media_asset_drops_prev(tmp_path):
    book_id = "bk"
    style = "semi-real"
    media = tmp_path / "media"
    path = media / book_id / style
    path.mkdir(parents=True)
    live = path / "insert_3.png"
    live.write_bytes(b"NEW")
    prev = path / "insert_3.prev.png"
    prev.write_bytes(b"OLD")
    url = commit_media_asset(media, book_id, style, "inserts", "3")
    assert url and "?v=" in url
    assert not prev.is_file()
    assert live.read_bytes() == b"NEW"
