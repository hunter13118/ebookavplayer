/**
 * Canonical expression-bucket vocabulary + freeform normalizer.
 * Expression Sensitivity Plan (docs/EXPRESSION_SENSITIVITY_PLAN.md) Phase 1a/3a:
 * the extraction prompt's canonical vocabulary and this normalizer must agree,
 * so any of the 70+ freeform values the model still produces (e.g. "giggling",
 * "grimacing") bucket onto one of these 16 rather than falling through to an
 * inert CSS class or a no-op TTS prosody offset.
 *
 * Mirrored (not imported — separate bundle) in web/src/expressionBucket.js so
 * the worker (audio) and web (visual) sides never disagree about what a given
 * freeform tag means. Keep the two ALIASES tables in sync when editing either.
 */

export const CANONICAL_EXPRESSION_BUCKETS = [
  "yell", "angry", "whisper", "sad", "scared", "surprised", "happy", "excited",
  "embarrassed", "smug", "tender", "nervous", "sarcastic", "determined", "desperate", "normal",
];

const ALIASES = {
  yell: ["yelling", "yelled", "shouting", "shouted", "screaming", "screamed", "hollering", "bellowing"],
  angry: ["mad", "furious", "irritated", "annoyed", "grumpy", "hostile", "rage", "raging", "fuming", "resentful", "frustrated", "scowling"],
  whisper: ["whispering", "whispered", "hushed", "murmuring", "murmured", "soft-spoken", "muted", "quiet", "quietly"],
  sad: ["sorrowful", "mournful", "gloomy", "dejected", "heartbroken", "crying", "cried", "tearful", "melancholy", "grief-stricken", "reflective", "pensive", "wistful"],
  scared: ["afraid", "frightened", "terrified", "fearful", "anxious", "panicked", "alarmed", "trembling"],
  surprised: ["shocked", "startled", "astonished", "stunned", "amazed", "wide-eyed"],
  happy: ["joyful", "cheerful", "pleased", "delighted", "content", "glad", "smiling", "giggling", "amused"],
  excited: ["thrilled", "eager", "enthusiastic", "energetic", "elated", "exhilarated"],
  embarrassed: ["flustered", "awkward", "sheepish", "ashamed", "blushing", "mortified", "bashful"],
  smug: ["smirking", "cocky", "self-satisfied", "arrogant", "condescending", "gloating", "teasing", "playful"],
  tender: ["affectionate", "loving", "gentle", "warm", "caring", "soothing", "fond"],
  nervous: ["worried", "uneasy", "jittery", "timid", "hesitant", "uncertain", "stammering"],
  sarcastic: ["mocking", "dry", "wry", "ironic", "sardonic", "deadpan"],
  determined: ["resolute", "firm", "focused", "steely", "adamant", "assertive"],
  desperate: ["pleading", "frantic", "urgent", "hopeless", "dire", "begging"],
};

const ALIAS_LOOKUP = (() => {
  const map = new Map();
  for (const bucket of CANONICAL_EXPRESSION_BUCKETS) map.set(bucket, bucket);
  for (const [bucket, words] of Object.entries(ALIASES)) {
    for (const word of words) map.set(word, bucket);
  }
  return map;
})();

/** Map any freeform or canonical expression string onto one of the 16
 *  canonical buckets. Exact match first, then a substring scan (so e.g.
 *  "grimacing angrily" still resolves), then "normal". */
export function normalizeExpressionBucket(raw) {
  const s = String(raw || "normal").trim().toLowerCase();
  if (!s) return "normal";
  if (ALIAS_LOOKUP.has(s)) return ALIAS_LOOKUP.get(s);
  for (const [word, bucket] of ALIAS_LOOKUP) {
    if (s.includes(word)) return bucket;
  }
  return "normal";
}
