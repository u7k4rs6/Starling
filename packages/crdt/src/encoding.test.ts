import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toRef, type ElemId, type ElemRef } from "./elem-id.js";
import {
  decodeOps,
  decodeOpsStream,
  decodeUtf8,
  encodeOps,
  encodeUtf8,
  readVarUint,
  writeVarUint,
} from "./encoding.js";
import type { CrdtOp, CrdtPayload } from "./ops.js";

describe("LEB128 varints", () => {
  it("round-trips small values (single byte)", () => {
    for (const v of [0, 1, 42, 127]) {
      const out: number[] = [];
      writeVarUint(out, v);
      expect(out).toHaveLength(1);
      expect(readVarUint(new Uint8Array(out), { i: 0 })).toBe(v);
    }
  });

  it("round-trips values needing multiple bytes", () => {
    for (const v of [128, 300, 16384, 2_097_151, 60_000, 100_000]) {
      const out: number[] = [];
      writeVarUint(out, v);
      expect(readVarUint(new Uint8Array(out), { i: 0 })).toBe(v);
    }
  });

  it("round-trips past 2^31 without going through 32-bit bitwise ops", () => {
    const v = 5_000_000_000; // > 2^32
    const out: number[] = [];
    writeVarUint(out, v);
    expect(readVarUint(new Uint8Array(out), { i: 0 })).toBe(v);
  });

  it("property: round-trips any non-negative safe integer up to 2^40", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 40 }), (v) => {
        const out: number[] = [];
        writeVarUint(out, v);
        expect(readVarUint(new Uint8Array(out), { i: 0 })).toBe(v);
      }),
      { numRuns: 1000 }
    );
  });

  it("rejects negative or non-integer input", () => {
    expect(() => writeVarUint([], -1)).toThrow(RangeError);
    expect(() => writeVarUint([], 1.5)).toThrow(RangeError);
  });

  it("sequential reads advance the shared position cursor", () => {
    const out: number[] = [];
    writeVarUint(out, 1);
    writeVarUint(out, 300);
    writeVarUint(out, 60_000);
    const bytes = new Uint8Array(out);
    const pos = { i: 0 };
    expect(readVarUint(bytes, pos)).toBe(1);
    expect(readVarUint(bytes, pos)).toBe(300);
    expect(readVarUint(bytes, pos)).toBe(60_000);
    expect(pos.i).toBe(bytes.length);
  });
});

describe("manual UTF-8 (no TextEncoder/TextDecoder — verified unavailable under gate 1)", () => {
  it("round-trips ASCII", () => {
    const bytes = new Uint8Array(encodeUtf8("hello"));
    expect(decodeUtf8(bytes, { i: 0 }, bytes.length)).toBe("hello");
  });

  it("round-trips 2-byte, 3-byte, and 4-byte code points", () => {
    const cases = ["é", "€", "中", "🎉", "hello 🌍 world"];
    for (const str of cases) {
      const bytes = new Uint8Array(encodeUtf8(str));
      expect(decodeUtf8(bytes, { i: 0 }, bytes.length)).toBe(str);
    }
  });

  it("property: round-trips arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (str) => {
        const bytes = new Uint8Array(encodeUtf8(str));
        expect(decodeUtf8(bytes, { i: 0 }, bytes.length)).toBe(str);
      }),
      { numRuns: 1000 }
    );
  });
});

// Normalizes `l` the same way the doc classes do, so a hand-built op has
// the identical shape to one that has been through encode/decode.
function makeInsert(id: ElemId, origin: ElemRef | null, char: string, side?: "L" | "R"): CrdtOp {
  const l = origin === null ? null : toRef(origin);
  const payload: CrdtPayload = side === undefined ? { type: "insert", l, char } : { type: "insert", l, char, side };
  return { id, deps: l === null ? [] : [l], payload };
}

function makeDelete(id: ElemId, targetId: ElemRef): CrdtOp {
  const target = toRef(targetId);
  return { id, deps: [target], payload: { type: "delete", target } };
}

function countOccurrences(haystack: Uint8Array, needle: Uint8Array): number {
  let count = 0;
  for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    let match = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) count += 1;
  }
  return count;
}

