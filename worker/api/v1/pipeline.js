import { publicView, saveConfig, getConfig } from "../../_shared/pipeline-registry.js";
import { evaluateCostEfficiency, presetPipelinePatch } from "../../_shared/pipeline-cost-guide.js";
import { localExtractPresetPatch } from "../../_shared/local-extract-presets.js";
import { json } from "../../_shared/jobs-kv.js";

function pipelineEnabled(env) {
  return Boolean(env.VAE_JOBS);
}

export async function onPipelineGet({ env }) {
  if (!pipelineEnabled(env)) return null;
  return json(await publicView(env));
}

export async function onPipelinePatch({ request, env }) {
  if (!pipelineEnabled(env)) return null;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (body.apply_cost_efficient) {
    const cfg = await getConfig(env);
    await saveConfig(env, presetPipelinePatch(cfg));
  } else if (body.apply_local_extract_preset) {
    const cfg = await getConfig(env);
    const patch = localExtractPresetPatch(cfg, body.apply_local_extract_preset);
    if (!patch) return json({ error: "unknown preset" }, 400);
    await saveConfig(env, patch);
  } else {
    await saveConfig(env, body.lanes || body);
  }
  return json(await publicView(env));
}
