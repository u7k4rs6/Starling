import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IndexedDbPersistence, InMemoryPersistence, type PersistedState } from "./persistence.js";

function sampleState(n: number): PersistedState {
  return {
    opLogBytes: new Uint8Array([n, n + 1, n + 2]),
    lastPushedVectorEntries: [["replica-A", n]],
    relayReadOffset: n * 10,
  };
}

describe.each([
  ["InMemoryPersistence", () => new InMemoryPersistence()],
  ["IndexedDbPersistence", () => new IndexedDbPersistence(`doc-${Math.random()}`)],
])("%s (shared Persistence contract)", (_name, makePersistence) => {
  it("returns null when nothing has been saved yet", async () => {
    const persistence = makePersistence();
    expect(await persistence.load()).toBeNull();
  });

  it("round-trips a saved state exactly, byte array included", async () => {
    const persistence = makePersistence();
    const state = sampleState(1);
    await persistence.save(state);
    const loaded = await persistence.load();
    expect(loaded).toEqual(state);
  });

  it("a later save overwrites the earlier one, it does not append", async () => {
    const persistence = makePersistence();
    await persistence.save(sampleState(1));
    await persistence.save(sampleState(2));
    expect(await persistence.load()).toEqual(sampleState(2));
  });
});

describe("IndexedDbPersistence: concurrent save() calls resolve in call order (DECISIONS #0025)", () => {
  it("N unawaited save() calls fired back to back leave the store holding the last one, not whichever happened to commit last", async () => {
    // Prediction: without serializing, each save() independently opens
    // its own IndexedDB connection and transaction — nothing guarantees
    // the Nth call's transaction is also the Nth to commit, so firing
    // many without awaiting between them risks the final stored state
    // being an earlier one, not sampleState(19). This is exactly the
    // shape of bug that surfaced through the demo (packages/demo, Step
    // 14): persistNow() fired once per keystroke, unawaited, and a
    // fast-typed offline string reloaded with only its first few
    // characters.
    const persistence = new IndexedDbPersistence(`doc-concurrency-${Math.random()}`);
    const saves: Promise<void>[] = [];
    for (let i = 0; i < 20; i += 1) saves.push(persistence.save(sampleState(i)));
    await Promise.all(saves);
    expect(await persistence.load()).toEqual(sampleState(19));
  });

  it("save() calls interleaved with load() calls still resolve in call order — load() joins the same queue", async () => {
    const persistence = new IndexedDbPersistence(`doc-concurrency-load-${Math.random()}`);
    const firstSave = persistence.save(sampleState(1));
    const firstLoad = persistence.load();
    const secondSave = persistence.save(sampleState(2));
    const secondLoad = persistence.load();
    await Promise.all([firstSave, firstLoad, secondSave, secondLoad]);
    expect(await firstLoad).toEqual(sampleState(1));
    expect(await secondLoad).toEqual(sampleState(2));
  });
});

describe("IndexedDbPersistence: separate doc ids do not share state", () => {
  it("two documents persisted under different ids stay independent", async () => {
    const a = new IndexedDbPersistence("doc-a-independence-check");
    const b = new IndexedDbPersistence("doc-b-independence-check");
    await a.save(sampleState(1));
    await b.save(sampleState(2));
    expect(await a.load()).toEqual(sampleState(1));
    expect(await b.load()).toEqual(sampleState(2));
  });
});
