import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeJobEvents, jobEventToStatus } from "../api.js";

export function logLineFromEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  const st = jobEventToStatus(ev);
  const ts = ev.ts || Date.now();
  const type = ev.type || "progress";
  let text = st.detail
    || (st.phase_label && st.step_index != null && st.step_total != null
      ? `${st.phase_label} · ${st.step_index}/${st.step_total}`
      : null)
    || st.phase_label
    || type;

  if (st.error && type === "error") {
    text = st.error;
  } else if (st.error && !String(text).includes(st.error)) {
    text = `${text} — ${st.error}`;
  }

  if (ev.provider && (type === "provider" || /Trying |Waiting on /i.test(String(text)))) {
    const target = ev.kind && ev.id != null ? `${ev.kind} · ${ev.id}` : "";
    text = target ? `${text} (${ev.provider} → ${target})` : `${text} (${ev.provider})`;
  }

  const dbg = st.debug_log;
  if (Array.isArray(dbg) && dbg.length) {
    const last = dbg[dbg.length - 1];
    const failMsg = last?.msg && /fail|error/i.test(String(last.msg)) ? last.msg : null;
    if (failMsg && !String(text).includes(failMsg)) {
      const errBit = last?.data?.error ? `: ${last.data.error}` : "";
      text = `${text} — ${failMsg}${errBit}`;
    }
  }

  return { ts, type, text, phase: st.phase || null, progress: st.progress };
}

/** One SSE subscription — accumulates a processing log; no HTTP polling. */
export function useJobEvents(jobId, { enabled = true, onEvent, onTerminal } = {}) {
  const [log, setLog] = useState([]);
  const [lastEvent, setLastEvent] = useState(null);
  const seenRef = useRef(new Set());
  const onEventRef = useRef(onEvent);
  const onTerminalRef = useRef(onTerminal);
  onEventRef.current = onEvent;
  onTerminalRef.current = onTerminal;

  const pushLog = useCallback((ev) => {
    const row = logLineFromEvent(ev);
    if (!row) return;
    const key = `${row.ts}:${row.type}:${row.text}`;
    if (seenRef.current.has(key)) return;
    seenRef.current.add(key);
    setLog((prev) => [...prev, row].slice(-120));
  }, []);

  useEffect(() => {
    if (!enabled || !jobId) {
      setLog([]);
      setLastEvent(null);
      seenRef.current = new Set();
      return undefined;
    }

    seenRef.current = new Set();
    setLog([]);

    const unsub = subscribeJobEvents(jobId, {
      onEvent: (ev) => {
        setLastEvent(ev);
        pushLog(ev);
        onEventRef.current?.(ev, jobEventToStatus(ev));
        const done = ev.type === "done" || ev.type === "error"
          || ev.status === "done" || ev.status === "error";
        if (done) onTerminalRef.current?.(ev, jobEventToStatus(ev));
      },
      onError: (err) => onTerminalRef.current?.(null, null, err),
    });

    return unsub;
  }, [jobId, enabled, pushLog]);

  return {
    log,
    lastEvent,
    status: lastEvent ? jobEventToStatus(lastEvent) : null,
    clearLog: () => {
      seenRef.current = new Set();
      setLog([]);
    },
  };
}

export function activeJobIdForBook(book = {}) {
  if (book.active_job_id) return book.active_job_id;
  if (book.job_id && book.status !== "ready" && book.status !== "error") return book.job_id;
  return null;
}
