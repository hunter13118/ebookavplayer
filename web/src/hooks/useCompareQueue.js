/** Compare picker — modal stays open until user picks Keep previous / Keep new. */



import { useCallback, useEffect, useRef, useState } from "react";

import { subscribeJobEvents, jobEventToStatus } from "../api.js";

/**
 * The local wait-queue being empty does NOT mean the job is done — a fast
 * item (e.g. the cover) can resolve before a slower one (e.g. a character)
 * has even finished generating. Only tear down the session (unsubscribe
 * from SSE, forget the job id) once the backend has actually reported the
 * job done/errored — otherwise later results for the same still-running job
 * arrive after the session is forgotten and get silently dropped.
 */
export function isJobStillRunning(streamJobId, lastStatus) {
  return streamJobId != null
    && lastStatus?.status !== "done"
    && lastStatus?.status !== "error";
}



function labelFor(book, kind, key) {

  if (kind === "cover") return "Cover";

  if (kind === "inserts") {

    const n = parseInt(key, 10);

    return Number.isNaN(n) ? `Moment ${key}` : `Moment · slide ${n + 1}`;

  }

  if (kind === "characters") return book?.characters?.[key]?.name || key;

  const scene = (book?.scenes || []).find((s) => s.id === key);

  return scene?.title || scene?.location || key;

}



function eligibleComparisons(rows = []) {

  return rows.filter((c) => c?.after_url);

}



function compareStorageKey(bookId) {

  return `vae-compare-lock:${bookId}`;

}



function readCompareSession(bookId) {

  if (!bookId) return null;

  try {

    const raw = sessionStorage.getItem(compareStorageKey(bookId));

    return raw ? JSON.parse(raw) : null;

  } catch {

    return null;

  }

}



function writeCompareSession(bookId, data) {

  if (!bookId) return;

  try {

    if (!data) sessionStorage.removeItem(compareStorageKey(bookId));

    else sessionStorage.setItem(compareStorageKey(bookId), JSON.stringify(data));

  } catch { /* quota / private mode */ }

}



function hydrateFromSession(bookId) {

  const stored = readCompareSession(bookId);

  if (!stored?.jobId) {

    return {

      lockedCompare: null,

      queueRemaining: 0,

      streamJobId: null,

      sessionJobId: null,

      waitQueue: [],

      seen: [],

      awaitingUserChoice: false,

    };

  }

  return {

    lockedCompare: stored.lockedCompare || null,

    queueRemaining: stored.queueRemaining ?? (stored.waitQueue?.length || 0),

    streamJobId: stored.awaitingUserChoice ? null : stored.jobId,

    sessionJobId: stored.jobId,

    waitQueue: stored.waitQueue || [],

    seen: stored.seen || [],

    awaitingUserChoice: Boolean(stored.awaitingUserChoice),

  };

}



