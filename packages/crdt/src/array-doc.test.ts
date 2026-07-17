import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ArrayDoc } from "./array-doc.js";

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
    expect(op1.payload.l).toBeNull();

    const op2 = replica.insertLocal(1, "b"); // origin: op1's id
    expect(op2.deps).toEqual([op1.id]);
    expect(op2.payload.l).toEqual(op1.id);

    const op3 = replica.insertLocal(0, "c"); // origin: none again, inserted before everything
    expect(op3.deps).toEqual([]);
    expect(op3.payload.l).toBeNull();
  });
});

// --- S1/S2: fast-check property tests (PRD §3, ladder gate for Step 3) ---

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

type OpSpec = { replicaIndex: number; rawIndex: number; char: string };

/**
 * Generate `opSpecs.length` ops, each from whichever replica it's
 * addressed to, each inserted at an index clamped to that replica's
 * current (local) length at the time — so every op is valid, and ops from
 * different replicas are concurrent by construction (each replica only
 * ever sees its own prior ops when generating its next one). Then deliver
 * the full op set to every replica in an INDEPENDENT per-replica shuffled
 * order, exercising both concurrent editing (S1/S2) and delivery-order
 * independence (the property the origin-forest search, DECISIONS #0012,
 * already established for the merge rule in isolation — this exercises it
 * through the real Sequence + ArrayDoc stack).
 */
function runScenario(replicaCount: number, opSpecs: OpSpec[], shuffleSeeds: number[]): string[] {
  const replicas = Array.from({ length: replicaCount }, (_, i) => new ArrayDoc(`replica-${i}`));

  const allOps = opSpecs.map((spec) => {
    const replica = replicas[spec.replicaIndex % replicaCount]!;
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
  rawIndex: fc.nat({ max: 50 }),
  char: fc.char(),
});

describe("ArrayDoc convergence (S1, S2)", () => {
  it("S1: two replicas editing concurrently always converge", () => {
    fc.assert(
      fc.property(
        fc.array(opSpecArb, { minLength: 0, maxLength: 12 }),
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
        fc.array(opSpecArb, { minLength: 0, maxLength: 12 }),
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
