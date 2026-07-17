// ARCH §9: encode/decode round-trip throughput, and the §3.1 byte-budget
// assertion (60,000 deletions in a single contiguous run). The byte-budget
// number already has its own vitest assertion (packages/crdt/src/
// encoding.test.ts, "ARCH §3.1 target") — reproduced here too so it prints
// alongside the throughput numbers in one place for bench/README.md,
// rather than sending a reader to a different file for one figure.
//
// Ops are built with `RgaDoc`, not `Doc` — `encodeOps`/`decodeOps` operate
// on the wire `CrdtOp` shape, which every `Sequence<CrdtPayload>` subclass
// (ArrayDoc/RgaDoc/Doc) produces identically; encoding throughput is a
// property of the wire format, not of which tree built the ops, so there
// is no reason to pay `Doc`'s much slower op-construction cost (bench/
// cold-open.mjs's whole point) just to get *building material* for a
// benchmark that isn't measuring that cost.
import { RgaDoc, encodeOps, decodeOps } from "starling-crdt";
import { fmtBytes, fmtMs, now, sourceText } from "./lib.mjs";

function buildOps(Ctor, text) {
  const writer = new Ctor("writer");
  const ops = [];
  for (let i = 0; i < text.length; i += 1) ops.push(writer.insertLocal(i, text[i]));
  return ops;
}

console.log("=== Encode/decode round-trip throughput (CrdtOp[], via RgaDoc) ===");
for (const n of [1000, 10000, 100000]) {
  const ops = buildOps(RgaDoc, sourceText(n));

  const t0 = now();
  const bytes = encodeOps(ops);
  const encodeMs = now() - t0;

  const t1 = now();
  const decoded = decodeOps(bytes);
  const decodeMs = now() - t1;

  if (decoded.length !== ops.length) throw new Error(`n=${n}: decode length mismatch`);

  const encodeOpsPerSec = Math.round((n / encodeMs) * 1000);
  const decodeOpsPerSec = Math.round((n / decodeMs) * 1000);
  console.log(
    `  n=${String(n).padStart(6)}  bytes=${fmtBytes(bytes.length).padStart(9)}  ` +
      `encode=${fmtMs(encodeMs).padStart(8)} (${encodeOpsPerSec.toLocaleString()} ops/s)  ` +
      `decode=${fmtMs(decodeMs).padStart(8)} (${decodeOpsPerSec.toLocaleString()} ops/s)`
  );
}

console.log("\n=== ARCH §3.1: 60,000 deletions, one contiguous run ===");
{
  // Built directly as ops, not via 60,000 sequential `deleteLocal(0)` calls
  // on a live doc — deleting index 0 repeatedly is itself an O(n) splice
  // per call against a live document (O(n²) total), a cost this figure has
  // nothing to do with measuring. The target scenario (§3.1) is one
  // contiguous run of deletions from one replica against contiguous
  // targets from another — exactly what encoding.test.ts's own
  // `makeDelete` helper constructs; same shape, inlined here.
  const targetReplica = "T";
  const deleteReplica = "D";
  const deleteOps = [];
  for (let i = 0; i < 60_000; i += 1) {
    const target = { replica: targetReplica, counter: i };
    deleteOps.push({ id: { replica: deleteReplica, counter: i }, deps: [target], payload: { type: "delete", target } });
  }

  const bytes = encodeOps(deleteOps);
  console.log(`  60,000 deletions: ${bytes.length} bytes (target: < 29, per ARCH §3.1 and encoding.test.ts)`);
}
