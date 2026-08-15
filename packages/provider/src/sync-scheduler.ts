/**
 * When, and whether, to poll next. The demo syncs the relay over HTTP, and a
 * poll is an inbound request, so two things follow.
 *
 * While the page is visible the cadence adapts: fast right after a change so a
 * collaborator's keystrokes land with no perceptible lag, slower when idle,
 * since a quiet room does not need several reads a second.
 *
 * While the page is hidden the cadence is not the point; the budget is. Render
 * spins a free service down only after 15 minutes with no inbound request, so a
 * hidden tab that keeps polling, at any interval, holds the relay awake
 * indefinitely. One shared link left open in a background tab overnight would
 * cost 24 instance-hours, a week 168, from a single distracted visitor. So a
 * hidden tab is given a short grace window and then stops polling entirely
 * (`poll: false`); the demo resumes it on the next `visibilitychange`. The
 * grace is 2 minutes: comfortably longer than a glance at another tab, so an
 * active collaborator is never cut off mid-session, and far shorter than the
 * 15-minute spin-down, so a forgotten tab caps the relay's awake time at about
 * 2 + 15 = 17 minutes total rather than holding it up for as long as the tab
 * stays open.
 *
 * The fast interval is well under the relay's per-IP rate cap, and the local
 * transport ignores the delay entirely (its reads are in-memory), so any of
 * this only matters against a real relay.
 */
export const SYNC_INTERVAL_ACTIVE_MS = 400;
export const SYNC_INTERVAL_IDLE_MS = 2_000;
export const SYNC_INTERVAL_HIDDEN_MS = 15_000;

/** How recently a local edit or applied remote change still counts as "active". */
export const SYNC_ACTIVE_WINDOW_MS = 3_000;

/** How long a hidden tab keeps polling, with no change, before it stops. */
export const HIDDEN_POLL_STOP_MS = 2 * 60_000;

export type SyncActivity = {
  /** Whether the page is visible (document.visibilityState === "visible"). */
  visible: boolean;
  /** Milliseconds since the last local edit or applied remote change. */
  msSinceChange: number;
  /** Milliseconds the page has been continuously hidden (0 while visible). */
  msHidden: number;
};

export type SyncDecision =
  /** Poll again after `delayMs`. */
  | { poll: true; delayMs: number }
  /** Stop polling; the caller resumes on visibilitychange. */
  | { poll: false };

export function nextSyncDecision(activity: SyncActivity): SyncDecision {
  if (activity.visible) {
    const delayMs = activity.msSinceChange <= SYNC_ACTIVE_WINDOW_MS ? SYNC_INTERVAL_ACTIVE_MS : SYNC_INTERVAL_IDLE_MS;
    return { poll: true, delayMs };
  }
  // Hidden: stop once the tab has been hidden for the grace window with no
  // change arriving in it. A remote change resets msSinceChange, so an active
  // room keeps a hidden tab syncing; a truly idle one is let go.
  if (Math.min(activity.msHidden, activity.msSinceChange) >= HIDDEN_POLL_STOP_MS) return { poll: false };
  return { poll: true, delayMs: SYNC_INTERVAL_HIDDEN_MS };
}
