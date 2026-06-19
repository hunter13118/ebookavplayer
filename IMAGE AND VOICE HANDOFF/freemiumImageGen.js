/**
 * freemiumImageGen.js
 *
 * Generates an image from a text prompt by trying a chain of free,
 * card-free image-generation APIs in order. If one fails (rate limit,
 * outage, quota), it falls through to the next.
 *
 * Order of attempts:
 *   1. Cloudflare Workers AI   (FLUX.1 schnell)        -- needs token + account id
 *   2. Pollinations (Seed)     (Flux, authed URL)      -- needs token
 *   3. Pollinations (Anon)     (Flux, no auth)         -- no key
 *   4. Hugging Face            (FLUX.1-dev via router) -- needs token
 *
 * Returns: { provider, model, bytes: Uint8Array, contentType }  on success
 * Throws:  an AggregateError listing every provider's failure if all fail.
 *
 * --- Keys / config -------------------------------------------------------
 * Set these as environment variables (server-side only -- never ship these
 * to the browser). On Cloudflare Pages Functions, bind them as secrets and
 * read from `context.env` instead of `process.env`.
 *
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN     (Workers AI permission)
 *   POLLINATIONS_TOKEN       (sk_... secret key from auth.pollinations.ai)
 *   HF_TOKEN                 (read token from huggingface.co/settings/tokens)
 *
 * Any provider whose required keys are missing is skipped automatically,
 * so you can run with just a subset configured.
 * ------------------------------------------------------------------------
 */

// Pull config from env. Swap `process.env` for your platform's mechanism
// (e.g. Cloudflare Pages: pass an env object into the function).
const CONFIG = {
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  cloudflareToken: process.env.CLOUDFLARE_API_TOKEN,
  pollinationsToken: process.env.POLLINATIONS_TOKEN,
  hfToken: process.env.HF_TOKEN,
};

// How long to wait on any single provider before giving up and moving on.
const PER_PROVIDER_TIMEOUT_MS = 30_000;

/**
 * Small helper: fetch with an abort-based timeout so a hung provider
 * doesn't stall the whole chain.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = PER_PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Normalize a fetch Response body into a Uint8Array. */
