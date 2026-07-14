/** Per-character Edge voice assignment (mirrors server/audio/voices.py). */

const NARRATOR_DEFAULT = {
  male: "en-US-AndrewMultilingualNeural",
  female: "en-US-AvaMultilingualNeural",
};

const NATURAL_MALE = [
  "en-US-AndrewMultilingualNeural",
  "en-US-BrianMultilingualNeural",
  "en-US-ChristopherNeural",
  "en-US-DavisNeural",
  "en-US-EricNeural",
  "en-US-GuyNeural",
  "en-US-JasonNeural",
  "en-US-RogerNeural",
  "en-US-SteffanNeural",
  "en-US-TonyNeural",
  "en-GB-RyanNeural",
  "en-GB-ThomasNeural",
  "en-AU-WilliamMultilingualNeural",
];

const NATURAL_FEMALE = [
  "en-US-AvaMultilingualNeural",
  "en-US-AriaNeural",
  "en-US-EmmaMultilingualNeural",
  "en-US-JennyNeural",
  "en-US-MichelleNeural",
  "en-US-MonicaNeural",
  "en-US-NancyNeural",
  "en-US-SaraNeural",
  "en-GB-LibbyNeural",
  "en-GB-MaisieNeural",
  "en-GB-SoniaNeural",
  "en-AU-NatashaNeural",
];

const NATURAL_NEUTRAL = [
  "en-US-AndrewMultilingualNeural",
  "en-US-AvaMultilingualNeural",
];

export function poolForGender(gender) {
  const g = String(gender || "").toLowerCase();
  if (g.startsWith("m")) return NATURAL_MALE;
  if (g.startsWith("f")) return NATURAL_FEMALE;
  return NATURAL_NEUTRAL;
}

export function narratorVoice(gender = "male") {
  return NARRATOR_DEFAULT[gender] || NARRATOR_DEFAULT.male;
}

function bucket(gender, age) {
  const g = String(gender || "").toLowerCase();
  if (g.startsWith("m")) return "male";
  if (g.startsWith("f")) return "female";
  return "neutral";
}

function pitchOffset(bkt, idx, age, speechRegister) {
  let hz = 0;
  if (idx >= 1) hz += bkt === "male" ? -10 : 8;
  const ageL = String(age || "").toLowerCase();
  if (ageL === "child" || ageL === "young") hz += 6;
  else if (ageL === "old" || ageL === "elderly") hz -= 6;
  hz += pitchNudgeFromRegister(speechRegister);
  return Math.max(-18, Math.min(18, hz));
}

// Phase 3 character enrichment (character-enrich.js) — small deterministic
// keyword maps from the LLM-derived speech_register/cadence free text onto
// the pitch/rate dials that already exist here. No effect (0) when the
// enrichment fields are absent, which is the default for every character
// today (toggle off or no wiki match) — preserves current behavior exactly.
const REGISTER_PITCH_KEYWORDS = [
  { re: /\b(deep|gravelly|booming|low|husky)\b/i, hz: -4 },
  { re: /\b(high|light|airy|bright|shrill)\b/i, hz: 4 },
];

const CADENCE_RATE_KEYWORDS = [
  { re: /\b(fast|quick|rapid|brisk|clipped|snappy)\b/i, pct: 8 },
  { re: /\b(slow|deliberate|measured|unhurried|drawling)\b/i, pct: -8 },
];

function pitchNudgeFromRegister(speechRegister) {
  const s = String(speechRegister || "").toLowerCase();
  for (const { re, hz } of REGISTER_PITCH_KEYWORDS) if (re.test(s)) return hz;
  return 0;
}

function rateFromCadence(cadence) {
  const s = String(cadence || "").toLowerCase();
  for (const { re, pct } of CADENCE_RATE_KEYWORDS) if (re.test(s)) return pct;
  return 0;
}

function rateTag(pct) {
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

export function assignVoices(characters = []) {
  const assignments = {};
  const used = { male: 0, female: 0, neutral: 0 };
  const order = [...characters].sort((a, b) => {
    const rank = { primary: 0, secondary: 1, background: 2 };
    return (rank[a.importance] ?? 1) - (rank[b.importance] ?? 1);
  });

  for (const c of order) {
    const cid = c.id || c.name;
    if (!cid || cid === "narrator") continue;
    const bkt = bucket(c.gender, c.age);
    const pool = poolForGender(c.gender);
    const idx = used[bkt];
    used[bkt] += 1;
    const voice = pool[idx % pool.length];
    const pitchHz = pitchOffset(bkt, idx, c.age, c.speech_register);
    assignments[cid] = {
      character_id: cid,
      voice,
      pitch: pitchHz ? `${pitchHz > 0 ? "+" : ""}${pitchHz}Hz` : "+0Hz",
      rate: rateTag(rateFromCadence(c.cadence)),
    };
  }
  return assignments;
}

/**
 * Assign voices to characters not already in voiceState.assignments,
 * appending to the running per-bucket counters instead of re-sorting the
 * whole roster by importance. Used for per-chapter incremental compilation
 * so a character's voice never changes once assigned, at the cost of no
 * longer guaranteeing "primary" characters get first pick of the voice pool
 * across the whole book — only within the chapter they're first seen in.
 */
export function assignVoicesIncremental(newCharacters = [], voiceState) {
  const usedCounts = { ...(voiceState?.usedCounts || { male: 0, female: 0, neutral: 0 }) };
  const assignments = { ...(voiceState?.assignments || {}) };
  const order = [...newCharacters].sort((a, b) => {
    const rank = { primary: 0, secondary: 1, background: 2 };
    return (rank[a.importance] ?? 1) - (rank[b.importance] ?? 1);
  });

  for (const c of order) {
    const cid = c.id || c.name;
    if (!cid || cid === "narrator" || assignments[cid]) continue;
    const bkt = bucket(c.gender, c.age);
    const pool = poolForGender(c.gender);
    const idx = usedCounts[bkt];
    usedCounts[bkt] += 1;
    const voice = pool[idx % pool.length];
    const pitchHz = pitchOffset(bkt, idx, c.age, c.speech_register);
    assignments[cid] = {
      character_id: cid,
      voice,
      pitch: pitchHz ? `${pitchHz > 0 ? "+" : ""}${pitchHz}Hz` : "+0Hz",
      rate: rateTag(rateFromCadence(c.cadence)),
    };
  }
  return { usedCounts, assignments };
}

export function edgeVoiceCatalog(locale) {
  const rows = [];
  for (const id of [...NATURAL_MALE, ...NATURAL_FEMALE]) {
    const loc = id.split("-").slice(0, 2).join("-");
    if (locale && !loc.startsWith(locale)) continue;
    rows.push({
      id,
      label: id.replace(/Neural$/i, "").replace(/Multilingual/i, " "),
      locale: loc,
      gender: NATURAL_MALE.includes(id) ? "male" : "female",
      neural: true,
    });
  }
  return rows;
}
