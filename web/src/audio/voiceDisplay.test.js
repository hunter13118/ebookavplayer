import { describe, expect, it } from "vitest";
import {
  resolveActiveVoiceId,
  voiceFriendlyLabel,
  voiceShortName,
} from "./voiceDisplay.js";

describe("voiceDisplay", () => {
  const voices = [
    { id: "en-US-AvaMultilingualNeural", label: "Microsoft Ava Multilingual Online (Natural)" },
    { id: "en-US-AndrewMultilingualNeural", label: "Microsoft Andrew Multilingual Online (Natural)" },
  ];

  it("shortens neural voice ids", () => {
    expect(voiceShortName("en-US-JennyNeural")).toBe("Jenny");
  });

  it("uses edge catalog label when available", () => {
    expect(voiceFriendlyLabel(voices, "en-US-AvaMultilingualNeural"))
      .toContain("Ava");
  });

  it("resolves active voice from override or default", () => {
    expect(resolveActiveVoiceId(null, "en-US-AvaMultilingualNeural")).toBe("en-US-AvaMultilingualNeural");
    expect(resolveActiveVoiceId({ source: "edge", voice: "en-US-JennyNeural" }, "en-US-AvaMultilingualNeural"))
      .toBe("en-US-JennyNeural");
  });
});
