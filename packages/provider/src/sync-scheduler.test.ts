import { describe, expect, it } from "vitest";
import {
  HIDDEN_POLL_STOP_MS,
  nextSyncDecision,
  SYNC_ACTIVE_WINDOW_MS,
  SYNC_INTERVAL_ACTIVE_MS,
  SYNC_INTERVAL_HIDDEN_MS,
  SYNC_INTERVAL_IDLE_MS,
} from "./sync-scheduler.js";

describe("nextSyncDecision: adaptive cadence while visible", () => {
  it("polls fast right after a change", () => {
    expect(nextSyncDecision({ visible: true, msSinceChange: 0, msHidden: 0 })).toEqual({
      poll: true,
      delayMs: SYNC_INTERVAL_ACTIVE_MS,
    });
    expect(nextSyncDecision({ visible: true, msSinceChange: SYNC_ACTIVE_WINDOW_MS, msHidden: 0 })).toEqual({
      poll: true,
      delayMs: SYNC_INTERVAL_ACTIVE_MS,
    });
  });

  it("backs off to idle once nothing has changed for a while", () => {
    expect(nextSyncDecision({ visible: true, msSinceChange: SYNC_ACTIVE_WINDOW_MS + 1, msHidden: 0 })).toEqual({
      poll: true,
      delayMs: SYNC_INTERVAL_IDLE_MS,
    });
  });
});

describe("nextSyncDecision: hidden tab stops polling instead of holding the relay awake", () => {
  it("polls slowly during the grace window", () => {
    expect(nextSyncDecision({ visible: false, msSinceChange: 0, msHidden: 0 })).toEqual({
      poll: true,
      delayMs: SYNC_INTERVAL_HIDDEN_MS,
    });
    expect(nextSyncDecision({ visible: false, msSinceChange: 10_000, msHidden: HIDDEN_POLL_STOP_MS - 1 })).toEqual({
      poll: true,
      delayMs: SYNC_INTERVAL_HIDDEN_MS,
    });
  });

  it("stops entirely once hidden for the grace window with no change", () => {
    expect(nextSyncDecision({ visible: false, msSinceChange: HIDDEN_POLL_STOP_MS, msHidden: HIDDEN_POLL_STOP_MS })).toEqual({
      poll: false,
    });
  });

  it("keeps polling a hidden tab while remote changes are still arriving (an active room)", () => {
    // Hidden well past the grace window, but a change landed recently, so
    // msSinceChange is small: the room is live, do not give up.
    expect(nextSyncDecision({ visible: false, msSinceChange: 500, msHidden: 60 * 60_000 })).toEqual({
      poll: true,
      delayMs: SYNC_INTERVAL_HIDDEN_MS,
    });
  });

  it("does not stop the instant a tab is hidden, even if it was long idle", () => {
    // Idle for an hour, but only just hidden: the grace window has not elapsed.
    expect(nextSyncDecision({ visible: false, msSinceChange: 60 * 60_000, msHidden: 1_000 })).toEqual({
      poll: true,
      delayMs: SYNC_INTERVAL_HIDDEN_MS,
    });
  });
});
