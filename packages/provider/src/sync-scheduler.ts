/**
 * How long to wait before the next sync. The demo polls the relay over HTTP,
 * so a fixed fast interval would keep a phone radio and a free relay busy long
 * after anyone stopped typing. Instead the cadence adapts to what the page is
 * doing:
 *
 * - Visible and recently changed: poll fast, so a collaborator's keystrokes
 *   appear with no perceptible lag.
 * - Visible but idle: back off, since a quiet room does not need four reads a
 *   second.
 * - Backgrounded: back off hard, since a hidden tab needs almost nothing, and
 *   this is where the savings on relay instance-hours and battery come from.
 *
 * The fast interval is well under the relay's per-IP rate cap, and the local
 * transport ignores the delay's cost entirely (its reads are in-memory), so
 * the schedule only ever matters when a real relay is in use.
 */
export const SYNC_INTERVAL_ACTIVE_MS = 400;
export const SYNC_INTERVAL_IDLE_MS = 2_000;
export const SYNC_INTERVAL_HIDDEN_MS = 15_000;

/** How recently a local edit or applied remote change still counts as "active". */
export const SYNC_ACTIVE_WINDOW_MS = 3_000;

export type SyncActivity = {
  /** Whether the page is visible (document.visibilityState === "visible"). */
  visible: boolean;
  /** Milliseconds since the last local edit or applied remote change. */
  msSinceChange: number;
};

export function nextSyncDelayMs(activity: SyncActivity): number {
  if (!activity.visible) return SYNC_INTERVAL_HIDDEN_MS;
  if (activity.msSinceChange <= SYNC_ACTIVE_WINDOW_MS) return SYNC_INTERVAL_ACTIVE_MS;
  return SYNC_INTERVAL_IDLE_MS;
}
