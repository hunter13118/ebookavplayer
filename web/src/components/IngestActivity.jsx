import { useEffect, useRef, useState } from "react";
import { subscribeJobEvents, jobEventToStatus, backendConfigured } from "../api.js";
import ProcessingLog from "./ProcessingLog.jsx";
import { logLineFromEvent } from "../hooks/useJobEvents.js";

function stepSummary(row) {
  if (row.step_index != null && row.step_total != null) {
    return `${row.step_index}/${row.step_total}`;
  }
  return null;
}

function mergeEventRow(row, ev) {
  const st = jobEventToStatus(ev);
  const done = ev.type === "done" || st.status === "done" || st.stage === "done";
  const errored = ev.type === "error" || st.status === "error" || st.stage === "error";
  return {
    ...row,
    stage: st.stage || st.status || row.stage,
    progress: st.progress ?? row.progress ?? 0,
    detail: st.detail || row.detail || "",
    phase: st.phase ?? row.phase,
    phase_label: st.phase_label ?? row.phase_label,
    step: st.step ?? row.step,
    step_index: st.step_index ?? row.step_index,
    step_total: st.step_total ?? row.step_total,
    progress_meta: st.progress_meta ?? row.progress_meta,
    debug_log: st.debug_log || row.debug_log || [],
    event_log: row.event_log || [],
    status: st.status || row.status,
    done,
    errored,
  };
}

/** Live ingest job panel — SSE subscription per job for phase + step progress. */
export default function IngestActivity({ jobs, onDone }) {
  const [snap, setSnap] = useState([]);
  const rowsRef = useRef(new Map());
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!backendConfigured() || !jobs?.length) {
      rowsRef.current = new Map();
      setSnap([]);
      return undefined;
    }

    const unsubs = [];
    let alive = true;

    for (const row of jobs) {
      if (!row.job_id) continue;

      rowsRef.current.set(row.job_id, { ...row, done: false, errored: false, event_log: [] });

      const apply = (ev) => {
        const prev = rowsRef.current.get(row.job_id) || row;
        const logRow = logLineFromEvent(ev);
        const event_log = logRow
          ? [...(prev.event_log || []), logRow].slice(-80)
          : (prev.event_log || []);
        const merged = mergeEventRow({ ...prev, event_log }, ev);
        if (merged.done || merged.errored) {
          onDoneRef.current?.(row.book_id, merged);
          rowsRef.current.delete(row.job_id);
        } else {
          rowsRef.current.set(row.job_id, merged);
        }
        if (alive) {
          setSnap([...rowsRef.current.values()].filter((r) => !r.done && !r.errored));
        }
      };

      unsubs.push(subscribeJobEvents(row.job_id, {
        onEvent: apply,
        onError: () => { /* reconnect handled internally */ },
      }));
    }

    setSnap([...rowsRef.current.values()].filter((r) => !r.done && !r.errored));

    return () => {
      alive = false;
      for (const u of unsubs) u();
    };
  }, [jobs]);

  if (!snap.length) return null;

  return (
    <section className="vae-ingest-activity" data-testid="ingest-activity">
      <h2 className="vae-lib-heading">Processing</h2>
      {snap.map((row) => {
        const pct = Math.round((row.progress || 0) * 100);
        const steps = stepSummary(row);
        const phaseLabel = row.phase_label || row.stage || "queued";
        const lastLog = (row.debug_log || []).slice(-5);
        return (
          <details key={row.job_id || row.book_id} className="vae-ingest-row" open>
            <summary>
              <strong>{row.title || row.book_id}</strong>
              {" · "}
              {phaseLabel}
              {steps ? ` · step ${steps}` : ""}
              {" · "}
              {pct}%
            </summary>

            <div className="vae-ingest-progress-wrap">
              <div className="vae-ingest-progress-bar" role="progressbar"
                aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
                aria-label={`${phaseLabel} ${pct}%`}>
                <div className="vae-ingest-progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="vae-ingest-progress-meta">
                {row.phase && (
                  <span className="vae-ingest-phase" data-phase={row.phase}>{row.phase}</span>
                )}
                {row.detail && <span className="vae-ingest-detail">{row.detail}</span>}
              </div>
            </div>

            {row.errored && (
              <p className="vae-upload-err">Ingest failed — expand for log, or retry upload.</p>
            )}
            {!row.errored && row.phase === "extracting" && pct < 45 && (
              <p className="vae-ingest-hint">
                Script extraction runs in chunks — progress advances per LLM pass.
              </p>
            )}
            {!row.errored && row.phase === "imaging" && (
              <p className="vae-ingest-hint">
                Generating character sprites and backgrounds — each image advances the bar.
              </p>
            )}
            <ProcessingLog entries={row.event_log || []} />
            {lastLog.length > 0 && (
              <ul className="vae-ingest-log">
                {lastLog.map((e, i) => (
                  <li key={`${e.at || i}-${e.msg}`}>
                    [{e.phase}] {e.msg}
                  </li>
                ))}
              </ul>
            )}
          </details>
        );
      })}
    </section>
  );
}

export function mergeCatalogEntries(serverList, pending = []) {
  const byId = new Map((serverList || []).map((b) => [b.book_id, { ...b }]));
  for (const p of pending) {
    const prev = byId.get(p.book_id);
    if (!prev) {
      byId.set(p.book_id, { ...p });
      continue;
    }
    byId.set(p.book_id, {
      ...p,
      ...prev,
      title: prev.title || p.title,
      progress: Math.max(prev.progress || 0, p.progress || 0),
      phase_label: prev.phase_label || p.phase_label,
      detail: prev.detail || prev.detail,
    });
  }
  return [...byId.values()].sort((a, b) => (a.title || "").localeCompare(b.title || ""));
}
