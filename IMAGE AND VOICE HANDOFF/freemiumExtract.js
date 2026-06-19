/**
 * freemiumExtract.js
 *
 * Extracts structured JSON (characters, scenes, dialogue, etc.) from book text
 * by cascading through free, mostly no-credit-card LLM APIs. Same philosophy as
 * freemiumImageGen.js: try a provider, fall through on failure to the next.
 *
 * This is the FAILSAFE behind Gemini for the EPUB-parsing pipeline. Gemini
 * (Google AI Studio) is the primary; the rest catch overflow when its daily
 * request quota is exhausted during heavy/live testing.
 *
 * ─── Why this is shaped differently from the image module (READ FIRST) ───────
 *
 * 1) CONTEXT WINDOW IS THE BINDING CONSTRAINT, NOT REQUESTS/DAY.
 *    A whole novel is 100k–200k+ tokens. Gemini has a ~1M window so it can eat
 *    huge chunks; the open-weights fallbacks (Cerebras/Groq/Mistral/OpenRouter
 *    free) are ~128k. To make fallback trivial, we CHUNK THE BOOK to fit the
 *    SMALLEST provider in the chain (see chunkText + MAX_CHUNK_TOKENS). Then any
 *    provider can handle any chunk and a throttled chunk just re-runs elsewhere
 *    with no resize logic. DO NOT lean on Gemini's giant window and assume the
 *    fallbacks can swallow the same chunk — they can't.
 *
 * 2) OUTPUT MUST BE VALID JSON OR THE WHOLE PIPELINE BREAKS.
 *    Downstream image/voice steps consume these objects. Open-weights models
 *    emit malformed JSON more often than Gemini. So every call goes through a
 *    parse-and-repair rung: strip code fences, attempt parse, and if it fails,
 *    fall through to the next provider (a different model often fixes it).
 *
 * 3) CONSISTENCY: different models extract differently (one splits a scene
 *    another merges; "the old man" vs "Aldric"). For coherent objects, PIN a
 *    book to one provider and only fall through on hard quota exhaustion, rather
 *    than round-robining mid-book. Use options.preferProvider for this.
 *
 * 4) PRIVACY/COPYRIGHT NOTE (not a code constraint, a heads-up): no-card free
 *    tiers are typically funded by training on your inputs. Parsing PUBLISHED
 *    copyrighted books means sending copyrighted text through training-enabled
 *    endpoints. Cerebras/Groq have not stated input-training policies (a point
 *    in their favor here); Google trains on prompts outside the EU/UK/EEA. This
 *    is a product/legal decision for the app owner, surfaced here for awareness.
 *
 * ─── Provider chain (default order, tuned for batch book parsing) ────────────
 *    1. gemini    Google AI Studio, Gemini 2.5 Flash  — ~1M ctx, ~1500 req/day, best JSON
 *    2. cerebras  open-weights                        — ~1M tokens/DAY, best sustained batch volume
 *    3. groq      llama-3.3-70b-versatile             — very fast, but ~100K tokens/day (small) → fast topper
 *    4. mistral   Mistral Small                       — prototyping tier, no card
 *    5. openrouter:free models                        — variety/tail; free availability changes w/o notice
 *
 * ─── Keys / config (server-side only — never ship to a browser) ──────────────
 *    GEMINI_API_KEY        (aistudio.google.com)
 *    CEREBRAS_API_KEY      (cloud.cerebras.ai)
 *    GROQ_API_KEY          (console.groq.com)
 *    MISTRAL_API_KEY       (console.mistral.ai)
 *    OPENROUTER_API_KEY    (openrouter.ai)
 * Any provider whose key is missing is auto-skipped, so a subset works fine.
 *
 * ─── Integration notes (Claude Code / Cursor) ───────────────────────────────
 *  - Pure-ish: only does HTTP via fetch. No SDK deps. All five providers are
 *    called over their OpenAI-compatible /chat/completions endpoints (Gemini via
 *    its OpenAI-compat shim) so the per-provider code is near-identical.
 *  - Token counting here is a cheap CHAR-BASED ESTIMATE (chars/4). Good enough
 *    for chunk sizing. If you need exactness, swap estimateTokens() for a real
 *    tokenizer (e.g. tiktoken/js-tiktoken). Marked TODO.
 *  - chunkText() splits on paragraph/sentence boundaries to keep scenes intact.
 *    For EPUBs, parse to plain text per chapter FIRST (e.g. epub2/epub.js), then
 *    feed each chapter here; chunkText further subdivides if a chapter is huge.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const CONFIG = {
  geminiKey: process.env.GEMINI_API_KEY,
  cerebrasKey: process.env.CEREBRAS_API_KEY,
  groqKey: process.env.GROQ_API_KEY,
  mistralKey: process.env.MISTRAL_API_KEY,
  openrouterKey: process.env.OPENROUTER_API_KEY,
};

// Per-call timeout. Extraction calls are heavier than image calls; allow more.
const PER_PROVIDER_TIMEOUT_MS = 90_000;

// Size chunks to fit the SMALLEST provider window in the chain (~128k) with
// generous headroom for the prompt + the model's own output. Conservative on
// purpose so fallback never chokes. Tune up if you drop the small-window
// providers from your chain.
const MAX_CHUNK_TOKENS = 24_000;

// Cheap token estimate. TODO: replace with a real tokenizer for precision.
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = PER_PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── JSON parse + repair ──────────────────────────────────────────────────────
// Models love to wrap JSON in ```json fences or add a preamble. Strip and parse.
// Returns the parsed object/array, or throws (which triggers provider fallthrough).
function parseModelJson(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('empty model response');
  }
  let s = raw.trim();

  // Strip markdown code fences if present.
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(s);
  if (fence) s = fence[1].trim();

  // If there's leading/trailing prose, grab the outermost JSON object or array.
  if (!(s.startsWith('{') || s.startsWith('['))) {
    const firstObj = s.indexOf('{');
    const firstArr = s.indexOf('[');
    const start =
      firstArr === -1 ? firstObj : firstObj === -1 ? firstArr : Math.min(firstObj, firstArr);
    if (start !== -1) {
      const lastObj = s.lastIndexOf('}');
      const lastArr = s.lastIndexOf(']');
      const end = Math.max(lastObj, lastArr);
      if (end > start) s = s.slice(start, end + 1);
    }
  }

  try {
    return JSON.parse(s);
  } catch (e) {
    // One light repair pass: remove trailing commas before } or ].
    const repaired = s.replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(repaired); // if this still throws, caller falls through
  }
}

// ── Generic OpenAI-compatible chat call ──────────────────────────────────────
// All providers below share this; they differ only in base URL + model + key.
async function openAICompatibleExtract({ baseUrl, apiKey, model, providerId, systemPrompt, userText, jsonMode }) {
  if (!apiKey) throw new Error(`${providerId}: missing API key (skipped)`);

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
    temperature: 0.2, // low — extraction wants determinism, not creativity
  };
  // Ask for JSON object mode where supported (Gemini, Groq, Mistral, OpenRouter
  // mostly honor this; harmless where ignored since we also repair).
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // 429 = rate/quota; 413/400 = too big for this model's window. Both fall through.
    throw new Error(`${providerId}: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${providerId}: no content in response`);

  const parsed = parseModelJson(content); // throws on unrepairable JSON
  return { provider: providerId, model, data: parsed };
}

// ── Provider implementations (thin wrappers over the generic call) ───────────
function tryGemini(systemPrompt, userText) {
  return openAICompatibleExtract({
    providerId: 'gemini',
    // Gemini's OpenAI-compatibility endpoint:
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: CONFIG.geminiKey,
    model: 'gemini-2.5-flash',
    systemPrompt,
    userText,
    jsonMode: true,
  });
}

function tryCerebras(systemPrompt, userText) {
  return openAICompatibleExtract({
    providerId: 'cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKey: CONFIG.cerebrasKey,
    // TODO: confirm current free model id (e.g. 'llama-3.3-70b' / 'qwen-3-...').
    model: 'llama-3.3-70b',
    systemPrompt,
    userText,
    jsonMode: true,
  });
}

function tryGroq(systemPrompt, userText) {
  return openAICompatibleExtract({
    providerId: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: CONFIG.groqKey,
    model: 'llama-3.3-70b-versatile',
    systemPrompt,
    userText,
    jsonMode: true,
  });
}

function tryMistral(systemPrompt, userText) {
  return openAICompatibleExtract({
    providerId: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKey: CONFIG.mistralKey,
    model: 'mistral-small-latest',
    systemPrompt,
    userText,
    jsonMode: true,
  });
}

function tryOpenRouter(systemPrompt, userText) {
  return openAICompatibleExtract({
    providerId: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: CONFIG.openrouterKey,
    // TODO: pick a current ":free" model; free availability changes w/o notice.
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    systemPrompt,
    userText,
    jsonMode: true,
  });
}

// Provider registry + default ordering (tuned for batch book parsing).
const PROVIDERS = {
  gemini: tryGemini,
  cerebras: tryCerebras,
  groq: tryGroq,
  mistral: tryMistral,
  openrouter: tryOpenRouter,
};

const DEFAULT_CHAIN = ['gemini', 'cerebras', 'groq', 'mistral', 'openrouter'];

function buildChain(preferProvider) {
  if (preferProvider && PROVIDERS[preferProvider]) {
    return [preferProvider, ...DEFAULT_CHAIN.filter((id) => id !== preferProvider)];
  }
  return [...DEFAULT_CHAIN];
}

// ── Default extraction prompt ────────────────────────────────────────────────
// Override via options.systemPrompt to change the schema. Keep it strict about
// "JSON only" — that plus parseModelJson keeps downstream steps safe.
const DEFAULT_SYSTEM_PROMPT = `You are a literary extraction engine. From the provided book text, extract structured data and respond with a SINGLE valid JSON object and NOTHING else — no markdown, no commentary, no code fences.

Use exactly this shape:
{
  "characters": [
    { "name": string, "aliases": string[], "description": string, "traits": string[] }
  ],
  "scenes": [
    { "id": string, "summary": string, "setting": string, "environment": "open"|"indoor"|"hall"|"cave"|string, "characters": string[] }
  ],
  "dialogue": [
    { "character": string, "text": string, "expression": "normal"|"whisper"|"yell"|"sad"|"angry"|string, "intensity": number, "sceneId": string }
  ]
}

Rules:
- Resolve pronouns/epithets to a canonical character name where possible; list variants in "aliases".
- Infer "expression" and "intensity" (0..1) from punctuation, capitalization, and narration cues ("she screamed" -> yell ~0.9; "he muttered" -> whisper ~0.4).
- Infer "environment" from the setting when stated (a cave/cavern -> "cave").
- If a field is unknown, use an empty string/array or 0; never omit keys.
- Output JSON only.`;

/**
 * freemiumExtract(text, options)
 *
 * Extracts structured JSON from ONE chunk of book text. Tries providers in order
 * (optionally pinned), repairs/validates JSON, returns the first success.
 *
 * For a whole book: chunk with chunkText(), then call this per chunk — ideally
 * pinning the whole book to one provider via options.preferProvider for
 * consistency, and merging the per-chunk results yourself (see mergeExtractions
 * for a starting point).
 *
 * @param {string} text                 a chunk of book text (<= MAX_CHUNK_TOKENS)
 * @param {object} [options]
 * @param {string} [options.systemPrompt]   override the extraction schema/prompt
 * @param {string} [options.preferProvider] 'gemini'|'cerebras'|'groq'|'mistral'|'openrouter'
 *        Tried first; rest remain as fallback. Use to pin a book to one model.
 * @returns {Promise<{provider, model, data:object}>}
 * @throws {AggregateError} if all providers fail (quota/JSON/size)
 */