export function useCompareQueue(bookId, book) {

  const hydrated = useRef(null);

  if (hydrated.current?.bookId !== bookId) {

    hydrated.current = { bookId, ...hydrateFromSession(bookId) };

  }

  const boot = hydrated.current;



  /** Shown in the modal — cleared ONLY by completeCompareChoice(). */

  const [lockedCompare, setLockedCompare] = useState(boot.lockedCompare);

  const [queueRemaining, setQueueRemaining] = useState(boot.queueRemaining);

  const [streamJobId, setStreamJobId] = useState(boot.streamJobId);

  const [awaitingUserChoice, setAwaitingUserChoice] = useState(boot.awaitingUserChoice);

  // How many items have been resolved (Keep previous/new) so far this
  // session — surfaced alongside queueRemaining so the user has a persistent
  // "N resolved, M pending" signal even between compare-modal popups.
  const [resolvedCount, setResolvedCount] = useState(0);



  const sessionJobRef = useRef(boot.sessionJobId);

  const waitQueueRef = useRef(boot.waitQueue);

  const seenRef = useRef(new Set(boot.seen));

  const lastStatusRef = useRef(null);

  const lockedRef = useRef(null);

  const bookRef = useRef(book);

  bookRef.current = book;



  useEffect(() => {

    lockedRef.current = lockedCompare;

  }, [lockedCompare]);



  useEffect(() => {

    const next = hydrateFromSession(bookId);

    sessionJobRef.current = next.sessionJobId;

    waitQueueRef.current = next.waitQueue;

    seenRef.current = new Set(next.seen);

    lastStatusRef.current = null;

    // Session can lag behind UI (e.g. startCompareJob cleared storage before persist caught up).
    if (lockedRef.current && !next.lockedCompare) return;

    lockedRef.current = next.lockedCompare;

    setLockedCompare(next.lockedCompare);

    setQueueRemaining(next.queueRemaining);

    setStreamJobId(next.streamJobId);

    setAwaitingUserChoice(next.awaitingUserChoice);

  }, [bookId]);



  const persistSession = useCallback(() => {
    if (!bookId) return;
    const jobId = sessionJobRef.current;
    if (!jobId) {
      writeCompareSession(bookId, null);
      return;
    }
    writeCompareSession(bookId, {
      jobId,
      lockedCompare: lockedRef.current,
      waitQueue: waitQueueRef.current,
      queueRemaining: waitQueueRef.current.length,
      seen: [...seenRef.current],
      awaitingUserChoice: Boolean(
        lockedRef.current || waitQueueRef.current.length > 0 || awaitingUserChoice,
      ),
    });
  }, [bookId, awaitingUserChoice]);



  useEffect(() => {

    persistSession();

  }, [lockedCompare, queueRemaining, awaitingUserChoice, streamJobId, persistSession]);



  const offerComparison = useCallback((row, jobId) => {

    if (!row?.after_url || !jobId || jobId !== sessionJobRef.current) return false;

    const key = `${jobId}:${row.kind}:${row.key}`;

    if (seenRef.current.has(key)) return false;

    seenRef.current.add(key);



    const item = {

      ...row,

      jobId,

      label: labelFor(bookRef.current, row.kind, row.key),

    };



    if (lockedRef.current) {

      waitQueueRef.current = [...waitQueueRef.current, item];

      setQueueRemaining(waitQueueRef.current.length);

      return true;

    }

    lockedRef.current = item;

    setLockedCompare(item);

    setAwaitingUserChoice(true);

    return true;

  }, []);



  const ingestRows = useCallback((rows = [], jobId = sessionJobRef.current) => {

    if (!jobId || jobId !== sessionJobRef.current) return 0;

    let added = 0;

    for (const c of eligibleComparisons(rows)) {

      if (offerComparison(c, jobId)) added += 1;

    }

    if (added > 0) setAwaitingUserChoice(true);

    return added;

  }, [offerComparison]);



  /** New regen — only a different job id clears an open picker. */

  const startCompareJob = useCallback((jobId) => {

    if (!jobId) return;

    if (sessionJobRef.current === jobId && (lockedRef.current || waitQueueRef.current.length > 0)) {

      setStreamJobId(jobId);

      return;

    }

    sessionJobRef.current = jobId;

    seenRef.current = new Set();

    lastStatusRef.current = null;

    waitQueueRef.current = [];

    setQueueRemaining(0);

    setResolvedCount(0);

    lockedRef.current = null;

    setLockedCompare(null);

    setAwaitingUserChoice(false);

    setStreamJobId(jobId);

    writeCompareSession(bookId, null);

  }, [bookId]);



  /** Intentionally a no-op — nothing auto-dismisses the compare modal. */

  const stopCompareJob = useCallback(() => {}, []);



  /** Called only after Keep previous / Keep new succeeds. */

  const completeCompareChoice = useCallback(() => {

    setResolvedCount((n) => n + 1);

    if (waitQueueRef.current.length > 0) {

      const [next, ...rest] = waitQueueRef.current;

      waitQueueRef.current = rest;

      setQueueRemaining(rest.length);

      lockedRef.current = next;

      setLockedCompare(next);

      setAwaitingUserChoice(true);

      return true;

    }

    lockedRef.current = null;

    setLockedCompare(null);

    setQueueRemaining(0);

    if (isJobStillRunning(streamJobId, lastStatusRef.current)) {

      setAwaitingUserChoice(false);

      writeCompareSession(bookId, {
        jobId: sessionJobRef.current,
        lockedCompare: null,
        waitQueue: [],
        seen: [...seenRef.current],
        awaitingUserChoice: false,
      });

      return false;

    }

    setAwaitingUserChoice(false);

    sessionJobRef.current = null;

    setStreamJobId(null);

    seenRef.current = new Set();

    lastStatusRef.current = null;

    writeCompareSession(bookId, null);

    return false;

  }, [bookId, streamJobId]);



  const ingestCompareFromJob = useCallback((id, comparisons) => {

    if (!id || id !== sessionJobRef.current) return 0;

    const rows = comparisons?.length

      ? comparisons

      : (lastStatusRef.current?.comparisons || []);

    return ingestRows(rows, id);

  }, [ingestRows]);



  const handleJobEvent = useCallback((ev, boundJobId) => {

    if (boundJobId !== sessionJobRef.current) return;

    const st = jobEventToStatus(ev);

    lastStatusRef.current = st;

    if (st.comparisons?.length) ingestRows(st.comparisons, boundJobId);



    const done = ev.type === "done" || ev.type === "error"

      || st.status === "done" || st.status === "error";

    if (done) {

      const rows = st.comparisons || [];

      ingestRows(rows, boundJobId);

      if (!lockedRef.current && waitQueueRef.current.length > 0) {

        const [next, ...rest] = waitQueueRef.current;

        waitQueueRef.current = rest;

        setQueueRemaining(rest.length);

        lockedRef.current = next;

        setLockedCompare(next);

      }

      if (!lockedRef.current) {

        for (const c of eligibleComparisons(rows)) {

          const dedupeKey = `${boundJobId}:${c.kind}:${c.key}`;

          seenRef.current.delete(dedupeKey);

          if (offerComparison(c, boundJobId)) break;

        }

      }

      const hasChoice = lockedRef.current != null || waitQueueRef.current.length > 0;

      if (hasChoice || eligibleComparisons(rows).length > 0) {
        setAwaitingUserChoice(true);
      }

      setStreamJobId(null);

    }

  }, [ingestRows, offerComparison]);



  useEffect(() => {

    if (!streamJobId || !bookId) return undefined;



    const boundJobId = streamJobId;

    let alive = true;



    const unsub = subscribeJobEvents(boundJobId, {

      onEvent: (ev) => {

        if (!alive) return;

        handleJobEvent(ev, boundJobId);

      },

      onError: () => { /* reconnect handled by subscribeJobEvents */ },

    });



    return () => {

      alive = false;

      unsub();

    };

  }, [streamJobId, bookId, handleJobEvent]);



  const comparePending = awaitingUserChoice

    || lockedCompare != null

    || queueRemaining > 0

    || streamJobId != null;



  return {

    compareOpen: lockedCompare != null,

    activeCompare: lockedCompare,

    queueRemaining,

    resolvedCount,

    comparePending,

    startCompareJob,

    stopCompareJob,

    completeCompareChoice,

    ingestCompareFromJob,

    /** @deprecated use completeCompareChoice */

    resolveCompare: completeCompareChoice,

  };

}


