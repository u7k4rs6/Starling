import { describe, expect, it } from "vitest";
import { InMemoryPersistence } from "./persistence.js";
import { Provider } from "./provider.js";
import type { RelayTransport } from "./transport.js";

/**
 * A stand-in for the hosted relay that can be restarted, mimicking the exact
 * contract the real server exposes: every read and append reports the current
 * generation token, an out-of-range read returns empty bytes (not an error),
 * and restarting swaps in a fresh empty log with a new generation. This is the
 * behaviour a client sees when a free-tier relay spins down and comes back.
 */
class RestartableRelay {
  private log: number[] = [];
  generation = "gen-1";

  restart(nextGeneration: string): void {
    this.log = [];
    this.generation = nextGeneration;
  }

  append(bytes: Uint8Array): number {
    const offset = this.log.length;
    this.log.push(...bytes);
    return offset;
  }

  read(from: number): Uint8Array {
    if (from > this.log.length) return new Uint8Array(0); // out of range -> empty, as the server does
    return Uint8Array.from(this.log.slice(from));
  }
}

class RestartableTransport implements RelayTransport {
  private lastGeneration: string;
  constructor(private readonly relay: RestartableRelay) {
    this.lastGeneration = relay.generation;
  }
  generation(): string {
    return this.lastGeneration;
  }
  async append(bytes: Uint8Array): Promise<number> {
    const offset = this.relay.append(bytes);
    this.lastGeneration = this.relay.generation;
    return offset;
  }
  async read(from: number): Promise<Uint8Array> {
    const bytes = this.relay.read(from);
    this.lastGeneration = this.relay.generation;
    return bytes;
  }
}

async function settle(a: Provider, b: Provider): Promise<void> {
  await a.sync();
  await b.sync();
  await a.sync();
  await b.sync();
}

describe("Provider: relay restart reconciliation", () => {
  it("recovers from a restart mid-session with no lost or duplicated ops", async () => {
    const relay = new RestartableRelay();
    const a = await Provider.create("a", new InMemoryPersistence(), new RestartableTransport(relay));
    const b = await Provider.create("b", new InMemoryPersistence(), new RestartableTransport(relay));

    await a.insertLocal(0, "a");
    await a.insertLocal(1, "a");
    await b.insertLocal(0, "b");
    await settle(a, b);
    expect(a.text).toBe(b.text);
    const before = a.text;
    expect(before).toHaveLength(3);

    // The relay spins down and comes back: fresh empty log, new generation.
    // Both clients still hold cursors into the old log and vectors claiming
    // their history is already uploaded. Without the generation check this is a
    // permanent split.
    relay.restart("gen-2");
    await settle(a, b);

    expect(a.text).toBe(b.text);
    expect(a.text).toHaveLength(3); // nothing duplicated
    expect([...a.text].sort()).toEqual([...before].sort()); // same document, re-uploaded
  });

  it("a client that only reads after the restart still receives the re-pushed history", async () => {
    const relay = new RestartableRelay();
    const writer = await Provider.create("w", new InMemoryPersistence(), new RestartableTransport(relay));
    const reader = await Provider.create("r", new InMemoryPersistence(), new RestartableTransport(relay));

    for (const [i, ch] of [..."hello"].entries()) await writer.insertLocal(i, ch);
    await settle(writer, reader);
    expect(reader.text).toBe("hello");

    relay.restart("gen-2");
    // Writer re-pushes on its next sync; reader picks it back up.
    await settle(writer, reader);
    expect(reader.text).toBe("hello");
  });

  it("does not reset on the first generation seen, only on a change", async () => {
    const relay = new RestartableRelay();
    const a = await Provider.create("a", new InMemoryPersistence(), new RestartableTransport(relay));
    await a.insertLocal(0, "x");
    await a.sync(); // first generation adopted, no spurious reset
    await a.sync(); // stable generation, no reset
    expect(a.text).toBe("x");
    expect(a.pendingCount()).toBe(0); // still marked as pushed, not re-queued
  });
});
