import { describe, expect, it } from "vitest";
import { AwarenessClient } from "./awareness.js";
import type { RelayTransport } from "./transport.js";

/** Same shape as `provider.test.ts`'s `FakeRelay`, kept local since only
 * this file needs it — a shared in-process append-only byte log standing
 * in for the relay. */
class FakeChannel {
  private log: number[] = [];

  transport(): RelayTransport {
    return {
      append: async (bytes) => {
        const offset = this.log.length;
        this.log.push(...bytes);
        return offset;
      },
      read: async (from) => new Uint8Array(this.log.slice(from)),
    };
  }
}

function clockAt(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let t = startMs;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("AwarenessClient: publish/poll over a shared channel", () => {
  it("a client's own publish is reflected in its own peerStates immediately, before any poll", () => {
    const channel = new FakeChannel();
    const clock = clockAt(0);
    const a = new AwarenessClient("replica-A", channel.transport(), 30_000, clock.now);
    // No await needed to observe this — publish sets local state
    // synchronously before the (async) network append.
    void a.publish({ cursor: 5 });
    expect(a.peerStates()).toEqual([{ replica: "replica-A", data: { cursor: 5 }, timestamp: 0 }]);
  });

  it("a second client sees the first's presence after polling", async () => {
    const channel = new FakeChannel();
    const clock = clockAt(0);
    const a = new AwarenessClient("replica-A", channel.transport(), 30_000, clock.now);
    const b = new AwarenessClient("replica-B", channel.transport(), 30_000, clock.now);

    await a.publish({ cursor: 5 });
    expect(b.peerStates()).toEqual([]); // hasn't polled yet

    await b.poll();
    expect(b.peerStates()).toEqual([{ replica: "replica-A", data: { cursor: 5 }, timestamp: 0 }]);
  });

  it("two peers converge to seeing each other after both publish and both poll", async () => {
    const channel = new FakeChannel();
    const clock = clockAt(0);
    const a = new AwarenessClient("replica-A", channel.transport(), 30_000, clock.now);
    const b = new AwarenessClient("replica-B", channel.transport(), 30_000, clock.now);

    await a.publish({ cursor: 1 });
    await b.publish({ cursor: 2 });
    await a.poll();
    await b.poll();

    const replicas = (c: AwarenessClient) => c.peerStates().map((p) => p.replica).sort();
    expect(replicas(a)).toEqual(["replica-A", "replica-B"]);
    expect(replicas(b)).toEqual(["replica-A", "replica-B"]);
  });
});

describe("AwarenessClient: last-write-wins per replica", () => {
  it("a newer update from the same replica replaces the older one", async () => {
    const channel = new FakeChannel();
    const clock = clockAt(0);
    const a = new AwarenessClient("replica-A", channel.transport(), 30_000, clock.now);
    const b = new AwarenessClient("replica-B", channel.transport(), 30_000, clock.now);

    await a.publish({ cursor: 1 });
    clock.advance(100);
    await a.publish({ cursor: 2 });
    await b.poll();

    expect(b.peerStates()).toEqual([{ replica: "replica-A", data: { cursor: 2 }, timestamp: 100 }]);
  });

  it("an update that arrives late but is chronologically older does not overwrite a newer one already applied", async () => {
    // Simulates network reordering: publish the "old" record's bytes to
    // the channel *after* the "new" one, but with an earlier timestamp —
    // poll() must still resolve to the newer timestamp, since LWW compares
    // `timestamp`, not arrival order.
    const channel = new FakeChannel();
    const clock = clockAt(0);
    const a = new AwarenessClient("replica-A", channel.transport(), 30_000, clock.now);
    const b = new AwarenessClient("replica-B", channel.transport(), 30_000, clock.now);

    clock.advance(100);
    await a.publish({ cursor: "new" }); // timestamp 100, appended first
    clock.advance(-50); // pretend a delayed message with an earlier timestamp arrives next
    await a.publish({ cursor: "stale" }); // timestamp 50, appended second

    await b.poll();
    expect(b.peerStates()).toEqual([{ replica: "replica-A", data: { cursor: "new" }, timestamp: 100 }]);
  });
});

describe("AwarenessClient: TTL — ephemeral, not persisted", () => {
  it("a peer whose last update is older than the TTL is excluded from peerStates", async () => {
    const channel = new FakeChannel();
    const clock = clockAt(0);
    const a = new AwarenessClient("replica-A", channel.transport(), 1000, clock.now);
    const b = new AwarenessClient("replica-B", channel.transport(), 1000, clock.now);

    await a.publish({ cursor: 1 });
    await b.poll();
    expect(b.peerStates()).toHaveLength(1);

    clock.advance(1001); // b's own clock, not a's — TTL is evaluated locally
    expect(b.peerStates()).toEqual([]); // evaporated, with no further poll needed
  });

  it("a fresh publish after a gap makes a previously-evaporated peer reappear", async () => {
    const channel = new FakeChannel();
    const clock = clockAt(0);
    const a = new AwarenessClient("replica-A", channel.transport(), 1000, clock.now);
    const b = new AwarenessClient("replica-B", channel.transport(), 1000, clock.now);

    await a.publish({ cursor: 1 });
    await b.poll();
    clock.advance(2000);
    expect(b.peerStates()).toEqual([]);

    await a.publish({ cursor: 2 }); // a "closed the laptop and came back"
    await b.poll();
    expect(b.peerStates()).toEqual([{ replica: "replica-A", data: { cursor: 2 }, timestamp: 2000 }]);
  });
});
