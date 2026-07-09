/**
 * Freemium LLM cascade for book extract on the edge (mirrors server/analyze/freemium_extract.py).
 */
import { SYSTEM, SCHEMA_HINT, buildSystemPrompt } from "./extract-prompt.js";
import { resolvedExtractProviders } from "./pipeline-registry.js";
import { chunkTextByChapters, chunkChaptersStrict } from "./epub-text.js";
import { runOrderedDrain } from "./ordered-drain.js";
import { reconcileChapterCharacters } from "./character-reconcile.js";
import {
  getRawChapterExtract, putRawChapterExtract, deleteRawChapterExtract,
} from "./book-checkpoint.js";

const PER_PROVIDER_TIMEOUT_MS = 90_000;
// Groq's free tier caps at 12k tokens/minute per request; Cloudflare Workers AI
// truncates long JSON responses. Keep chunks well under both ceilings.
// Also lower for local Ollama: an oversized chapter (~57k chars, ~5x a normal
// chapter) produced a ~16k-char chunk that hung the local 7B model indefinitely
// (near num_ctx, plus a long fully-verbatim structured JSON output demanded of
// it) — smaller chunks keep every single call comfortably inside safe bounds.
const MAX_CHUNK_TOKENS = 2000;

// EXTRACT_CHUNK_MAX_TOKENS (documented in .env.example, referenced in
// docs/LOCAL_LLM_EXTRACTION.md's troubleshooting table) — was never actually
// wired to anything; MAX_CHUNK_TOKENS above was a dead-hardcoded constant.
// Smaller chunks mean more, faster round-trips per chapter — more frequent
// onProgress ticks (chunk N/M) instead of one slow local-model call sitting
// silent for many minutes with zero visible progress. Character continuity
// across chunks is untouched by this either way: extractChapterRaw's
// chapterKnown list is threaded into every chunk's prompt regardless of how
// many chunks a chapter is split into. What *does* trade off: each chunk is
// extracted independently with no visibility into neighboring chunks' prose
// (only the character roster carries over) — a scene that happens to
// straddle a chunk boundary can come back as two partial scene entries
// instead of one. Smaller chunks raise how often that can happen.
export function resolveMaxChunkTokens(env) {
  const n = Number(env?.EXTRACT_CHUNK_MAX_TOKENS);
  return Number.isFinite(n) && n > 0 ? n : MAX_CHUNK_TOKENS;
}

const PROVIDER_MODELS = {
  gemini: "gemini-2.5-flash",
  cerebras: "gpt-oss-120b",
  groq: "llama-3.3-70b-versatile",
  mistral: "mistral-small-latest",
  openrouter: "meta-llama/llama-3.3-70b-instruct:free",
  cloudflare: "@cf/meta/llama-3.1-8b-instruct",
  "ollama-7b": "qwen2.5:7b",
  "ollama-20b": "gpt-oss:20b",
  "ollama-30b": "qwen3:30b-a3b",
  "ollama-14b": "qwen2.5:14b",
  "mlx-30b": "mlx-community/Qwen3-30B-A3B-4bit",
};

const PROVIDER_URLS = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  cerebras: "https://api.cerebras.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

