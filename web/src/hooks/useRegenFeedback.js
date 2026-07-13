import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeJobEvents, jobEventToStatus, unlockImaging, fetchJobStatus } from "../api.js";
import { useClientBanners } from "./useClientBanners.js";
import { logLineFromEvent } from "./useJobEvents.js";
import { summarizeRegenTarget } from "../regenSummary.js";
import { computeImagingProgress, waitingOnProvider } from "../../../worker/_shared/imaging-progress-ui.js";

const STALL_MS = 600_000;
const IMAGING_START = 0.08;

function computeProgress(st, opts) {
  return computeImagingProgress(st, opts);
}

const idleImaging = () => ({
  active: false,
  progress: 1,
  stage: "done",
  label: null,
  providerWait: false,
});

function regenStorageKey(bookId) {
  return `vae-regen-job:${bookId}`;
}

function readStoredRegen(bookId) {
  try {
    const raw = sessionStorage.getItem(regenStorageKey(bookId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStoredRegen(bookId, data) {
  try {
    if (!data) sessionStorage.removeItem(regenStorageKey(bookId));
    else sessionStorage.setItem(regenStorageKey(bookId), JSON.stringify(data));
  } catch { /* quota / private mode */ }
}

function compareReviewStorageKey(bookId) {
  return `vae-compare-lock:${bookId}`;
}

function hasPendingCompareReview(bookId) {
  try {
    const raw = sessionStorage.getItem(compareReviewStorageKey(bookId));
    if (!raw) return false;
    const data = JSON.parse(raw);
    return Boolean(data?.awaitingUserChoice || data?.lockedCompare);
  } catch {
    return false;
  }
}

/** Regen feedback: banners + imaging progress bar driven by job SSE only (no client polling). */
export function useRegenFeedback(bookId) {
  const { banners, pushBanner } = useClientBanners();
  const [imagingJob, setImagingJob] = useState(idleImaging);
  const [processingLog, setProcessingLog] = useState([]);
  const cleanupRef = useRef(null);
  const bookIdRef = useRef(bookId);
  bookIdRef.current = bookId;

  const stopImaging = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    writeStoredRegen(bookIdRef.current, null);
    setImagingJob(idleImaging());
  }, []);

  // jobId scopes the unlock server-side to that specific job — see
  // unlockImaging's docstring for the real, confirmed-live bug this fixes:
  // without it, THIS hook's own stale tracking (e.g. surviving across
  // several regen attempts in one open tab) could force-unlock and
  // stale-mark a completely different, still-legitimately-running job.
  const releaseServerLock = useCallback(async (jobId) => {
    const id = bookIdRef.current;
    if (!id) return;
    try {
      await unlockImaging(id, { force: true, jobId });
    } catch { /* best-effort */ }
  }, []);

  const failRegenStart = useCallback((message) => {
    pushBanner("error", "regen_request_failed", message || "Could not start image regen.");
  }, [pushBanner]);

  const pushLog = useCallback((ev) => {
    const row = logLineFromEvent(ev);
    if (!row) return;
    setProcessingLog((prev) => {
      const key = `${row.ts}:${row.type}:${row.text}`;
      if (prev.some((p) => `${p.ts}:${p.type}:${p.text}` === key)) return prev;
      return [...prev, row].slice(-120);
    });
  }, []);

  const applyStatus = useCallback((st, targetLabel, { onDone, onError, holdAfterDone, startedAt, lastProgressRef, doneOnceRef, jobId }) => {
    const lastProgress = lastProgressRef.current;
    const nextProgress = computeProgress(st, { lastProgress, startedAt });
    lastProgressRef.current = nextProgress;
    const providerWait = waitingOnProvider(st.detail);

    setImagingJob((prev) => ({
      ...prev,
      active: true,
      progress: Math.max(nextProgress, prev.progress || 0),
      stage: st.stage || st.status || "imaging",
      label: st.detail ? `${targetLabel} — ${st.detail}` : targetLabel,
      providerWait,
    }));

    if (st.status === "error") {
      const detail = st.detail || st.error || "";
      pushBanner(
        "error",
        "regen_failed",
        detail ? `Regen failed (${targetLabel}): ${detail}` : `Regen failed for ${targetLabel}.`,
      );
      releaseServerLock(jobId).then(() => {});
      onError?.(detail);
      stopImaging();
      return true;
    }

    if (st.status === "done") {
      if (doneOnceRef?.current) return true;
      if (doneOnceRef) doneOnceRef.current = true;
      lastProgressRef.current = 1;
      setImagingJob((prev) => ({
        ...prev,
        active: true,
        progress: 1,
        stage: "done",
        providerWait: false,
        label: holdAfterDone ? `${targetLabel} — review new art` : prev.label,
      }));
      pushBanner(
        "info",
        "regen_done",
        holdAfterDone
          ? `Art regen finished for ${targetLabel} — review the before/after picker.`
          : `Art regen finished for ${targetLabel}.`,
      );
      onDone?.(st);
      if (!holdAfterDone) setTimeout(() => stopImaging(), 900);
      return true;
    }

    return false;
  }, [pushBanner, releaseServerLock, stopImaging]);

  const trackImagingJob = useCallback((jobId, targetLabel, { onDone, onError, holdAfterDone } = {}) => {
    cleanupRef.current?.();
    cleanupRef.current = null;

    const startedAt = Date.now();
    const lastProgressRef = { current: IMAGING_START };
    const doneOnceRef = { current: false };

    writeStoredRegen(bookIdRef.current, {
      jobId, label: targetLabel, startedAt, regen: true, holdAfterDone: Boolean(holdAfterDone),
    });
    setProcessingLog([]);

    setImagingJob({
      active: true,
      progress: IMAGING_START,
      stage: "imaging",
      label: targetLabel,
      providerWait: false,
    });

    let alive = true;
    let stallTimer;

    function resetStallTimer() {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (!alive) return;
        pushBanner(
          "warn",
          "regen_stalled",
          `Regen for ${targetLabel} is still running — check the processing log below.`,
        );
      }, STALL_MS);
    }

    const unsub = subscribeJobEvents(jobId, {
      onEvent: (ev) => {
        if (!alive) return;
        resetStallTimer();
        pushLog(ev);
        const st = jobEventToStatus(ev);
        if (applyStatus(st, targetLabel, {
          onDone, onError, holdAfterDone, startedAt, lastProgressRef, doneOnceRef, jobId,
        })) return;
      },
      onError: () => { /* SSE reconnects internally — server KV watch backs progress */ },
    });

    resetStallTimer();
    cleanupRef.current = () => {
      alive = false;
      clearTimeout(stallTimer);
      unsub();
    };
    return cleanupRef.current;
  }, [applyStatus, pushBanner, pushLog]);

  const ackRegenStart = useCallback((jobId, meta = {}, { onDone, onError, holdAfterDone } = {}) => {
    if (!jobId) {
      pushBanner("error", "regen_no_job", "Server accepted the request but returned no job id.");
      return () => {};
    }
    const target = summarizeRegenTarget(meta);
    pushBanner("info", "regen_started", `Regen started for ${target} — running in the background.`);
    const label = meta?.label || `Regenerating ${target}`;
    const hold = holdAfterDone ?? meta?.compare !== false;
    return trackImagingJob(jobId, label, { onDone, onError, holdAfterDone: hold });
  }, [pushBanner, trackImagingJob]);

  useEffect(() => {
    const stored = readStoredRegen(bookId);
    if (!stored?.jobId || !stored?.regen || cleanupRef.current) return undefined;
    if (hasPendingCompareReview(bookId)) return undefined;

    let cancelled = false;
    // A stored job can outlive its own job — reopening the tab (or just
    // remounting) days later used to resume tracking unconditionally,
    // subscribing to a job that finished (or errored, or was cleaned up
    // out of KV) long ago. Since a dead job never emits another SSE event,
    // the banner got stuck showing its very first "queued" state forever —
    // confirmed live: "Regenerating 2 images — queued · 25%" with a
    // processing log of nothing but repeated "queued" entries at
    // different timestamps (each SSE reconnect re-delivering the same
    // stale initial event, never a real one). Check the job's actual
    // current status once before resuming; only keep tracking it if it's
    // genuinely still in flight.
    fetchJobStatus(stored.jobId)
      .then((job) => {
        if (cancelled) return;
        if (job?.status === "done" || job?.status === "error") {
          writeStoredRegen(bookId, null);
          return;
        }
        trackImagingJob(stored.jobId, stored.label || "art", {
          holdAfterDone: stored.holdAfterDone,
          onDone: () => {},
        });
      })
      .catch(() => {
        // Job vanished entirely (e.g. KV expired) — nothing to resume.
        if (!cancelled) writeStoredRegen(bookId, null);
      });

    return () => { cancelled = true; };
  }, [bookId, trackImagingJob]);

  return {
    clientBanners: banners,
    ackRegenStart,
    failRegenStart,
    imagingJob,
    processingLog,
    stopImaging,
    releaseServerLock,
  };
}
