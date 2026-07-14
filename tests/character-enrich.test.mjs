/**
 * Phase 3 character enrichment (worker/_shared/character-enrich.js) +
 * downstream voice-assign.js splice. Mocks global.fetch and a fake KV so no
 * real provider or network needs to be running.
 * Run: node tests/character-enrich.test.mjs
 */
import assert from "node:assert";
import {
  isCharacterEnrichEnabled,
  characterEnrichKvKey,
  enrichCharacter,
  mergeEnrichmentIntoCharacter,
} from "../worker/_shared/character-enrich.js";
import { assignVoices } from "../worker/_shared/voice-assign.js";

const originalFetch = globalThis.fetch;
function mockFetch(handler) { globalThis.fetch = async (url, options) => handler(String(url), options); }
function restoreFetch() { globalThis.fetch = originalFetch; }

function fakeKv() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    _store: store,
  };
}

const OLLAMA_ENV_BASE = { OLLAMA_BASE_URL: "http://localhost:11434" };
function ollamaResponse(payload) {
  return { ok: true, json: async () => ({ message: { content: JSON.stringify(payload) } }) };
}

// --- isCharacterEnrichEnabled: only the literal string "true" turns it on ---
{
  assert.equal(isCharacterEnrichEnabled({ VAE_CHARACTER_ENRICH: "true" }), true);
  assert.equal(isCharacterEnrichEnabled({ VAE_CHARACTER_ENRICH: "1" }), false);
  assert.equal(isCharacterEnrichEnabled({}), false);
  assert.equal(isCharacterEnrichEnabled(undefined), false);
}

// --- characterEnrichKvKey: slugifies series + name into a stable key -------
{
  assert.equal(
    characterEnrichKvKey("Mushoku Tensei", "Rudeus Greyrat"),
    "character_enrich:v1:mushoku-tensei:rudeus-greyrat",
  );
  assert.equal(
    characterEnrichKvKey("", "Elara!"),
    "character_enrich:v1:unknown:elara",
  );
}

// --- mergeEnrichmentIntoCharacter: nulls never clobber, only sets present keys ---
{
  const character = { id: "elara", name: "Elara", description: "a mage" };
  const merged = mergeEnrichmentIntoCharacter(character, {
    hair_color: "silver", eye_color: null, build: null, age: null, outfit: "travel cloak",
    speech_register: null, cadence: null, enrichment_source: "fandom",
  });
  assert.equal(merged.hair_color, "silver");
  assert.equal(merged.outfit, "travel cloak");
  assert.equal(merged.enrichment_source, "fandom");
  assert.equal("eye_color" in merged, false, "null attributes are not written onto the character at all");
  assert.equal(character.hair_color, undefined, "original character object is not mutated");

  assert.strictEqual(
    mergeEnrichmentIntoCharacter(character, null),
    character,
    "no attributes -> character returned as-is",
  );
  assert.strictEqual(
    mergeEnrichmentIntoCharacter(character, { hair_color: null, eye_color: null }),
    character,
    "all-null attributes -> character returned as-is (no-op patch)",
  );
}