// Repairs the most common LLM JSON-generation quirk: a literal, unescaped
// `"` inside a string value (usually nested quotation/dialogue) that
// prematurely closes the string. Walks the text tracking string/escape
// state; a `"` while inside a string is only treated as the real closing
// quote when what follows (after whitespace) looks like valid JSON
// continuation (`,`, `}`, `]`, `:`, or end-of-input) — otherwise it's
// escaped in place and the string is kept open.
function escapeStrayQuotes(s) {
  let out = "";
  let inString = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (ch === "\\") {
      out += ch + (s[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j += 1;
      const next = s[j];
      // `"` is also a valid continuation: the far more common cause of a
      // string immediately followed by another quote is a real close with
      // a forgotten comma (e.g. `"id": "s1" "title": ...`), not a nested
      // literal quote — insertCommaAtPosition (below) patches that gap.
      if (next === undefined || ',}]:"'.includes(next)) {
        out += ch;
        inString = false;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function errorPosition(err) {
  const m = /position (\d+)/.exec(err?.message || "");
  return m ? Number(m[1]) : null;
}

// V8's "Expected ',' or '}' after property value" / "Expected ',' or ']'
// after array element" errors name the exact offset where a separator was
// required and missing — not always caused by a stray quote (escapeStrayQuotes
// is a no-op when there's genuinely no misplaced quote to fix, just a comma
// the model forgot). Safe to patch directly: insert the missing comma at
// that offset and re-parse.
const MISSING_SEPARATOR_RE = /after (?:property value|array element)/;

function insertCommaAtPosition(s, pos) {
  // A missing-separator error whose position lands at (or past) the very
  // end of the string isn't a gap to fill with a comma — it's truncation
  // (see closeTruncatedJson below). Inserting a trailing comma there can
  // never produce valid JSON, so don't waste a repair round on it.
  if (pos == null || pos < 0 || pos >= s.length) return null;
  return `${s.slice(0, pos)},${s.slice(pos)}`;
}

// String/bracket-aware scan shared by closeTruncatedJson: tracks the open
// `{`/`[` stack, whether we're currently inside a string (and where that
// string started), and the last "safe" cut point — right after a comma or
// an opening bracket, i.e. right before a new element/property began.
function scanJsonStructure(str) {
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let lastSafeCut = -1;
  const stack = [];
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; stringStart = i; continue; }
    if (ch === "{" || ch === "[") { stack.push(ch); lastSafeCut = i + 1; continue; }
    if (ch === "}" && stack[stack.length - 1] === "{") { stack.pop(); continue; }
    if (ch === "]" && stack[stack.length - 1] === "[") { stack.pop(); continue; }
    if (ch === ",") lastSafeCut = i + 1;
  }
  return {
    stack, inString, stringStart, lastSafeCut,
  };
}

function closeStack(str, stack) {
  let out = str;
  for (let i = stack.length - 1; i >= 0; i -= 1) out += stack[i] === "{" ? "}" : "]";
  return out;
}

// Local generation can also simply run out of context/tokens before the
// JSON structure finishes — no misplaced character anywhere, just missing
// closing brackets at the end (the telltale sign: JSON.parse's error
// position lands exactly at the string's length, confirmed against
// synthetic cases like `JSON.parse('{"a":"x","b":[1,2]')`, which reports
// the identical "Expected ',' or '}' after property value" message). Only
// this class of error should reach here — the comma-insertion loop above
// already handles a genuinely missing separator mid-string. Recovered by
// finding what's still open and closing it; a dangling partial key/value
// the cutoff landed inside gets dropped rather than guessed at.
function closeTruncatedJson(s) {
  const full = scanJsonStructure(s);
  if (!full.stack.length && !full.inString) return null;

  let base = full.inString ? s.slice(0, full.stringStart) : s;
  base = base.replace(/\s+$/, "").replace(/,\s*$/, "");
  const baseStack = full.inString ? scanJsonStructure(base).stack : full.stack;
  if (baseStack.length) {
    const candidate = closeStack(base, baseStack);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch { /* fall through to a further-back cut */ }
  }

  if (full.lastSafeCut < 0) return null;
  const fallbackBase = s.slice(0, full.lastSafeCut).replace(/\s+$/, "").replace(/,\s*$/, "");
  const fallbackStack = scanJsonStructure(fallbackBase).stack;
  if (!fallbackStack.length) return null;
  const fallbackCandidate = closeStack(fallbackBase, fallbackStack);
  try {
    JSON.parse(fallbackCandidate);
    return fallbackCandidate;
  } catch {
    return null;
  }
}

// Context around a JSON parse failure — the "problematic line and the
// adjacent lines" callers log so a human can confirm the repair didn't
// mangle neighboring content, not just that JSON.parse stopped complaining.
function snippetAround(s, pos, radius = 300) {
  if (pos == null) return null;
  const start = Math.max(0, pos - radius);
  const end = Math.min(s.length, pos + radius);
  return s.slice(start, end);
}

// Shared by every provider's extract call: parses the model's raw content
// and, when the stray-quote repair kicked in, logs the provider/model plus
// a snippet of the surrounding text so the repaired line and its neighbors
// can be manually checked rather than silently trusted.
function fromModelContent(providerId, model, content) {
  if (!content) throw new Error(`${providerId}: no content in response`);
  const { data, repaired, snippet } = parseModelJson(content);
  if (repaired) {
    console.warn(
      `freemium extract ${providerId}/${model}: repaired malformed JSON (stray quote, missing separator, and/or truncated response) — review this text and its neighbors:\n${snippet}`,
    );
  }
  return {
    provider: providerId, model, data, repaired, repairSnippet: snippet,
  };
}

export function parseModelJson(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("empty model response");
  let s = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(s);
  if (fence) s = fence[1].trim();
  if (!(s.startsWith("{") || s.startsWith("["))) {
    const firstObj = s.indexOf("{");
    const firstArr = s.indexOf("[");
    const start = firstArr === -1 ? firstObj : firstObj === -1 ? firstArr : Math.min(firstObj, firstArr);
    if (start !== -1) {
      const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
      if (end > start) s = s.slice(start, end + 1);
    }
  }
  try {
    return { data: JSON.parse(s), repaired: false };
  } catch (firstErr) {
    try {
      return { data: JSON.parse(s.replace(/,(\s*[}\]])/g, "$1")), repaired: false };
    } catch {
      // Escape stray quotes once, then iteratively patch any remaining
      // "expected , after ..." gaps by inserting a comma at the exact spot
      // JSON.parse names — a single dense chunk can have more than one
      // broken spot, so keep going while the parser keeps naming new ones.
      let candidate = escapeStrayQuotes(s);
      for (let round = 0; round < 5; round += 1) {
        try {
          const data = JSON.parse(candidate.replace(/,(\s*[}\]])/g, "$1"));
          return { data, repaired: true, snippet: snippetAround(s, errorPosition(firstErr)) };
        } catch (err) {
          const pos = MISSING_SEPARATOR_RE.test(err.message) ? errorPosition(err) : null;
          const patched = insertCommaAtPosition(candidate, pos);
          if (!patched) break;
          candidate = patched;
        }
      }

      // Comma-insertion couldn't converge — likely because the response
      // was truncated (generation cut off mid-structure) rather than
      // missing a single separator. Close whatever's still open instead.
      const closed = closeTruncatedJson(candidate) || closeTruncatedJson(s);
      if (closed) {
        try {
          const data = JSON.parse(closed.replace(/,(\s*[}\]])/g, "$1"));
          return { data, repaired: true, snippet: snippetAround(s, errorPosition(firstErr)) };
        } catch { /* genuinely unrecoverable — fall through */ }
      }

      throw firstErr;
    }
  }
}

