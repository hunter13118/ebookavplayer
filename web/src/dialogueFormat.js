/** Format delivery-tag lines for display (sang → ♪, yelled → emphasis). */
const VERB_EMOJI = {
  sang: "♪",
  sung: "♪",
  hummed: "♪",
  whistled: "♪",
  yelled: "‼",
  shouted: "‼",
  screamed: "‼",
  whispered: "…",
  murmured: "…",
  muttered: "…",
};

export function formatDeliveryText(line) {
  if (!line || line.kind !== "delivery") return line?.text || "";
  const verb = (line.delivery_verb || "").toLowerCase().trim();
  const text = line.text || "";
  const mark = VERB_EMOJI[verb];
  if (mark === "♪") return `♪ ${text} ♪`;
  if (mark === "‼") return text.toUpperCase();
  if (mark === "…") return `… ${text}`;
  return text;
}

export function dialogueBoxClass(line, baseStyle) {
  if (!line) return baseStyle;
  if (line.kind === "delivery" || line.line_weight === "minor") return `${baseStyle} delivery`;
  if (line.kind === "narration") return `${baseStyle} narration`;
  return baseStyle;
}
