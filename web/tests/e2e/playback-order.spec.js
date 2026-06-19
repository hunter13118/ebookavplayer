import { test, expect } from "@playwright/test";
import { bootPlayer, EXPECTED_LINES, TOTAL_LINES } from "./fixtures.js";

test.describe("TTS invocation order + per-character voice", () => {
  test("fires one /tts per line, in scene order", async ({ page }) => {
    const { ttsCalls } = await bootPlayer(page);
    await page.getByTestId("play").click();
    // wait until the whole book has been spoken
    await expect.poll(() => ttsCalls.length, { timeout: 15000 }).toBe(TOTAL_LINES);

    const gotVoices = ttsCalls.map((c) => c.voice);
    const wantVoices = EXPECTED_LINES.map((l) => l.voice);
    expect(gotVoices).toEqual(wantVoices);

    const gotText = ttsCalls.map((c) => c.text);
    const wantText = EXPECTED_LINES.map((l) => l.text);
    expect(gotText).toEqual(wantText);
  });

  test("routes voice by CHARACTER, never by screen position", async ({ page }) => {
    // In scene 1 both Elara and Garrick are on screen the whole time; each line
    // must still use its own speaker's voice.
    const { ttsCalls } = await bootPlayer(page);
    await page.getByTestId("play").click();
    await expect.poll(() => ttsCalls.length).toBeGreaterThanOrEqual(3);

    const narrator = EXPECTED_LINES[0];
    const elara = EXPECTED_LINES[1];
    const garrick = EXPECTED_LINES[2];
    expect(ttsCalls[0].voice).toBe(narrator.voice);
    expect(ttsCalls[1].voice).toBe(elara.voice);
    expect(ttsCalls[2].voice).toBe(garrick.voice);
    // distinct voices prove it isn't keyed off position
    expect(ttsCalls[1].voice).not.toBe(ttsCalls[2].voice);
  });

  test("passes per-character pitch/rate through to /tts", async ({ page }) => {
    const { ttsCalls } = await bootPlayer(page);
    await page.getByTestId("play").click();
    await expect.poll(() => ttsCalls.length).toBeGreaterThanOrEqual(2);
    // Elara carries a non-zero pitch in the sample (de-collision)
    const elara = EXPECTED_LINES[1];
    expect(ttsCalls[1].pitch).toBe(elara.pitch);
  });

  test("passes expression tags through to /tts", async ({ page }) => {
    const { ttsCalls } = await bootPlayer(page);
    await page.getByTestId("play").click();
    await expect.poll(() => ttsCalls.length).toBeGreaterThanOrEqual(7);
    // Garrick "Quiet, boy…" is tagged whisper in the sample book
    const garrick = ttsCalls[6];
    expect(garrick.text).toContain("Quiet, boy");
    expect(garrick.expression).toBe("whisper");
    expect(garrick.environment).toBe("hall");
    expect(garrick.intensity).toBeCloseTo(0.85, 2);
  });
});
