import type { ElemId, ReplicaId } from "./elem-id.js";
import type { CrdtOp, CrdtPayload } from "./ops.js";
import type { Op } from "./sequence.js";

/**
 * Binary wire format (ARCH §3.1). No JSON — designing this format is what
 * surfaced the clock conflict in §2.1 (per ARCH), and it's what the
 * 60,000-deletions-in-29-bytes target (§3.1) is checked against.
 *
 * No `TextEncoder`/`TextDecoder`: neither resolves under packages/crdt's
 * restricted tsconfig (lib: ["ES2022"], types: []) — verified, not
 * assumed, before writing the manual UTF-8 codec below. That restriction
 * doing its job here, on a genuinely-reached-for global, is exactly what
 * gate 1 (ARCH §1) exists to catch before it becomes a dependency.
 */

// --- LEB128 varints -------------------------------------------------------

/** Unsigned LEB128. Uses multiply/divide, not bit-shift, so it stays
 * correct past 2^31 (JS's `<<` operates on 32-bit signed integers; `*`/`/`
 * don't, up to Number.MAX_SAFE_INTEGER). */
export function writeVarUint(out: number[], value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`writeVarUint: expected a non-negative integer, got ${value}`);
  }
  let v = value;
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

export function readVarUint(bytes: Uint8Array, pos: { i: number }): number {
  let result = 0;
  let multiplier = 1;
  for (;;) {
    if (pos.i >= bytes.length) throw new RangeError("readVarUint: unexpected end of input");
    const byte = bytes[pos.i]!;
    pos.i += 1;
    result += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) break;
    multiplier *= 128;
  }
  return result;
}

// --- Manual UTF-8 (no TextEncoder/TextDecoder available under gate 1) ----

export function encodeUtf8(str: string): number[] {
  const bytes: number[] = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x7f) {
      bytes.push(cp);
    } else if (cp <= 0x7ff) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp <= 0xffff) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
    }
  }
  return bytes;
}

export function decodeUtf8(bytes: Uint8Array, pos: { i: number }, byteLength: number): string {
  const end = pos.i + byteLength;
  const codePoints: number[] = [];
  while (pos.i < end) {
    const b0 = bytes[pos.i]!;
    let cp: number;
    let len: number;
    if (b0 <= 0x7f) {
      cp = b0;
      len = 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      cp = b0 & 0x1f;
      len = 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      cp = b0 & 0x0f;
      len = 3;
    } else {
      cp = b0 & 0x07;
      len = 4;
    }
    for (let k = 1; k < len; k += 1) {
      cp = (cp << 6) | (bytes[pos.i + k]! & 0x3f);
    }
    codePoints.push(cp);
    pos.i += len;
  }
  return String.fromCodePoint(...codePoints);
}

// --- Replica table ----------------------------------------------------

function buildReplicaTable(ops: CrdtOp[]): { indexOf: Map<ReplicaId, number>; table: ReplicaId[] } {
  const table: ReplicaId[] = [];
  const indexOf = new Map<ReplicaId, number>();
  const see = (replica: ReplicaId) => {
    if (!indexOf.has(replica)) {
      indexOf.set(replica, table.length);
      table.push(replica);
    }
  };
  for (const op of ops) {
    see(op.id.replica);
    if (op.payload.type === "insert" && op.payload.l !== null) see(op.payload.l.replica);
    if (op.payload.type === "delete") see(op.payload.target.replica);
  }
  return { indexOf, table };
}

// --- Record types -------------------------------------------------------

const RECORD_INSERT = 0;
const RECORD_DELETE_SINGLE = 1;
const RECORD_DELETE_RUN = 2;

const SIDE_ABSENT = 0;
const SIDE_L = 1;
const SIDE_R = 2;

/**
 * Delete ops cluster (ARCH §3.1): "a user selects a paragraph and hits
 * delete, producing thousands of contiguous ids from one replica with
 * consecutive counters." A run is eligible for RLE when BOTH the delete
 * ops' own ids AND the ids they target are each contiguous counters from
 * a single (possibly different) replica — the common case for a real
 * selection-delete, where one replica issues one delete op per character
 * it itself typed in one earlier burst.
 */
function findDeleteRun(ops: CrdtOp[], start: number): number {
  const first = ops[start]!;
  if (first.payload.type !== "delete") return start;
  let end = start + 1;
  while (end < ops.length) {
    const prev = ops[end - 1]! as Op<CrdtPayload> & { payload: { type: "delete"; target: ElemId } };
    const cur = ops[end]!;
    if (cur.payload.type !== "delete") break;
    const sameDeleteReplica = cur.id.replica === prev.id.replica && cur.id.counter === prev.id.counter + 1;
    const sameTargetReplica =
      cur.payload.target.replica === prev.payload.target.replica &&
      cur.payload.target.counter === prev.payload.target.counter + 1;
    if (!sameDeleteReplica || !sameTargetReplica) break;
    end += 1;
  }
  return end;
}

