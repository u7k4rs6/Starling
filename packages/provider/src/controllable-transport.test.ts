import { describe, expect, it } from "vitest";
import { ControllableTransport } from "./controllable-transport.js";
import { LocalRelayHub } from "./local-transport.js";
import { InMemoryPersistence } from "./persistence.js";
import { Provider } from "./provider.js";

const ROOM = "8f14e45f-ceea-467e-bd7e-2e8912cee2b8";
const noSleep = { sleep: async () => {} };

describe("ControllableTransport: partition", () => {
  it("rejects append and read while disconnected", async () => {
    const link = new ControllableTransport(new LocalRelayHub().transport(ROOM), { connected: false });
    await expect(link.append(Uint8Array.from([1]))).rejects.toThrow(/partition/);
    await expect(link.read(0)).rejects.toThrow(/partition/);
  });

  it("diverges under partition and reconverges on reconnect, with no lost keystrokes", async () => {
    const hub = new LocalRelayHub();
    const linkA = new ControllableTransport(hub.transport(ROOM), {}, noSleep);
    const linkB = new ControllableTransport(hub.transport(ROOM), {}, noSleep);
    const a = await Provider.create("a", new InMemoryPersistence(), linkA);
    const b = await Provider.create("b", new InMemoryPersistence(), linkB);

    await a.insertLocal(0, "x");
    await a.sync();
    await b.sync();
    expect(b.text).toBe("x");

    // Partition A, then both edit the same spot.
    linkA.setState({ connected: false });
    await a.insertLocal(1, "A");
    await b.insertLocal(1, "B");
    await expect(a.sync()).rejects.toThrow(/partition/); // A cannot reach the log
    await b.sync();
    expect(a.text).not.toBe(b.text); // visibly diverged

    // Reconnect A: its edit was never lost, only held.
    linkA.setState({ connected: true });
    await a.sync();
    await b.sync();
    await a.sync();
    expect(a.text).toBe(b.text);
    expect(a.text).toHaveLength(3); // x, A, B all present
  });
});

describe("ControllableTransport: latency", () => {
  it("delays each call by the configured latency", async () => {
    const waited: number[] = [];
    const link = new ControllableTransport(new LocalRelayHub().transport(ROOM), { latencyMs: 120 }, {
      sleep: async (ms) => {
        waited.push(ms);
      },
    });
    await link.append(Uint8Array.from([1]));
    await link.read(0);
    expect(waited).toEqual([120, 120]);
  });
});

describe("ControllableTransport: drop is transient, never a lost op", () => {
  it("a dropped push is re-offered on the next sync and the document converges", async () => {
    const hub = new LocalRelayHub();
    const link = new ControllableTransport(hub.transport(ROOM), {}, { ...noSleep, random: () => 0 });
    const a = await Provider.create("a", new InMemoryPersistence(), link);
    const b = await Provider.create("b", new InMemoryPersistence(), hub.transport(ROOM));

    await a.insertLocal(0, "z");
    link.setState({ dropRate: 1 }); // every append drops
    await expect(a.sync()).rejects.toThrow(/dropped/);
    await b.sync();
    expect(b.text).toBe(""); // the op did not get through

    link.setState({ dropRate: 0 }); // link recovers
    await a.sync();
    await b.sync();
    expect(b.text).toBe("z"); // and the op was still there to send, not lost
  });
});

describe("ControllableTransport: reordering does not change the converged document", () => {
  it("two replicas converge with reordering forced on", async () => {
    const hub = new LocalRelayHub();
    const link = new ControllableTransport(hub.transport(ROOM), { reorderRate: 1 }, { ...noSleep, random: () => 0 });
    const a = await Provider.create("a", new InMemoryPersistence(), link);
    const b = await Provider.create("b", new InMemoryPersistence(), hub.transport(ROOM));

    await a.insertLocal(0, "a");
    await a.insertLocal(1, "b");
    await a.insertLocal(2, "c");
    await a.sync();
    await b.sync();

    expect(b.text).toBe("abc");
  });
});
