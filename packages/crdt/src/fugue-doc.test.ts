import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { runConvergencePropertyTests, runDocContractTests } from "./doc-contract.test-helpers.js";
import { Doc } from "./fugue-doc.js";

runDocContractTests("Doc (Fugue, the survivor)", (replica) => new Doc(replica));
runConvergencePropertyTests("Doc (Fugue, the survivor)", (replica) => new Doc(replica));

describe("Doc fixes RgaDoc's bug (ARCH §2.3): concurrent backward typing stays contiguous", () => {
  it("two replicas each typing a word backward converge to a clean concatenation, not a jumble", () => {
    const a = new Doc("A");
    const b = new Doc("B");
    const opsA = [..."hello"].map((ch) => a.insertLocal(0, ch));
    const opsB = [..."world"].map((ch) => b.insertLocal(0, ch));

    // Same per-replica reversal as RgaDoc (§2.4 of the RgaDoc test) — not
    // the bug, just what index-0 insertion does.
    expect(a.text).toBe("olleh");
    expect(b.text).toBe("dlrow");

    const allOps = [...opsA, ...opsB];
    const r1 = new Doc("R1");
    for (const op of allOps) r1.receive(op);
    const r2 = new Doc("R2");
    for (const op of [...allOps].reverse()) r2.receive(op);

    // Converges, same as RgaDoc...
    expect(r1.text).toBe(r2.text);
    // ...but this time as a clean concatenation of the two words, in
    // either order — never interleaved. This is S5.
    expect(["ollehdlrow", "dlrowolleh"]).toContain(r1.text);
  });

  it("the fix generalizes: three concurrent backward-typed words all stay contiguous, in some order", () => {
    const a = new Doc("A");
    const b = new Doc("B");
    const c = new Doc("C");
    const opsA = [..."cat"].map((ch) => a.insertLocal(0, ch));
    const opsB = [..."dog"].map((ch) => b.insertLocal(0, ch));
    const opsC = [..."fox"].map((ch) => c.insertLocal(0, ch));

    const allOps = [...opsA, ...opsB, ...opsC];
    const r1 = new Doc("R1");
    for (const op of allOps) r1.receive(op);
    const r2 = new Doc("R2");
    for (const op of [...allOps].reverse()) r2.receive(op);

    expect(r1.text).toBe(r2.text);

    const words = ["tac", "god", "xof"]; // each word reversed, per-replica
    const isCleanConcatenationOfAllThree = (text: string): boolean => {
      for (const perm of permutations(words)) {
        if (text === perm.join("")) return true;
      }
      return false;
    };
    expect(isCleanConcatenationOfAllThree(r1.text)).toBe(true);
  });
});

describe("Doc: single-replica structural correctness against a plain-array reference", () => {
  // No concurrency here — this isolates the tree's own bookkeeping
  // (bucket insertion, size/liveSize propagation, tombstone skipping)
  // from merge-rule questions, by cross-checking against the simplest
  // possible reference: a plain JS array doing visible-index splice.
  it("a long random sequence of local inserts and deletes matches array semantics at every step", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ kind: fc.constant("insert" as const), rawIndex: fc.nat({ max: 60 }), char: fc.char() }),
            fc.record({ kind: fc.constant("delete" as const), rawIndex: fc.nat({ max: 60 }) })
          ),
          { minLength: 1, maxLength: 80 }
        ),
        (ops) => {
          const doc = new Doc("A");
          const reference: string[] = [];
          for (const op of ops) {
            if (op.kind === "insert") {
              const index = Math.min(op.rawIndex, reference.length);
              doc.insertLocal(index, op.char);
              reference.splice(index, 0, op.char);
            } else if (reference.length > 0) {
              const index = op.rawIndex % reference.length;
              doc.deleteLocal(index);
              reference.splice(index, 1);
            }
            expect(doc.text).toBe(reference.join(""));
          }
        }
      ),
      { numRuns: 500 }
    );
  });
});

function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += 1) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) result.push([arr[i]!, ...p]);
  }
  return result;
}
