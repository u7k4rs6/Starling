import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ArrayDoc, type InsertPayload } from "./array-doc.js";

function asInsert(payload: InsertPayload | { type: "delete" }): InsertPayload {
  if (payload.type !== "insert") throw new Error("expected an insert payload");
  return payload;
}

describe("ArrayDoc (museum exhibit 2): converges where NaiveDoc diverged", () => {
  it("concurrent inserts at the same index converge, unlike NaiveDoc's counterexample", () => {
    // Same shape of scenario as naive-doc.test.ts's divergence proof, but
    // ArrayDoc's origin-anchored merge rule (not raw index) is what makes
    // the difference.
    const replicaA = new ArrayDoc("A");
    const replicaB = new ArrayDoc("B");

    const opA = replicaA.insertLocal(0, "A");
    const opB = replicaB.insertLocal(0, "B");

    replicaA.receive(opB);
    replicaB.receive(opA);

    expect(replicaA.text).toBe(replicaB.text);
  });

  it("deps matches its payload's actual dependency: the origin id, or none for an insert at position 0 (DECISIONS #0010)", () => {
    const replica = new ArrayDoc("A");
    const op1 = replica.insertLocal(0, "a"); // no origin: inserted at the very start
    expect(op1.deps).toEqual([]);
    expect(asInsert(op1.payload).l).toBeNull();

    const op2 = replica.insertLocal(1, "b"); // origin: op1's id
    expect(op2.deps).toEqual([op1.id]);
    expect(asInsert(op2.payload).l).toEqual(op1.id);

    const op3 = replica.insertLocal(0, "c"); // origin: none again, inserted before everything
    expect(op3.deps).toEqual([]);
    expect(asInsert(op3.payload).l).toBeNull();
  });
});

describe("ArrayDoc deletion (ARCH §2.4, Step 4): tombstones, not removal", () => {
  it("a deleted character disappears from text but its id stays resolvable (insertBefore still works)", () => {
    const replica = new ArrayDoc("A");
    const opB = replica.insertLocal(0, "b");
    replica.insertLocal(1, "c");
    replica.insertLocal(0, "a"); // "abc"
    expect(replica.text).toBe("abc");

    replica.deleteLocal(1); // delete "b"
    expect(replica.text).toBe("ac");

    // The tombstone is still there: insertBefore(opB.id, ...) must not throw.
    replica.insertBefore(opB.id, "B");
    expect(replica.text).toBe("aBc");
  });

  it("deps for a delete op is exactly the target id (DECISIONS #0010)", () => {
    const replica = new ArrayDoc("A");
    const op1 = replica.insertLocal(0, "x");
    const del = replica.deleteLocal(0);
    expect(del.payload).toEqual({ type: "delete", target: op1.id });
    expect(del.deps).toEqual([op1.id]);
  });

  it("delete is idempotent: the same target deleted twice (two independent ops) has the same effect as once", () => {
    const origin = new ArrayDoc("A");
    const op1 = origin.insertLocal(0, "x");

    const replicaB = new ArrayDoc("B");
    replicaB.receive(op1);
    const replicaC = new ArrayDoc("C");
    replicaC.receive(op1);

    // B and C independently decide to delete the same (only) character —
    // two distinct delete ops, same target, neither aware of the other.
    const delFromB = replicaB.deleteLocal(0);
    const delFromC = replicaC.deleteLocal(0);
    expect(delFromB.id).not.toEqual(delFromC.id); // genuinely two different ops

    const receiver = new ArrayDoc("D");
    receiver.receive(op1);
    receiver.receive(delFromB);
    expect(receiver.text).toBe("");
    receiver.receive(delFromC); // second delete of the same target: no-op
    expect(receiver.text).toBe("");

    // Order doesn't matter either.
    const receiver2 = new ArrayDoc("E");
    receiver2.receive(op1);
    receiver2.receive(delFromC);
    receiver2.receive(delFromB);
    expect(receiver2.text).toBe("");
  });

  it("delete is commutative: deleting two different characters converges regardless of order", () => {
    const origin = new ArrayDoc("A");
    const opX = origin.insertLocal(0, "x");
    const opY = origin.insertLocal(1, "y");
    const opZ = origin.insertLocal(2, "z"); // "xyz"

    const delX = origin.deleteLocal(0);
    const delY = origin.deleteLocal(0); // "y" is now at visible index 0 after x's delete... but
    // deleteLocal reads *origin*'s own current visible state, which already
    // reflects delX locally (deleteLocal integrates immediately, same as
    // insertLocal) — so this targets "y", not "x" again.
    expect(delY.payload).toEqual({ type: "delete", target: opY.id });

    const allOps = [opX, opY, opZ, delX, delY];
    const r1 = new ArrayDoc("R1");
    for (const op of allOps) r1.receive(op);
    const r2 = new ArrayDoc("R2");
    for (const op of [...allOps].reverse()) r2.receive(op); // reverse order, buffered until deps resolve

    expect(r1.text).toBe("z");
    expect(r2.text).toBe("z");
  });

  it("undelete is insertBefore with a brand new id, never a revive (ARCH §2.4)", () => {
    const replica = new ArrayDoc("A");
    const original = replica.insertLocal(0, "x");
    replica.deleteLocal(0);
    expect(replica.text).toBe("");

    const restored = replica.insertBefore(original.id, "x");
    expect(replica.text).toBe("x");
    expect(restored.id).not.toEqual(original.id); // a new element, not the old one reappearing
  });

  it("concurrent delete + insert whose origin is the deleted element still converges", () => {
    // Base state "abc", shared by two replicas. Concurrently: replica B
    // deletes "b"; replica C, unaware of that, inserts "X" using "b" (its
    // origin) as the insertion anchor — exactly the case ARCH §2.4 flags
    // as the likeliest bug (confusing visible and internal index), since a
    // concurrent op can reference a tombstone as an origin.
    const setup = new ArrayDoc("setup");
    const opA = setup.insertLocal(0, "a");
    const opB = setup.insertLocal(1, "b");
    const opC = setup.insertLocal(2, "c"); // "abc"

    const replicaB = new ArrayDoc("B");
    for (const op of [opA, opB, opC]) replicaB.receive(op);
    const delB = replicaB.deleteLocal(1); // delete "b"
    expect(replicaB.text).toBe("ac");

    const replicaC = new ArrayDoc("C");
    for (const op of [opA, opB, opC]) replicaC.receive(op);
    const insX = replicaC.insertLocal(2, "X"); // origin: "b"
    // Wrong prediction on first write, corrected here rather than silently
    // fixed (DECISIONS #0013): this is "abcX", not the naively-expected
    // "abXc". X's origin is "b", so it's a *sibling* of "c" (also anchored
    // at "b"), and RGA's tie-break among siblings is purely by id — "c"'s
    // id has a higher counter (2, from replica "setup") than "X"'s (0, from
    // replica "C"'s own fresh counter), so "c" wins the tie-break and stays
    // left of "X" even though "c" was already fully known to replica C
    // before "X" was created. Same-replica typing never hits this (a
    // replica's own counter is always increasing relative to its own prior
    // ops); it shows up here because C's *first* local op starts back at
    // counter 0, regardless of how much of the document it already knows.
    expect(replicaC.text).toBe("abcX");

    const allOps = [opA, opB, opC, delB, insX];
    const r1 = new ArrayDoc("R1");
    for (const op of shuffledCopy(allOps, 1)) r1.receive(op);
    const r2 = new ArrayDoc("R2");
    for (const op of shuffledCopy(allOps, 999)) r2.receive(op);

    // "b" tombstoned, "c" stays left of "X" for the same tie-break reason
    // as replicaC's local view above: "acX", not "aXc".
    expect(r1.text).toBe("acX");
    expect(r2.text).toBe("acX");
  });
});

