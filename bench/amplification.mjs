// Reconciliation amplification: when the relay restarts (or evicts a room) onto
// an empty log, clients re-push. The relay log does not dedupe (that is the
// "relay ignorance" boundary), so this adds real bytes. This is the producer
// for the "~10 KB staggered / ~30 KB concurrent / 1.45% of the 2 MB cap" figures
// in DECISIONS #0032.
//
// It runs the real `Provider` sync logic against the real `LogStore` (the relay's
// in-memory byte log, with its per-document generation token and its
// out-of-range-reads-as-empty behaviour), through a transport that maps onto the
// store directly. A "restart" swaps in a fresh empty store with a new boot token,
// exactly what a spin-down looks like to a client. Deterministic apart from the
// randomly-generated ids, so the byte totals are stable.
// Imported from built dist by relative path: unlike `starling-crdt` (a
// published package name), `@starling/provider` and `@starling/relay` are
// workspace-internal and not hoisted to the repo-root node_modules, so a
// bare specifier does not resolve from bench/. Run `tsc -b` first if dist is stale.
import { Provider, InMemoryPersistence } from "../packages/provider/dist/index.js";
import { LogStore } from "../packages/relay/dist/index.js";
import { randomUUID } from "node:crypto";

const DOC = "8f14e45f-ceea-467e-bd7e-2e8912cee2b8";
const CAP = 2 * 1024 * 1024; // MAX_LOG_BYTES_PER_DOC
const CLIENTS = 3;
const CHARS_PER_CLIENT = 300; // 3 * 300 = 900-op document
const RESTARTS = 5;

// A RelayTransport backed directly by a LogStore, honouring the same contract
// the HTTP relay exposes: append -> offset, read -> bytes (empty when the cursor
// is past the end), and a per-document generation token that falls back to the
// boot token for an absent doc.
function transport(ref) {
  return {
    generation() {
      return ref.store.generationOf(DOC) ?? ref.boot;
    },
    async read(from) {
      const r = ref.store.read(DOC, from);
      return r.ok ? new Uint8Array(r.bytes) : new Uint8Array(0);
    },
    async append(bytes) {
      const r = ref.store.append(DOC, Buffer.from(bytes));
      if (!r.ok) throw new Error(r.error);
      return r.offset;
    },
  };
}

function logBytes(ref) {
  const r = ref.store.read(DOC, 0);
  return r.ok ? r.bytes.length : 0;
}

async function run(concurrent) {
  const ref = { store: new LogStore(), boot: randomUUID() };
  const clients = [];
  for (let i = 0; i < CLIENTS; i += 1) {
    clients.push(await Provider.create(randomUUID(), new InMemoryPersistence(), transport(ref)));
  }
  // Each client types its own run; converge so every client holds the full doc.
  for (let i = 0; i < clients.length; i += 1) {
    for (let k = 0; k < CHARS_PER_CLIENT; k += 1) await clients[i].insertLocal(0, String.fromCharCode(97 + i));
  }
  for (let r = 0; r < 4; r += 1) for (const c of clients) await c.sync();
  const ops = clients[0].text.length;
  const oneCopy = logBytes(ref);

  const sizes = [];
  for (let restart = 0; restart < RESTARTS; restart += 1) {
    // Restart: fresh empty log, new boot token. Cursors and vectors still point
    // at the old log; the generation change makes clients reconcile.
    ref.store = new LogStore();
    ref.boot = randomUUID();
    if (concurrent) {
      // All read the empty log before any push: the worst case.
      await Promise.all(clients.map((c) => c.sync()));
      await Promise.all(clients.map((c) => c.sync()));
    } else {
      // Staggered: the first re-push fills the log, the rest read it and push nothing.
      for (const c of clients) await c.sync();
      for (const c of clients) await c.sync();
    }
    sizes.push(logBytes(ref));
  }
  const converged = clients.every((c) => c.text === clients[0].text) && clients[0].text.length === ops;
  return { ops, oneCopy, sizes, converged };
}

const stag = await run(false);
const conc = await run(true);
const pct = (n) => ((n / CAP) * 100).toFixed(2);

console.log(`=== Reconciliation amplification: ${CLIENTS} clients, ${stag.ops}-op document, ${RESTARTS} restarts ===`);
console.log(`  single copy of the document on the log: ${stag.oneCopy.toLocaleString()} bytes`);
console.log(`  staggered  reconcile, log bytes per restart: ${stag.sizes.map((n) => n.toLocaleString()).join(", ")}  (converged=${stag.converged})`);
console.log(`  concurrent reconcile, log bytes per restart: ${conc.sizes.map((n) => n.toLocaleString()).join(", ")}  (converged=${conc.converged})`);
const worst = Math.max(...conc.sizes);
console.log(`  worst single-restart log vs 2 MB cap: ${worst.toLocaleString()} bytes = ${pct(worst)}% of ${CAP.toLocaleString()}`);
console.log("  (per restart, not cumulative: each restart empties the log first.)");
