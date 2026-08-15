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
    },
  ],
});
