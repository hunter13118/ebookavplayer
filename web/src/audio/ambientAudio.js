// Procedurally-synthesized ambient scene sound (rain, wind, forest, tavern) —
// a fully independent Web Audio chain, entirely decoupled from the TTS/
// segment playback the orchestrator drives (playSpeech.js, sharedAudioSource.js
// are both plain <audio> elements; there is no shared audio graph to tap
// into). No files, no licensing questions — every category is synthesized
// from one shared noise buffer plus filters/oscillators.
//
// Mirrors sharedAudioSource.js's module-level singleton convention: one
// lazily-created instance, reused for the page's lifetime.

const Ctor = typeof window !== "undefined" ? (window.AudioContext || window.webkitAudioContext) : undefined;

const NOISE_BUFFER_SECONDS = 4;
const CROSSFADE_SECONDS = 1.5;
const GAIN_RAMP_SECONDS = 0.6;

// Relative output level per category (further scaled by the user's overall
// ambient-volume pref) — event-driven beds (forest/tavern) sit quieter than
// the continuous rain/wind textures so the occasional chirp/clink reads as
// an accent, not a new layer competing with narration.
const CATEGORY_LEVEL = { rain: 1, wind: 0.9, forest: 0.5, tavern: 0.6 };

let ctx = null;
let masterGain = null;
let noiseBuffer = null;
let current = null; // { category, gain, stop() }

let enabled = true;
let volume = 0.35;
let playing = false;

function ensureCtx() {
  if (!Ctor) return null;
  if (!ctx) {
    ctx = new Ctor();
    masterGain = ctx.createGain();
    masterGain.gain.value = enabled && playing ? volume : 0;
    masterGain.connect(ctx.destination);
  }
  return ctx;
}

function makeNoiseBuffer(c) {
  if (noiseBuffer) return noiseBuffer;
  const length = Math.floor(c.sampleRate * NOISE_BUFFER_SECONDS);
  const buf = c.createBuffer(1, length, c.sampleRate);
  const data = buf.getChannelData(0);
  const fade = Math.floor(c.sampleRate * 0.02); // 20ms in/out so loop=true has no click at the seam
  for (let i = 0; i < length; i++) {
    let s = Math.random() * 2 - 1;
    if (i < fade) s *= i / fade;
    else if (i > length - fade) s *= (length - i) / fade;
    data[i] = s;
  }
  noiseBuffer = buf;
  return buf;
}

function updateMasterGain() {
  if (!ctx || !masterGain) return;
  const target = enabled && playing ? volume : 0;
  const now = ctx.currentTime;
  masterGain.gain.cancelScheduledValues(now);
  masterGain.gain.setValueAtTime(masterGain.gain.value, now);
  masterGain.gain.linearRampToValueAtTime(target, now + GAIN_RAMP_SECONDS);
}

function playChirp(c, destGain) {
  const now = c.currentTime;
  const osc = c.createOscillator();
  osc.type = "sine";
  const env = c.createGain();
  env.gain.value = 0;
  osc.connect(env);
  env.connect(destGain);
  const freqStart = 2200 + Math.random() * 800;
  osc.frequency.setValueAtTime(freqStart, now);
  osc.frequency.exponentialRampToValueAtTime(freqStart * 1.4, now + 0.08);
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(0.15, now + 0.02);
  env.gain.linearRampToValueAtTime(0, now + 0.18);
  osc.start(now);
  osc.stop(now + 0.2);
  osc.onended = () => { try { osc.disconnect(); env.disconnect(); } catch { /* already gone */ } };
}

function playClink(c, destGain) {
  const now = c.currentTime;
  [2400 + Math.random() * 400, 3600 + Math.random() * 400].forEach((freq) => {
    const osc = c.createOscillator();
    osc.type = "sine";
    const env = c.createGain();
    env.gain.value = 0;
    osc.connect(env);
    env.connect(destGain);
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.08, now + 0.005);
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.start(now);
    osc.stop(now + 0.4);
    osc.onended = () => { try { osc.disconnect(); env.disconnect(); } catch { /* already gone */ } };
  });
}

