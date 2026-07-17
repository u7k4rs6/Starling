import { describe, expect, it } from "vitest";
import { InMemoryPersistence } from "./persistence.js";
import { Provider } from "./provider.js";
import type { RelayTransport } from "./transport.js";

/**
 * An in-process stand-in for the relay's append-only byte log (ARCH §5),
 * shared by every `RelayTransport` view constructed from `forDoc` — this
 * is what lets these tests exercise multi-replica convergence through
 * push/pull without a real HTTP server. Step 10 is where a real relay
 * takes over this role.
 */
class FakeRelay {
  private readonly logs = new Map<string, number[]>();

  forDoc(docId: string): RelayTransport {
    return {
      append: async (bytes) => {
        const log = this.logs.get(docId) ?? [];
        const offset = log.length;
        log.push(...bytes);
        this.logs.set(docId, log);
        return offset;
      },
      read: async (from) => {
        const log = this.logs.get(docId) ?? [];
        return new Uint8Array(log.slice(from));
      },
    };
  }
}

describe("Provider.doc: exposes the same instance sync/persistence operate on", () => {
  it("edits made directly on .doc are visible via .text and get synced, without going through insertLocal", async () => {
    const relay = new FakeRelay();
    const transport = relay.forDoc("d1");
    const p = await Provider.create("r1", new InMemoryPersistence(), transport);

    // Bypassing Provider's own insertLocal entirely — this is exactly
    // what the editor binding does (transactionToOps operates on a Doc
    // directly, DECISIONS #0023) — and sync() must still pick it up,
    // proving .doc is the *same* instance sync()/pendingCount() use, not
    // an unrelated copy.
    p.doc.insertLocal(0, "x");
    expect(p.text).toBe("x");
    expect(p.pendingCount()).toBe(1);

    await p.sync();
    expect(p.pendingCount()).toBe(0);

    const other = await Provider.create("r2", new InMemoryPersistence(), transport);
    await other.sync();
    expect(other.text).toBe("x");
  });

  it("persistNow() persists a .doc-direct edit without ever calling sync() — the offline-editing case", async () => {
    // Found via the demo (packages/demo, Step 14): a real offline-reload
    // bug, not a hypothetical. The editor binding drives `.doc` directly
    // and never calls sync() while a replica is deliberately offline —
    // if persistence only ever happened inside sync() (as it did before
    // persistNow() was made public), an edit made while offline was
    // visible in .text immediately but silently never reached
    // IndexedDB, so reloading lost it. This test is the regression this
    // production bug turned into.
    const relay = new FakeRelay();
    const persistence = new InMemoryPersistence();
    const transport = relay.forDoc("d1");
    const p = await Provider.create("r1", persistence, transport);

    for (const [i, ch] of [..."offline"].entries()) p.doc.insertLocal(i, ch);
    await p.persistNow();

    const reloaded = await Provider.create("r1", persistence, transport);
    expect(reloaded.text).toBe(p.text);
    // Never synced — nothing reached the relay, on purpose (this is the
    // "still offline" case, not "came back online").
    expect(reloaded.pendingCount()).toBeGreaterThan(0);
  });
});

describe("Provider: local edits and persistence", () => {
  it("insertLocal/deleteLocal update .text immediately", async () => {
    const relay = new FakeRelay();
    const p = await Provider.create("r1", new InMemoryPersistence(), relay.forDoc("d1"));
    await p.insertLocal(0, "h");
    await p.insertLocal(1, "i");
    expect(p.text).toBe("hi");
    await p.deleteLocal(0);
    expect(p.text).toBe("i");
  });

  it("pendingCount reflects unpushed local ops and drops to 0 after a sync", async () => {
    const relay = new FakeRelay();
    const p = await Provider.create("r1", new InMemoryPersistence(), relay.forDoc("d1"));
    expect(p.pendingCount()).toBe(0);
    await p.insertLocal(0, "a");
    await p.insertLocal(1, "b");
    expect(p.pendingCount()).toBe(2);
    await p.sync();
    expect(p.pendingCount()).toBe(0);
  });
});

