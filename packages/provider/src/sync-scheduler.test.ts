import { describe, expect, it } from "vitest";
import {
  nextSyncDelayMs,
  SYNC_ACTIVE_WINDOW_MS,
  SYNC_INTERVAL_ACTIVE_MS,
  SYNC_INTERVAL_HIDDEN_MS,
  SYNC_INTERVAL_IDLE_MS,
} from "./sync-scheduler.js";

describe("nextSyncDelayMs: adaptive poll cadence", () => {
  it("polls fast while visible and recently changed", () => {
    expect(nextSyncDelayMs({ visible: true, msSinceChange: 0 })).toBe(SYNC_INTERVAL_ACTIVE_MS);
    expect(nextSyncDelayMs({ visible: true, msSinceChange: SYNC_ACTIVE_WINDOW_MS })).toBe(SYNC_INTERVAL_ACTIVE_MS);
  });

  it("backs off when visible but idle", () => {
    expect(nextSyncDelayMs({ visible: true, msSinceChange: SYNC_ACTIVE_WINDOW_MS + 1 })).toBe(SYNC_INTERVAL_IDLE_MS);
    expect(nextSyncDelayMs({ visible: true, msSinceChange: 60_000 })).toBe(SYNC_INTERVAL_IDLE_MS);
  });

  it("backs off hard when backgrounded, regardless of recent activity", () => {
    expect(nextSyncDelayMs({ visible: false, msSinceChange: 0 })).toBe(SYNC_INTERVAL_HIDDEN_MS);
    expect(nextSyncDelayMs({ visible: false, msSinceChange: 60_000 })).toBe(SYNC_INTERVAL_HIDDEN_MS);
  });

  it("the intervals are ordered fast to slow", () => {
    expect(SYNC_INTERVAL_ACTIVE_MS).toBeLessThan(SYNC_INTERVAL_IDLE_MS);
    expect(SYNC_INTERVAL_IDLE_MS).toBeLessThan(SYNC_INTERVAL_HIDDEN_MS);
  });
});
