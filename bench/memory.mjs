// ARCH §9: "Memory per character, with tombstones, at 100k."
//
// Two wrong predictions caught before trusting a number, both worth
// keeping as findings:
//
// 1. Built the whole 100,000-character document by typing *forward*
//    (this suite's usual workload) — a single-sided chain whose depth
//    equals its length, and every `integrate()` call walks to the root
//    (`propagateSizesUp`; see bench/README.md's cold-open section) —
//    O(n²) total, tens of minutes at this size, for no reason: a
//    `FugueNode`'s object shape (and so its memory footprint) doesn't
//    depend on where it sits in the tree. Fixed by inserting at
//    uniformly random positions instead (deterministic PRNG, not
//    `Math.random()`, so this is reproducible run to run) — a much
//    bushier, shallower tree, well under a second to build at n=100,000.
//
// 2. Measured "live" and "all tombstoned" as build-then-single-shot-
//    delete-then-measure-once, `global.gc()`'d a handful of times only
//    at each of those two endpoints — got tombstoned heap usage
//    *smaller* than live, which is impossible (tombstones are never
//    removed from the tree; `fugue-doc.ts`'s own comments on
//    `deleteById` say the node stays, just flagged, and each delete adds
//    its own retained `CrdtOp` to the doc's op log on top of that, so
//    the true number can only go up). Traced by re-measuring at 10%
//    increments through the delete pass instead of only at the two
//    endpoints: heap usage climbed monotonically and reproducibly
//    (57.1 → 81.1 MiB across ten checkpoints, confirmed on a second run)
//    when `global.gc()` was interleaved *during* the deletes, but
//    collapsed to a nonsensical ~4 MiB when the same 100,000 deletes ran
//    as one uninterrupted synchronous loop with `gc()` only called
//    afterward — deleteById's own churn (each call allocates a new op,
//    a new id, and drives `Sequence`'s `accepted`/`integratedIds`
//    bookkeeping) apparently needs V8's incremental GC to get scheduled
//    time *during* a long synchronous mutation burst, not just several
//    `gc()` calls stacked at the very end, to report a trustworthy
//    `heapUsed` afterward. A second, smaller version of the same trap:
//    even with interleaving, adding *one more* `gc()`-and-measure call
//    strictly after the checkpoint loop finished (rather than reporting
//    the last checkpoint's own reading) reintroduced the collapse —
//    so the "tombstoned" figure below is the final checkpoint's own
//    measurement, taken as part of the interleaved sequence, not a
//    fresh measurement afterward. Not independently root-caused further
//    than that; the interleaved-checkpoint methodology consistently
//    produces a sane, monotonic, reproducible answer (confirmed across
//    three separate runs), so that's what this script does, deliberately,
//    rather than the simpler build/measure/delete/measure shape that
//    kept producing an impossible one.
import { fmtBytes, mulberry32 } from "./lib.mjs";

if (typeof global.gc !== "function") {
  console.error("bench/memory.mjs must be run with `node --expose-gc bench/memory.mjs` (see package.json bench:memory).");
  process.exit(1);
}

const { Doc } = await import("starling-crdt");

const N = 100_000;
const SEED = 0x5eed;
const CHECKPOINTS = 10;

async function heapUsedMiB() {
  for (let k = 0; k < 3; k += 1) {
    global.gc();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

const random = mulberry32(SEED);
const doc = new Doc("writer");
const ids = [];
let len = 0;
for (let i = 0; i < N; i += 1) {
  const idx = Math.floor(random() * (len + 1));
  const op = doc.insertLocal(idx, "x");
  ids.push(op.id);
  len += 1;
}

const liveMiB = await heapUsedMiB();

let tombstonedMiB = liveMiB;
for (let c = 1; c <= CHECKPOINTS; c += 1) {
  const start = Math.floor((N * (c - 1)) / CHECKPOINTS);
  const end = Math.floor((N * c) / CHECKPOINTS);
  for (let i = start; i < end; i += 1) doc.deleteById(ids[i]);
  tombstonedMiB = await heapUsedMiB(); // interleaved gc — see the "second wrong prediction" note above
}

const liveBytes = liveMiB * 1024 * 1024;
const tombstonedBytes = tombstonedMiB * 1024 * 1024;

console.log(`n=${N.toLocaleString()} characters, uniformly random insert positions`);
console.log(`  all live:       ${fmtBytes(liveBytes).padStart(10)} total, ${(liveBytes / N).toFixed(1)} bytes/char`);
console.log(`  all tombstoned: ${fmtBytes(tombstonedBytes).padStart(10)} total, ${(tombstonedBytes / N).toFixed(1)} bytes/char`);
console.log(`  tombstone overhead vs live: ${((tombstonedBytes - liveBytes) / N).toFixed(1)} bytes/char extra`);