async function responseToBytes(res) {
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

// --- Prompt composition: subject type + art style -----------------------
//
// Two independent axes:
//   subjectType: 'character' | 'background'
//   style:       'realistic' | 'anime' | 'pixel' | 'comic'  (else -> neutral)
//
// The extraction process hands us a raw description. We wrap it with framing
// cues (so a sprite gets sprite framing and a landscape gets scene framing)
// plus a style descriptor, then hand the composed string to the image gen.

// Framing scaffolding per subject type. These keep sprite conventions out of
// background prompts and vice versa.
const SUBJECT_FRAMING = {
  character: {
    pre: 'Full-body character sprite, single character, centered composition, ' +
         'clean readable silhouette, front-facing or 3/4 view,',
    post: 'isolated on a plain flat background, even lighting, no scenery, ' +
          'consistent line weight, game-asset ready.',
  },
  background: {
    pre: 'Wide establishing background scene, environment art, no characters, ' +
         'no people, strong sense of depth and atmosphere,',
    post: 'full scene fills the frame, layered foreground/midground/background, ' +
          'usable as a game backdrop layer.',
  },
};

// Style descriptors. Keyed by a normalized style id. `neutral` is the fallback.
const STYLE_TEMPLATES = {
  realistic: 'photorealistic, highly detailed, realistic proportions, ' +
             'natural lighting and shading, lifelike textures',
  anime: 'anime art style, cel-shaded, clean bold outlines, vibrant flat colors, ' +
         'expressive features, in the style of modern Japanese animation',
  pixel: 'pixel art, crisp pixel grid, limited palette, dithered shading, ' +
         'retro 16-bit game aesthetic, sharp edges (no anti-aliasing)',
  comic: 'comic book / cartoon style, bold inked outlines, flat cel coloring, ' +
         'dynamic stylized shapes, halftone-friendly shading',
  // Fallback when the user picks nothing or an unknown style.
  neutral: 'clean digital illustration, balanced colors, clear detail',
};

/**
 * Normalize loosely-typed style input to a known key.
 * Accepts things like "Anime / cel-shaded", "PIXEL", "photoreal", etc.
 */
function normalizeStyle(style) {
  if (typeof style !== 'string') return 'neutral';
  const s = style.toLowerCase();
  if (s.includes('real') || s.includes('photo')) return 'realistic';
  if (s.includes('anime') || s.includes('cel')) return 'anime';
  if (s.includes('pixel')) return 'pixel';
  if (s.includes('comic') || s.includes('cartoon')) return 'comic';
  return 'neutral';
}

/** Normalize subject type; defaults to 'character'. */
function normalizeSubject(subjectType) {
  return subjectType === 'background' ? 'background' : 'character';
}

/**
 * Compose the final prompt sent to the image API.
 * @param {string} description  raw description from the extraction process
 * @param {object} opts
 * @param {string} opts.subjectType 'character' | 'background'
 * @param {string} opts.style       style selector (loose string ok)
 * @returns {string}
 */
function composePrompt(description, { subjectType, style } = {}) {
  const subjKey = normalizeSubject(subjectType);
  const styleKey = normalizeStyle(style);
  const framing = SUBJECT_FRAMING[subjKey];
  const styleDesc = STYLE_TEMPLATES[styleKey];

  // Order: framing intro -> the actual extracted description -> framing outro
  //        -> style descriptor. Trailing style anchors the overall look.
  return [
    framing.pre,
    description.trim().replace(/\s+/g, ' '),
    framing.post,
    `Art style: ${styleDesc}.`,
  ].join(' ');
}

// --- Provider implementations -------------------------------------------
// Each provider is an async fn that either returns a result object or throws.
// Throwing is the signal to fall through to the next provider.

async function tryCloudflare(prompt, seed) {
  const { cloudflareAccountId: acct, cloudflareToken: token } = CONFIG;
  if (!acct || !token) throw new Error('Cloudflare: missing account id or token (skipped)');

  const model = '@cf/black-forest-labs/flux-1-schnell';
  const url = `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${model}`;

  const body = { prompt };
  if (Number.isInteger(seed)) body.seed = seed;

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Cloudflare: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }

  // Workers AI returns JSON: { result: { image: "<base64>" }, success: true }
  const data = await res.json();
  const b64 = data?.result?.image;
  if (!b64) throw new Error('Cloudflare: no image field in response');

  // Decode base64 -> bytes (works in Node 16+ and modern runtimes).
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return { provider: 'cloudflare', model: 'flux-1-schnell', bytes, contentType: 'image/jpeg' };
}

async function tryPollinationsSeed(prompt, seed) {
  const { pollinationsToken: token } = CONFIG;
  if (!token) throw new Error('Pollinations(Seed): missing token (skipped)');

  // The image endpoint takes the prompt in the path; token authenticates the
  // request to your Seed tier (faster rate limit than anonymous).
  let url =
    `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}` +
    `?model=flux&token=${encodeURIComponent(token)}`;
  if (Number.isInteger(seed)) url += `&seed=${seed}`;

  const res = await fetchWithTimeout(url, { method: 'GET' });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Pollinations(Seed): HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  if (!contentType.startsWith('image/')) {
    throw new Error(`Pollinations(Seed): unexpected content-type ${contentType}`);
  }
  const bytes = await responseToBytes(res);
  return { provider: 'pollinations-seed', model: 'flux', bytes, contentType };
}

