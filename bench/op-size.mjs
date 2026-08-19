// Encoded wire size of one `Doc` (Fugue) op, across workloads. This is the
// producer for the "12.4 bytes/op" family of figures cited in DECISIONS #0032
// (the freeze-cap headroom argument: 2 MB / bytes-per-op = how many ops a room
// holds). It is deterministic (a byte count, not a timing), so it reproduces
// exactly on any machine.
//
// Note this measures `Doc`, not `RgaDoc`. bench/encode-decode.mjs measures the
// same wire format via `RgaDoc` and reports a different per-op size, because the
// two structures put different things in each op (Fugue carries an origin ref,
// RGA carries left/right refs); both are honest, they are different subjects.
import { Doc, encodeOps } from "starling-crdt";

const N = 20000;
const CAP = 2 * 1024 * 1024; // MAX_LOG_BYTES_PER_DOC, packages/relay/src/store.ts

function bytesPerOp(build) {
  const doc = new Doc("writer");
  const ops = [];
  build(doc, ops);
  return encodeOps(ops).length / ops.length;
}

// Deterministic pseudo-scatter without Math.random, so the run is reproducible.
function scatter(i, len) {
  return (i * 7919) % (len + 1);
}

const sequential = bytesPerOp((doc, ops) => {
  for (let i = 0; i < N; i += 1) ops.push(doc.insertLocal(i, "x"));
});

const interior = bytesPerOp((doc, ops) => {
  let len = 0;
  for (let i = 0; i < N; i += 1) {
    ops.push(doc.insertLocal(scatter(i, len), "y"));
    len += 1;
  }
});

const churn = bytesPerOp((doc, ops) => {
  let len = 0;
  for (let i = 0; i < N; i += 1) {
    if (i % 5 < 3 || len === 0) {
      ops.push(doc.insertLocal(scatter(i, len), "m"));
      len += 1;
    } else {
      ops.push(doc.deleteLocal(scatter(i, len - 1)));
      len -= 1;
    }
  }
});

const halfDelete = bytesPerOp((doc, ops) => {
  for (let i = 0; i < N; i += 1) ops.push(doc.insertLocal(i, "z"));
  for (let i = 0; i < N / 2; i += 1) ops.push(doc.deleteLocal(0));
});

const row = (label, v) =>
  `  ${label.padEnd(22)} ${v.toFixed(1)} bytes/op   -> 2 MB holds ~${Math.floor(CAP / v).toLocaleString()} ops`;

console.log("=== Doc (Fugue) encoded wire size per op ===");
console.log(row("sequential insert", sequential));
console.log(row("interior insert", interior));
console.log(row("mixed edit churn", churn));
console.log(row("insert + 50% delete", halfDelete));
console.log("\n(sequential insert is the conservative figure for inserts; deletes/tombstones");
console.log(" encode smaller, since a delete op carries an id but no character or origin.)");
