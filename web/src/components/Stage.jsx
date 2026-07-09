import { useRef } from "react";
import Sprite from "./Sprite.jsx";
import IllustrationFlash from "./IllustrationFlash.jsx";
import { backgroundStyle } from "../media.js";
import { stageLayout } from "../audio/timing.js";
import { sceneDisplayTitle } from "../sceneLabels.js";
import { normalizeExpressionBucket } from "../expressionBucket.js";

// Expression Sensitivity Plan Phase 4: how intense a line needs to be before
// the stage push-in/impact-frame fires at all — subtle disables it entirely,
// full lowers the bar so it reads more often.
const INTENSITY_THRESHOLD = { subtle: Infinity, balanced: 0.7, full: 0.5 };

export default function Stage({
  scene, characters, speakerId, lineSprites, curExpression, curIntensity, performanceMode = "balanced",
  tension = 0, borders, pixelFilter, portraitLayout,
  illustrationFlash, lineKey, flashActive, flashDismissSignal, flashManual,
  onFlashDone, onDismissFlash, onSwipeNext, onSwipePrev, sceneDimmed, children,
}) {
  const touchStart = useRef(null);

  if (!scene) return <div className="vae-stage" />;

  // Subtle mode also turns off alt-expression sprite swaps (Phase 3d) — the
  // reader gets the CSS filter treatment only, never a different portrait.
  const useAltSprites = performanceMode !== "subtle";
  const present = (scene.present || []).map((p) => ({
    ...p,
    name: p.name || characters?.[p.character_id]?.name || p.character_id,
    sprite: (useAltSprites && lineSprites?.[p.character_id])
      || p.sprite
      || characters?.[p.character_id]?.sprite,
  }));
  const laid = stageLayout(present, speakerId, 2);
  // Expression Sensitivity Plan Phase 3b: on a high-intensity dramatic line,
  // push in on the whole stage (contrast against idle speaking); yell/angry
  // additionally get a brief one-shot "impact frame" flash, re-triggered per
  // line via the lineKey remount below rather than any extra timer state.
  const expressionBucket = curExpression ? normalizeExpressionBucket(curExpression) : "normal";
  const intensity = typeof curIntensity === "number" ? curIntensity : 1;
  const threshold = INTENSITY_THRESHOLD[performanceMode] ?? INTENSITY_THRESHOLD.balanced;
  const highIntensity = intensity > threshold && expressionBucket !== "normal";
  const impactFrame = highIntensity && (expressionBucket === "yell" || expressionBucket === "angry");
  const stageCls = [
    "vae-stage",
    pixelFilter ? "vae-pixel-filter" : "",
    portraitLayout ? "vae-stage-portrait" : "",
    highIntensity ? "vae-stage-pushin" : "",
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
      {performanceMode !== "subtle" && tension > 0 && (
        <div
          className="vae-tension-overlay"
          style={{ opacity: Math.min(1, tension) * 0.35 }}
          data-testid="tension-overlay"
          aria-hidden="true"
        />
      )}
      {impactFrame && (
        <div key={lineKey} className={`vae-stage-impact expr-${expressionBucket}`} aria-hidden="true" />
      )}
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
            lineKey={p.character_id === speakerId ? lineKey : undefined}
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
