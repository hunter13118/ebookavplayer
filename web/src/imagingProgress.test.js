import { describe, expect, it } from "vitest";
import { computeImagingProgress, waitingOnProvider } from "../../worker/_shared/imaging-progress-ui.js";

describe("computeImagingProgress", () => {
  it("does not jump to 100% while waiting on a provider", () => {
    const p = computeImagingProgress(
      {
        status: "processing",
        progress: 0.5,
        step_index: 1,
        step_total: 1,
        detail: "Generating character · mei via pollinations-anon",
      },
      { lastProgress: 0.4 },
    );
    expect(p).toBeLessThan(0.99);
    expect(waitingOnProvider("Generating character · mei via pollinations-seed")).toBe(true);
  });

  it("reaches 1 only when done", () => {
    expect(computeImagingProgress({ status: "done", progress: 0.99 }, { lastProgress: 0.5 })).toBe(1);
  });

  it("caps in-flight progress below 100%", () => {
    const p = computeImagingProgress(
      { status: "processing", progress: 1, step_index: 1, step_total: 1, detail: "character · mei (1/1)" },
      { lastProgress: 0 },
    );
    expect(p).toBeLessThanOrEqual(0.99);
  });
});
