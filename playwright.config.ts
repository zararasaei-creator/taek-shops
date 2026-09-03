import { defineConfig, devices } from "@playwright/test";

const PORT = 3000;
const baseURL = `http://localhost:${PORT}`;

/**
 * E2E runs against a production build (`next build` + `next start`) so route
 * handlers are not compiled lazily on first hit — that made parallel first
 * requests flaky. For fast local iteration, start `npm run dev` yourself first;
 * `reuseExistingServer` will pick it up.
 *
 * `next start` is the correct command here now that `output: "standalone"` is no
 * longer set in `next.config.ts` (see the note there).
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run build && npm run start",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
