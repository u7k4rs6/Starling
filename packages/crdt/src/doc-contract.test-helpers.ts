import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ElemId } from "./elem-id.js";
import type { CrdtOp, InsertPayload } from "./ops.js";
import type { StateVector } from "./sequence.js";

export type CrdtDoc = {
  readonly text: string;
  insertLocal(visibleIndex: number, char: string): CrdtOp;
  insertBefore(tombstoneId: ElemId, char: string): CrdtOp;
  deleteLocal(visibleIndex: number): CrdtOp;
  receive(op: CrdtOp): void;
  getStateVector(): StateVector;
  missingFrom(theirVector: StateVector): CrdtOp[];
};

function asInsert(payload: CrdtOp["payload"]): InsertPayload {
  if (payload.type !== "insert") throw new Error("expected an insert payload");
  return payload;
}

/**
 * The shared test suite PRD §4 requires: "all four [document classes]...
 * run against the same test suite. If a change to the base breaks an
 * exhibit, the exhibit was load-bearing and the change is wrong." `NaiveDoc`
 * is deliberately exempt (its whole point is to fail the convergence half
 * of this contract); `ArrayDoc` and `RgaDoc` both run it, and eventually
 * `Doc` will too, once Fugue replaces RGA (Step 6).
 *
 * Assertions here deliberately avoid hardcoding exact converged strings
 * where the value depends on cross-replica counter tie-break arithmetic
 * (DECISIONS #0013) — they check convergence *between replicas*, not
 * equality to a literal a human predicted by hand. Where a literal is used
 * (single-replica sequential typing), the value is unambiguous.
 */
export function runDocContractTests(label: string, makeDoc: (replica: string) => CrdtDoc): void {
  describe(`${label}: shared doc contract (PRD §4)`, () => {
    it("concurrent inserts at the same index converge", () => {
      const a = makeDoc("A");
      const b = makeDoc("B");
      const opA = a.insertLocal(0, "A");
      const opB = b.insertLocal(0, "B");
      a.receive(opB);
      b.receive(opA);
      expect(a.text).toBe(b.text);
    });

    it("sequential single-replica typing lands exactly where expected", () => {
      const doc = makeDoc("A");
      doc.insertLocal(0, "h");
      doc.insertLocal(1, "e");
      doc.insertLocal(2, "l");
      doc.insertLocal(3, "l");
      doc.insertLocal(4, "o");
      expect(doc.text).toBe("hello");
    });

    it("deps matches an insert's actual dependency: the origin id, or none at position 0", () => {
      const doc = makeDoc("A");
      const op1 = doc.insertLocal(0, "a");
      expect(op1.deps).toEqual([]);
      expect(asInsert(op1.payload).l).toBeNull();

      const op2 = doc.insertLocal(1, "b");
      expect(op2.deps).toEqual([op1.id]);
      expect(asInsert(op2.payload).l).toEqual(op1.id);
    });

    it("a deleted character disappears from text but its id stays resolvable", () => {
      const doc = makeDoc("A");
      const opB = doc.insertLocal(0, "b");
      doc.insertLocal(1, "c");
      doc.insertLocal(0, "a"); // "abc"
      expect(doc.text).toBe("abc");

      doc.deleteLocal(1); // delete "b"
      expect(doc.text).toBe("ac");

      doc.insertBefore(opB.id, "B"); // must not throw: tombstone still resolvable
      expect(doc.text).toBe("aBc");
    });

    it("deps for a delete op is exactly the target id", () => {
      const doc = makeDoc("A");
      const op1 = doc.insertLocal(0, "x");
      const del = doc.deleteLocal(0);
      expect(del.payload).toEqual({ type: "delete", target: op1.id });
      expect(del.deps).toEqual([op1.id]);
    });

    it("delete is idempotent: the same target deleted by two independent ops has the same effect as once", () => {
      const origin = makeDoc("A");
      const op1 = origin.insertLocal(0, "x");

      const b = makeDoc("B");
      b.receive(op1);
      const c = makeDoc("C");
      c.receive(op1);

      const delFromB = b.deleteLocal(0);
      const delFromC = c.deleteLocal(0);
      expect(delFromB.id).not.toEqual(delFromC.id);

      const receiver = makeDoc("D");
      receiver.receive(op1);
      receiver.receive(delFromB);
      expect(receiver.text).toBe("");
      receiver.receive(delFromC);
      expect(receiver.text).toBe("");
    });

    it("delete is commutative: deleting two different characters converges regardless of order", () => {
      const origin = makeDoc("A");
      const opX = origin.insertLocal(0, "x");
      const opY = origin.insertLocal(1, "y");
      const opZ = origin.insertLocal(2, "z");
      const delX = origin.deleteLocal(0);
      const delY = origin.deleteLocal(0); // targets "y": delX already applied locally

      const allOps = [opX, opY, opZ, delX, delY];
      const r1 = makeDoc("R1");
      for (const op of allOps) r1.receive(op);
      const r2 = makeDoc("R2");
      for (const op of [...allOps].reverse()) r2.receive(op);

      expect(r1.text).toBe(r2.text);
      expect(r1.text).toBe("z");
    });

    it("undelete is insertBefore with a brand new id, never a revive", () => {
      const doc = makeDoc("A");
      const original = doc.insertLocal(0, "x");
      doc.deleteLocal(0);
      expect(doc.text).toBe("");

      const restored = doc.insertBefore(original.id, "x");
      expect(doc.text).toBe("x");
      expect(restored.id).not.toEqual(original.id);
    });

    it("concurrent delete + insert whose origin is the deleted element still converges", () => {
      const setup = makeDoc("setup");
      const opA = setup.insertLocal(0, "a");
      const opB = setup.insertLocal(1, "b");
      const opC = setup.insertLocal(2, "c"); // "abc"

      const b = makeDoc("B");
      for (const op of [opA, opB, opC]) b.receive(op);
      const delB = b.deleteLocal(1);

      const c = makeDoc("C");
      for (const op of [opA, opB, opC]) c.receive(op);
      const insX = c.insertLocal(2, "X"); // origin: "b"

      const allOps = [opA, opB, opC, delB, insX];
      const r1 = makeDoc("R1");
      for (const op of allOps) r1.receive(op);
      const r2 = makeDoc("R2");
      for (const op of [...allOps].reverse()) r2.receive(op);

      expect(r1.text).toBe(r2.text);
      expect(r1.text.length).toBe(3); // a, c, X — "b" tombstoned
    });

    it("state-vector sync (ARCH §3.2): missingFrom the other's vector, applied, reproduces full convergence — no queue, just the delta", () => {
      const a = makeDoc("A");
      a.insertLocal(0, "a");
      a.insertLocal(1, "b");
      a.deleteLocal(0);
      const b = makeDoc("B");
      b.insertLocal(0, "z");

      // A and B have never synced.
      expect(a.getStateVector()).not.toEqual(b.getStateVector());

      const missingForB = a.missingFrom(b.getStateVector());
      for (const op of missingForB) b.receive(op);
      const missingForA = b.missingFrom(a.getStateVector());
      // missingForA, computed before b applied A's ops, may now include
      // ops b already has — receive() is idempotent, so applying it is
      // still correct; this is exactly why "no offline queue" (ARCH §6)
      // works without needing to track what was already sent.
      for (const op of missingForA) a.receive(op);
      const stillMissingForA = b.missingFrom(a.getStateVector());
      for (const op of stillMissingForA) a.receive(op);

      expect(a.text).toBe(b.text);
      expect(a.getStateVector()).toEqual(b.getStateVector());
    });
  });
}

