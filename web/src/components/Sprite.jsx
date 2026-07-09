import { useState, useEffect } from "react";
import { spriteVisual, gradientFromSeed } from "../media.js";
import { normalizeExpressionBucket } from "../expressionBucket.js";

export default function Sprite({
  character, spotlight, dim, borders, pixelFilter, speaking, expression, slotX = 50, lineKey,
}) {
  const [broken, setBroken] = useState(false);
  const [entered, setEntered] = useState(false);
  useEffect(() => { setBroken(false); }, [character.sprite]);
  useEffect(() => {
    setEntered(false);
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, [character.character_id, character.id]);
  const v = broken ? gradientFromSeed(character.character_id || character.id || character.name)
    : spriteVisual(character.sprite);
  // Freeform values (e.g. "giggling") normalize onto one of the 16 canonical
  // buckets the CSS below actually has rules for — see EXPRESSION_SENSITIVITY_PLAN.md Phase 3a.
  const bucket = expression ? normalizeExpressionBucket(expression) : "normal";
  const cls = [
    "vae-sprite",
    entered ? "vae-sprite-visible" : "vae-sprite-enter",
    spotlight ? "spot" : "",
    dim ? "dim" : "",
    borders ? "bordered" : "",
    pixelFilter ? "pixel-filter" : "",
    speaking ? "speaking" : "idle",
    bucket !== "normal" ? `expr-${bucket}` : "",
  ].join(" ").trim();
  // Remount on every line (not just sprite/character change) whenever there's
  // an active expression, so the short punch-in/shake/etc. keyframe replays
  // even when the same bucket repeats on consecutive lines by this character.
  const artKey = bucket !== "normal"
    ? `${character.sprite || character.character_id}-${lineKey ?? ""}`
    : (character.sprite || character.character_id);
  const inner =
    v.type === "image" ? (
      <img src={v.url} alt={character.name} draggable={false}
        onError={() => setBroken(true)} />
    ) : v.type === "gradient" ? (
      <div className="vae-sprite-fill" style={{ background: v.css }}>
        <span>{(character.name || "?").slice(0, 1)}</span>
      </div>
    ) : (
      <div className="vae-sprite-fill narrator"><span>📖</span></div>
    );
  return (
    <div
      className={cls}
      style={{ "--slot-x": `${slotX}%` }}
      data-id={character.character_id || character.id}
      data-testid="sprite"
      data-state={spotlight ? "spotlight" : dim ? "dim" : "normal"}
    >
      <div className="vae-sprite-art" key={artKey}>
        {inner}
      </div>
      <div className="vae-sprite-name">{character.name}</div>
    </div>
  );
}
