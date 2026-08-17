import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayServer, type RelayOptions } from "@starling/relay";
import { HttpRelayTransport } from "./transport.js";
import { InMemoryPersistence } from "./persistence.js";
import { Provider } from "./provider.js";

/**
 * End-to-end tests of the client against the real relay HTTP server: the
 * generation header, the rate limit, and eviction all exercised through the
 * wire, not a double. These cross the provider/relay boundary on purpose, to
 * catch exactly the failures a same-package unit test cannot see.
 */

const ALLOWED_ORIGIN = "https://demo.example";
const DOC = "8f14e45f-ceea-467e-bd7e-2e8912cee2b8";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let server: ReturnType<typeof createRelayServer> | null = null;

function start(options: Partial<RelayOptions> = {}): Promise<string> {
  server = createRelayServer({ allowedOrigin: ALLOWED_ORIGIN, ...options });
  return new Promise((resolve) => {
    server!.listen(0, "127.0.0.1", () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

function otherDoc(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

describe("LRU eviction recovery (the case the per-boot token missed)", () => {
  it("two live clients reconcile and converge after their room is evicted and recreated, no lost or duplicated ops", async () => {
    const maxDocs = 4;
    const base = await start({ maxDocs });
    const a = await Provider.create("a", new InMemoryPersistence(), new HttpRelayTransport(base, DOC));
    const b = await Provider.create("b", new InMemoryPersistence(), new HttpRelayTransport(base, DOC));

    await a.insertLocal(0, "a");
    await a.insertLocal(1, "a");
    await b.insertLocal(0, "b");
    for (let i = 0; i < 3; i += 1) {
      await a.sync();
      await b.sync();
    }
    expect(a.text).toBe(b.text);
    const before = a.text;
    expect(before).toHaveLength(3);

    // Force the room out of the in-memory cache: create maxDocs other docs, each
    // more recently used, so the room becomes the LRU and is evicted. There is
    // no persistent disk, so its log is dropped and it will be recreated empty
    // under a new per-document token.
    for (let i = 1; i <= maxDocs; i += 1) {
      await fetch(`${base}/doc/${otherDoc(i)}`, { method: "POST", body: "x" });
    }

    // Both clients still hold cursors into the evicted log and vectors claiming
    // full upload. Without a per-document token this is a permanent silent
    // split; with it, the changed token makes both reconcile and re-push.
    for (let i = 0; i < 4; i += 1) {
      await a.sync();
      await b.sync();
    }

    expect(a.text).toBe(b.text);
    expect(a.text).toHaveLength(3); // no duplication
    expect([...a.text].sort()).toEqual([...before].sort()); // same document, re-uploaded
  });
});

describe("rate-limit retry (a path the old unreachable caps never ran)", () => {
  it("an append rejected with 429 is retried on a later sync and the op still lands", async () => {
    // Per-doc ceiling of 2/s, so a third append in the same one-second window is
    // rejected. The per-IP ceiling is left high so only the per-doc one bites.
    const base = await start({ appendRatePerSecondPerDoc: 2, appendRatePerSecond: 1000 });
    const a = await Provider.create("a", new InMemoryPersistence(), new HttpRelayTransport(base, DOC));
    const b = await Provider.create("b", new InMemoryPersistence(), new HttpRelayTransport(base, DOC));

    await a.insertLocal(0, "a");
    await a.sync();
    await a.insertLocal(1, "b");
    await a.sync();
    await a.insertLocal(2, "c");
    await expect(a.sync()).rejects.toThrow(/429/); // third append rejected
    await b.sync();
    expect(b.text).not.toContain("c"); // the op has not landed

    // The op is not dropped: it stays unpushed (the vector never advanced past
    // it), so a normal sync re-offers it once the one-second window refills.
    await sleep(1100);
    await a.sync();
    await b.sync();
    expect(b.text).toBe(a.text);
    expect([...b.text].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("per-document generation over the wire", () => {
  it("different documents carry different tokens, and a document's token is stable while resident", async () => {
    const base = await start();
    const DOC_B = "22222222-2222-4222-8222-222222222222";
    await fetch(`${base}/doc/${DOC}`, { method: "POST", body: "x" });
    await fetch(`${base}/doc/${DOC_B}`, { method: "POST", body: "y" });
    const genA1 = (await fetch(`${base}/doc/${DOC}?from=0`)).headers.get("x-relay-generation");
    const genA2 = (await fetch(`${base}/doc/${DOC}?from=0`)).headers.get("x-relay-generation");
    const genB = (await fetch(`${base}/doc/${DOC_B}?from=0`)).headers.get("x-relay-generation");
    expect(genA1).toBeTruthy();
    expect(genA2).toBe(genA1); // stable while resident
    expect(genB).not.toBe(genA1); // per document, not per boot
  });
});
