const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const params = new URLSearchParams(window.location.search);

function overridableId(param: string, fixed: string): string {
  const override = params.get(param);
  return override !== null && UUID_RE.test(override) ? override : fixed;
}

/**
 * FRONTEND §2.5: "No document list." This demo shows exactly one
 * document, always — so its id (and its awareness channel's id, a
 * second, unrelated UUID per DECISIONS #0022) default to fixed constants,
 * not something a user picks or the app generates per session.
 *
 * The `?doc=`/`?awareness=` override exists for one reason only: the e2e
 * suite (`packages/demo/e2e`) runs many tests against one long-lived dev
 * relay process (Playwright's `webServer`, started once for the whole
 * run) sharing this same fixed document id — without a way to point a
 * single test at its own fresh pair of ids, every test after the first
 * would inherit whatever text prior tests already pushed to the relay,
 * since the relay never resets between tests and never forgets. A
 * malformed or missing override falls back to the fixed id silently,
 * same as any other query param a stray visitor might append.
 */
export const DOC_ID = overridableId("doc", "8f14e45f-ceea-467e-bd7e-2e8912cee2b8");
export const AWARENESS_ID = overridableId("awareness", "1f0e3dad-99f9-4a8e-9c9c-58e4c58e5e5a");

/** Local dev default: `scripts/dev-relay.mjs` binds here. Step 16 (deploy)
 * is where a real hosted URL replaces this default via the env var. */
export const RELAY_URL = (import.meta.env.VITE_RELAY_URL as string | undefined) ?? "http://127.0.0.1:8787";

// Overridable so the e2e suite (packages/demo/e2e) doesn't need to sit
// through a real 5-second TTL to verify F7 (a stale replica's cursor
// disappears) — production gets the real default.
export const AWARENESS_TTL_MS = Number(import.meta.env.VITE_AWARENESS_TTL_MS ?? 5_000);
export const SYNC_INTERVAL_MS = 700;
