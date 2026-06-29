/** Sprite spotlight: delivery tags keep the prior dialogue speaker lit. */
export function spotlightCharacterId(lines, index) {
  const line = lines?.[index];
  if (!line) return null;
  if (line.kind === "delivery") {
    for (let j = index - 1; j >= 0; j -= 1) {
      if (lines[j]?.kind === "dialogue") return lines[j].character_id;
    }
    return null;
  }
  if (line.character_id === "narrator") return null;
  return line.character_id;
}
