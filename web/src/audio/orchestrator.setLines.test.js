import { describe, it, expect, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";

vi.mock("../api.js", () => ({
  backendConfigured: () => false,
}));

const LINES = [
  { idx: 0, text: "Line zero.", character_id: "narrator" },
  { idx: 1, text: "Line one.", character_id: "narrator" },
  { idx: 2, text: "Line two.", character_id: "narrator" },
  { idx: 3, text: "Line three.", character_id: "narrator" },
];

describe("Orchestrator.setLines", () => {
  it("lets seek() reach a real target BEFORE play() has ever run", () => {
    // Regression: seek()/rewind()/next() all clamp against this.lines.length,
    // which stayed [] (the constructor default) until the first play() call —
    // so scrubbing the progress bar on a freshly-opened, never-played book
    // silently snapped every seek back to line 0.
    const orch = new Orchestrator();
    orch.setLines(LINES);
    orch.seek(3);
    expect(orch.index).toBe(3);
  });

  it("without setLines, seek() before any play() clamps to 0 (documents the bug this fixes)", () => {
    const orch = new Orchestrator();
    orch.seek(3);
    expect(orch.index).toBe(0);
  });

  it("does not touch status/index as a side effect", () => {
    const orch = new Orchestrator();
    orch.index = 2;
    orch.status = "idle";
    orch.setLines(LINES);
    expect(orch.index).toBe(2);
    expect(orch.status).toBe("idle");
  });

  it("accepts null/undefined as an empty book", () => {
    const orch = new Orchestrator();
    orch.setLines(null);
    expect(orch.lines).toEqual([]);
  });
});
