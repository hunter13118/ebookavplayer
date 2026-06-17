import { spriteVisual } from "../media.js";

export default function Sprite({ character, spotlight, dim, borders }) {
  const v = spriteVisual(character.sprite);
  const cls = [
    "vae-sprite",
    spotlight ? "spot" : "",
    dim ? "dim" : "",
    borders ? "bordered" : "",
  ].join(" ").trim();
  const inner =
    v.type === "image" ? (
      <img src={v.url} alt={character.name} draggable={false} />
    ) : v.type === "gradient" ? (
      <div className="vae-sprite-fill" style={{ background: v.css }}>
        <span>{(character.name || "?").slice(0, 1)}</span>
      </div>
    ) : (
      <div className="vae-sprite-fill narrator"><span>📖</span></div>
    );
  return (
    <div className={cls} data-id={character.character_id || character.id}
      data-testid="sprite"
      data-state={spotlight ? "spotlight" : dim ? "dim" : "normal"}>
      <div className="vae-sprite-art">{inner}</div>
      <div className="vae-sprite-name">{character.name}</div>
    </div>
  );
}
