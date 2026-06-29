import { describe, expect, it } from "vitest";
import { formatRegenRequestError } from "./clientBanners.js";
import { summarizeArtSelection, summarizeRegenTarget } from "./regenSummary.js";
import { logLineFromEvent } from "./hooks/useJobEvents.js";

describe("formatRegenRequestError", () => {
  it("maps timeout errors", () => {
    const err = new DOMException("Aborted", "TimeoutError");
    expect(formatRegenRequestError(err)).toMatch(/timed out/i);
  });

  it("maps missing job id", () => {
    expect(formatRegenRequestError(new Error("generate-media: no job id in response")))
      .toMatch(/job id/i);
  });
});

describe("regenSummary", () => {
  const items = [
    { key: "char:a", label: "Elara" },
    { key: "char:b", label: "Kuro" },
  ];

  it("summarizes a single selection", () => {
    const s = summarizeArtSelection(["char:a"], items);
    expect(summarizeRegenTarget(s)).toBe("Elara");
  });

  it("summarizes multiple selections", () => {
    const s = summarizeArtSelection(["char:a", "char:b"], items);
    expect(summarizeRegenTarget(s)).toBe("2 images");
  });
});

describe("logLineFromEvent", () => {
  it("includes image failure detail from job events", () => {
    const row = logLineFromEvent({
      type: "progress",
      ts: 1,
      detail: "Failed character · kuro: generate_image: all tiers failed (2) — freemium_image: pollinations-anon: HTTP 429",
      debug_log: [{ phase: "P3_IMAGES", msg: "char fail kuro", data: { error: "pollinations-anon: HTTP 429" } }],
    });
    expect(row.text).toMatch(/Failed character · kuro/);
    expect(row.text).toMatch(/429|char fail kuro/);
  });
});
