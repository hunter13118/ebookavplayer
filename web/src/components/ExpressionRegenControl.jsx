/** Collapsible "redo one expression" control — shared by CharacterRosterSheet
 * (browse view) and ReplaceArtSheet (the main "Replace art" / regen sheet),
 * per the user's ask that it live in both places. Only meaningful for
 * primary characters (the only ones expression art ever generates for) with
 * a base portrait already committed. There's no "regenerate all" here by
 * design — pick one bucket at a time, same cost-gate as everywhere else in
 * this feature. */
import { useEffect, useRef, useState } from "react";
import { regenExpressionSprite, subscribeJobEvents, jobEventToStatus } from "../api.js";

// Mirrors worker/_shared/edge-imaging.js's DEFAULT_EXPRESSIVE_BUCKETS — the
// only buckets ever generated (cost control: 4, not the full 16-bucket
// vocabulary). Keep these two lists in sync if that ever changes.
export const REGENERATABLE_BUCKETS = ["happy", "angry", "sad", "surprised"];

export const BUCKET_LABELS = {
  happy: "Happy",
  sad: "Sad",
  angry: "Angry",
  surprised: "Surprised",
  whisper: "Whisper",
  yell: "Yell",
  scared: "Scared",
  excited: "Excited",
  embarrassed: "Embarrassed",
  smug: "Smug",
  tender: "Tender",
  nervous: "Nervous",
  sarcastic: "Sarcastic",
  determined: "Determined",
  desperate: "Desperate",
};

export function bucketLabel(bucket) {
  return BUCKET_LABELS[bucket] || bucket;
}

export function canRegenExpression(character) {
  return character?.importance === "primary" && Boolean(character?.sprite);
}

export default function ExpressionRegenControl({ bookId, character, onRegenerated }) {
  const [expanded, setExpanded] = useState(false);
  const [bucket, setBucket] = useState(REGENERATABLE_BUCKETS[0]);
  const [state, setState] = useState({ phase: "idle", detail: "" }); // idle | queued | working | done | error
  const unsubRef = useRef(null);

  useEffect(() => () => unsubRef.current?.(), []);

  async function startRegen() {
    unsubRef.current?.();
    setState({ phase: "queued", detail: "" });
    try {
      const { job_id } = await regenExpressionSprite(bookId, character.id, bucket);
      unsubRef.current = subscribeJobEvents(job_id, {
        onEvent: (ev) => {
          const st = jobEventToStatus(ev);
          if (st.status === "error") {
            setState({ phase: "error", detail: st.detail || st.error || "Regen failed." });
            unsubRef.current?.();
            unsubRef.current = null;
            return;
          }
          if (st.status === "done") {
            setState({ phase: "done", detail: "" });
            unsubRef.current?.();
            unsubRef.current = null;
            onRegenerated?.();
            return;
          }
          setState({ phase: "working", detail: st.detail || "" });
        },
      });
    } catch (e) {
      setState({ phase: "error", detail: e.message || "Could not start regen." });
    }
  }

  const busy = state.phase === "queued" || state.phase === "working";

  return (
    <div className="vae-roster-regen">
      <button
        type="button"
        className="vae-roster-expr-toggle"
        onClick={() => setExpanded((v) => !v)}
        data-testid={`regen-expr-toggle-${character.id}`}
        aria-expanded={expanded}
      >
        {expanded ? "▾" : "▸"} Regenerate expression
      </button>
      {expanded && (
        <div className="vae-roster-regen-body" data-testid={`regen-expr-body-${character.id}`}>
          <select
            className="vae-roster-regen-select"
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            disabled={busy}
            data-testid={`regen-expr-select-${character.id}`}
          >
            {REGENERATABLE_BUCKETS.map((b) => (
              <option key={b} value={b}>{bucketLabel(b)}</option>
            ))}
          </select>
          <button
            type="button"
            className="vae-btn-xs"
            onClick={startRegen}
            disabled={busy}
            data-testid={`regen-expr-btn-${character.id}`}
          >
            {busy ? "Generating…" : "Regenerate"}
          </button>
          {state.phase === "working" && state.detail && (
            <p className="vae-sheet-hint vae-roster-regen-status">{state.detail}</p>
          )}
          {state.phase === "done" && (
            <p className="vae-sheet-hint vae-roster-regen-status">
              {bucketLabel(bucket)} regenerated.
            </p>
          )}
          {state.phase === "error" && (
            <p className="vae-sheet-hint vae-roster-regen-status vae-roster-regen-error">
              {state.detail}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
