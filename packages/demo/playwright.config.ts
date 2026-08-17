import { defineConfig } from "@playwright/test";

/**
 * Verifies the deployed demo against a real browser: concurrent convergence,
 * the cut-link diverge-then-reconverge with no dialog, undo isolation, and the
 * share handoff over the dev relay. Needs a Chromium binary at the path below;
 * CI does not run this suite (see .github/workflows/ci.yml), it is a local and
 * pre-deploy check.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5173",
    // Point at a system Chrome/Chromium binary rather than a Playwright-managed
    // download (Playwright has no build for this OS). Override with
    // PW_CHROME_PATH if the binary lives elsewhere.
    launchOptions: { executablePath: process.env.PW_CHROME_PATH ?? "/usr/bin/google-chrome" },
  },
  webServer: [
    {
      command: "node scripts/dev-relay.mjs",
      url: "http://127.0.0.1:8787/doc/8f14e45f-ceea-467e-bd7e-2e8912cee2b8",
      reuseExistingServer: false,
      // A small per-doc freeze cap so the frozen-room test can reach a freeze
      // with a paragraph of text rather than 2 MB. The other relay tests push
      // only a handful of characters, well under this. See the frozen-room test.
      env: { RELAY_ALLOWED_ORIGIN: "http://127.0.0.1:5173", RELAY_MAX_LOG_BYTES: "1024" },
    },
    {
      command: "pnpm exec vite --port 5173 --strictPort",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
    },
  ],
});
