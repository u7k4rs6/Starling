import { defineConfig } from "@playwright/test";

/**
 * Verifies the actual FRONTEND §5 acceptance criteria (F3-F7) and the
 * three demonstrations (§2.3) against a real browser — this repo has
 * Chromium pre-installed, so "the demo works" is checked directly rather
 * than only inferred from unit tests of its pieces.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5173",
    // Environment ships a pinned Chromium; using it directly (see
    // AGENTS/system notes) rather than triggering Playwright's own
    // browser download, which this sandbox has no route to.
    launchOptions: { executablePath: "/opt/pw-browsers/chromium" },
  },
  webServer: [
    {
      command: "node scripts/dev-relay.mjs",
      url: "http://127.0.0.1:8787/doc/8f14e45f-ceea-467e-bd7e-2e8912cee2b8",
      reuseExistingServer: false,
      env: { RELAY_ALLOWED_ORIGIN: "http://127.0.0.1:5173" },
    },
    {
      command: "pnpm exec vite --port 5173 --strictPort",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      // A short TTL so the F7 (stale cursor fade) e2e test doesn't sit
      // through the real 5s production default — see config.ts.
      env: { VITE_AWARENESS_TTL_MS: "1200" },
    },
  ],
});
