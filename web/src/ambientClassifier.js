/** Ambient-sound category inferred from a scene's title/location. Mirrors
 *  sceneLabels.js's TIME_HINTS keyword-matching pattern — no "setting" field
 *  exists on a compiled scene, so this works off the same free-form
 *  title/location text the display label already uses. */

const AMBIENT_HINTS = [
  { re: /\b(tavern|inn|pub|bar|saloon)\b/i, category: "tavern" },
  { re: /\b(forest|woods|grove|jungle|wilderness)\b/i, category: "forest" },
  { re: /\b(storm|rain(?:y|ing|storm)?|downpour|drizzle)\b/i, category: "rain" },
  { re: /\b(wind(?:y|storm)?|gale|breeze|blizzard)\b/i, category: "wind" },
];

/** @returns {"tavern"|"forest"|"rain"|"wind"|null} */
export function classifyAmbience(scene) {
  const hay = [scene?.title, scene?.location].filter(Boolean).join(" ");
  for (const { re, category } of AMBIENT_HINTS) {
    if (re.test(hay)) return category;
  }
  return null;
}