async function freemiumExtract(text, options = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('freemiumExtract: text must be a non-empty string');
  }
  const systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const chain = buildChain(options.preferProvider);

  // Soft guard: warn (don't block) if the chunk likely overflows small windows.
  const est = estimateTokens(text);
  if (est > MAX_CHUNK_TOKENS) {
    console.warn(
      `[freemiumExtract] chunk ~${est} tokens exceeds MAX_CHUNK_TOKENS ` +
      `(${MAX_CHUNK_TOKENS}); small-window providers may reject it. Consider chunkText().`
    );
  }

  const failures = [];
  for (const id of chain) {
    try {
      const result = await PROVIDERS[id](systemPrompt, text);
      console.info(
        `[freemiumExtract] extracted via ${result.provider} (${result.model})` +
        `${options.preferProvider ? ` preferred=${options.preferProvider}` : ''}`
      );
      return result;
    } catch (err) {
      console.warn(`[freemiumExtract] ${err.message}`);
      failures.push(err);
    }
  }
  throw new AggregateError(failures, 'freemiumExtract: all providers failed');
}

// ── EPUB / long-text chunking helper ─────────────────────────────────────────
/**
 * chunkText(text, maxTokens)
 *
 * Splits long text into chunks under maxTokens, preferring paragraph then
 * sentence boundaries so scenes/dialogue aren't cut mid-thought. Feed it plain
 * text (parse the EPUB to text per chapter first).
 *
 * @param {string} text
 * @param {number} [maxTokens=MAX_CHUNK_TOKENS]
 * @returns {string[]}
 */
