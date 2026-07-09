// Expression Sensitivity Plan Phase 4 "Callback/echo staging for interrupted
// dialogue": a short attribution tag between two dialogue lines by the same
// character (dialogue-rules.js's INTERRUPTED DIALOGUE pattern, e.g. '"Whatever
// you wish for," he said quietly. "The coin only summoned me."') should keep
// the speaker's sprite mid-gesture through the beat, not reset to idle and
// re-trigger the speaking animation on the very next line. A real narration
// paragraph (scene-setting prose, not a tag) should still reset normally —
// distinguished by length, same cutoff used server-side for the analogous
// dialogue-repair.js promotion heuristic.
const SHORT_TAG_MAX_WORDS = 12;

function isShortInterruptionTag(line, prevLine, nextLine) {
  if (line.kind !== "narration") return false;
  if (prevLine?.kind !== "dialogue" || nextLine?.kind !== "dialogue") return false;
  if (!prevLine.character_id || prevLine.character_id !== nextLine.character_id) return false;
  const words = String(line.text || "").trim().split(/\s+/).filter(Boolean).length;
  return words > 0 && words <= SHORT_TAG_MAX_WORDS;
}

/** Sprite spotlight: delivery tags (and short interrupted-dialogue narration
 *  tags) keep the prior dialogue speaker lit instead of resetting to idle. */
export function spotlightCharacterId(lines, index) {
  const line = lines?.[index];
  if (!line) return null;
  if (line.kind === "delivery" || isShortInterruptionTag(line, lines?.[index - 1], lines?.[index + 1])) {
    for (let j = index - 1; j >= 0; j -= 1) {
      if (lines[j]?.kind === "dialogue") return lines[j].character_id;
    }
    return null;
  }
  if (line.character_id === "narrator") return null;
  return line.character_id;
}
