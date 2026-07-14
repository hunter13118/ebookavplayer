/**
 * Phase 3 (docs/02_REVOLUTION_ROADMAP.md, docs/CHARACTER_ENRICHMENT.md) —
 * character enrichment. Best-effort, opt-in (VAE_CHARACTER_ENRICH) lookup of
 * structured textual attributes (hair/eye color, build, age, outfit, speech
 * register/cadence) for named characters, sourced from Fandom wiki pages and
 * MyAnimeList (via the free Jikan API) — both keyless, free, public APIs,
 * keeping this on the right side of the project's $0 ceiling. Results feed
 * the character's image-gen description (edge-imaging.js) and voice/prosody
 * assignment (voice-assign.js).
 *
 * Never fatal: any network/parse failure at any stage falls back to no
 * enrichment for that character, exactly like today's (pre-Phase-3) behavior.
 */
import { freemiumExtract } from "./freemium-extract.js";
import { isPlaceholderCharacter } from "./character-reconcile.js";

const KV_PREFIX = "character_enrich:v1:";
const WIKI_KV_PREFIX = "character_enrich:wiki:v1:";
const POSITIVE_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days — fan-wiki prose is fairly stable
const NEGATIVE_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days — avoid re-hammering search for obscure/original characters
const FETCH_TIMEOUT_MS = 10_000;
const MAX_EXTRACT_CHARS = 6000;

export const ATTRIBUTE_KEYS = [
  "hair_color", "eye_color", "build", "age", "outfit", "speech_register", "cadence",
];

