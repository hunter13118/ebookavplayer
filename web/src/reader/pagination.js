// Pure pagination for the M4B-first minimal reader. Pages are "procedurally
// generated based on user configuration" (font size → measured sentence
// heights → how many fit the viewport). This module does the packing; the
// component measures heights in the DOM (text wrapping is font/width dependent
// and can't be computed here) and feeds them in.
//
// A "page" is a contiguous run of sentence lines whose stacked heights fit the
// available page height. Greedy first-fit: fill a page until the next sentence
// would overflow, then start a new one. A single sentence taller than the whole
// page still gets its own page (never dropped, never split mid-sentence — the
// bolden/typewriter unit is the whole sentence).

/**
 * @param {number[]} lineHeights  Rendered px height of each sentence, in order
 *   (including its bottom margin/gap).
 * @param {number} pageHeightPx   Usable content height of one page.
 * @returns {{startLine:number, endLine:number}[]}  endLine is EXCLUSIVE.
 */
export function paginate(lineHeights, pageHeightPx) {
  const pages = [];
  const n = lineHeights?.length || 0;
  if (!n) return pages;
  const cap = Math.max(1, pageHeightPx || 0);

  let start = 0;
  let used = 0;
  for (let i = 0; i < n; i++) {
    const h = Math.max(0, lineHeights[i] || 0);
    // Start a new page when adding this sentence would overflow — unless the
    // page is empty (a lone oversized sentence must still land somewhere).
    if (used > 0 && used + h > cap) {
      pages.push({ startLine: start, endLine: i });
      start = i;
      used = 0;
    }
    used += h;
  }
  pages.push({ startLine: start, endLine: n });
  return pages;
}

/**
 * Index of the page containing lineIndex (0 if none — a just-built, not-yet
 * paginated state shouldn't throw). Pages are contiguous and ordered, so this
 * is a plain scan; page counts are small (tens to low hundreds for a book).
 */
export function pageOfLine(pages, lineIndex) {
  if (!pages || !pages.length) return 0;
  for (let p = 0; p < pages.length; p++) {
    if (lineIndex < pages[p].endLine) return p;
  }
  return pages.length - 1;
}