describe("encodeOps / decodeOps round-trip", () => {
  it("round-trips a small hand-built op set exactly, deps included", () => {
    const a0: ElemId = { replica: "A", counter: 0, clock: 1 };
    const a1: ElemId = { replica: "A", counter: 1, clock: 2 };
    const ops: CrdtOp[] = [
      makeInsert(a0, null, "h", "R"),
      makeInsert(a1, a0, "i", "R"),
      makeDelete({ replica: "A", counter: 2, clock: 3 }, a0),
    ];
    const decoded = decodeOps(encodeOps(ops));
    expect(decoded).toEqual(ops);
  });

  it("dedupes the replica table: a long replica id's bytes appear exactly once, not once per op", () => {
    // A weaker version of this test first asserted a total byte-size
    // bound that turned out to just be wrong arithmetic on my part (20
    // insert records each carry ~8-9 bytes of real per-op data — ids,
    // origins, side, char — regardless of table dedup, so total size
    // isn't the right signal). The actual claim to check is narrower and
    // more direct: the replica id's own bytes shouldn't be repeated.
    const longReplicaId = "replica-with-a-long-uuid-like-name-0000";
    const ops: CrdtOp[] = [];
    let prev: ElemId | null = null;
    for (let i = 0; i < 20; i += 1) {
      const id: ElemId = { replica: longReplicaId, counter: i, clock: i + 1 };
      ops.push(makeInsert(id, prev, "x"));
      prev = id;
    }
    const bytes = encodeOps(ops);
    const decoded = decodeOps(bytes);
    expect(decoded).toEqual(ops);

    const needle = new Uint8Array(encodeUtf8(longReplicaId));
    expect(countOccurrences(bytes, needle)).toBe(1);
  });

  it("property: round-trips a random insert-only op sequence exactly", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            replica: fc.constantFrom("A", "B", "C"),
            char: fc.char(),
            side: fc.constantFrom<"L" | "R" | undefined>("L", "R", undefined),
            hasOrigin: fc.boolean(),
          }),
          { minLength: 0, maxLength: 40 }
        ),
        (specs) => {
          const countersByReplica = new Map<string, number>();
          const allIds: ElemId[] = [];
          const ops: CrdtOp[] = [];
          // Clock is globally monotonic across the sequence: these ops are
          // generated in causal order, which is what a real replica emits.
          let clock = 0;
          for (const spec of specs) {
            const counter = countersByReplica.get(spec.replica) ?? 0;
            countersByReplica.set(spec.replica, counter + 1);
            clock += 1;
            const id: ElemId = { replica: spec.replica, counter, clock };
            const origin = spec.hasOrigin && allIds.length > 0 ? allIds[allIds.length - 1]! : null;
            ops.push(makeInsert(id, origin, spec.char, spec.side));
            allIds.push(id);
          }
          const decoded = decodeOps(encodeOps(ops));
          expect(decoded).toEqual(ops);
        }
      ),
      { numRuns: 500 }
    );
  });

  it("property: round-trips mixed insert/delete sequences, including RLE-eligible delete runs", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("insert", "delete-run"), { minLength: 0, maxLength: 10 }),
        (kinds) => {
          const ops: CrdtOp[] = [];
          let counter = 0;
          let lastInserted: ElemId | null = null;
          const insertedIds: ElemId[] = [];
          for (const kind of kinds) {
            if (kind === "insert" || insertedIds.length === 0) {
              const id: ElemId = { replica: "A", counter, clock: counter + 1 };
              counter += 1;
              ops.push(makeInsert(id, lastInserted, "x"));
              lastInserted = id;
              insertedIds.push(id);
            } else {
              // Delete a contiguous run of 1-3 previously inserted ids.
              const runLength = Math.min(3, insertedIds.length);
              const startIdx = insertedIds.length - runLength;
              for (let k = 0; k < runLength; k += 1) {
                const delId: ElemId = { replica: "A", counter, clock: counter + 1 };
                counter += 1;
                ops.push(makeDelete(delId, insertedIds[startIdx + k]!));
              }
              insertedIds.length = startIdx; // consumed
            }
          }
          const decoded = decodeOps(encodeOps(ops));
          expect(decoded).toEqual(ops);
        }
      ),
      { numRuns: 500 }
    );
  });
});

