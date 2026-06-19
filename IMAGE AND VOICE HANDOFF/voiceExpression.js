/**
 * voiceExpression.js
 *
 * Expression layer for a multi-engine TTS pipeline. Converts a structured
 * "expression tag" (emitted by the Gemini ebook-extraction step) into concrete
 * synthesis + post-processing instructions for whichever TTS engine is active.
 *
 * The whole design rests on one idea: the cheap engine (Edge) can't *natively*
 * produce whisper/yell, so we reconstruct those expressions from their acoustic
 * correlates using DSP applied AFTER synthesis. The tag is a stable interface;
 * each engine resolves it differently.
 *
 * ─── Why this shape (read before refactoring) ───────────────────────────────
 *
 * ENGINES
 *   'edge'  (PRIMARY)  Free Microsoft Edge read-aloud loophole (e.g. edge-tts /
 *                      msedge-tts). IMPORTANT CONSTRAINT: the free endpoint only
 *                      accepts a SINGLE <voice> + SINGLE <prosody> tag. Microsoft
 *                      strips any SSML that real Edge couldn't have produced, so
 *                      mstts:express-as (whispering/shouting styles) is NOT
 *                      available here. Native control = rate, pitch, volume ONLY.
 *                      => All whisper/yell timbre on Edge is DSP, not native.
 *
 *   'xtts'  (FUTURE)   Offline Coqui XTTS v2. Expression comes from the REFERENCE
 *                      AUDIO you condition on, not SSML. To whisper, you feed it a
 *                      whispered reference clip; to yell, a shouted one. Plus a
 *                      `temperature`-style knob trades stability for expressiveness.
 *                      Also doubles as the OFFLINE FAILOVER when the Edge loophole
 *                      rate-limits or eventually closes.
 *
 *   'azure' (OPTIONAL) Real Azure Speech with a key. This is the ONLY path where
 *                      mstts:express-as ('whispering','shouting','angry', etc.)
 *                      works. Not free. Wired in here as a capability so that IF
 *                      you ever add a keyed backend, the native style rung lights
 *                      up automatically. Off by default.
 *
 * RESOLUTION (per expression tag, per engine):
 *   edge : SSML prosody preset  +  DSP timbre preset     (2 layers)
 *   xtts : reference-clip selection + sampling knob + light DSP cleanup
 *   azure: native express-as style (+ optional light DSP)
 *
 * Environment effects (cave echo, etc.) are ENGINE-AGNOSTIC: they're pure
 * post-processing applied to dry speech regardless of which engine made it.
 * Build that reverb/delay stage once; it serves all engines.
 *
 * ─── Integration notes for the consuming app (Claude Code / Cursor) ──────────
 *   - This module is PURE MAPPING. It returns plain instruction objects; it does
 *     NOT call any TTS engine or run any DSP itself. Your app supplies:
 *       (a) an Edge TTS client (edge-tts / msedge-tts) that accepts rate/pitch/volume
 *       (b) a DSP stage (ffmpeg filtergraph, Web Audio, SoX, or native) that can
 *           apply the filter chains described in DSP_PRESETS
 *       (c) [future] an XTTS runner + a per-character reference-clip library
 *   - The expression tag schema (see buildExpressionPlan JSDoc) is what Gemini
 *     should emit per dialogue line. Keep that schema stable across engines.
 *   - DSP_PRESETS values are described as ffmpeg-style filter atoms with plain
 *     descriptions, so any DSP backend can implement them. They are STARTING
 *     POINTS — tune per voice. See TODO markers.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Capability flags ────────────────────────────────────────────────────────
// Flip ENGINE_CAPS.azure.expressAs to true only if you add a real keyed Azure
// backend. On the free Edge endpoint it MUST stay false (the endpoint strips it).
const ENGINE_CAPS = {
  edge: {
    prosody: true,        // rate / pitch / volume via single <prosody> tag
    expressAs: false,     // NOT available on the free loophole — do not enable
    referenceClips: false,
  },
  xtts: {
    prosody: false,       // no SSML; control is via reference + sampling
    expressAs: false,
    referenceClips: true, // expression lives in the conditioning clip
    samplingKnob: true,   // temperature-like expressiveness/stability tradeoff
  },
  azure: {
    prosody: true,
    expressAs: true,      // the one place whisper/shout styles are real
    referenceClips: false,
  },
};

// Known Azure express-as style names we map our tags onto (only used if a keyed
// azure backend is active). Reference only; the free path ignores these.
const AZURE_STYLE_FOR_EXPRESSION = {
  whisper: 'whispering',
  yell: 'shouting',
  sad: 'sad',
  angry: 'angry',
  cheerful: 'cheerful',
  normal: null,
};

// ── SSML prosody presets (Edge tier) ─────────────────────────────────────────
// These are the ONLY native controls Edge honors. Values are relative strings in
// the form edge-tts/msedge-tts expect (e.g. "+20%", "-30%", "+8Hz"/"high").
// `intensity` (0..1) scales these in scaleProsody() below.
//
// Rationale per expression:
//   whisper -> slower, quieter, slightly lower pitch (timbre comes from DSP)
//   yell    -> faster/clipped, louder, higher pitch (harshness comes from DSP)
const PROSODY_PRESETS = {
  normal:  { rate: '+0%',  pitch: '+0Hz',  volume: '+0%'  },
  whisper: { rate: '-15%', pitch: '-2Hz',  volume: '-40%' },
  yell:    { rate: '+8%',  pitch: '+12Hz', volume: '+40%' },
  sad:     { rate: '-12%', pitch: '-4Hz',  volume: '-15%' },
  angry:   { rate: '+6%',  pitch: '+6Hz',  volume: '+20%' },
};

// ── DSP timbre presets ───────────────────────────────────────────────────────
// Each entry is an ordered list of filter atoms. `type` names the operation;
// `desc` explains intent so any DSP backend (ffmpeg, Web Audio, SoX) can map it.
// Params are nominal at intensity=1.0 and scaled by scaleDsp() where it makes
// sense. These reconstruct the acoustic signature of each expression.
//
// WHISPER signature: suppress the voiced fundamental, emphasize breathy noise.
//   - aggressive high-pass kills chest/body resonance
//   - high-shelf boost lifts the turbulent air band
//   - optional envelope-gated noise layer adds the characteristic hiss
// YELL signature: not "louder" but strained + bright + dynamically flat.
//   - hard compression then make-up gain (loud AND flat)
//   - high-shelf / mild saturation adds the harsh upper harmonics that sell it
const DSP_PRESETS = {
  normal: [],

  whisper: [
    { type: 'highpass', freqHz: 1200, desc: 'remove low/voiced body so tone reads as breath' },
    { type: 'highshelf', freqHz: 4000, gainDb: 6, desc: 'lift breathy air band' },
    { type: 'gain', db: -6, desc: 'overall quieter, but timbre (not just level) carries the whisper' },
    // Optional, highest-fidelity touch. Requires a noise source in your DSP stage,
    // gated to the speech amplitude envelope so hiss only rides on phonation.
    { type: 'noise_blend', source: 'pink', level: 0.12, gatedToEnvelope: true,
      desc: 'airy turbulence layer; the single biggest cue that sells a fake whisper' },
    // ADVANCED ALTERNATIVE (better than the above if available): a "whisperization"
    // / phase-vocoder effect that replaces harmonic excitation with noise while
    // keeping formants. TODO: wire if your DSP backend exposes it (e.g. a vocoder).
  ],

  yell: [
    { type: 'compressor', thresholdDb: -18, ratio: 6, attackMs: 5, releaseMs: 80,
      desc: 'flatten dynamics — a yell is already at the ceiling' },
    { type: 'saturation', driveDb: 6, desc: 'add harsh upper harmonics = vocal strain (sells it more than volume)' },
    { type: 'highshelf', freqHz: 3000, gainDb: 4, desc: 'brighten / push energy upward' },
    { type: 'gain', db: 5, desc: 'make-up gain after compression' },
    // TODO: a touch of soft-clip can intensify extreme yells; add at high intensity only.
  ],

  sad:   [ { type: 'lowpass', freqHz: 6000, desc: 'slightly darker/duller tone' } ],
  angry: [ { type: 'saturation', driveDb: 3, desc: 'mild edge without full yell' } ],
};

// ── Environment (reverb/delay) presets — engine-agnostic post FX ─────────────
// Applied AFTER expression DSP, to dry speech, identical across all engines.
// "cave" deliberately pairs a long reverb tail WITH discrete slap-back delays —
// the early reflections are what make the brain localize a hard enclosed space.
const ENVIRONMENT_PRESETS = {
  open:   [],
  indoor: [ { type: 'reverb', decaySec: 0.4, wet: 0.15, desc: 'small room ambience' } ],
  hall:   [ { type: 'reverb', decaySec: 1.6, wet: 0.30, desc: 'large reverberant hall' } ],
  cave:   [
    { type: 'delay', timeMs: 120, feedback: 0.35, mix: 0.4, desc: 'discrete slap-back: cues hard enclosed walls' },
    { type: 'reverb', decaySec: 2.4, wet: 0.40, desc: 'long damp tail behind the slaps' },
  ],
};

// ── Normalizers ──────────────────────────────────────────────────────────────
function normalizeExpression(expr) {
  if (typeof expr !== 'string') return 'normal';
  const e = expr.toLowerCase().trim();
  if (e.includes('whisper') || e.includes('mutter') || e.includes('hush')) return 'whisper';
  if (e.includes('yell') || e.includes('shout') || e.includes('scream')) return 'yell';
  if (e.includes('sad') || e.includes('sob') || e.includes('weep')) return 'sad';
  if (e.includes('angry') || e.includes('furious') || e.includes('snarl')) return 'angry';
  return 'normal';
}

function normalizeEnvironment(env) {
  if (typeof env !== 'string') return 'open';
  const e = env.toLowerCase().trim();
  if (e.includes('cave') || e.includes('cavern') || e.includes('tunnel')) return 'cave';
  if (e.includes('hall') || e.includes('cathedral') || e.includes('chamber')) return 'hall';
  if (e.includes('indoor') || e.includes('room') || e.includes('inside')) return 'indoor';
  return 'open';
}

function clamp01(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

// Scale relative SSML prosody strings by intensity (0..1). intensity=1 -> preset
// as written; lower values ease the effect toward neutral.
function scaleProsody(preset, intensity) {
  const k = clamp01(intensity);
  const scalePct = (s) => {
    const m = /^([+-]?\d+(?:\.\d+)?)%$/.exec(s);
    if (!m) return s;
    return `${Math.round(parseFloat(m[1]) * k)}%`.replace(/^(\d)/, '+$1');
  };
  const scaleHz = (s) => {
    const m = /^([+-]?\d+(?:\.\d+)?)Hz$/.exec(s);
    if (!m) return s;
    const v = Math.round(parseFloat(m[1]) * k);
    return `${v >= 0 ? '+' : ''}${v}Hz`;
  };
  return {
    rate: scalePct(preset.rate),
    pitch: scaleHz(preset.pitch),
    volume: scalePct(preset.volume),
  };
}

// Scale DSP atom magnitudes by intensity where meaningful (gains, drive, blend).
function scaleDsp(atoms, intensity) {
  const k = clamp01(intensity);
  return atoms.map((a) => {
    const out = { ...a };
    if (typeof out.gainDb === 'number') out.gainDb = +(out.gainDb * k).toFixed(2);
    if (typeof out.db === 'number') out.db = +(out.db * k).toFixed(2);
    if (typeof out.driveDb === 'number') out.driveDb = +(out.driveDb * k).toFixed(2);
    if (typeof out.level === 'number') out.level = +(out.level * k).toFixed(3);
    return out;
  });
}

/**
 * buildExpressionPlan(tag, engine)
 *
 * The core mapping. Turns one extraction tag into an engine-specific plan your
 * app can execute. Does NOT synthesize or process audio itself.
 *
 * @param {object} tag  Expression tag emitted by the Gemini extraction step:
 * @param {string} tag.text         the dialogue line (required)
 * @param {string} [tag.character]  character id (for per-character voice/clip lookup)
 * @param {('normal'|'whisper'|'yell'|'sad'|'angry'|string)} [tag.expression='normal']
 *        Loose string ok; Gemini can infer from punctuation/caps/narration cues
 *        ("she screamed", "he muttered").
 * @param {('open'|'indoor'|'hall'|'cave'|string)} [tag.environment='open']
 * @param {number} [tag.intensity=1] 0..1 — how strong the expression is. On edge
 *        this scales prosody + DSP; on xtts it maps to the sampling knob.
 * @param {('edge'|'xtts'|'azure')} [engine='edge']
 * @returns {object} engine-specific plan (see shapes inside)
 */