export function buildSystemPromptLegacy() {
  return buildSystemPrompt();
}

function formatKnownCharacters(knownCharacters) {
  if (!knownCharacters?.length) return "";
  const rows = knownCharacters.slice(0, 40).map((c) => {
    const aliases = c.aliases?.length ? ` aka [${c.aliases.join(", ")}]` : "";
    const desc = c.description ? ` — ${c.description.slice(0, 100)}` : "";
    return `  - id=${c.id} name=${c.name || c.id}${aliases}${desc}`;
  });
  return `\nKNOWN CHARACTERS (already identified elsewhere in this book — reuse these ids for matches, see rules):\n${rows.join("\n")}\n`;
}

function formatIllustrationsNearby(illustrationsNearby) {
  if (!illustrationsNearby?.length) return "";
  const rows = illustrationsNearby.slice(0, 20).map((p) => {
    const ctx = p.textContext ? p.textContext.slice(0, 160) : "";
    return `  - index=${p.index}${ctx ? `: "${ctx}"` : ""}`;
  });
  return `\nILLUSTRATION PLATES near this chapter (set illustration_ref to the matching index on a character or scene ONLY when the plate's nearby text clearly matches something you're extracting — do not guess):\n${rows.join("\n")}\n`;
}

// Mirrors formatKnownCharacters' role, but for scene continuity across a
// chunk boundary — see the SCENE_CONTINUES rule in dialogue-rules.js. Smaller
// EXTRACT_CHUNK_MAX_TOKENS values (more, smaller chunks) make chunk-boundary
// scene splits more frequent, so this note is what lets the model stitch a
// scene back together across chunks instead of it landing as two separate
// partial scenes in the output.
function formatOpenScene(openScene) {
  if (!openScene) return "";
  const present = openScene.present_character_ids?.length
    ? openScene.present_character_ids.join(", ")
    : "none listed";
  return (
    `\nOPEN SCENE FROM PREVIOUS CHUNK (cut off mid-scene by the chunk boundary, ` +
    `not a real scene end): id=${openScene.id}, location=${JSON.stringify(openScene.location || "")}, ` +
    `title=${JSON.stringify(openScene.title || "")}, characters present=[${present}].\n` +
    `Continue this EXACT scene id as the first scene in your output — do not start a ` +
    `new scene for the same moment. Set "scene_continues": true on it again only if ` +
    `it's still not resolved by the end of this excerpt.\n`
  );
}

export function buildUserPrompt(
  book_id, title, author, body_text, chunkIndex, chunkTotal, knownCharacters, illustrationsNearby, openScene,
) {
  const chunkNote =
    chunkIndex != null && chunkTotal > 1
      ? `\nNOTE: chunk ${chunkIndex + 1} of ${chunkTotal}. Extract only this chunk; stable character ids. Respect ## Chapter N headers — scenes in this chunk must use matching chapter numbers.\n`
      : "";
  const knownNote = formatKnownCharacters(knownCharacters);
  const illustrationNote = formatIllustrationsNearby(illustrationsNearby);
  const openSceneNote = formatOpenScene(openScene);
  return `book_id = ${JSON.stringify(book_id)}; title = ${JSON.stringify(title)}; author = ${JSON.stringify(author)}.${chunkNote}${knownNote}${illustrationNote}${openSceneNote}\n\nBOOK TEXT START\n${body_text}\nBOOK TEXT END\n`;
}

function keysFromEnv(env) {
  return {
    gemini: env.GEMINI_API_KEY,
    cerebras: env.CEREBRAS_API_KEY,
    groq: env.GROQ_API_KEY,
    mistral: env.MISTRAL_API_KEY,
    openrouter: env.OPENROUTER_API_KEY,
    cloudflare_account: env.CLOUDFLARE_ACCOUNT_ID,
    cloudflare_token: env.CLOUDFLARE_API_TOKEN,
  };
}

