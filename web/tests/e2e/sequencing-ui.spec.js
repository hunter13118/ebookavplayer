import { test, expect } from "@playwright/test";
import { bootPlayer, EXPECTED_LINES } from "./fixtures.js";

test.describe("UI follows the spoken line", () => {
  test("speaker label + spotlight track the current speaker", async ({ page }) => {
    await bootPlayer(page);
    await page.getByTestId("play").click();

    // Narrator narration first (no speaker label, kind=narration)
    await expect(page.getByTestId("dialogue")).toHaveAttribute("data-kind", "narration");

    // Then Elara speaks -> her sprite is spotlighted
    await expect(page.getByTestId("speaker")).toContainText("Elara", { timeout: 10000 });
    await expect(page.locator('[data-testid="sprite"][data-id="elara"]'))
      .toHaveAttribute("data-state", "spotlight");

    // Then Garrick -> spotlight moves to him
    await expect(page.getByTestId("speaker")).toContainText("Garrick", { timeout: 10000 });
    await expect(page.locator('[data-testid="sprite"][data-id="garrick"]'))
      .toHaveAttribute("data-state", "spotlight");
  });

  test("background switches when the story moves to scene 2", async ({ page }) => {
    await bootPlayer(page);
    await page.getByTestId("play").click();

    await expect(page.getByTestId("scene-title")).toHaveText("The Gate at Dusk");
    await expect(page.getByTestId("stage")).toHaveAttribute("data-scene-id", "scene-0001");

    // eventually advances into the courtyard
    await expect(page.getByTestId("scene-title")).toHaveText("The Inner Courtyard", { timeout: 15000 });
    await expect(page.getByTestId("stage")).toHaveAttribute("data-scene-id", "scene-0002");
  });

  test("group scene spotlights the speaker and dims extras", async ({ page }) => {
    await bootPlayer(page);
    await page.getByTestId("play").click();

    // Pip speaks in the 3-character courtyard scene
    await expect(page.getByTestId("speaker")).toContainText("Pip", { timeout: 15000 });
    await expect(page.locator('[data-testid="sprite"][data-id="child"]'))
      .toHaveAttribute("data-state", "spotlight");
    // at least one other character is dimmed (group scene rule)
    await expect(page.locator('[data-testid="sprite"][data-state="dim"]').first())
      .toBeVisible();
  });

  test("progress index advances monotonically to the end", async ({ page }) => {
    await bootPlayer(page);
    await page.getByTestId("play").click();
    await expect(page.getByTestId("progress")).toHaveAttribute(
      "data-status", "done", { timeout: 20000 });
    const total = EXPECTED_LINES.length;
    await expect(page.getByTestId("progress")).toHaveAttribute(
      "data-index", String(total - 1));
  });
});
