/** Expression-art control — shared by CharacterRosterSheet (browse view) and
 * ReplaceArtSheet (the main "Replace art" / regen sheet). Three states:
 * - Not opted in (secondary/background character, wants_expressions unset):
 *   just a checkbox to opt the character in.
 * - Opted in (primary, or wants_expressions: true) but no base portrait yet:
 *   a hint — nothing to condition expression art on.
 * - Opted in with a base portrait: the actual regen controls — redo one
 *   bucket, or all of them.
 */
import { useEffect, useRef, useState } from "react";
import {
  regenExpressionSprite, setCharacterWantsExpressions, subscribeJobEvents, jobEventToStatus,
} from "../api.js";

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

// Mirrors worker/_shared/edge-imaging.js's wantsExpressionSprites() — kept
// as a separate small function (not imported, worker code isn't bundled
// into the web app) so the two sides can't silently disagree either.
export function wantsExpressionSprites(character) {
  return character?.importance === "primary" || Boolean(character?.wants_expressions);
}

export function canRegenExpression(character) {
  return wantsExpressionSprites(character) && Boolean(character?.sprite);
}

export default function ExpressionRegenControl({ bookId, character, onRegenerated }) {
  const [expanded, setExpanded] = useState(false);
  const [bucket, setBucket] = useState(REGENERATABLE_BUCKETS[0]);
  const [state, setState] = useState({ phase: "idle", detail: "", target: "" }); // idle | queued | working | done | error
  const [optInBusy, setOptInBusy] = useState(false);
  const [optInErr, setOptInErr] = useState("");
  const unsubRef = useRef(null);

  useEffect(() => () => unsubRef.current?.(), []);

  const isPrimary = character?.importance === "primary";
  const optedIn = wantsExpressionSprites(character);
  const hasSprite = Boolean(character?.sprite);

  async function toggleOptIn(next) {
    setOptInBusy(true);
    setOptInErr("");
    try {
      await setCharacterWantsExpressions(bookId, { id: character.id, wants_expressions: next });
      onRegenerated?.();
    } catch (e) {
      setOptInErr(e.message || "Could not update.");
    } finally {
      setOptInBusy(false);
    }
  }

  async function startRegen(target) {
    unsubRef.current?.();
    setState({ phase: "queued", detail: "", target });
    try {
      const { job_id } = await regenExpressionSprite(bookId, character.id, target);
      unsubRef.current = subscribeJobEvents(job_id, {
        onEvent: (ev) => {
          const st = jobEventToStatus(ev);
          if (st.status === "error") {
            setState({ phase: "error", detail: st.detail || st.error || "Regen failed.", target });
            unsubRef.current?.();
            unsubRef.current = null;
            return;
          }
          if (st.status === "done") {
            setState({ phase: "done", detail: "", target });
            unsubRef.current?.();
            unsubRef.current = null;
            onRegenerated?.();
            return;
          }
          setState({ phase: "working", detail: st.detail || "", target });
        },
      });
    } catch (e) {
      setState({ phase: "error", detail: e.message || "Could not start regen.", target });
    }
  }

  const busyOne = state.target === bucket && (state.phase === "queued" || state.phase === "working");
  const busyAll = state.target === "all" && (state.phase === "queued" || state.phase === "working");
  const anyBusy = busyOne || busyAll;

  if (!optedIn) {
    return (
      <div className="vae-roster-regen" data-testid={`regen-expr-optin-wrap-${character.id}`}>
        <label className="vae-roster-regen-optin">
          <input
            type="checkbox"
            checked={false}
            disabled={optInBusy}
            onChange={() => toggleOptIn(true)}
            data-testid={`regen-expr-optin-${character.id}`}
          />
          {" "}{optInBusy ? "Opting in…" : "Generate expression art for this character"}
        </label>
        {optInErr && <p className="vae-sheet-hint vae-roster-regen-error">{optInErr}</p>}
      </div>
    );
  }

  if (!hasSprite) {
    return (
      <p className="vae-sheet-hint vae-roster-regen-empty">
        Generate a base portrait first to enable expression art.
      </p>
    );
  }

  return (
    <div className="vae-roster-regen">
      {!isPrimary && (
        <label className="vae-roster-regen-optin">
          <input
            type="checkbox"
            checked
            disabled={optInBusy}
            onChange={() => toggleOptIn(false)}
            data-testid={`regen-expr-optin-${character.id}`}
          />
          {" "}{optInBusy ? "Updating…" : "Expression art enabled"}
        </label>
      )}
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
            disabled={anyBusy}
            data-testid={`regen-expr-select-${character.id}`}
          >
            {REGENERATABLE_BUCKETS.map((b) => (
              <option key={b} value={b}>{bucketLabel(b)}</option>
            ))}
          </select>
          <button
            type="button"
            className="vae-btn-xs"
            onClick={() => startRegen(bucket)}
            disabled={anyBusy}
            data-testid={`regen-expr-btn-${character.id}`}
          >
            {busyOne ? "Generating…" : "Regenerate"}
          </button>
          <button
            type="button"
            className="vae-btn-xs"
            onClick={() => startRegen("all")}
            disabled={anyBusy}
            data-testid={`regen-expr-all-btn-${character.id}`}
            title="Regenerate every expression for this character"
          >
            {busyAll ? "Generating all…" : "Regenerate all"}
          </button>
          {state.phase === "working" && state.detail && (
            <p className="vae-sheet-hint vae-roster-regen-status">{state.detail}</p>
          )}
          {state.phase === "done" && (
            <p className="vae-sheet-hint vae-roster-regen-status">
              {state.target === "all" ? "All expressions regenerated." : `${bucketLabel(state.target)} regenerated.`}
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