async function fetchWithTimeout(url, options, timeoutMs = PER_PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function openAICompatibleExtract({
  providerId, baseUrl, apiKey, model, systemPrompt, userText, temperature = 0.2,
}) {
  if (!apiKey) throw new Error(`${providerId}: missing API key (skipped)`);
  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
      temperature,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${providerId}: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  return fromModelContent(providerId, model, content);
}

// Ollama's OpenAI-compat endpoint doesn't expose num_ctx, and its default
// (4096) is smaller than our chunk + prompt + JSON output easily needs — use
// the native API so we can size the context window to the model's real limit.
//
// 16384 was sized for the original EXTRACT_CHUNK_MAX_TOKENS=2000 default — a
// generous ceiling, never precisely tuned, just big enough not to worry
// about. A smaller chunk budget doesn't need nearly as much: measured
// system prompt + rules is ~2800 tokens, so an 800-token chunk's real input
// is ~4000 tokens total, a fraction of 16384. A larger context window means
// more KV-cache for Ollama to compute attention over on every single
// generation step, real overhead independent of the model's own speed.
// Scales with the resolved chunk budget at the same ~8x ratio the fixed
// 16384/2000 pairing already proved safe at (this is exactly the kind of
// value that's dangerous to under-size — too little and long dialogue-dense
// output truncates mid-JSON, which reads as a hang from the outside; see
// the num_predict history below). OLLAMA_NUM_CTX itself can still override
// this directly if the computed value turns out wrong for a given book.
const OLLAMA_NUM_CTX_FLOOR = 4096;
const OLLAMA_NUM_CTX_CHUNK_RATIO = 8;
export function resolveOllamaNumCtx(env) {
  const override = Number(env?.OLLAMA_NUM_CTX);
  if (Number.isFinite(override) && override > 0) return override;
  return Math.max(OLLAMA_NUM_CTX_FLOOR, resolveMaxChunkTokens(env) * OLLAMA_NUM_CTX_CHUNK_RATIO);
}
// NOTE: deliberately no num_predict cap. A 6000-token cap was tried here to
// guard against a suspected repetition-loop hang, but real dense chunks
// legitimately need more than that — the cap was silently truncating valid
// output mid-JSON-string (parseModelJson then throws "Unterminated string"),
// which looked identical to a hang from the outside (endless retries on the
// same chunk). The original "hang" this was meant to fix turned out to be
// ordinary slow generation (confirmed via Ollama's own token-by-token log
// ticking up steadily, never stalling) — not a runaway loop — so there's
// nothing here that actually needs bounding.
// Measured ~83s for a synthetic 5k-token prompt on a local 14B model, but real
// dialogue-dense chunks generate far more output tokens and blew past 280s.
// Local inference has no rate limit to race against, so give it lots of room.
// Bumped further after concurrency=5 runs showed requests getting cut off
// well before 600s — GPU contention across concurrent chapters slows each
// individual generation down, not just queues them.
const OLLAMA_TIMEOUT_MS = 1_200_000;

async function ollamaExtract({
  providerId, baseUrl, model, systemPrompt, userText, temperature = 0.2, accessHeaders, numCtx,
}) {
  const res = await fetchWithTimeout(
    `${baseUrl}/api/chat`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...accessHeaders },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText },
        ],
        format: "json",
        stream: false,
        // Hybrid-reasoning models (qwen3 family included — confirmed via
        // /api/show's capabilities list) generate a hidden chain-of-thought
        // before the actual answer unless told not to. That reasoning is
        // pure overhead for a structured-extraction task (we only want the
        // JSON), and its length doesn't scale down with a smaller input
        // chunk — a single chunk sat generating for 3+ minutes even at 800
        // input tokens, independent of EXTRACT_CHUNK_MAX_TOKENS. Ollama
        // silently ignores `think` for models that don't support it, so
        // this is safe to send unconditionally.
        think: false,
        options: { temperature, num_ctx: numCtx ?? OLLAMA_NUM_CTX_FLOOR },
      }),
    },
    OLLAMA_TIMEOUT_MS,
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${providerId}: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.message?.content;
  return fromModelContent(providerId, model, content);
}

// MLX (mlx_lm.server) is an additive, Apple-Silicon-only local backend — see
// docs/LOCAL_LLM_EXTRACTION.md's "MLX: tested as an alternative runtime"
// section. It speaks the same OpenAI-compatible /chat/completions shape as
// openAICompatibleExtract() above, but needs no real API key (a local server,
// like Ollama, doesn't validate the Authorization header) and the same long,
// no-rate-limit timeout Ollama gets above — local inference on a
// consumer GPU/CPU is slow but never actually hangs.
async function mlxExtract({
  providerId, baseUrl, model, systemPrompt, userText, temperature = 0.2, accessHeaders,
}) {
  const res = await fetchWithTimeout(
    `${baseUrl}/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json", authorization: "Bearer not-needed", ...accessHeaders,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText },
        ],
        temperature,
        response_format: { type: "json_object" },
      }),
    },
    OLLAMA_TIMEOUT_MS,
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${providerId}: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  return fromModelContent(providerId, model, content);
}

async function cloudflareExtract({
  accountId, token, model, systemPrompt, userText, temperature = 0.2,
}) {
  if (!accountId || !token) throw new Error("cloudflare: missing account id or token (skipped)");
  const modelId = envCloudflareModel(model);
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
      max_tokens: 8192,
      temperature,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`cloudflare: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.errors?.length) throw new Error(`cloudflare: ${JSON.stringify(data.errors).slice(0, 200)}`);
  const result = data.result || {};
  const content = result.response || result.text || result.message?.content || "";
  return fromModelContent("cloudflare", modelId, content);
}