function buildExpressionPlan(tag = {}, engine = 'edge') {
  if (!tag || typeof tag.text !== 'string' || tag.text.trim() === '') {
    throw new Error('buildExpressionPlan: tag.text must be a non-empty string');
  }
  const expression = normalizeExpression(tag.expression);
  const environment = normalizeEnvironment(tag.environment);
  const intensity = clamp01(tag.intensity ?? 1);
  const caps = ENGINE_CAPS[engine] || ENGINE_CAPS.edge;

  // Environment FX are identical for every engine.
  const environmentFx = ENVIRONMENT_PRESETS[environment] || [];

  // ── EDGE (primary): native prosody + DSP timbre. No express-as available. ──
  if (engine === 'edge') {
    return {
      engine: 'edge',
      text: tag.text,
      character: tag.character ?? null,
      expression,
      intensity,
      // What your edge-tts/msedge-tts client should send (single prosody tag):
      ssml: scaleProsody(PROSODY_PRESETS[expression] || PROSODY_PRESETS.normal, intensity),
      // What your DSP stage should apply to the returned audio, in order:
      dsp: [
        ...scaleDsp(DSP_PRESETS[expression] || [], intensity),
        ...environmentFx,
      ],
      notes:
        expression === 'whisper' || expression === 'yell'
          ? 'Edge cannot do this natively; timbre is reconstructed entirely in DSP.'
          : 'Prosody-only; DSP minimal.',
    };
  }

  // ── XTTS (future / offline failover): reference clip + sampling knob ──
  if (engine === 'xtts') {
    return {
      engine: 'xtts',
      text: tag.text,
      character: tag.character ?? null,
      expression,
      intensity,
      // Your app resolves this to an actual file via a per-character clip library.
      // Keep 3+ takes per character: neutral / whispered / shouted (+ sad/angry opt).
      referenceClipKey: `${tag.character ?? 'default'}:${expression}`,
      // Map intensity to expressiveness/stability. Higher = more emotion, more
      // artifacts. TODO: calibrate range to your XTTS build.
      sampling: { temperature: +(0.55 + 0.35 * intensity).toFixed(2) },
      // Lighter DSP — the model already produced real expressive timbre.
      dsp: [...environmentFx],
      notes: 'Expression carried by reference clip; DSP only for environment.',
    };
  }

  // ── AZURE (optional, keyed): native express-as if capable ──
  if (engine === 'azure') {
    const style = caps.expressAs ? AZURE_STYLE_FOR_EXPRESSION[expression] : null;
    return {
      engine: 'azure',
      text: tag.text,
      character: tag.character ?? null,
      expression,
      intensity,
      // styledegree 0.01..2 in Azure; map intensity onto it.
      expressAs: style ? { style, styledegree: +(0.5 + 1.5 * intensity).toFixed(2) } : null,
      // Fall back to prosody+DSP if this voice/style isn't supported.
      ssml: style ? null : scaleProsody(PROSODY_PRESETS[expression] || PROSODY_PRESETS.normal, intensity),
      dsp: style ? [...environmentFx] : [...scaleDsp(DSP_PRESETS[expression] || [], intensity), ...environmentFx],
      notes: style ? 'Native express-as style used.' : 'Style unsupported for voice; fell back to prosody+DSP.',
    };
  }

  throw new Error(`buildExpressionPlan: unknown engine "${engine}"`);
}

module.exports = {
  buildExpressionPlan,
  normalizeExpression,
  normalizeEnvironment,
  ENGINE_CAPS,
  PROSODY_PRESETS,
  DSP_PRESETS,
  ENVIRONMENT_PRESETS,
  AZURE_STYLE_FOR_EXPRESSION,
};
