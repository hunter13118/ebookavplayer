import { useCallback, useEffect, useState } from "react";
import { fetchPipeline, patchPipeline, applyCostEfficientPipeline, applyLocalExtractPreset } from "../api.js";

function tipClass(level) {
  if (level === "ok") return "vae-pipeline-tip ok";
  if (level === "warn") return "vae-pipeline-tip warn";
  return "vae-pipeline-tip";
}

function LaneSection({ laneKey, lane, onChange }) {
  const [dragId, setDragId] = useState(null);

  function toggle(id) {
    const disabled = new Set(lane.items.filter((it) => !it.enabled).map((it) => it.id));
    if (disabled.has(id)) disabled.delete(id);
    else disabled.add(id);
    onChange(laneKey, {
      order: lane.items.map((it) => it.id),
      disabled: [...disabled],
    });
  }

  function onDragStart(id) {
    setDragId(id);
  }

  function onDrop(targetId) {
    if (!dragId || dragId === targetId) return;
    const order = lane.items.map((it) => it.id);
    const from = order.indexOf(dragId);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0) return;
    order.splice(from, 1);
    order.splice(to, 0, dragId);
    const disabled = lane.items.filter((it) => !it.enabled).map((it) => it.id);
    onChange(laneKey, { order, disabled });
    setDragId(null);
  }

  return (
    <section className="vae-pipeline-lane" data-lane={laneKey}>
      <h3>{lane.title}</h3>
      <ul className="vae-pipeline-list">
        {lane.items.map((item) => (
          <li
            key={item.id}
            className={`vae-pipeline-item${item.enabled ? "" : " off"}${!item.available ? " unavailable" : ""}`}
            draggable
            onDragStart={() => onDragStart(item.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(item.id)}
            data-testid="pipeline-item"
            data-id={item.id}
          >
            <span className="vae-pipeline-drag" title="Drag to reorder">≡</span>
            <button
              type="button"
              className={`vae-pipeline-toggle${item.enabled ? " on" : ""}`}
              onClick={() => toggle(item.id)}
              title={item.enabled ? "Disable" : "Enable"}
              aria-pressed={item.enabled}
            >
              <span className="vae-pipeline-icon" aria-hidden>{item.icon}</span>
            </button>
            <div className="vae-pipeline-meta">
              <span className="vae-pipeline-name">{item.label}</span>
              {item.model && <span className="vae-pipeline-model">{item.model}</span>}
              {!item.available && <span className="vae-pipeline-badge">no key</span>}
              <span className="vae-pipeline-tier">{item.tier}</span>
              {item.note && <p className="vae-pipeline-note">{item.note}</p>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CostGuidePanel({ guide, onApply, busy }) {
  if (!guide) return null;
  const { preset, matching, tips, attr_llm } = guide;

  return (
    <aside className="vae-pipeline-cost" data-testid="pipeline-cost-guide">
      <div className="vae-pipeline-cost-head">
        <strong>{preset?.label || "Cost guide"}</strong>
        {matching
          ? <span className="vae-pipeline-cost-badge ok">Active</span>
          : <span className="vae-pipeline-cost-badge">Custom</span>}
      </div>
      <p className="vae-pipeline-cost-summary">{preset?.summary}</p>
      {attr_llm && (
        <p className="vae-pipeline-cost-attr">
          Attribution: {attr_llm.enabled ? "on" : "off"}
          {attr_llm.enabled && ` · batch ${attr_llm.batch} · max ${attr_llm.max_scenes} scenes`}
        </p>
      )}
      {preset?.bullets?.length > 0 && (
        <ul className="vae-pipeline-cost-bullets">
          {preset.bullets.map((b) => <li key={b}>{b}</li>)}
        </ul>
      )}
      {tips?.length > 0 && (
        <ul className="vae-pipeline-tips">
          {tips.map((t) => (
            <li key={t.text} className={tipClass(t.level)}>{t.text}</li>
          ))}
        </ul>
      )}
      {!matching && (
        <button
          type="button"
          className="vae-pipeline-apply-btn"
          data-testid="pipeline-apply-cost"
          disabled={busy}
          onClick={onApply}
        >
          Apply recommended preset
        </button>
      )}
    </aside>
  );
}

// Which env var this preset's leading stage needs to actually be usable —
// derived from the stageId prefix rather than a duplicated per-preset field,
// since every local stage is either an ollama-* or an mlx-* stage today.
function presetConfigured(p, ollamaConfigured, mlxConfigured) {
  if (p.stageId.startsWith("mlx-")) return mlxConfigured;
  if (p.stageId.startsWith("ollama-")) return ollamaConfigured;
  return true;
}

function LocalExtractPresetPanel({ guide, onApply, busy }) {
  if (!guide?.presets?.length) return null;
  const { presets, active, ollamaConfigured, mlxConfigured } = guide;
  const hasMlxPreset = presets.some((p) => p.stageId.startsWith("mlx-"));

  return (
    <aside className="vae-local-presets" data-testid="local-extract-presets">
      <div className="vae-pipeline-cost-head">
        <strong>Local extraction presets</strong>
      </div>
      {!ollamaConfigured && (
        <p className="vae-pipeline-cost-summary">
          Set <code>OLLAMA_BASE_URL</code> (see docs/LOCAL_LLM_EXTRACTION.md) to
          enable local extraction and use these presets.
        </p>
      )}
      {hasMlxPreset && !mlxConfigured && (
        <p className="vae-pipeline-cost-summary">
          Set <code>MLX_BASE_URL</code> (see docs/LOCAL_LLM_EXTRACTION.md) to enable the
          MLX preset below — Apple Silicon only, separate <code>mlx-lm</code> Python venv.
        </p>
      )}
      <ul className="vae-local-preset-list">
        {presets.map((p) => (
          <li key={p.id} className={`vae-local-preset${active === p.id ? " active" : ""}`}>
            <div className="vae-pipeline-cost-head">
              <strong>{p.label}</strong>
              {active === p.id && <span className="vae-pipeline-cost-badge ok">Active</span>}
            </div>
            <p className="vae-local-preset-eff">{p.effectiveness}</p>
            <p className="vae-pipeline-cost-summary">{p.summary}</p>
            <ul className="vae-local-preset-env">
              {p.recommendedEnv.map((e) => (
                <li key={e.key}>
                  <code>{e.key}={e.value}</code>
                  {e.note && <span className="vae-local-preset-note"> — {e.note}</span>}
                </li>
              ))}
            </ul>
            {active !== p.id && (
              <button
                type="button"
                className="vae-pipeline-apply-btn"
                disabled={busy || !presetConfigured(p, ollamaConfigured, mlxConfigured)}
                onClick={() => onApply(p.id)}
              >
                Use this
              </button>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}

/** Drag-and-drop AI pipeline editor (model order + enable/disable). */
export default function PipelineSheet({ open, onClose }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState({});

  useEffect(() => {
    if (!open) return;
    setErr("");
    setDirty(false);
    setPending({});
    fetchPipeline()
      .then(setData)
      .catch((e) => setErr(e.message || "Could not load pipeline."));
  }, [open]);

  const onLaneChange = useCallback((laneKey, patch) => {
    setPending((prev) => ({ ...prev, [laneKey]: patch }));
    setDirty(true);
    setData((prev) => {
      if (!prev) return prev;
      const lanes = { ...prev.lanes };
      const lane = { ...lanes[laneKey] };
      const order = patch.order || lane.items.map((it) => it.id);
      const disabled = new Set(patch.disabled || []);
      const byId = Object.fromEntries(lane.items.map((it) => [it.id, it]));
      lane.items = order.filter((id) => byId[id]).map((id) => ({
        ...byId[id],
        enabled: !disabled.has(id),
      }));
      lanes[laneKey] = lane;
      return { ...prev, lanes };
    });
  }, []);

  async function applyPreset() {
    setBusy(true);
    setErr("");
    try {
      const updated = await applyCostEfficientPipeline();
      setData(updated);
      setPending({});
      setDirty(false);
    } catch (e) {
      setErr(e.message || "Could not apply preset.");
    } finally {
      setBusy(false);
    }
  }

  async function applyLocalPreset(presetId) {
    setBusy(true);
    setErr("");
    try {
      const updated = await applyLocalExtractPreset(presetId);
      setData(updated);
      setPending({});
      setDirty(false);
    } catch (e) {
      setErr(e.message || "Could not apply preset.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!dirty) { onClose?.(); return; }
    setBusy(true);
    setErr("");
    try {
      const lanes = { ...pending };
      const updated = await patchPipeline(lanes);
      setData(updated);
      setPending({});
      setDirty(false);
    } catch (e) {
      setErr(e.message || "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="vae-sheet-backdrop" data-testid="pipeline-sheet" onClick={onClose}>
      <div className="vae-sheet vae-pipeline-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="vae-sheet-head">
          <h2>AI pipeline</h2>
          <button type="button" className="vae-sheet-close" onClick={onClose}>×</button>
        </header>
        <p className="vae-sheet-hint">
          Toggle models on or off and drag to set fallback order. Disabled stages are skipped.
        </p>
        <CostGuidePanel guide={data?.cost_guide} onApply={applyPreset} busy={busy} />
        <LocalExtractPresetPanel guide={data?.local_extract_guide} onApply={applyLocalPreset} busy={busy} />
        {err && <p className="vae-sheet-err">{err}</p>}
        {!data && !err && <p className="vae-sheet-hint">Loading…</p>}
        {data?.lanes && Object.entries(data.lanes).map(([key, lane]) => (
          <LaneSection key={key} laneKey={key} lane={lane} onChange={onLaneChange} />
        ))}
        <footer className="vae-sheet-foot">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" data-testid="pipeline-save" disabled={busy} onClick={save}>
            {busy ? "Saving…" : dirty ? "Save pipeline" : "Close"}
          </button>
        </footer>
      </div>
    </div>
  );
}