function envCloudflareModel(model) {
  return model.startsWith("@cf/") ? model : `@cf/${model.replace(/^@cf\//, "")}`;
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// An explicit provider choice (vs "auto") is a hard pin: never fall through
// to other providers/APIs, even on failure. Since there's no fallback to
// absorb a transient hiccup, retry the pinned provider itself a few times
// with backoff before giving up.
const PINNED_RETRY_ATTEMPTS = 3;
const PINNED_RETRY_BACKOFF_MS = 5_000;

// Ollama/MLX are localhost-only in dev, but may be reached through a
// Cloudflare Tunnel (see docs/LOCAL_LLM_EXTRACTION.md) when the worker is
// deployed to Workers instead of run via `wrangler dev` on the same box as
// the model server. The tunnel hostname sits behind a Cloudflare Access
// Service Auth policy, so requests need these two headers — harmless no-ops
// against a bare localhost target, required against the tunnel.
function cfAccessHeaders(env) {
  if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) return undefined;
  return {
    "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
  };
}

async function callProvider(pid, {
  cfg, env, systemPrompt, userText, temperature,
}) {
  if (pid === "cloudflare") {
    return cloudflareExtract({
      accountId: cfg.cloudflare_account,
      token: cfg.cloudflare_token,
      model: env.CLOUDFLARE_EXTRACT_MODEL || PROVIDER_MODELS.cloudflare,
      systemPrompt,
      userText,
      temperature,
    });
  }
  if (pid === "gemini") {
    return openAICompatibleExtract({
      providerId: "gemini",
      baseUrl: PROVIDER_URLS.gemini,
      apiKey: cfg.gemini,
      model: env.GEMINI_MODEL || PROVIDER_MODELS.gemini,
      systemPrompt,
      userText,
      temperature,
    });
  }
  if (pid === "ollama-7b" || pid === "ollama-20b" || pid === "ollama-30b" || pid === "ollama-14b") {
    const base = (env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
    const modelEnvKey = {
      "ollama-7b": "OLLAMA_MODEL_7B",
      "ollama-20b": "OLLAMA_MODEL_20B",
      "ollama-30b": "OLLAMA_MODEL_30B",
      "ollama-14b": "OLLAMA_MODEL_14B",
    }[pid];
    return ollamaExtract({
      providerId: pid,
      baseUrl: base,
      model: env[modelEnvKey] || PROVIDER_MODELS[pid],
      systemPrompt,
      userText,
      temperature,
      accessHeaders: cfAccessHeaders(env),
      numCtx: resolveOllamaNumCtx(env),
    });
  }
  if (pid === "mlx-30b") {
    const base = (env.MLX_BASE_URL || "http://localhost:8081").replace(/\/$/, "");
    return mlxExtract({
      providerId: pid,
      baseUrl: base,
      model: env.MLX_MODEL_30B || PROVIDER_MODELS[pid],
      systemPrompt,
      userText,
      temperature,
      accessHeaders: cfAccessHeaders(env),
    });
  }
  return openAICompatibleExtract({
    providerId: pid,
    baseUrl: PROVIDER_URLS[pid],
    apiKey: cfg[pid],
    model: env[`${pid.toUpperCase()}_EXTRACT_MODEL`] || PROVIDER_MODELS[pid],
    systemPrompt,
    userText,
    temperature,
  });
}

export async function freemiumExtract(userText, {
  systemPrompt, preferProvider, preferProviderSoft, env, temperature,
}) {
  const cfg = keysFromEnv(env);
  const pinned = Boolean(preferProvider);
  // preferProviderSoft moves a stage to the front of the auto chain (if
  // available) without excluding the rest — unlike preferProvider, which is
  // a hard pin with no fallback. Used by expression-repass.js to prefer the
  // cheap local model without breaking when it isn't configured.
  const chain = pinned ? [preferProvider] : await resolvedExtractProviders(env, preferProviderSoft || null);
  const failures = [];
  for (const pid of chain) {
    const attempts = pinned ? PINNED_RETRY_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await callProvider(pid, {
          cfg, env, systemPrompt, userText, temperature,
        });
      } catch (e) {
        const willRetry = attempt < attempts;
        console.warn("freemium extract", pid, willRetry ? `retry ${attempt}/${attempts - 1}` : "giving up", e.message || e);
        failures.push(e);
        if (willRetry) await sleep(PINNED_RETRY_BACKOFF_MS * attempt);
      }
    }
  }
  const err = new Error(
    `freemium_extract: all providers failed (${failures.length}) — ${
      failures.slice(0, 3).map((e) => e.message || e).join(" | ")
    }`,
  );
  // Distinguishes "every provider is rate-limited/out of quota right now"
  // (checkpointable — stop and let the user resume later) from a genuine bug
  // (infra error, R2 failure, etc. — worth the existing retry-the-whole-job path).
  err.providerExhausted = true;
  throw err;
}