export function encodeOps(ops: CrdtOp[]): Uint8Array {
  const { indexOf, table } = buildReplicaTable(ops);
  const out: number[] = [];

  writeVarUint(out, table.length);
  for (const replica of table) {
    const strBytes = encodeUtf8(replica);
    writeVarUint(out, strBytes.length);
    out.push(...strBytes);
  }

  const records: number[] = [];
  let recordCount = 0;
  let i = 0;
  while (i < ops.length) {
    const op = ops[i]!;
    if (op.payload.type === "delete") {
      const runEnd = findDeleteRun(ops, i);
      const runLength = runEnd - i;
      const target0 = op.payload.target;
      if (runLength > 1) {
        records.push(RECORD_DELETE_RUN);
        writeVarUint(records, indexOf.get(op.id.replica)!);
        writeVarUint(records, op.id.counter);
        writeVarUint(records, indexOf.get(target0.replica)!);
        writeVarUint(records, target0.counter);
        writeVarUint(records, runLength);
        recordCount += 1;
        i = runEnd;
        continue;
      }
      records.push(RECORD_DELETE_SINGLE);
      writeVarUint(records, indexOf.get(op.id.replica)!);
      writeVarUint(records, op.id.counter);
      writeVarUint(records, indexOf.get(target0.replica)!);
      writeVarUint(records, target0.counter);
      recordCount += 1;
      i += 1;
      continue;
    }

    // insert
    records.push(RECORD_INSERT);
    writeVarUint(records, indexOf.get(op.id.replica)!);
    writeVarUint(records, op.id.counter);
    if (op.payload.l === null) {
      records.push(0);
    } else {
      records.push(1);
      writeVarUint(records, indexOf.get(op.payload.l.replica)!);
      writeVarUint(records, op.payload.l.counter);
    }
    records.push(op.payload.side === "L" ? SIDE_L : op.payload.side === "R" ? SIDE_R : SIDE_ABSENT);
    const charBytes = encodeUtf8(op.payload.char);
    records.push(charBytes.length);
    records.push(...charBytes);
    recordCount += 1;
    i += 1;
  }

  writeVarUint(out, recordCount);
  out.push(...records);

  return new Uint8Array(out);
}

function deriveDeps(payload: CrdtPayload): ElemId[] {
  if (payload.type === "delete") return [payload.target];
  return payload.l === null ? [] : [payload.l];
}

export function decodeOps(bytes: Uint8Array): CrdtOp[] {
  const pos = { i: 0 };
  const replicaCount = readVarUint(bytes, pos);
  const table: ReplicaId[] = [];
  for (let r = 0; r < replicaCount; r += 1) {
    const len = readVarUint(bytes, pos);
    table.push(decodeUtf8(bytes, pos, len));
  }

  const ops: CrdtOp[] = [];
  const recordCount = readVarUint(bytes, pos);
  for (let r = 0; r < recordCount; r += 1) {
    const recordType = bytes[pos.i]!;
    pos.i += 1;

    if (recordType === RECORD_DELETE_SINGLE || recordType === RECORD_DELETE_RUN) {
      const idReplicaIdx = readVarUint(bytes, pos);
      const idCounter0 = readVarUint(bytes, pos);
      const targetReplicaIdx = readVarUint(bytes, pos);
      const targetCounter0 = readVarUint(bytes, pos);
      const count = recordType === RECORD_DELETE_RUN ? readVarUint(bytes, pos) : 1;
      for (let k = 0; k < count; k += 1) {
        const id: ElemId = { replica: table[idReplicaIdx]!, counter: idCounter0 + k };
        const target: ElemId = { replica: table[targetReplicaIdx]!, counter: targetCounter0 + k };
        const payload: CrdtPayload = { type: "delete", target };
        ops.push({ id, deps: deriveDeps(payload), payload });
      }
      continue;
    }

    // insert
    const idReplicaIdx = readVarUint(bytes, pos);
    const idCounter = readVarUint(bytes, pos);
    const id: ElemId = { replica: table[idReplicaIdx]!, counter: idCounter };
    const hasOrigin = bytes[pos.i]!;
    pos.i += 1;
    let l: ElemId | null = null;
    if (hasOrigin === 1) {
      const originReplicaIdx = readVarUint(bytes, pos);
      const originCounter = readVarUint(bytes, pos);
      l = { replica: table[originReplicaIdx]!, counter: originCounter };
    }
    const sideByte = bytes[pos.i]!;
    pos.i += 1;
    const side = sideByte === SIDE_L ? "L" : sideByte === SIDE_R ? "R" : undefined;
    const charByteLength = bytes[pos.i]!;
    pos.i += 1;
    const char = decodeUtf8(bytes, pos, charByteLength);
    const payload: CrdtPayload = side === undefined ? { type: "insert", l, char } : { type: "insert", l, char, side };
    ops.push({ id, deps: deriveDeps(payload), payload });
  }

  return ops;
}