describe("decodeOpsStream: concatenated blobs (ARCH §5/§6 — the relay's raw byte log is many POSTs back to back)", () => {
  it("an empty buffer (a doc nobody has pushed to yet) decodes to no ops", () => {
    expect(decodeOpsStream(new Uint8Array(0))).toEqual([]);
  });

  it("a single blob decodes the same via decodeOpsStream as via decodeOps", () => {
    const a0: ElemId = { replica: "A", counter: 0, clock: 1 };
    const ops: CrdtOp[] = [makeInsert(a0, null, "h", "R")];
    const bytes = encodeOps(ops);
    expect(decodeOpsStream(bytes)).toEqual(decodeOps(bytes));
  });

  it("property: N independently-encoded batches concatenated decode to the flat concatenation of their ops", () => {
    // Prediction: this should just work with no special-casing, because
    // each encodeOps blob is self-delimiting (its own replica table +
    // record count say exactly how many bytes it occupies) — the position-
    // aware decoder should stop exactly at each blob's boundary on its own.
    fc.assert(
      fc.property(
        fc.array(
          fc.array(
            fc.record({ replica: fc.constantFrom("A", "B", "C"), char: fc.char() }),
            { minLength: 0, maxLength: 8 }
          ),
          { minLength: 0, maxLength: 6 }
        ),
        (batches) => {
          const allOps: CrdtOp[] = [];
          const blobs: Uint8Array[] = [];
          for (const batch of batches) {
            const countersByReplica = new Map<string, number>();
            const batchOps: CrdtOp[] = [];
            for (const spec of batch) {
              const counter = countersByReplica.get(spec.replica) ?? 0;
              countersByReplica.set(spec.replica, counter + 1);
              const id: ElemId = { replica: spec.replica, counter, clock: counter + 1 };
              batchOps.push(makeInsert(id, null, spec.char));
            }
            blobs.push(encodeOps(batchOps));
            allOps.push(...batchOps);
          }
          const totalLength = blobs.reduce((sum, b) => sum + b.length, 0);
          const concatenated = new Uint8Array(totalLength);
          let offset = 0;
          for (const b of blobs) {
            concatenated.set(b, offset);
            offset += b.length;
          }
          expect(decodeOpsStream(concatenated)).toEqual(allOps);
        }
      ),
      { numRuns: 500 }
    );
  });
});

describe("ARCH §3.1 target: 60,000 deletions encode in 29 bytes", () => {
  it("predicts, then measures: a single contiguous delete run of 60,000 should be small; 29 bytes specifically is not re-derived from the lost original design and may not match exactly", () => {
    // Prediction before measuring: header ~3 bytes (1 replica, short id) +
    // recordCount (1 byte) + record type (1 byte) + 4 small-to-medium
    // varuints (delete-replica index, delete-start-counter,
    // target-replica index, target-start-counter) + count as a varuint
    // (60000 needs 3 bytes) — expect roughly 12-20 bytes, comfortably
    // under the cited 29, for this specific (single replica, contiguous
    // targets, small starting counters) scenario.
    const targetReplica = "T";
    const deleteReplica = "D";
    const targets: ElemRef[] = [];
    for (let i = 0; i < 60_000; i += 1) targets.push({ replica: targetReplica, counter: i });
    // Consecutive clocks, as one uninterrupted local delete burst produces —
    // the eligibility condition that keeps this a single RLE run.
    const ops: CrdtOp[] = targets.map((target, i) =>
      makeDelete({ replica: deleteReplica, counter: i, clock: i + 1 }, target)
    );

    const bytes = encodeOps(ops);
    const decoded = decodeOps(bytes);
    expect(decoded).toHaveLength(60_000);
    expect(decoded).toEqual(ops);

    console.log(`60,000 deletions (1 contiguous run): ${bytes.length} bytes`);
    expect(bytes.length).toBeLessThan(29);
  });
});
