import { useRef } from "react";
import Sprite from "./Sprite.jsx";
import IllustrationFlash from "./IllustrationFlash.jsx";
import { backgroundStyle } from "../media.js";
import { stageLayout } from "../audio/timing.js";
import { sceneDisplayTitle } from "../sceneLabels.js";

export default function Stage({
  scene, characters, speakerId, lineSprites, curExpression, borders, pixelFilter, portraitLayout,
  illustrationFlash, lineKey, flashActive, flashDismissSignal, flashManual,
  onFlashDone, onDismissFlash, onSwipeNext, onSwipePrev, sceneDimmed, children,
}) {
  const touchStart = useRef(null);

  if (!scene) return <div className="vae-stage" />;

  const present = (scene.present || []).map((p) => ({
    ...p,
    name: p.name || characters?.[p.character_id]?.name || p.character_id,
    sprite: lineSprites?.[p.character_id]
      || p.sprite
      || characters?.[p.character_id]?.sprite,
  }));
  const laid = stageLayout(present, speakerId, 2);
  const stageCls = [
    "vae-stage",
    pixelFilter ? "vae-pixel-filter" : "",
    portraitLayout ? "vae-stage-portrait" : "",
  ].filter(Boolean).join(" ");

  function handleStageClick(e) {
    if (e.target.closest(".vae-dialogue, .vae-subtitle")) return;
    if (flashActive && illustrationFlash) {
      onDismissFlash?.();
    }
  }

  function onTouchStart(e) {
    touchStart.current = e.changedTouches[0].clientX;
  }

  function onTouchEnd(e) {
    const start = touchStart.current;
    if (start == null) return;
    const dx = e.changedTouches[0].clientX - start;
    touchStart.current = null;
    if (Math.abs(dx) < 56) return;
    if (dx < 0) onSwipeNext?.();
    else onSwipePrev?.();
  }

  return (
    <div
      className={stageCls}
      style={backgroundStyle(scene.background)}
      data-testid="stage"
      data-scene-id={scene.id}
      data-pixel-filter={pixelFilter ? "true" : "false"}
      onClick={handleStageClick}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="vae-scene-title" data-testid="scene-title">{sceneDisplayTitle(scene)}</div>
      <div className="vae-sprites">
        {laid.map((p) => (
          <Sprite
            key={p.character_id}
            character={p}
            slotX={p.slotX}
            spotlight={p.spotlight}
            dim={p.dim}
            borders={borders}
            pixelFilter={pixelFilter}
            speaking={p.character_id === speakerId}
            expression={p.character_id === speakerId ? curExpression : undefined}
          />
        ))}
      </div>
      <IllustrationFlash
        url={illustrationFlash}
        lineKey={lineKey}
        active={flashActive}
        dismissSignal={flashDismissSignal}
        autoDismiss={!flashManual}
        onDone={onFlashDone}
        onTap={onDismissFlash}
      />
      <div
        className={`vae-scene-dim-overlay${sceneDimmed ? " show" : ""}`}
        data-testid="scene-dim-overlay"
        aria-hidden
      />
      {children}
    </div>
  );
}