function chunkText(text, maxTokens = MAX_CHUNK_TOKENS) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const maxChars = maxTokens * 4; // mirror estimateTokens()
  if (text.length <= maxChars) return [text.trim()];

  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let current = '';

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length <= maxChars) {
      current = current ? `${current}\n\n${para}` : para;
      continue;
    }
    // Current is full; flush it.
    pushCurrent();

    if (para.length <= maxChars) {
      current = para;
    } else {
      // Paragraph itself too big: split on sentence boundaries.
      const sentences = para.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [para];
      for (const sent of sentences) {
        if ((current + sent).length <= maxChars) {
          current += sent;
        } else {
          pushCurrent();
          // Hard-cut a single monster sentence as a last resort.
          if (sent.length > maxChars) {
            for (let i = 0; i < sent.length; i += maxChars) {
              chunks.push(sent.slice(i, i + maxChars).trim());
            }
            current = '';
          } else {
            current = sent;
          }
        }
      }
    }
  }
  pushCurrent();
  return chunks;
}

// ── Optional: merge per-chunk extractions into one book object ────────────────
/**
 * mergeExtractions(results)
 *
 * Naive merge of multiple freemiumExtract().data objects into one. De-dupes
 * characters by lowercased name (merging aliases/traits); concatenates scenes
 * and dialogue. STARTING POINT — your app may want smarter character-coref
 * merging (e.g. matching aliases across chunks). Marked accordingly.
 *
 * @param {Array<{characters?:any[],scenes?:any[],dialogue?:any[]}>} dataObjects
 * @returns {{characters:any[], scenes:any[], dialogue:any[]}}
 */
