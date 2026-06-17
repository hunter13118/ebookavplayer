import { defineConfig, devices } from "@playwright/test";

// E2E for the player. The Vite dev server is started automatically; all network
// (/books, /books/:id, /tts) is mocked per-test, and the Audio element is
// stubbed deterministically (see tests/e2e/fixtures.js) so we assert ORDER and
// timing of invocations rather than relying on real audio decode/playback.
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
