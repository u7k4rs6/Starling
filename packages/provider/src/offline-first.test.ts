import "fake-indexeddb/auto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
// Relative, not a package import: packages/provider declares no runtime
// dependency on packages/relay (ARCH §1's graph has no edge between them,
// and never should — a browser bundle of provider must never need a
// Node http-server implementation). This is Step 10's own integration
// test reaching across a package boundary to prove the real stack works
// together, the same latitude tools/gates already takes reaching into
// packages/relay by relative path; it is not a claim that provider
// depends on relay.
import { createRelayServer } from "../../relay/src/server.js";
import { IndexedDbPersistence } from "./persistence.js";
import { HttpRelayTransport } from "./transport.js";
import { Provider } from "./provider.js";

/**
 * PRD §5, Step 10: "Offline-first integration test | S9 demonstrable".
 * Step 9's own tests already proved the sync loop's logic correct against
 * in-process doubles (`InMemoryPersistence`, a fake shared-byte-log). This
 * file swaps both doubles for the real thing: a real relay server over
 * real HTTP (`packages/relay`, unmodified since Step 8), and real
 * IndexedDB persistence (`packages/provider`'s own `IndexedDbPersistence`,
 * backed by `fake-indexeddb` — the same real-API-shape implementation
 * Step 9's `persistence.test.ts` already exercises directly).
 *
 * Prediction, stated before running: no new behavior should surface here.
 * Each piece (`Provider`'s sync logic, `HttpRelayTransport` against a real
 * HTTP server, `IndexedDbPersistence` against a real IndexedDB API) was
 * independently verified in Step 8 and Step 9. This test exists to check
 * that assembling them produces the same result as the doubles predicted,
 * not to go looking for a new algorithmic bug — if it fails, the most
 * likely cause is a wiring mistake in this test, not a new discovery.
 */

let activeServer: ReturnType<typeof createRelayServer> | null = null;

async function startRelay(): Promise<string> {
  const server = createRelayServer({ allowedOrigin: "https://demo.example" });
  activeServer = server;
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
    activeServer = null;
  }
});

describe("S9 end to end: real relay (HTTP) + real IndexedDB persistence", () => {
  it("offline edits survive reload (IndexedDB) and reconcile on reconnect (real relay)", async () => {
    const docId = "11111111-1111-4111-8111-111111111111"; // relay validates doc ids as UUIDs (SECURITY §2.2)
    const relayUrl = await startRelay();

    const a1 = await Provider.create(
      "replica-A",
      new IndexedDbPersistence(docId),
      new HttpRelayTransport(relayUrl, docId)
    );
    await a1.insertLocal(0, "h");
    await a1.insertLocal(1, "e");
    await a1.insertLocal(2, "l");
    await a1.insertLocal(3, "l");
    await a1.insertLocal(4, "o");
    // Offline the entire time: a1 never calls .sync(). Nothing has left
    // this process, let alone reached the relay.

    // Reload: a brand-new Provider, a brand-new IndexedDbPersistence
    // instance pointed at the same doc id — the only thing carried over
    // is whatever actually made it into (fake-)IndexedDB.
    const a2 = await Provider.create(
      "replica-A",
      new IndexedDbPersistence(docId),
      new HttpRelayTransport(relayUrl, docId)
    );
    expect(a2.text).toBe("hello");
    expect(a2.pendingCount()).toBe(5); // still unpushed — reload alone doesn't sync

    // Reconnect: this goes over real HTTP to the real relay server.
    await a2.sync();
    expect(a2.pendingCount()).toBe(0);

    // A second replica, its own persistence, pulling from the same real
    // relay: this is the "reconcile" half — content that only ever
    // existed in replica A's IndexedDB is now visible to a completely
    // independent process via nothing but the relay's byte log.
    const b = await Provider.create(
      "replica-B",
      new IndexedDbPersistence(docId + "-viewed-by-b"), // its own local storage
      new HttpRelayTransport(relayUrl, docId)
    );
    await b.sync();
    expect(b.text).toBe("hello");

    // Close the loop: B edits and pushes, A pulls it back — genuine
    // two-way reconciliation over the real relay, not just one-way
    // replication.
    await b.insertLocal(5, "!");
    await b.sync();
    await a2.sync();
    expect(a2.text).toBe("hello!");
  });
});
