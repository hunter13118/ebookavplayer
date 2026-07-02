import { useEffect, useState } from "react";
import { fetchPipeline } from "../api.js";
import { getHealthSnapshot } from "../backends/health.js";

/**
 * Per-operation provider picker — generalizes Uploader.jsx's extraction <select>
 * to any pipeline lane, on any backend connection. Reuses PipelineSheet.jsx's
 * exact availability check (item.available) and checkPipeline's cached snapshot
 * so opening several of these for the same connection doesn't refetch.
 */
export default function ProviderSelect({
  lane, connection, value, onChange, testId, className, disabled = false,
}) {
  const [pipeline, setPipeline] = useState(() => getHealthSnapshot(connection?.id)?.pipeline || null);
  const [err, setErr] = useState("");

  useEffect(() => {
    const cached = getHealthSnapshot(connection?.id)?.pipeline;
    if (cached) { setPipeline(cached); return undefined; }
    if (!connection) return undefined;
    let alive = true;
    setErr("");
    fetchPipeline(connection)
      .then((data) => { if (alive) setPipeline(data); })
      .catch((e) => { if (alive) setErr(e.message || "Could not load providers"); });
    return () => { alive = false; };
  }, [connection?.id, lane]);

  const items = pipeline?.lanes?.[lane]?.items?.filter((it) => it.enabled) || [];

  return (
    <span className="vae-select-wrap">
      <select
        data-testid={testId}
        className={`vae-select${className ? ` ${className}` : ""}`}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="auto">Auto</option>
        {items.map((it) => (
          <option key={it.id} value={it.id} disabled={!it.available}>
            {it.label}
            {it.tier === "local" ? " (local)" : ""}
            {!it.available ? " — unavailable" : ""}
          </option>
        ))}
        {err && <option disabled>{err}</option>}
      </select>
    </span>
  );
}