// --- enrichCharacter: Fandom hit -> LLM structures -> caches ---------------
{
  const kv = fakeKv();
  const env = { ...OLLAMA_ENV_BASE, VAE_JOBS: kv };
  let fetchCalls = 0;

  mockFetch(async (url, options) => {
    fetchCalls += 1;
    if (url.includes("someseries.fandom.com/api.php") && url.includes("meta=siteinfo")) {
      return { ok: true, json: async () => ({ query: { general: { sitename: "Some Fandom Wiki" } } }) };
    }
    if (url.includes(".fandom.com/api.php") && url.includes("meta=siteinfo")) {
      // any other guessed domain (e.g. the hyphenated fallback) doesn't exist
      return { ok: false, json: async () => ({}) };
    }
    if (url.includes("someseries.fandom.com/api.php") && url.includes("list=search")) {
      return { ok: true, json: async () => ({ query: { search: [{ title: "Elara" }] } }) };
    }
    if (url.includes("someseries.fandom.com/api.php") && url.includes("prop=wikitext")) {
      return {
        ok: true,
        json: async () => ({
          parse: {
            wikitext: "{{Infobox Character\n|hair=silver\n|eye=violet\n}}\nElara wears a travel cloak and speaks formally and precisely.",
          },
        }),
      };
    }
    if (url.includes("localhost:11434")) {
      const body = JSON.parse(options.body);
      assert.match(body.messages[1].content, /hair=silver/, "raw wiki extract is forwarded to the LLM");
      return ollamaResponse({
        hair_color: "silver", eye_color: "violet", build: null, age: null,
        outfit: "travel cloak", speech_register: "formal and precise", cadence: null,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const attrs = await enrichCharacter(env, {
    seriesTitle: "Some Series",
    character: { id: "elara", name: "Elara" },
  });
  restoreFetch();

  assert.equal(attrs.hair_color, "silver");
  assert.equal(attrs.eye_color, "violet");
  assert.equal(attrs.build, null);
  assert.equal(attrs.enrichment_source, "fandom");

  const cached = await kv.get(characterEnrichKvKey("Some Series", "Elara"));
  assert.ok(cached, "positive result is cached in KV");
  assert.deepEqual(JSON.parse(cached), attrs);
}

// --- enrichCharacter: cache hit skips every network call --------------------
{
  const kv = fakeKv();
  await kv.put(characterEnrichKvKey("Some Series", "Elara"), JSON.stringify({ hair_color: "silver" }));
  const env = { ...OLLAMA_ENV_BASE, VAE_JOBS: kv };

  mockFetch(async (url) => { throw new Error(`should not fetch on cache hit: ${url}`); });
  const attrs = await enrichCharacter(env, {
    seriesTitle: "Some Series",
    character: { id: "elara", name: "Elara" },
  });
  restoreFetch();
  assert.equal(attrs.hair_color, "silver");
}

// --- enrichCharacter: no source match anywhere -> null + negative cache -----
{
  const kv = fakeKv();
  const env = { ...OLLAMA_ENV_BASE, VAE_JOBS: kv };

  mockFetch(async (url) => {
    if (url.includes(".fandom.com/api.php") && url.includes("meta=siteinfo")) {
      return { ok: false, json: async () => ({}) }; // no guessed domain exists for this title
    }
    if (url.includes("api.jikan.moe")) return { ok: true, json: async () => ({ data: [] }) };
    throw new Error(`unexpected fetch: ${url}`);
  });
  const attrs = await enrichCharacter(env, {
    seriesTitle: "Wholly Original Book",
    character: { id: "zeke", name: "Zeke" },
  });
  restoreFetch();

  assert.equal(attrs, null);
  const cached = await kv.get(characterEnrichKvKey("Wholly Original Book", "Zeke"));
  assert.equal(JSON.parse(cached), null, "negative result is cached too, to avoid re-searching every run");
}

// --- enrichCharacter: placeholder / narrator characters are skipped without any fetch ---
{
  let called = false;
  mockFetch(async () => { called = true; return { ok: true, json: async () => ({}) }; });
  const env = { ...OLLAMA_ENV_BASE, VAE_JOBS: fakeKv() };

  const placeholder = await enrichCharacter(env, {
    seriesTitle: "Series",
    character: { id: "unnamed-male-protagonist", name: "unnamed man" },
  });
  const narrator = await enrichCharacter(env, {
    seriesTitle: "Series",
    character: { id: "narrator", name: "Narrator" },
  });
  restoreFetch();

  assert.equal(placeholder, null);
  assert.equal(narrator, null);
  assert.equal(called, false, "should skip the network entirely for placeholder/narrator characters");
}

// --- voice-assign.js: speech_register/cadence nudge pitch/rate when present ---
{
  const withEnrichment = assignVoices([
    { id: "a", name: "A", gender: "male", cadence: "fast and clipped", speech_register: "deep and gravelly" },
  ]);
  assert.equal(withEnrichment.a.rate, "+8%", "fast/clipped cadence bumps rate up");
  assert.equal(withEnrichment.a.pitch, "-4Hz", "deep/gravelly register nudges pitch down (first male gets no idx offset)");

  const withoutEnrichment = assignVoices([{ id: "b", name: "B", gender: "male" }]);
  assert.equal(withoutEnrichment.b.rate, "+0%", "absent enrichment fields -> unchanged default rate");
  assert.equal(withoutEnrichment.b.pitch, "+0Hz", "absent enrichment fields -> unchanged default pitch");
}

console.log("character-enrich: all assertions passed");
