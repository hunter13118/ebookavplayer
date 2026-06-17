"""EPUB parser (pure stdlib)."""
import zipfile

from server.epub.parse import parse_epub


def _make(tmp_path):
    p = tmp_path / "demo.epub"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("OEBPS/content.opf",
                   '<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
                   '<dc:title>The Silver Gate</dc:title>'
                   '<dc:creator>A. Writer</dc:creator></metadata></package>')
        z.writestr("OEBPS/ch1.xhtml",
                   "<html><head><title>Ch1</title></head><body><h1>The Gate</h1>"
                   "<p>Rain hammered the old stones for a good while now.</p></body></html>")
        z.writestr("OEBPS/img/c.png", b"\x89PNG\r\n\x1a\n" + b"0" * 64)
    return p


def test_metadata_and_chapters(tmp_path):
    b = parse_epub(str(_make(tmp_path)))
    assert b.title == "The Silver Gate"
    assert b.author == "A. Writer"
    assert len(b.chapters) == 1
    assert "Rain hammered" in b.chapters[0].text


def test_images_extracted(tmp_path):
    b = parse_epub(str(_make(tmp_path)))
    assert len(b.images) == 1
