import Sprite from "./Sprite.jsx";
import { backgroundStyle } from "../media.js";
import { stageLayout } from "../audio/timing.js";

// Scene background + sprites. Max ~2 in focus for 1:1; in groups the speaker is
// spotlighted (foreground/larger) and others dim/semi-transparent (Brief UI).
export default function Stage({ scene, characters, speakerId, borders, children }) {
  if (!scene) return <div className="vae-stage" />;
  const present = (scene.present || []).map((p) => ({
    ...p,
    name: p.name || characters?.[p.character_id]?.name || p.character_id,
    sprite: p.sprite || characters?.[p.character_id]?.sprite,
  }));
  const laid = stageLayout(present, speakerId, 2);
  return (
    <div className="vae-stage" style={backgroundStyle(scene.background)}
      data-testid="stage" data-scene-id={scene.id}>
      <div className="vae-scene-title" data-testid="scene-title">{scene.title}</div>
      <div className="vae-sprites">
        {laid.map((p) => (
          <Sprite
            key={p.character_id}
            character={p}
            spotlight={p.spotlight}
            dim={p.dim}
            borders={borders}
          />
        ))}
      </div>
      {children}
    </div>
  );
}
