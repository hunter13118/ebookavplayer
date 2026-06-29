import { describe, expect, it } from "vitest";
import { formatHz, formatPct, parseHz, parsePct, prosodySummary } from "./voiceProsody.js";
import { resolveVoiceSettings } from "./voiceOverrides.js";

describe("voiceProsody", () => {
  it("round-trips hz", () => {
    expect(formatHz(parseHz("+8Hz"))).toBe("+8Hz");
    expect(formatHz(parseHz("-12Hz"))).toBe("-12Hz");
  });

  it("round-trips pct", () => {
    expect(formatPct(parsePct("-15%"))).toBe("-15%");
  });

  it("summarizes non-default prosody", () => {
    expect(prosodySummary({ pitch: "+8Hz", rate: "-5%" })).toContain("+8Hz");
  });
});

describe("resolveVoiceSettings", () => {
  it("uses compiled defaults when no override", () => {
    const s = resolveVoiceSettings(null, { voice: "en-US-AvaNeural", pitch: "+6Hz", rate: "+0%" });
    expect(s.voice).toBe("en-US-AvaNeural");
    expect(s.pitch).toBe("+6Hz");
  });

  it("merges edge voice with override prosody", () => {
    const s = resolveVoiceSettings(
      { source: "edge", voice: "en-US-JennyNeural", pitch: "+10Hz", rate: "-8%" },
      { voice: "en-US-AvaNeural", pitch: "+0Hz", rate: "+0%" },
    );
    expect(s.voice).toBe("en-US-JennyNeural");
    expect(s.pitch).toBe("+10Hz");
    expect(s.rate).toBe("-8%");
  });

  it("applies pitch override on book default voice", () => {
    const s = resolveVoiceSettings(
      { source: "default", pitch: "+12Hz" },
      { voice: "en-US-AndrewNeural", pitch: "+0Hz", rate: "+0%" },
    );
    expect(s.voice).toBe("en-US-AndrewNeural");
    expect(s.pitch).toBe("+12Hz");
  });
});