// --- S1/S2: fast-check property tests (PRD §3), parameterized per doc class ---

function mulberry32(seed: number) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledCopy<T>(arr: T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export type OpSpec = { replicaIndex: number; kind: "insert" | "delete"; rawIndex: number; char: string };

export const opSpecArb = fc.record({
  replicaIndex: fc.nat({ max: 10 }),
  kind: fc.constantFrom<"insert" | "delete">("insert", "delete"),
  rawIndex: fc.nat({ max: 50 }),
  char: fc.char(),
});

/**
 * Same generation strategy as Step 3's original test: ops are addressed to
 * a replica and clamped to that replica's own current state, so
 * concurrency is real (each replica only ever sees its own prior ops when
 * generating its next one), and delivery to each replica is independently
 * shuffled, exercising delivery-order independence through the real
 * Sequence + doc stack (DECISIONS #0012 already established it for the
 * bare merge rule).
 */
export function runScenario(
  makeDoc: (replica: string) => CrdtDoc,
  replicaCount: number,
  opSpecs: OpSpec[],
  shuffleSeeds: number[]
): string[] {
  const replicas = Array.from({ length: replicaCount }, (_, i) => makeDoc(`replica-${i}`));

  const allOps = opSpecs.map((spec) => {
    const replica = replicas[spec.replicaIndex % replicaCount]!;
    if (spec.kind === "delete" && replica.text.length > 0) {
      const index = spec.rawIndex % replica.text.length;
      return replica.deleteLocal(index);
    }
    const index = Math.min(spec.rawIndex, replica.text.length);
    return replica.insertLocal(index, spec.char);
  });

  return replicas.map((replica, i) => {
    const seed = shuffleSeeds[i % shuffleSeeds.length] ?? i;
    for (const op of shuffledCopy(allOps, seed)) {
      replica.receive(op);
    }
    return replica.text;
  });
}

export function runConvergencePropertyTests(label: string, makeDoc: (replica: string) => CrdtDoc): void {
  describe(`${label}: convergence (S1, S2), inserts and deletes mixed`, () => {
    it("S1: two replicas editing concurrently always converge", () => {
      fc.assert(
        fc.property(
          fc.array(opSpecArb, { minLength: 0, maxLength: 16 }),
          fc.tuple(fc.integer(), fc.integer()),
          (opSpecs, shuffleSeeds) => {
            const texts = runScenario(makeDoc, 2, opSpecs, shuffleSeeds);
            expect(new Set(texts).size).toBe(1);
          }
        ),
        { numRuns: 1000 }
      );
    });

    it("S2: three replicas editing concurrently always converge", () => {
      fc.assert(
        fc.property(
          fc.array(opSpecArb, { minLength: 0, maxLength: 16 }),
          fc.tuple(fc.integer(), fc.integer(), fc.integer()),
          (opSpecs, shuffleSeeds) => {
            const texts = runScenario(makeDoc, 3, opSpecs, shuffleSeeds);
            expect(new Set(texts).size).toBe(1);
          }
        ),
        { numRuns: 500 }
      );
    });
  });
}
