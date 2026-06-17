// Capture key UI states as PNGs (run on host: `npm run test:e2e`).
// Output -> web/tests/screenshots/*.png, which you can open or hand back to
// Claude to display as image cards in chat.
import { test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { bootPlayer } from "./fixtures.js";

const shotDir = fileURLToPath(new URL("../screenshots/", import.meta.url));
const shot = (name) => `${shotDir}${name}.png`;

test.describe("UI screenshots", () => {
  test.use({ viewport: { width: 1100, height: 720 } });

  test("scene 1 — smooth dialogue box", async ({ page }) => {
    await bootPlayer(page, { audio: { clipMs: 4000 } });
    await page.getByTestId("select-advance").selectOption("click");
    await page.getByTestId("play").click();
    await page.getByTestId("speaker").waitFor();           // a character is speaking
    await page.locator('[data-testid="dialogue"]').waitFor();
    await page.screenshot({ path: shot("01-smooth-dialogue") });
  });

  test("pixel + subtitle styles", async ({ page }) => {
    await bootPlayer(page, { audio: { clipMs: 4000 } });
    await page.getByTestId("select-advance").selectOption("click");
    await page.getByTestId("play").click();
    await page.getByTestId("dialogue").waitFor();
    await page.getByTestId("select-style").selectOption("pixel");
    await page.screenshot({ path: shot("02-pixel-box") });
    await page.getByTestId("select-style").selectOption("subtitle");
    await page.screenshot({ path: shot("03-subtitle") });
  });

  test("light theme", async ({ page }) => {
    await bootPlayer(page, { audio: { clipMs: 4000 } });
    await page.getByTestId("select-advance").selectOption("click");
    await page.getByTestId("play").click();
    await page.getByTestId("dialogue").waitFor();
    await page.getByTestId("select-theme").selectOption("light");
    await page.screenshot({ path: shot("04-light-theme") });
  });

  test("group scene — speaker spotlight + dimmed extras", async ({ page }) => {
    // checkpoint off; small clips so we reach Pip's line, then capture
    await bootPlayer(page, { audio: { clipMs: 40 } });
    await page.getByTestId("play").click();
    await page.getByTestId("speaker").filter({ hasText: "Pip" }).waitFor({ timeout: 15000 });
    await page.screenshot({ path: shot("05-group-spotlight") });
  });

  test("checkpoint overlay", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("vae-checkpoint-every", "2"));
    await bootPlayer(page, { audio: { clipMs: 60 } });
    await page.getByTestId("play").click();
    await page.getByTestId("checkpoint").waitFor({ timeout: 10000 });
    await page.screenshot({ path: shot("06-checkpoint") });
  });
});
