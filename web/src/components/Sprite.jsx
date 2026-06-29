import { useState, useEffect } from "react";
import { spriteVisual, gradientFromSeed } from "../media.js";

export default function Sprite({
  character, spotlight, dim, borders, pixelFilter, speaking, expression, slotX = 50,
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
  const cls = [
    "vae-sprite",
    entered ? "vae-sprite-visible" : "vae-sprite-enter",
    spotlight ? "spot" : "",
    dim ? "dim" : "",
    borders ? "bordered" : "",
    pixelFilter ? "pixel-filter" : "",
    speaking ? "speaking" : "idle",
    expression && expression !== "normal" ? `expr-${expression}` : "",
  ].join(" ").trim();
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
      <div className="vae-sprite-art" key={character.sprite || character.character_id}>
        {inner}
      </div>
      <div className="vae-sprite-name">{character.name}</div>
    </div>
  );
}
