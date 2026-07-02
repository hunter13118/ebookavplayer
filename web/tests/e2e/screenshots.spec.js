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

  test("group scene — speaker spotlight + dimmed extras", async ({ page }) => {
    await bootPlayer(page, { audio: { clipMs: 2500 } });
    await page.getByTestId("play").click();
    await page.getByTestId("speaker").filter({ hasText: "Pip" }).waitFor({ timeout: 15000 });
    await page.screenshot({ path: shot("05-group-spotlight") });
  });
});