/** Recursive randomized-interval scheduler for one-shot "event" sounds. */
function scheduleEvents(c, gain, play, minDelayMs, maxDelayMs) {
  let cancelled = false;
  let timer = null;
  function fire() {
    if (cancelled) return;
    play(c, gain);
    timer = setTimeout(fire, minDelayMs + Math.random() * (maxDelayMs - minDelayMs));
  }
  timer = setTimeout(fire, minDelayMs + Math.random() * (maxDelayMs - minDelayMs));
  return { cancel() { cancelled = true; if (timer) clearTimeout(timer); } };
}

function buildChain(c, category) {
  const buf = makeNoiseBuffer(c);
  const gain = c.createGain();
  gain.gain.value = 0;
  gain.connect(masterGain);

  const src = c.createBufferSource();
  src.buffer = buf;
  src.loop = true;

  const extraNodes = [];
  let events = null;

  if (category === "rain") {
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3000;
    const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 800;
    src.connect(lp); lp.connect(hp); hp.connect(gain);
    const lfo = c.createOscillator(); lfo.frequency.value = 0.1;
    const lfoGain = c.createGain(); lfoGain.gain.value = 0.08;
    lfo.connect(lfoGain); lfoGain.connect(gain.gain);
    lfo.start();
    extraNodes.push(lfo);
  } else if (category === "wind") {
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 500;
    src.connect(lp); lp.connect(gain);
    const lfo = c.createOscillator(); lfo.frequency.value = 0.08;
    const lfoGain = c.createGain(); lfoGain.gain.value = 350;
    lfo.connect(lfoGain); lfoGain.connect(lp.frequency);
    lfo.start();
    extraNodes.push(lfo);
  } else if (category === "forest") {
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2000;
    src.connect(lp); lp.connect(gain);
    events = scheduleEvents(c, gain, playChirp, 3000, 9000);
  } else if (category === "tavern") {
    const bp = c.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 700; bp.Q.value = 0.7;
    src.connect(bp); bp.connect(gain);
    events = scheduleEvents(c, gain, playClink, 4000, 10000);
  } else {
    src.connect(gain);
  }

  src.start();

  function stop() {
    events?.cancel();
    try { src.stop(); } catch { /* already stopped */ }
    extraNodes.forEach((n) => { try { n.stop(); } catch { /* already stopped */ } });
    setTimeout(() => {
      try { src.disconnect(); } catch { /* already gone */ }
      extraNodes.forEach((n) => { try { n.disconnect(); } catch { /* already gone */ } });
      try { gain.disconnect(); } catch { /* already gone */ }
    }, 100);
  }

  return { gain, stop };
}

function fadeOutAndStop(chain, c) {
  const now = c.currentTime;
  chain.gain.gain.cancelScheduledValues(now);
  chain.gain.gain.setValueAtTime(chain.gain.gain.value, now);
  chain.gain.gain.linearRampToValueAtTime(0, now + CROSSFADE_SECONDS);
  setTimeout(() => chain.stop(), CROSSFADE_SECONDS * 1000 + 150);
}

/** category: "rain" | "wind" | "forest" | "tavern" | null (silence). No-op if
 *  already playing this category — consecutive same-category scenes don't
 *  restart/crossfade audibly. */
export function startAmbient(category) {
  const c = ensureCtx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  if (current?.category === category) return;

  const prev = current;
  current = null;
  if (prev) fadeOutAndStop(prev, c);

  if (!category) return;
  const chain = buildChain(c, category);
  current = { category, gain: chain.gain, stop: chain.stop };
  const now = c.currentTime;
  chain.gain.gain.cancelScheduledValues(now);
  chain.gain.gain.setValueAtTime(0, now);
  chain.gain.gain.linearRampToValueAtTime(CATEGORY_LEVEL[category] ?? 1, now + CROSSFADE_SECONDS);
}

/** Full teardown — use on Player unmount / switching books. */
export function stopAmbient() {
  if (!ctx || !current) return;
  const prev = current;
  current = null;
  fadeOutAndStop(prev, ctx);
}

export function setAmbientEnabled(next) {
  enabled = Boolean(next);
  updateMasterGain();
}

export function setAmbientVolume(next) {
  volume = Math.max(0, Math.min(1, Number(next) || 0));
  updateMasterGain();
}

/** Ties ambient to the player's actual play/pause state without tearing down
 *  the node graph (avoids needlessly restarting forest/tavern event timers
 *  on every pause). */
export function setAmbientPlaying(next) {
  playing = Boolean(next);
  updateMasterGain();
}