export function chunkText(text, maxTokens = MAX_CHUNK_TOKENS) {
  if (!text?.trim()) return [];
  const maxChars = maxTokens * 4;
  text = text.trim();
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  const sentRe = /[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g;

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    push();
    if (para.length <= maxChars) {
      current = para;
    } else {
      for (const sent of para.match(sentRe) || [para]) {
        if ((current + sent).length <= maxChars) current += sent;
        else {
          push();
          if (sent.length > maxChars) {
            for (let i = 0; i < sent.length; i += maxChars) chunks.push(sent.slice(i, i + maxChars).trim());
          } else current = sent;
        }
      }
    }
  }
  push();
  return chunks;
}

export function mergeAnalysisDicts(dataObjects) {
  const charById = new Map();
  const scenes = [];
  for (const d of dataObjects) {
    if (!d) continue;
    for (const c of d.characters || []) {
      const cid = (c.id || c.name || "").toLowerCase().trim();
      if (!cid) continue;
      if (!charById.has(cid)) charById.set(cid, { ...c, id: c.id || cid, aliases: [...(c.aliases || [])] });
      else {
        const ex = charById.get(cid);
        ex.aliases = [...new Set([...(ex.aliases || []), ...(c.aliases || [])])];
        if ((c.description || "").length > (ex.description || "").length) ex.description = c.description;
      }
    }
    for (const s of d.scenes || []) scenes.push(s);
  }
  return { characters: [...charById.values()], scenes };
}

/**
 * Scene-aware merge for one chapter's sequential chunk results — stitches a
 * scene the model flagged `scene_continues: true` (cut off by our own chunk
 * boundary, not a real scene end) onto the next chunk's matching-id opening
 * scene, instead of leaving them as two separate partial scene entries. Only
 * touches adjacency the model itself confirmed via matching ids; if it
 * didn't continue as asked (different id, or ignored the flag entirely),
 * this falls back to today's plain concatenation for that scene — additive,
 * never worse than the pre-existing behavior.
 */
export function mergeChapterScenes(partials) {
  const scenes = [];
  let pendingOpen = null; // { id, scene } — still-open scene carried from the previous chunk

  for (const d of partials) {
    const chunkScenes = d?.scenes || [];
    chunkScenes.forEach((scene, i) => {
      if (pendingOpen && i === 0 && scene.id === pendingOpen.id) {
        pendingOpen.scene.lines = [...(pendingOpen.scene.lines || []), ...(scene.lines || [])];
        pendingOpen.scene.present_character_ids = [...new Set([
          ...(pendingOpen.scene.present_character_ids || []),
          ...(scene.present_character_ids || []),
        ])];
        if (scene.scene_continues) return; // still open — keep accumulating in later chunks
        scenes.push(pendingOpen.scene);
        pendingOpen = null;
        return;
      }
      if (pendingOpen) {
        scenes.push(pendingOpen.scene);
        pendingOpen = null;
      }
      const sceneCopy = { ...scene, lines: [...(scene.lines || [])] };
      if (scene.scene_continues && i === chunkScenes.length - 1) {
        pendingOpen = { id: scene.id, scene: sceneCopy };
      } else {
        scenes.push(sceneCopy);
      }
    });
  }
  if (pendingOpen) scenes.push(pendingOpen.scene); // chapter ended still "open" — take what we have

  // Internal bookkeeping only — never leak into compiled playback.
  for (const s of scenes) delete s.scene_continues;
  return scenes;
}

/** Full book extract via freemium chain (chunked). */
export async function freemiumExtractBook(
  { book_id, title, author, body_text },
  { env, preferProvider, onProgress },
) {
  const system = buildSystemPrompt();
  const maxChars = resolveMaxChunkTokens(env) * 4;
  const chapterChunks = chunkTextByChapters(body_text, maxChars);
  const chunks = chapterChunks?.length ? chapterChunks : chunkText(body_text, maxChars / 4);
  if (!chunks.length) throw new Error("empty book text");

  let pin = preferProvider;
  const partials = [];
  let usedModel = "";

  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress({ chunk: i + 1, total: chunks.length, provider: pin });
    const user = buildUserPrompt(book_id, title, author, chunks[i], i, chunks.length);
    const result = await freemiumExtract(user, { systemPrompt: system, preferProvider: pin, env });
    if (!pin) {
      pin = result.provider;
      usedModel = result.model;
    } else if (!usedModel) usedModel = result.model;
    partials.push(result.data);

    if (result.repaired) {
      console.warn(
        `freemium extract: book "${title}" (${book_id}) chunk ${i + 1}/${chunks.length} needed a stray-quote `
        + "JSON repair — review this chunk and its neighbors:",
        {
          prevChunkTail: chunks[i - 1]?.slice?.(-300) ?? null,
          nextChunkHead: chunks[i + 1]?.slice?.(0, 300) ?? null,
        },
      );
    }
  }

  const merged = mergeAnalysisDicts(partials);
  merged.book_id = book_id;
  merged.title = title;
  merged.author = author;
  return { analysis: merged, provider: pin || "unknown", model: usedModel };
}

/** Extracts one chapter's chunks (sequentially, since sub-chunks of a chapter
 * build on each other's known-character seed) and returns the raw merged
 * chapterAnalysis — everything freemiumExtractBookByChapter used to do
 * inline, before onChapterComplete fired. Shared by the sequential and
 * parallel scheduling paths so neither duplicates the chunk-extraction logic.
 */
