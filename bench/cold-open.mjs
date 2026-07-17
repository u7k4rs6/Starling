// ARCH §9 / PRD S6: "100k-character document cold-opens in < 1s."
//
// Two phases, on purpose:
//   - "build": one replica typing n characters forward, live (insertLocal
//     per character) — this is local-edit latency, not the S6 metric
//     itself, but real and worth reporting since it exercises the exact
//     same tree-walk path (`originForVisibleIndex`) cold-open's replay
//     does.
//   - "replay": a *second*, fresh replica receiving that replica's whole
//     op log via `receive()`, one op at a time, in original order — this
//     is cold-open. ARCH §2.5: "it is what happens every time anyone
//     opens the document, because the whole op log replays." S6's <1s
//     target is about this number, not the build number.
//
// n=100,000 for `Doc` and `ArrayDoc` is NOT run live by default here: it
// takes minutes (Doc: ~340s build + ~168s replay, measured directly —
// see bench/README.md and DECISIONS #0026) to multiple tens of seconds
// (ArrayDoc, extrapolated in the original design doc, ARCH §2.4, to
// ~41s — see DECISIONS #0014), which would make every `node
// bench/cold-open.mjs` invocation impractically slow. Same precedent as
// DECISIONS #0014: cite the one-time measurement in the README rather
// than re-measure it on every run. Pass `--full` to run the 100k cases
// live anyway.
import { ArrayDoc, Doc, NaiveDoc, RgaDoc } from "starling-crdt";
import { fmtMs, now, sourceText } from "./lib.mjs";

const FULL = process.argv.includes("--full");
const SIZES = FULL ? [1000, 10000, 100000] : [1000, 10000];

const EXHIBITS = [
  { name: "NaiveDoc", ctor: NaiveDoc },
  { name: "ArrayDoc", ctor: ArrayDoc },
  { name: "RgaDoc", ctor: RgaDoc },
  { name: "Doc (Fugue)", ctor: Doc },
];

function buildOps(Ctor, text) {
  const writer = new Ctor("writer");
  const ops = [];
  const t0 = now();
  for (let i = 0; i < text.length; i += 1) {
    ops.push(writer.insertLocal(i, text[i]));
  }
  const buildMs = now() - t0;
  return { ops, buildMs, writer };
}

function replay(Ctor, ops) {
  const reader = new Ctor("reader");
  const t0 = now();
  for (const op of ops) reader.receive(op);
  const replayMs = now() - t0;
  return { reader, replayMs };
}

for (const n of SIZES) {
  const text = sourceText(n);
  console.log(`\n=== n=${n} ===`);
  for (const { name, ctor: Ctor } of EXHIBITS) {
    const { ops, buildMs, writer } = buildOps(Ctor, text);
    const { reader, replayMs } = replay(Ctor, ops);
    if (reader.text !== writer.text) {
      throw new Error(`${name} n=${n}: replay diverged from build — bench harness bug, not a perf number`);
    }
    console.log(`  ${name.padEnd(12)} build=${fmtMs(buildMs).padStart(9)}  replay=${fmtMs(replayMs).padStart(9)}`);
  }
}
