// Surfaces a real TTS failure (HTTP error / network) instead of letting
// auto-advance silently simulate audio and race through the rest of the book.
// Acknowledging switches playback to manual (click-through) mode so the user
// can keep reading and we retry narration for each new line they navigate to.
export default function TtsErrorModal({ open, onAcknowledge }) {
  if (!open) return null;
  return (
    <div className="vae-modal-backdrop" data-testid="tts-error-modal">
      <div className="vae-modal" role="dialog" aria-labelledby="tts-err-title">
        <h2 id="tts-err-title" className="vae-modal-title">Narration unavailable</h2>
        <p className="vae-modal-body">
          We couldn't reach the narration service for this line. Playback has been
          switched to manual mode — use Play or Next to keep going, and we'll try
          the narration again each time you load a new line.
        </p>
        <div className="vae-modal-actions">
          <button type="button" className="vae-btn" data-testid="tts-error-acknowledge"
            onClick={onAcknowledge}>
            OK, continue manually
          </button>
        </div>
      </div>
    </div>
  );
}