async function extractChapterRaw({
  book_id, title, author, chapterChunks, chunkOffset, totalChunks,
  env, preferProvider, knownCharactersSnapshot, illustrationsNearby,
  onProgress, chapterOfTotal, totalChapters,
}) {
  const system = buildSystemPrompt();
  let pin = preferProvider;
  let usedModel = "";
  const chapterKnown = [...knownCharactersSnapshot];
  const partials = [];
  let chunksDone = chunkOffset;
  // Trailing scene from the previous chunk, if it flagged scene_continues —
  // see formatOpenScene / mergeChapterScenes / the SCENE_CONTINUES rule in
  // dialogue-rules.js. null whenever the previous chunk's scene concluded
  // cleanly (the common case) — this is purely additive on top of it.
  let openScene = null;

  for (let idx = 0; idx < chapterChunks.length; idx += 1) {
    const chunk = chapterChunks[idx];
    chunksDone += 1;
    if (onProgress) {
      onProgress({
        chapterPos: chunk.chapterPos,
        chapterIndex: chunk.chapterIndex,
        chapterTitle: chunk.chapterTitle,
        chapterOfTotal,
        totalChapters,
        chunk: chunksDone,
        totalChunks,
        provider: pin,
      });
    }
    const user = buildUserPrompt(
      book_id, title, author, chunk.text, chunksDone - 1, totalChunks, chapterKnown, illustrationsNearby, openScene,
    );
    const result = await freemiumExtract(user, { systemPrompt: system, preferProvider: pin, env });
    if (!pin) {
      pin = result.provider;
      usedModel = result.model;
    } else if (!usedModel) usedModel = result.model;
    partials.push(result.data);

    if (result.repaired) {
      // The stray-quote repair is a best-effort heuristic — flag the source
      // text immediately before/after this chunk too, so whoever reviews the
      // warning can confirm those neighboring chunks extracted cleanly and
      // weren't thrown off by whatever tripped this one up.
      console.warn(
        `freemium extract: book "${title}" (${book_id}) chapter ${chunk.chapterIndex} "${chunk.chapterTitle}" `
        + `chunk ${chunksDone}/${totalChunks} needed a stray-quote JSON repair — review this chunk and its neighbors:`,
        {
          prevChunkTail: chapterChunks[idx - 1]?.text?.slice(-300) ?? null,
          nextChunkHead: chapterChunks[idx + 1]?.text?.slice(0, 300) ?? null,
        },
      );
    }

    const resultScenes = result.data?.scenes || [];
    const trailingScene = resultScenes[resultScenes.length - 1];
    openScene = trailingScene?.scene_continues ? {
      id: trailingScene.id,
      location: trailingScene.location,
      title: trailingScene.title,
      present_character_ids: trailingScene.present_character_ids || [],
    } : null;

    const knownIds = new Set(chapterKnown.map((c) => c.id));
    for (const c of result.data?.characters || []) {
      if (c.id && !knownIds.has(c.id)) {
        knownIds.add(c.id);
        chapterKnown.push(c);
      }
    }
  }

  const chapterAnalysis = mergeAnalysisDicts(partials);
  chapterAnalysis.scenes = mergeChapterScenes(partials);
  chapterAnalysis.chapterIndex = chapterChunks[0].chapterIndex;
  chapterAnalysis.chapterTitle = chapterChunks[0].chapterTitle;
  return {
    chapterAnalysis, provider: pin, model: usedModel, chunksDoneAfter: chunksDone,
  };
}

/**
 * Chapter-checkpointed book extract: chunks are strictly 1:1 (or N:1 when a
 * chapter must split) with source chapters — never mixing two chapters into
 * one chunk — and `onChapterComplete` fires after each chapter's chunks are
 * extracted and merged, so the caller can persist a checkpoint immediately
 * instead of only getting a result after the whole book succeeds.
 *
 * `startChapterPos` (0-based position in the `chapters` array, NOT the
 * semantic chapter number) skips chapters already checkpointed by a prior
 * run — used for resume. If a chapter's provider chain is exhausted, this
 * throws (same as freemiumExtract) — the caller decides whether that's a
 * hard failure or a "stop here, partial book is fine" checkpoint boundary.
 *
 * `concurrency` (default 1, fully sequential — identical to the original
 * one-chapter-at-a-time behavior) lets up to N chapters extract at once via
 * a bounded producer/ordered-consumer scheduler (see ordered-drain.js).
 * Concurrent chapters can't fully see each other's freshly-introduced
 * characters at dispatch time (the "known characters" hint is best-effort,
 * snapshotted when each chapter's extraction starts), so every chapter's raw
 * result is passed through reconcileChapterCharacters immediately before
 * onChapterComplete fires — using both already-drained knownCharacters and
 * any concurrently-finished-but-undrained chapters sitting in the
 * scheduler's look-ahead buffer — to fix up placeholder character ids
 * ("unnamed male protagonist") against the real name established elsewhere.
 */
