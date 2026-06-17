// "Are you still there?" — periodic check-in to catch a sleeping listener.
export default function CheckpointOverlay({ onContinue }) {
  return (
    <div className="vae-checkpoint" data-testid="checkpoint" onClick={onContinue}>
      <div className="vae-checkpoint-card">
        <div className="vae-checkpoint-title">Still listening?</div>
        <p>Tap anywhere to continue where you left off.</p>
        <button onClick={onContinue}>▶ Continue</button>
      </div>
    </div>
  );
}
