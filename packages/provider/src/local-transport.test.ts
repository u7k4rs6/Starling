import { describe, expect, it } from "vitest";
import { LocalRelayHub, type BroadcastLike } from "./local-transport.js";
import { InMemoryPersistence } from "./persistence.js";
import { Provider } from "./provider.js";

const ROOM = "8f14e45f-ceea-467e-bd7e-2e8912cee2b8";

/**
 * A deterministic stand-in for `BroadcastChannel`: `postMessage` from one
 * channel is delivered to every other channel on the same bus, never back to
 * the sender, exactly like the real thing across tabs, but synchronous so a
 * test does not have to wait on the event loop.
 */
class FakeBroadcastBus {
  private readonly handlers = new Map<object, (data: unknown) => void>();

  channel(): BroadcastLike {
    const token = {};
    return {
      postMessage: (message: unknown) => {
        for (const [other, handler] of this.handlers) if (other !== token) handler(message);
      },
      addEventListener: (_type, listener) => {
        this.handlers.set(token, (data) => listener({ data }));
      },
    };
  }
}

describe("LocalRelayHub: relay-shaped byte log with no server", () => {
  it("append returns the offset, read returns the tail from it, same contract as the relay", () => {
    const hub = new LocalRelayHub();
    expect(hub.append(ROOM, Uint8Array.from([1, 2, 3]))).toBe(0);
    expect(hub.append(ROOM, Uint8Array.from([4, 5]))).toBe(3);
    expect(hub.read(ROOM, 0)).toEqual(Uint8Array.from([1, 2, 3, 4, 5]));
    expect(hub.read(ROOM, 3)).toEqual(Uint8Array.from([4, 5]));
  });

  it("an untouched room reads as an empty log, not an error", () => {
    const hub = new LocalRelayHub();
    expect(hub.read(ROOM, 0)).toEqual(new Uint8Array(0));
  });

  it("two rooms are independent logs", () => {
    const hub = new LocalRelayHub();
    const other = "1f0e3dad-99f9-4a8e-9c9c-58e4c58e5e5a";
    hub.append(ROOM, Uint8Array.from([1]));
    hub.append(other, Uint8Array.from([2]));
    expect(hub.read(ROOM, 0)).toEqual(Uint8Array.from([1]));
    expect(hub.read(other, 0)).toEqual(Uint8Array.from([2]));
  });
});

describe("LocalRelayTransport: two panes in one page converge with no relay", () => {
  it("an edit on one pane reaches the other through a shared hub", async () => {
    const hub = new LocalRelayHub();
    const a = await Provider.create("pane-a", new InMemoryPersistence(), hub.transport(ROOM));
    const b = await Provider.create("pane-b", new InMemoryPersistence(), hub.transport(ROOM));

    await a.insertLocal(0, "h");
    await a.insertLocal(1, "i");
    await a.sync();
    await b.sync();

    expect(b.text).toBe("hi");
  });

  it("concurrent edits on both panes converge regardless of who syncs first", async () => {
    const hub = new LocalRelayHub();
    const a = await Provider.create("pane-a", new InMemoryPersistence(), hub.transport(ROOM));
    const b = await Provider.create("pane-b", new InMemoryPersistence(), hub.transport(ROOM));

    await a.insertLocal(0, "a");
    await b.insertLocal(0, "b");
    await a.sync();
    await b.sync();
    await a.sync();

    expect(a.text).toBe(b.text);
    expect(a.text).toHaveLength(2);
  });
});

describe("LocalRelayHub: a second tab mirrors appends over a broadcast channel", () => {
  it("an op appended in one tab's hub becomes readable in another tab's hub", async () => {
    const bus = new FakeBroadcastBus();
    const hubTab1 = new LocalRelayHub(bus.channel());
    const hubTab2 = new LocalRelayHub(bus.channel());

    const a = await Provider.create("tab1", new InMemoryPersistence(), hubTab1.transport(ROOM));
    const b = await Provider.create("tab2", new InMemoryPersistence(), hubTab2.transport(ROOM));

    await a.insertLocal(0, "x"); // append hits hubTab1 and is mirrored to hubTab2 over the bus
    await a.sync();
    await b.sync();

    expect(b.text).toBe("x");
  });

  it("a mirrored append does not echo back and loop", () => {
    const bus = new FakeBroadcastBus();
    const hub1 = new LocalRelayHub(bus.channel());
    const hub2 = new LocalRelayHub(bus.channel());

    hub1.append(ROOM, Uint8Array.from([7, 8, 9]));

    // hub2 received exactly the three bytes once; nothing bounced back to grow hub1.
    expect(hub2.read(ROOM, 0)).toEqual(Uint8Array.from([7, 8, 9]));
    expect(hub1.read(ROOM, 0)).toEqual(Uint8Array.from([7, 8, 9]));
  });
});
