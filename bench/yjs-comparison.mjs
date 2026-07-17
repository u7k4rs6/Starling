// ARCH §9: "Comparison against Yjs on the same workloads. Expect to lose.
// Report it anyway." Same workload as bench/cold-open.mjs: one replica
// typing n characters forward, one at a time; a second replica cold-opens
// (replays) the result. `Y.Text.insert` one character at a time inside one
// `doc.transact` call is Yjs idiomatic usage for this shape (a
// non-batched loop of separate transactions would be strictly slower and
// not a fair comparison).
//
// n=100,000 is NOT run live by default — Yjs's *build* phase at that size
// takes ~130s (measured directly building this script; see bench/
// README.md), for the same reason bench/cold-open.mjs skips its own
// 100k `Doc` case by default: an honest number worth citing once, not
// worth paying on every invocation. Pass `--full` to run it anyway.
import * as Y from "yjs";
import { Doc } from "starling-crdt";
import { fmtBytes, fmtMs, now, sourceText } from "./lib.mjs";

const FULL = process.argv.includes("--full");
const SIZES = FULL ? [1000, 10000, 100000] : [1000, 10000];

function benchYjs(text) {
  const doc = new Y.Doc();
  const ytext = doc.getText("t");
  const t0 = now();
  doc.transact(() => {
    for (let i = 0; i < text.length; i += 1) ytext.insert(i, text[i]);
  });
  const buildMs = now() - t0;

  const t1 = now();
  const update = Y.encodeStateAsUpdate(doc);
  const encodeMs = now() - t1;

  const reader = new Y.Doc();
  const t2 = now();
  Y.applyUpdate(reader, update);
  const replayMs = now() - t2;

  if (reader.getText("t").toString() !== text) throw new Error("yjs bench: replay diverged from build");
  return { buildMs, encodeMs, replayMs, bytes: update.length };
}

function benchDoc(text) {
  const writer = new Doc("writer");
  const t0 = now();
  const ops = [];
  for (let i = 0; i < text.length; i += 1) ops.push(writer.insertLocal(i, text[i]));
  const buildMs = now() - t0;

  const reader = new Doc("reader");
  const t1 = now();
  for (const op of ops) reader.receive(op);
  const replayMs = now() - t1;

  if (reader.text !== writer.text) throw new Error("Doc bench: replay diverged from build");
  return { buildMs, replayMs };
}

console.log("Workload: type n characters forward, one replica; a second replica cold-opens the result.");
console.log("(Doc's own build/replay is also measured live here, for a same-run, same-machine comparison —");
console.log(" bench/cold-open.mjs's numbers are the citable record; these should agree with them.)\n");

for (const n of SIZES) {
  const text = sourceText(n);
  console.log(`=== n=${n} ===`);

  const yjs = benchYjs(text);
  console.log(
    `  Yjs          build=${fmtMs(yjs.buildMs).padStart(9)}  replay=${fmtMs(yjs.replayMs).padStart(9)}  ` +
      `wire=${fmtBytes(yjs.bytes)} (${(yjs.bytes / n).toFixed(2)} bytes/char)`
  );

  const doc = benchDoc(text);
  console.log(`  Doc (Fugue)  build=${fmtMs(doc.buildMs).padStart(9)}  replay=${fmtMs(doc.replayMs).padStart(9)}`);

  const replaySlowdown = doc.replayMs / yjs.replayMs;
  console.log(`  → Doc replay is ${replaySlowdown.toFixed(1)}x slower than Yjs replay at this n\n`);
}
