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