export async function freemiumExtractBookByChapter(
  { book_id, title, author, chapters },
  {
    env, preferProvider, startChapterPos = 0, onChapterComplete, onProgress,
    getKnownCharacters, getChapterIllustrations, concurrency = 1,
  },
) {
  const maxChars = resolveMaxChunkTokens(env) * 4;
  const allChunks = chunkChaptersStrict(chapters, maxChars);
  if (!allChunks.length) throw new Error("empty book text");

  const byChapter = new Map();
  for (const chunk of allChunks) {
    if (!byChapter.has(chunk.chapterPos)) byChapter.set(chunk.chapterPos, []);
    byChapter.get(chunk.chapterPos).push(chunk);
  }
  const allPositions = [...byChapter.keys()].sort((a, b) => a - b);
  const chapterPositions = allPositions.filter((p) => p >= startChapterPos);
  const totalChapters = allPositions.length;
  const totalChunks = allChunks.length;

  let pin = preferProvider;
  let usedModel = "";

  if (concurrency <= 1) {
    let chunksDone = allPositions
      .filter((p) => p < startChapterPos)
      .reduce((n, p) => n + byChapter.get(p).length, 0);

    for (const chapterPos of chapterPositions) {
      const chapterChunks = byChapter.get(chapterPos);
      const chapterKnown = getKnownCharacters ? [...getKnownCharacters()] : [];
      const chapterIllustrations = getChapterIllustrations ? getChapterIllustrations(chapterPos) : null;
      const {
        chapterAnalysis, provider, model, chunksDoneAfter,
      } = await extractChapterRaw({
        book_id,
        title,
        author,
        chapterChunks,
        chunkOffset: chunksDone,
        totalChunks,
        env,
        preferProvider: pin,
        knownCharactersSnapshot: chapterKnown,
        illustrationsNearby: chapterIllustrations,
        onProgress,
        chapterOfTotal: allPositions.indexOf(chapterPos) + 1,
        totalChapters,
      });
      chunksDone = chunksDoneAfter;
      pin = provider;
      if (!usedModel) usedModel = model;
      if (onChapterComplete) {
        await onChapterComplete(chapterPos, chapterAnalysis, { provider: pin, model: usedModel });
      }
    }

    return { provider: pin || "unknown", model: usedModel, totalChapters };
  }

  // Parallel path: bounded-concurrency producers, strictly chapter-ordered
  // consumer — see runOrderedDrain and reconcileChapterCharacters above.
  const lookaheadBuffer = new Map(); // chapterPos -> raw chapterAnalysis (finished, not yet drained)

  await runOrderedDrain(chapterPositions, {
    concurrency,
    produce: async (chapterPos) => {
      const cached = await getRawChapterExtract(env, book_id, chapterPos);
      if (cached) {
        console.warn("freemium extract", "chapter", chapterPos, "resumed from raw cache — skipping re-extraction");
        if (!pin) pin = cached.provider;
        if (!usedModel) usedModel = cached.model;
        lookaheadBuffer.set(chapterPos, cached.chapterAnalysis);
        return cached;
      }

      const chapterChunks = byChapter.get(chapterPos);
      const chapterKnown = getKnownCharacters ? [...getKnownCharacters()] : [];
      const chapterIllustrations = getChapterIllustrations ? getChapterIllustrations(chapterPos) : null;
      const { chapterAnalysis, provider, model } = await extractChapterRaw({
        book_id,
        title,
        author,
        chapterChunks,
        chunkOffset: 0,
        totalChunks,
        env,
        preferProvider: pin,
        knownCharactersSnapshot: chapterKnown,
        illustrationsNearby: chapterIllustrations,
        onProgress,
        chapterOfTotal: allPositions.indexOf(chapterPos) + 1,
        totalChapters,
      });
      if (!pin) pin = provider;
      if (!usedModel) usedModel = model;
      lookaheadBuffer.set(chapterPos, chapterAnalysis);
      const produced = { chapterAnalysis, provider, model };
      // Durable the moment this chapter's own (slow, expensive) LLM work is
      // done — independent of whether it's this chapter's turn to drain yet.
      // A crash while an earlier chapter is still churning no longer throws
      // this away; resume finds it here and skips straight to reconciliation.
      await putRawChapterExtract(env, book_id, chapterPos, produced);
      return produced;
    },
    consume: async (chapterPos, produced) => {
      lookaheadBuffer.delete(chapterPos);
      const knownCharacters = getKnownCharacters ? getKnownCharacters() : [];
      const lookaheadCharacters = [...lookaheadBuffer.values()].flatMap((a) => a.characters || []);
      const reconciled = reconcileChapterCharacters(produced.chapterAnalysis, {
        knownCharacters,
        lookaheadCharacters,
      });
      if (onChapterComplete) {
        await onChapterComplete(chapterPos, reconciled, {
          provider: produced.provider || pin,
          model: produced.model || usedModel,
        });
      }
      // Now durably checkpointed in compiled form — the raw cache has served
      // its purpose for this chapter.
      await deleteRawChapterExtract(env, book_id, chapterPos);
    },
  });

  return { provider: pin || "unknown", model: usedModel, totalChapters };
}
