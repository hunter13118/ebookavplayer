// Game-style dialogue with typewriter reveal synced to the spoken line.
// Three display styles (Brief): pixel | smooth | subtitle.
export default function DialogueBox({ line, speakerName, revealed, style, onAdvance }) {
  if (!line) return null;
  const text = line.text || "";
  const shown = text.slice(0, revealed);
  const isNarr = line.kind === "narration";
  const done = revealed >= text.length;

  if (style === "subtitle") {
    return (
      <div className="vae-subtitle" data-testid="dialogue" data-style="subtitle"
        data-kind={line.kind} onClick={onAdvance}>
        <span className="vae-sub-speaker" data-testid="speaker">{isNarr ? "" : `${speakerName}: `}</span>
        <span className="vae-sub-text" data-testid="dialogue-text">{shown}</span>
        {!done && <span className="vae-caret">▍</span>}
      </div>
    );
  }

  const boxCls = `vae-dialogue ${style === "pixel" ? "pixel" : "smooth"} ${isNarr ? "narration" : ""}`;
  return (
    <div className={boxCls} data-testid="dialogue" data-style={style === "pixel" ? "pixel" : "smooth"}
      data-kind={line.kind} onClick={onAdvance}>
      {!isNarr && <div className="vae-speaker" data-testid="speaker">{speakerName}</div>}
      <div className="vae-text" data-testid="dialogue-text">
        {shown}
        {!done && <span className="vae-caret">▍</span>}
      </div>
      {done && <div className="vae-advance">▼</div>}
    </div>
  );
}