function mergeExtractions(dataObjects) {
  const charByName = new Map();
  const scenes = [];
  const dialogue = [];

  for (const d of dataObjects) {
    if (!d) continue;
    for (const c of d.characters || []) {
      const key = (c.name || '').toLowerCase().trim();
      if (!key) continue;
      if (!charByName.has(key)) {
        charByName.set(key, {
          name: c.name,
          aliases: [...(c.aliases || [])],
          description: c.description || '',
          traits: [...(c.traits || [])],
        });
      } else {
        const ex = charByName.get(key);
        ex.aliases = Array.from(new Set([...ex.aliases, ...(c.aliases || [])]));
        ex.traits = Array.from(new Set([...ex.traits, ...(c.traits || [])]));
        // Keep the longer description as the richer one.
        if ((c.description || '').length > ex.description.length) ex.description = c.description;
      }
    }
    for (const s of d.scenes || []) scenes.push(s);
    for (const line of d.dialogue || []) dialogue.push(line);
  }

  return { characters: [...charByName.values()], scenes, dialogue };
}

// ── Example usage ────────────────────────────────────────────────────────────
// (async () => {
//   const fs = require('fs');
//   const bookText = fs.readFileSync('chapter1.txt', 'utf8'); // EPUB -> text upstream
//   const chunks = chunkText(bookText);
//
//   // Pin the whole book to one provider for consistency; fall through only on
//   // hard failure. First successful provider becomes the pin.
//   let pin;
//   const results = [];
//   for (const chunk of chunks) {
//     const r = await freemiumExtract(chunk, { preferProvider: pin });
//     pin = pin || r.provider;          // lock to whoever served chunk 1
//     results.push(r.data);
//   }
//   const book = mergeExtractions(results);
//   fs.writeFileSync('book.json', JSON.stringify(book, null, 2));
// })();

module.exports = {
  freemiumExtract,
  chunkText,
  mergeExtractions,
  parseModelJson,
  estimateTokens,
  buildChain,
  PROVIDERS,
  DEFAULT_CHAIN,
  DEFAULT_SYSTEM_PROMPT,
  MAX_CHUNK_TOKENS,
};