// --- S1/S2: fast-check property tests (PRD §3, ladder gate for Step 3, extended for Step 4's deletes) ---

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

type OpSpec = { replicaIndex: number; kind: "insert" | "delete"; rawIndex: number; char: string };

/**
 * Generate `opSpecs.length` ops (insert or delete, per spec), each from
 * whichever replica it's addressed to, each targeting an index clamped to
 * that replica's current (local) state at the time — so every op is valid,
 * and ops from different replicas are concurrent by construction. A delete
 * on an empty document falls back to an insert (nothing to delete). Then
 * deliver the full op set to every replica in an INDEPENDENT per-replica
 * shuffled order, exercising concurrent editing (S1/S2) and delivery-order
 * independence together, now including deletes (Step 4).
 */
function runScenario(replicaCount: number, opSpecs: OpSpec[], shuffleSeeds: number[]): string[] {
  const replicas = Array.from({ length: replicaCount }, (_, i) => new ArrayDoc(`replica-${i}`));

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

const opSpecArb = fc.record({
  replicaIndex: fc.nat({ max: 10 }),
  kind: fc.constantFrom<"insert" | "delete">("insert", "delete"),
  rawIndex: fc.nat({ max: 50 }),
  char: fc.char(),
});

describe("ArrayDoc convergence (S1, S2), inserts and deletes mixed", () => {
  it("S1: two replicas editing concurrently always converge", () => {
    fc.assert(
      fc.property(
        fc.array(opSpecArb, { minLength: 0, maxLength: 16 }),
        fc.tuple(fc.integer(), fc.integer()),
        (opSpecs, shuffleSeeds) => {
          const texts = runScenario(2, opSpecs, shuffleSeeds);
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
          const texts = runScenario(3, opSpecs, shuffleSeeds);
          expect(new Set(texts).size).toBe(1);
        }
      ),
      { numRuns: 500 }
    );
  });
});
