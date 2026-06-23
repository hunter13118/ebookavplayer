import { useEffect, useState } from "react";
import { fetchJobStatus, backendConfigured } from "../api.js";

/** Live ingest job panel — polls GET /ingest/:job_id for stage + debug_log. */
export default function IngestActivity({ jobs, onDone }) {
  const [snap, setSnap] = useState([]);

  useEffect(() => {
    if (!backendConfigured() || !jobs?.length) {
      setSnap([]);
      return undefined;
    }
    let alive = true;

    async function poll() {
      const out = await Promise.all(jobs.map(async (row) => {
        if (!row.job_id) return { ...row, done: false, errored: false };
        try {
          const st = await fetchJobStatus(row.job_id);
          const done = st.status === "done" || st.stage === "done";
          const errored = st.status === "error" || st.stage === "error";
          if (done || errored) onDone?.(row.book_id, st);
          return {
            ...row,
            stage: st.stage || st.status,
            progress: st.progress ?? row.progress ?? 0,
            detail: st.detail || "",
            debug_log: st.debug_log || [],
            status: st.status,
            done,
            errored,
          };
        } catch {
          return { ...row, done: false, errored: false };
        }
      }));
      if (alive) setSnap(out.filter((r) => !r.done && !r.errored));
    }

    poll();
    const t = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [jobs, onDone]);

  if (!snap.length) return null;

  return (
    <section className="vae-ingest-activity" data-testid="ingest-activity">
      <h2 className="vae-lib-heading">Processing</h2>
      {snap.map((row) => {
        const pct = Math.round((row.progress || 0) * 100);
        const lastLog = (row.debug_log || []).slice(-3);
        return (
          <details key={row.job_id || row.book_id} className="vae-ingest-row" open>
            <summary>
              <strong>{row.title || row.book_id}</strong>
              {" · "}
              {row.stage || "queued"} · {pct}%
              {row.detail ? ` — ${row.detail}` : ""}
            </summary>
            {row.errored && (
              <p className="vae-upload-err">Ingest failed — expand for log, or retry upload.</p>
            )}
            {!row.errored && pct < 48 && (
              <p className="vae-ingest-hint">
                Text becomes readable around 45–50%. Art fills in after that — click the card when progress allows.
              </p>
            )}
            {lastLog.length > 0 && (
              <ul className="vae-ingest-log">
                {lastLog.map((e, i) => (
                  <li key={`${e.at || i}-${e.msg}`}>
                    [{e.phase}] {e.msg}
                  </li>
                ))}
              </ul>
            )}
            <p className="vae-ingest-api-hint">
              Debug: GET /api/ingest/{row.job_id}
            </p>
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
      ...prev,
      ...p,
      title: prev.title || p.title,
      progress: Math.max(prev.progress || 0, p.progress || 0),
    });
  }
  return [...byId.values()].sort((a, b) => (a.title || "").localeCompare(b.title || ""));
}
