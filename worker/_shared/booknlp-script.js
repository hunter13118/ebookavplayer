/**
 * Shapes one chapter's BookNLP server output (booknlp-client.js's
 * booknlpProcessChapter result: {characters, lines, meta}) into the exact
 * `chapterAnalysis` contract extractChapterRaw normally produces from an LLM
 * call (worker/_shared/freemium-extract.js) — {characters, scenes,
 * chapterIndex, chapterTitle} — so chapter-extract-pipeline.js's existing
 * per-chapter finishChapter step (repair -> attribute -> compile -> persist)
 * runs completely unchanged regardless of which source produced the analysis.
 *
 * One scene per chapter (matching mechanical-script.js's own granularity —
 * finer scene-boundary detection is explicitly out of scope for this slice,
 * see the plan's "wave 6" note).
 *
 * Known limitation (deliberate, not an oversight): this does NOT attach
 * illustrations. The LLM path attaches images via analysis-level
 * character.illustration_ref/scene.illustration_ref, resolved by
 * applyDirectIllustrations (illustrations.js) at whole-book finalization —
 * fields only the model itself can set from its own reading of the
 * "illustrationsNearby" prompt hint. BookNLP has no equivalent judgment call
 * to make (it never sees illustrations at all), and retrofitting a
 * mechanical position-matching path (like mechanical-script.js's
 * bestInsertionLine) into compileChapterPlayback's per-LINE output isn't
 * possible without also changing that shared, heavily-used compile path:
 * compileChapterPlayback only carries a source line's `visual_moment` flag
 * through (applyInsertFields), never a pre-attached illustration_url, since
 * the real URL is normally resolved later via a `media.inserts` map keyed by
 * the FINAL post-compile lineIdx — not yet known while this module runs.
 * A BookNLP-processed chapter simply has no illustrations for now, same as
 * any chapter with none — not broken, just not wired up yet.
 */

function narrationOrDialogueLine(line) {
  const out = { kind: line.kind, text: line.text };
  if (line.character_id) out.character_id = line.character_id;
  if (line.low_confidence_speaker) {
    out.low_confidence_speaker = true;
    out.confidence_reason = line.confidence_reason;
  }
  out.attribution_source = "booknlp";
  return out;
}

/**
 * @param {{characters: object[], lines: object[], meta: object}} booknlpResult
 * @param {{index: number, title: string}} chapter
 * @returns {{characters: object[], scenes: object[], chapterIndex: number, chapterTitle: string}}
 */
export function buildBooknlpChapterAnalysis(booknlpResult, chapter) {
  const characters = (booknlpResult.characters || []).map((c) => ({
    id: c.id,
    name: c.name,
    gender: c.gender || "unknown",
    importance: "secondary",
  }));

  const lines = (booknlpResult.lines || []).map(narrationOrDialogueLine);

  return {
    characters,
    scenes: [{
      id: "scene-0001",
      chapter: chapter.index,
      title: chapter.title || `Chapter ${chapter.index}`,
      location: "",
      present_character_ids: characters.map((c) => c.id),
      lines,
    }],
    chapterIndex: chapter.index,
    chapterTitle: chapter.title || "",
  };
}
