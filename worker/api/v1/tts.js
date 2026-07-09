import { json } from "../../_shared/jobs-kv.js";
import { synthesizeEdgeMp3 } from "../../_shared/edge-tts.js";
import { applyExpressionProsody } from "../../_shared/expression-prosody.js";

/** POST /tts — Edge neural voices (no Fly/Python backend required). */
export async function onTtsPost({ request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "expected JSON body" }, 400);
  }

  const text = String(body.text || "").trim();
  if (!text) return new Response(null, { status: 204 });

  const voice = body.voice || "en-US-AndrewMultilingualNeural";
  // Expression Sensitivity Plan Phase 2: the client already sends
  // expression/intensity on every request (web/src/audio/playSpeech.js) —
  // this was previously ignored entirely, so delivery was flat regardless of
  // tag. Apply it additively on top of the per-character base prosody.
  const { pitch, rate, volume } = applyExpressionProsody(
    { pitch: body.pitch || "+0Hz", rate: body.rate || "+0%", volume: body.volume || "+0%" },
    body.expression,
    body.intensity,
    body.performance_mode,
  );

  try {
    const audio = await synthesizeEdgeMp3(text, voice, { rate, pitch, volume });
    if (!audio?.length) return new Response(null, { status: 204 });
    return new Response(audio, {
      status: 200,
      headers: {
        "content-type": "audio/mpeg",
        "cache-control": "private, max-age=3600",
      },
    });
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
}