describe("S9: offline edits survive reload and reconcile on reconnect", () => {
  it("edits made while never synced are still there after the provider is reconstructed from persistence (reload)", async () => {
    const relay = new FakeRelay();
    const persistence = new InMemoryPersistence();

    const before = await Provider.create("r1", persistence, relay.forDoc("d1"));
    await before.insertLocal(0, "h");
    await before.insertLocal(1, "i");
    // Never called .sync() — this is the "offline" part: edits happen,
    // nothing has gone over the wire.

    // "Reload": a brand-new Provider instance, same persistence, no
    // in-memory state carried over except what was actually saved.
    const after = await Provider.create("r1", persistence, relay.forDoc("d1"));
    expect(after.text).toBe("hi");
    expect(after.pendingCount()).toBe(2); // still unpushed — reload doesn't sync by itself
  });

  it("reload, then reconnect: pending ops from before the reload reach the relay and a second replica sees them", async () => {
    const relay = new FakeRelay();
    const persistenceA = new InMemoryPersistence();

    const a1 = await Provider.create("replica-A", persistenceA, relay.forDoc("d1"));
    await a1.insertLocal(0, "h");
    await a1.insertLocal(1, "i");
    // offline the whole time up to here

    const a2 = await Provider.create("replica-A", persistenceA, relay.forDoc("d1")); // reload
    expect(a2.pendingCount()).toBe(2);
    await a2.sync(); // reconnect
    expect(a2.pendingCount()).toBe(0);

    const b = await Provider.create("replica-B", new InMemoryPersistence(), relay.forDoc("d1"));
    await b.sync();
    expect(b.text).toBe("hi");
  });
});

describe("Provider: sync loop convergence and idempotence", () => {
  it("two replicas converge after both sync, regardless of who syncs first", async () => {
    const relay = new FakeRelay();
    const a = await Provider.create("replica-A", new InMemoryPersistence(), relay.forDoc("d1"));
    const b = await Provider.create("replica-B", new InMemoryPersistence(), relay.forDoc("d1"));

    await a.insertLocal(0, "a");
    await b.insertLocal(0, "b");

    await a.sync();
    await b.sync();
    await a.sync(); // a needs a second sync to pick up what b just pushed

    expect(a.text).toBe(b.text);
    expect(a.text).toHaveLength(2);
  });

  it("syncing twice in a row with nothing new does not grow the relay log or throw", async () => {
    const relay = new FakeRelay();
    const transport = relay.forDoc("d1");
    const p = await Provider.create("replica-A", new InMemoryPersistence(), transport);
    await p.insertLocal(0, "x");
    await p.sync();
    const afterFirstSync = await transport.read(0);

    await p.sync(); // nothing changed locally or remotely since
    const afterSecondSync = await transport.read(0);

    expect(afterSecondSync).toEqual(afterFirstSync);
  });

  it("a replica does not re-push ops it just pulled from another replica", async () => {
    // If lastPushedVector weren't updated for pulled ops, the very next
    // sync would immediately re-encode and re-append them right back —
    // wasteful, and (if it went unnoticed) would make the relay log grow
    // without bound even with a single idle pair of replicas.
    const relay = new FakeRelay();
    const transport = relay.forDoc("d1");
    const a = await Provider.create("replica-A", new InMemoryPersistence(), transport);
    await a.insertLocal(0, "x");
    await a.sync();
    const afterAPush = await transport.read(0);

    const b = await Provider.create("replica-B", new InMemoryPersistence(), transport);
    await b.sync(); // pulls A's op
    expect(b.text).toBe("x");
    await b.sync(); // should push nothing back

    const afterBSyncs = await transport.read(0);
    expect(afterBSyncs).toEqual(afterAPush);
  });

  it("three replicas editing concurrently and syncing in a fixed round-robin converge", async () => {
    const relay = new FakeRelay();
    const docId = "d1";
    const replicas = ["replica-A", "replica-B", "replica-C"].map(async (id) =>
      Provider.create(id, new InMemoryPersistence(), relay.forDoc(docId))
    );
    const [a, b, c] = await Promise.all(replicas);

    await a!.insertLocal(0, "1");
    await b!.insertLocal(0, "2");
    await c!.insertLocal(0, "3");

    // Two full round-robin rounds is enough for a 3-replica chain to
    // fully propagate: round 1 lets each replica's own op reach the
    // relay, round 2 lets every replica pull what the other two pushed.
    for (let round = 0; round < 2; round += 1) {
      await a!.sync();
      await b!.sync();
      await c!.sync();
    }

    expect(a!.text).toBe(b!.text);
    expect(b!.text).toBe(c!.text);
    expect(a!.text).toHaveLength(3);
  });
});