async function tryPollinationsAnon(prompt, seed) {
  // No key. Same endpoint, no token. Rate-limited (~1 req / 15s) and may
  // include a watermark, but it's a genuine zero-config fallback.
  let url = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=flux`;
  if (Number.isInteger(seed)) url += `&seed=${seed}`;

  const res = await fetchWithTimeout(url, { method: 'GET' });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Pollinations(Anon): HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  if (!contentType.startsWith('image/')) {
    throw new Error(`Pollinations(Anon): unexpected content-type ${contentType}`);
  }
  const bytes = await responseToBytes(res);
  return { provider: 'pollinations-anon', model: 'flux', bytes, contentType };
}

async function tryHuggingFace(prompt, seed) {
  const { hfToken: token } = CONFIG;
  if (!token) throw new Error('HuggingFace: missing token (skipped)');

  // Routed through HF Inference Providers. The model's text-to-image route
  // returns the raw image bytes directly.
  const model = 'black-forest-labs/FLUX.1-dev';
  const url = `https://router.huggingface.co/hf-inference/models/${model}`;

  const payload = { inputs: prompt };
  if (Number.isInteger(seed)) payload.parameters = { seed };

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'image/png',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // 402 = monthly credits exhausted; 503 = model warming up. Both fall through.
    throw new Error(`HuggingFace: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const contentType = res.headers.get('content-type') || 'image/png';
  if (!contentType.startsWith('image/')) {
    throw new Error(`HuggingFace: unexpected content-type ${contentType}`);
  }
  const bytes = await responseToBytes(res);
  return { provider: 'huggingface', model: 'FLUX.1-dev', bytes, contentType };
}

// Provider registry keyed by id, so a character can re-pin to whoever first
// drew it (consistency across regenerations).
const PROVIDERS = {
  cloudflare: tryCloudflare,
  'pollinations-seed': tryPollinationsSeed,
  'pollinations-anon': tryPollinationsAnon,
  huggingface: tryHuggingFace,
};

// Per-subject fallback orderings.
//
// Characters: consistency matters most, and the watermark is worst on a sprite
// you'll composite, so anonymous Pollinations sits LAST.
//
// Backgrounds: one-and-done, consistency irrelevant, so the fast free anon
// route floats above HF's tiny monthly quota.
const CHARACTER_CHAIN = [
  'cloudflare',
  'pollinations-seed',
  'huggingface',
  'pollinations-anon',
];
const BACKGROUND_CHAIN = [
  'cloudflare',
  'pollinations-seed',
  'pollinations-anon',
  'huggingface',
];

// Back-compat: a flat default chain some callers may still import.
const PROVIDER_CHAIN = CHARACTER_CHAIN.map((id) => PROVIDERS[id]);

/**
 * Build the ordered list of provider ids to attempt.
 * If preferProvider is set and valid, it is moved to the FRONT of the chain
 * (the rest of the chain stays as fallback if the preferred one fails).
 */
function buildChain(subjectType, preferProvider) {
  const base = subjectType === 'background' ? BACKGROUND_CHAIN : CHARACTER_CHAIN;
  if (preferProvider && PROVIDERS[preferProvider]) {
    return [preferProvider, ...base.filter((id) => id !== preferProvider)];
  }
  return [...base];
}

/**
 * freemiumImageGen(description, options)
 *
 * Composes a final prompt from an extracted description + the user's chosen
 * subject type and art style, then tries providers in subject-appropriate
 * order and returns the first success.
 *
 * @param {string} description       raw description from the extraction process
 * @param {object} [options]
 * @param {('character'|'background')} [options.subjectType='character']
 *        Selects which fallback ordering is used.
 * @param {('realistic'|'anime'|'pixel'|'comic'|string)} [options.style]
 *        Loose string is fine; unknown/unspecified -> neutral default style.
 * @param {number} [options.seed]
 *        Integer seed for reproducible / consistent output. Pass the SAME seed
 *        with the SAME prompt to keep a character visually consistent across
 *        poses or regenerations. Omit (or pass non-integer) for random each time.
 *        NOTE: a seed is only consistent *within one provider/model* — the same
 *        seed produces different images on Cloudflare vs Pollinations vs HF.
 *        For real sprite consistency, pin BOTH seed AND preferProvider.
 * @param {string} [options.preferProvider]
 *        Provider id ('cloudflare' | 'pollinations-seed' | 'pollinations-anon'
 *        | 'huggingface') to try FIRST. Use this for a character's later
 *        regenerations: store the `provider` returned the first time, then pass
 *        it back here so the look stays matched. Falls through to the normal
 *        chain if the preferred provider fails.
 * @returns {Promise<{provider:string, model:string, prompt:string,
 *                    subjectType:string, style:string, seed:(number|null),
 *                    bytes:Uint8Array, contentType:string}>}
 */
async function freemiumImageGen(description, options = {}) {
  if (typeof description !== 'string' || description.trim() === '') {
    throw new Error('freemiumImageGen: description must be a non-empty string');
  }

  const subjectType = normalizeSubject(options.subjectType);
  const style = normalizeStyle(options.style);
  const seed = Number.isInteger(options.seed) ? options.seed : null;
  const prompt = composePrompt(description, { subjectType, style });

  const chain = buildChain(subjectType, options.preferProvider);

  const failures = [];
  for (const id of chain) {
    const provider = PROVIDERS[id];
    try {
      const result = await provider(prompt, seed);
      console.info(
        `[freemiumImageGen] served by ${result.provider} (${result.model}) ` +
        `| subject=${subjectType} style=${style} seed=${seed ?? 'random'}` +
        `${options.preferProvider ? ` preferred=${options.preferProvider}` : ''}`
      );
      // Surface the composed prompt + selections alongside the image. Store
      // `provider` + `seed` on your side to re-pin this character later.
      return { ...result, prompt, subjectType, style, seed };
    } catch (err) {
      console.warn(`[freemiumImageGen] ${err.message}`);
      failures.push(err);
      // continue to next provider
    }
  }

  throw new AggregateError(failures, 'freemiumImageGen: all providers failed');
}

// --- Example usage -------------------------------------------------------
// (async () => {
//   // 1) First generation of a character. Pick a stable seed per character
//   //    (e.g. hash the character id) and remember which provider served it.
//   const heroSeed = 48273;
//   const hero = await freemiumImageGen(
//     'A dark-magician-girl-adjacent sorceress, purple robes, golden trim, ' +
//       'staff topped with a crystal, confident expression',
//     { subjectType: 'character', style: 'anime', seed: heroSeed }
//   );
//   require('fs').writeFileSync('hero_idle.' + hero.contentType.split('/')[1], hero.bytes);
//
//   // Persist these two for the character:
//   const pinnedProvider = hero.provider;   // e.g. 'cloudflare'
//   const pinnedSeed     = hero.seed;        // 48273
//
//   // 2) Later: a new pose for the SAME character. Re-pin provider + seed so
//   //    the look stays matched (a seed alone won't match across providers).
//   const heroAttack = await freemiumImageGen(
//     'The same sorceress mid-spell, dynamic action pose, arm raised',
//     { subjectType: 'character', style: 'anime',
//       seed: pinnedSeed, preferProvider: pinnedProvider }
//   );
//   require('fs').writeFileSync('hero_attack.' + heroAttack.contentType.split('/')[1], heroAttack.bytes);
//
//   // 3) Background landscape, pixel art style (roams the full chain freely).
//   const bg = await freemiumImageGen(
//     'A ruined moonlit cathedral courtyard overgrown with vines, fog rolling in',
//     { subjectType: 'background', style: 'pixel' }
//   );
//   require('fs').writeFileSync('bg.' + bg.contentType.split('/')[1], bg.bytes);
// })();

module.exports = {
  freemiumImageGen,
  composePrompt,
  normalizeStyle,
  normalizeSubject,
  buildChain,
  STYLE_TEMPLATES,
  SUBJECT_FRAMING,
  PROVIDERS,
  CHARACTER_CHAIN,
  BACKGROUND_CHAIN,
  PROVIDER_CHAIN,
};