export function isCharacterEnrichEnabled(env) {
  return String(env?.VAE_CHARACTER_ENRICH ?? "false").toLowerCase() === "true";
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

export function characterEnrichKvKey(seriesTitle, characterName) {
  return `${KV_PREFIX}${slugify(seriesTitle)}:${slugify(characterName)}`;
}

function wikiResolveKvKey(seriesTitle) {
  return `${WIKI_KV_PREFIX}${slugify(seriesTitle)}`;
}

async function loadCachedEnrichment(env, seriesTitle, characterName) {
  if (!env?.VAE_JOBS) return undefined;
  const raw = await env.VAE_JOBS.get(characterEnrichKvKey(seriesTitle, characterName));
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function saveCachedEnrichment(env, seriesTitle, characterName, data, ttlSeconds) {
  if (!env?.VAE_JOBS) return;
  await env.VAE_JOBS.put(
    characterEnrichKvKey(seriesTitle, characterName),
    JSON.stringify(data),
    { expirationTtl: ttlSeconds },
  );
}

async function fetchJsonWithTimeout(url, { timeoutMs = FETCH_TIMEOUT_MS, headers } = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// --- Fandom -----------------------------------------------------------
//
// Fandom's own cross-wiki search (www.fandom.com/api/v1/Search/CrossWiki) is
// sat behind a Cloudflare JS challenge and returns an HTML "Just a moment…"
// page to a plain server-side fetch — confirmed live, not usable headlessly.
// Individual wiki subdomains are NOT behind that wall: their standard
// MediaWiki api.php responds directly and predictably. So instead of
// searching, this guesses the wiki subdomain from the series title (Fandom
// subdomains are near-always the series name with spaces/punctuation
// stripped, no dashes — confirmed against several real wikis) and confirms
// the guess with a lightweight `meta=siteinfo` call before using it.

function candidateWikiDomains(seriesTitle) {
  const noDash = String(seriesTitle || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const hyphenated = slugify(seriesTitle);
  const domains = [];
  if (noDash) domains.push(`${noDash}.fandom.com`);
  if (hyphenated && hyphenated !== noDash) domains.push(`${hyphenated}.fandom.com`);
  return domains;
}

async function probeWikiDomain(domain) {
  const url = `https://${domain}/api.php?action=query&meta=siteinfo&format=json`;
  const data = await fetchJsonWithTimeout(url, { timeoutMs: 6000 });
  return data?.query?.general?.sitename ? domain : null;
}

/** Resolve a series title to a Fandom wiki domain — cached per series since
 *  many characters share one wiki. Returns null (cached) when no wiki match. */
async function resolveFandomWiki(env, seriesTitle) {
  if (env?.VAE_JOBS) {
    const cached = await env.VAE_JOBS.get(wikiResolveKvKey(seriesTitle));
    if (cached != null) {
      try {
        return JSON.parse(cached);
      } catch { /* fall through to re-resolve */ }
    }
  }
  let domain = null;
  for (const candidate of candidateWikiDomains(seriesTitle)) {
    // eslint-disable-next-line no-await-in-loop -- sequential probes, first match wins
    domain = await probeWikiDomain(candidate);
    if (domain) break;
  }
  if (env?.VAE_JOBS) {
    await env.VAE_JOBS.put(wikiResolveKvKey(seriesTitle), JSON.stringify(domain), {
      expirationTtl: domain ? POSITIVE_TTL_SECONDS : NEGATIVE_TTL_SECONDS,
    });
  }
  return domain;
}

function stripWikitextNoise(raw) {
  return String(raw)
    .replace(/<gallery[\s\S]*?<\/gallery>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<ref[^/]*\/>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\{\{Sidenote\|([^{}]*)\}\}/gi, "($1)")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function fetchFandomCharacterExtract(wikiDomain, characterName) {
  if (!wikiDomain) return null;
  const base = `https://${wikiDomain}/api.php`;
  const searchUrl = `${base}?action=query&list=search&srsearch=${encodeURIComponent(characterName)}&format=json&srlimit=1`;
  const searchData = await fetchJsonWithTimeout(searchUrl);
  const pageTitle = searchData?.query?.search?.[0]?.title;
  if (!pageTitle) return null;

  // `action=query&prop=extracts` (clean plain text) needs the TextExtracts
  // extension, which isn't installed on every Fandom wiki — confirmed live:
  // it errors on at least one real wiki with "Unrecognized value for
  // parameter prop: extracts". `action=parse&prop=wikitext` is core
  // MediaWiki (works everywhere) and, confirmed against a real character
  // page, its infobox lines (`|hair=...`, `|eye=...`, `|age=...`) are exactly
  // the attributes this module wants — the LLM structuring pass handles
  // `|key = value` markup fine, so only the noisiest non-prose blocks
  // (galleries, citation refs, comments) are stripped before truncating.
  const wikitextUrl = `${base}?action=parse&page=${encodeURIComponent(pageTitle)}&prop=wikitext&formatversion=2&format=json`;
  const wikitextData = await fetchJsonWithTimeout(wikitextUrl);
  const raw = wikitextData?.parse?.wikitext;
  if (!raw) return null;

  const cleaned = stripWikitextNoise(raw);
  if (!cleaned) return null;
  return { text: cleaned.slice(0, MAX_EXTRACT_CHARS), pageTitle, source: "fandom" };
}

// --- MyAnimeList (via the free, keyless Jikan REST wrapper) --------------

async function fetchJikanCharacterAbout(characterName) {
  const url = `https://api.jikan.moe/v4/characters?q=${encodeURIComponent(characterName)}&limit=3`;
  const data = await fetchJsonWithTimeout(url);
  const candidates = data?.data || [];
  const match = candidates.find(
    (c) => String(c?.name || "").toLowerCase() === String(characterName).toLowerCase(),
  ) || candidates[0];
  const about = match?.about;
  if (!about) return null;
  return { text: String(about).slice(0, MAX_EXTRACT_CHARS), pageTitle: match?.name, source: "mal" };
}

// --- LLM structuring: raw wiki prose -> attributes JSON -------------------
// Reuses the existing multi-provider chain (freemiumExtract) instead of a
// bespoke HTTP/LLM client — same helper dialogue-attribute-llm.js uses.

export const ENRICH_SYSTEM = `You extract canonical physical/vocal attributes for a fictional character from fan-wiki prose.
Read the text and output ONLY facts explicitly stated in it — never invent or guess.
Output JSON only, in this exact shape:
{"hair_color": string|null, "eye_color": string|null, "build": string|null, "age": string|null, "outfit": string|null, "speech_register": string|null, "cadence": string|null}
- hair_color/eye_color: a short color word/phrase (e.g. "silver", "deep violet"), or null if not stated.
- build: a short physical build descriptor (e.g. "tall and lean", "short and stocky"), or null.
- age: a short age descriptor (e.g. "teenager", "mid-30s", "elderly"), or null.
- outfit: the character's defining/signature outfit, or null.
- speech_register: how formally/informally they speak (e.g. "blunt and informal", "highly formal and reserved"), or null.
- cadence: their rhythm/pacing of speech (e.g. "fast and clipped", "slow and deliberate"), or null.
Return null for any attribute not clearly supported by the text. Do not pad with generic guesses.`;

async function structureAttributesFromText(env, {
  characterName, seriesTitle, rawText, source,
}) {
  const user = `Character: ${characterName}${seriesTitle ? ` (from "${seriesTitle}")` : ""}\nSource: ${source}\n\n${rawText}`;
  try {
    const result = await freemiumExtract(user, { systemPrompt: ENRICH_SYSTEM, env, temperature: 0.2 });
    const data = result?.data || {};
    const out = {};
    for (const key of ATTRIBUTE_KEYS) {
      const v = data[key];
      out[key] = (typeof v === "string" && v.trim()) ? v.trim() : null;
    }
    return out;
  } catch {
    return null;
  }
}

// --- Orchestrator ----------------------------------------------------------

async function lookupRawText(env, seriesTitle, characterName) {
  try {
    const wikiDomain = await resolveFandomWiki(env, seriesTitle);
    const fandom = await fetchFandomCharacterExtract(wikiDomain, characterName);
    if (fandom) return fandom;
  } catch { /* fall through to MAL */ }
  try {
    const mal = await fetchJikanCharacterAbout(characterName);
    if (mal) return mal;
  } catch { /* no source found */ }
  return null;
}

/** Best-effort per-character enrichment lookup. Never throws — resolves to
 *  null on any failure/no-match/placeholder character, same as pre-Phase-3
 *  (no enrichment) behavior. `null` may also be a cached negative result. */
export async function enrichCharacter(env, { seriesTitle, character }) {
  const characterName = character?.name || character?.id;
  if (!characterName || character?.id === "narrator" || isPlaceholderCharacter(character)) return null;

  try {
    const cached = await loadCachedEnrichment(env, seriesTitle, characterName);
    if (cached !== undefined) return cached;

    const found = await lookupRawText(env, seriesTitle, characterName);
    if (!found) {
      await saveCachedEnrichment(env, seriesTitle, characterName, null, NEGATIVE_TTL_SECONDS);
      return null;
    }

    const attributes = await structureAttributesFromText(env, {
      characterName, seriesTitle, rawText: found.text, source: found.source,
    });
    if (!attributes || ATTRIBUTE_KEYS.every((k) => !attributes[k])) {
      await saveCachedEnrichment(env, seriesTitle, characterName, null, NEGATIVE_TTL_SECONDS);
      return null;
    }

    const result = { ...attributes, enrichment_source: found.source };
    await saveCachedEnrichment(env, seriesTitle, characterName, result, POSITIVE_TTL_SECONDS);
    return result;
  } catch {
    return null;
  }
}

/** Enrich a whole character roster with bounded concurrency and an overall
 *  time budget, so a slow/unreachable source can't stall book processing.
 *  Returns a Map<characterId, attributes> — characters with no match/failure
 *  are simply absent from the map. */
export async function enrichCharacters(env, {
  seriesTitle, characters = [], concurrency = 3, budgetMs = 45_000,
} = {}) {
  const results = new Map();
  const deadline = Date.now() + budgetMs;
  const queue = [...characters];

  async function worker() {
    while (queue.length && Date.now() < deadline) {
      const character = queue.shift();
      if (!character) continue;
      const attrs = await enrichCharacter(env, { seriesTitle, character });
      if (attrs) results.set(character.id, attrs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, characters.length) }, worker));
  return results;
}

/** Overlay only the non-null enrichment fields onto a character object —
 *  never clobbers an existing value with a null/missing attribute. */
export function mergeEnrichmentIntoCharacter(character, attributes) {
  if (!attributes) return character;
  const patch = {};
  for (const key of ATTRIBUTE_KEYS) {
    if (attributes[key]) patch[key] = attributes[key];
  }
  if (attributes.enrichment_source) patch.enrichment_source = attributes.enrichment_source;
  return Object.keys(patch).length ? { ...character, ...patch } : character;
}
