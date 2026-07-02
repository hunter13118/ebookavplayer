import { useState } from "react";

const KNOWN_STYLES = [
  { value: "anime", label: "Anime (light novels)" },
  { value: "semi-real", label: "Semi-realistic" },
  { value: "cartoon", label: "Cartoon / comic" },
  { value: "pixel", label: "Pixel-art" },
];
const KNOWN_VALUES = new Set(KNOWN_STYLES.map((s) => s.value));

/** Art style dropdown + "Custom..." free-text fallback — shared by Uploader
 * (upload time) and ReplaceArtSheet (regen time). `value` may be a known
 * style id or an arbitrary custom description; `onChange(nextStyle)` fires
 * with either a known style id or the current custom text. */
export default function ArtStylePicker({ value, onChange, testIdPrefix = "art-style" }) {
  const isKnown = KNOWN_VALUES.has(value);
  const [customText, setCustomText] = useState(isKnown ? "" : (value || ""));
  const selectValue = isKnown ? value : "custom";

  function handleSelect(v) {
    if (v === "custom") onChange(customText || "");
    else onChange(v);
  }

  function handleCustomChange(text) {
    setCustomText(text);
    onChange(text);
  }

  return (
    <span className="vae-art-style-picker">
      <span className="vae-select-wrap">
        <select
          className="vae-select"
          data-testid={testIdPrefix}
          value={selectValue}
          onChange={(e) => handleSelect(e.target.value)}
        >
          {KNOWN_STYLES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </span>
      {selectValue === "custom" && (
        <input
          type="text"
          className="vae-input vae-art-style-custom-input"
          data-testid={`${testIdPrefix}-custom`}
          placeholder="Describe your own art style…"
          value={customText}
          onChange={(e) => handleCustomChange(e.target.value)}
        />
      )}
    </span>
  );
}
