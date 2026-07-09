// Game-style dialogue with typewriter reveal synced to the spoken line.
import { dialogueBoxClass, formatDeliveryText } from "../dialogueFormat.js";
import { normalizeExpressionBucket } from "../expressionBucket.js";

export default function DialogueBox({ line, speakerName, revealed, style, onAdvance }) {
  if (!line) return null;
  const isDelivery = line.kind === "delivery" || line.line_weight === "minor";
  const isNarr = line.kind === "narration";
  const displayText = isDelivery ? formatDeliveryText(line) : (line.text || "");
  const rawLen = (line.text || "").length || 1;
  const showLen = Math.min(
    displayText.length,
    Math.ceil((revealed / rawLen) * displayText.length),
  );
  const shown = displayText.slice(0, showLen);
  const done = revealed >= rawLen;

  if (style === "subtitle") {
    const bucket = normalizeExpressionBucket(line.expression);
    const exprCls = bucket === "yell" || bucket === "whisper" ? ` expr-${bucket}` : "";
    const subCls = `vae-subtitle${isNarr ? " narration" : ""}${isDelivery ? " delivery" : ""}${exprCls}`;
    return (
      <div className={subCls} data-testid="dialogue" data-style="subtitle"
        data-kind={line.kind} onClick={onAdvance}>
        <span className="vae-sub-speaker" data-testid="speaker">
          {isNarr || isDelivery ? "Narrator: " : `${speakerName}: `}
        </span>
        <span className="vae-sub-text" data-testid="dialogue-text">{shown}</span>
        {!done && <span className="vae-caret">▍</span>}
      </div>
    );
  }

  const boxCls = dialogueBoxClass(line, `vae-dialogue ${style === "pixel" ? "pixel" : "smooth"}`);
  return (
    <div className={boxCls} data-testid="dialogue" data-style={style === "pixel" ? "pixel" : "smooth"}
      data-kind={line.kind} onClick={onAdvance}>
      {!isNarr && !isDelivery && (
        <div className="vae-speaker" data-testid="speaker">{speakerName}</div>
      )}
      {(isNarr || isDelivery) && (
        <div className="vae-speaker vae-speaker-narrator" data-testid="speaker">
          Narrator
        </div>
      )}
      <div className="vae-text" data-testid="dialogue-text">
        {shown}
        {!done && <span className="vae-caret">▍</span>}
      </div>
      {done && <div className="vae-advance">▼</div>}
    </div>
  );
}
