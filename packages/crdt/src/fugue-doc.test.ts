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

describe("Doc: anchors (ARCH §7, S10) — a cursor is an ElemId + side, not a number", () => {
  it("S10, exactly as PRD §3 states it: a remote insert before an anchor moves the anchor's resolved position, not the anchor itself", () => {
    // Prediction, stated before running: A's cursor sits at index 0 of
    // "world" (immediately before 'w'). Before any remote activity,
    // resolveAnchor must be 0. B then inserts "hello " (6 characters) at
    // the very start, entirely before what A's cursor points at. Once A
    // merges B's ops, the anchor must resolve to 6 — not because anyone
    // told it to move, but because 6 live characters now precede the same
    // 'w' it was always pointing at. If it stays at 0, resolution is
    // treating the anchor as a stale index instead of an id.
    //
    // B receives A's "world" before typing, so its insert is causally
    // anchored to the existing 'w' (a left-child of it, deterministically
    // before it) rather than an independent root-level insert whose
    // resulting order would depend on Fugue's id tie-break between two
    // *unrelated* root insertions — a real document has one shared history
    // to insert before, not two histories merging from scratch.
    const a = new Doc("A");
    const opsWorld = [..."world"].map((ch) => a.insertLocal(a.text.length, ch));
    const cursor = a.anchorAt(0);
    expect(a.resolveAnchor(cursor)).toBe(0);

    const b = new Doc("B");
    for (const op of opsWorld) b.receive(op);
    const opsB = [..."hello "].map((ch, i) => b.insertLocal(i, ch));
    for (const op of opsB) a.receive(op);

    expect(a.text).toBe("hello world");
    expect(a.resolveAnchor(cursor)).toBe(6);
  });

  it("a remote insert after the anchor does not move it", () => {
    // B's insert has to be causally anchored to A's own content (by
    // having already received A's ops before typing) to land "after
    // hello" at all — two replicas each independently root-inserting
    // content have no causal relationship to each other, and where the
    // two resulting root siblings land is decided by Fugue's id tie-break,
    // not by which replica "typed first". An earlier version of this test
    // had B build "!!!" from scratch with no knowledge of A's content and
    // asserted the merge would land it after "hello" — that assumed an
    // ordering the CRDT never promised, and only the specific tie-break
    // (id "B" sorting before id "A" at a shared counter) made a *different*
    // same-shaped test elsewhere in this file pass by coincidence. A test
    // bug, not a Doc bug — logged as such rather than silently rewritten.
    const a = new Doc("A");
    const opsA = [..."hello"].map((ch) => a.insertLocal(a.text.length, ch));
    const cursor = a.anchorAt(2); // between 'e' and 'l'
    expect(a.resolveAnchor(cursor)).toBe(2);

    const b = new Doc("B");
    for (const op of opsA) b.receive(op);
    const opsB = [..."!!!"].map((ch) => b.insertLocal(b.text.length, ch));
    for (const op of opsB) a.receive(op);

    expect(a.text).toBe("hello!!!");
    expect(a.resolveAnchor(cursor)).toBe(2);
  });

  it("anchors survive tombstoning: deleting the anchored character itself still resolves to a sensible, stable position", () => {
    const a = new Doc("A");
    for (const ch of "abc") a.insertLocal(a.text.length, ch);
    const cursorBeforeB = a.anchorAt(1); // before 'b'
    const cursorAfterB = { id: cursorBeforeB.id, side: "after" as const }; // after 'b'
    expect(a.resolveAnchor(cursorBeforeB)).toBe(1);
    expect(a.resolveAnchor(cursorAfterB)).toBe(2);

    a.deleteLocal(1); // delete 'b' — the tombstone stays in the tree
    expect(a.text).toBe("ac");

    // "immediately after the tombstone and immediately before it are the
    // same visible position" (Doc.insertBefore's own comment) — both
    // sides collapse to 1 once 'b' is no longer live.
    expect(a.resolveAnchor(cursorBeforeB)).toBe(1);
    expect(a.resolveAnchor(cursorAfterB)).toBe(1);
  });

  it("an end-of-document anchor stays pinned to the last character that existed when it was created, not to the live end", () => {
    const a = new Doc("A");
    for (const ch of "ab") a.insertLocal(a.text.length, ch);
    const endAnchor = a.anchorAt(2); // past 'b', the live end at anchor time
    expect(a.resolveAnchor(endAnchor)).toBe(2);

    a.insertLocal(2, "c"); // appended after the anchor's target, not before it
    expect(a.text).toBe("abc");
    // The anchor is pinned to 'b' (side "after"), not to "wherever the
    // document currently ends" — 'c' landing after 'b' doesn't move it.
    expect(a.resolveAnchor(endAnchor)).toBe(2);
  });

  it("a boundary anchor on a genuinely empty document always resolves to 0", () => {
    const a = new Doc("A");
    const cursor = a.anchorAt(0);
    expect(cursor.id).toBeNull();
    expect(a.resolveAnchor(cursor)).toBe(0);
  });

  it("rejects an out-of-range visible index the same way insertLocal/deleteLocal do", () => {
    const a = new Doc("A");
    for (const ch of "ab") a.insertLocal(a.text.length, ch);
    expect(() => a.anchorAt(-1)).toThrow(RangeError);
    expect(() => a.anchorAt(3)).toThrow(RangeError); // length is 2; 0..2 are valid
  });

  it("property: anchorAt and resolveAnchor are exact inverses immediately after creation, across random tree shapes", () => {
    // anchorAt does index-to-node (top-down, via nodeAtVisibleIndex);
    // resolveAnchor does node-to-count (countLiveBefore, a differently-
    // shaped walk that stops at the first match). They must agree at
    // every position for every tree the random insert/delete sequence
    // below can produce — this is two independently-implemented
    // traversals checking each other, not one algorithm confirming itself.
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ kind: fc.constant("insert" as const), rawIndex: fc.nat({ max: 40 }), char: fc.char() }),
            fc.record({ kind: fc.constant("delete" as const), rawIndex: fc.nat({ max: 40 }) })
          ),
          { minLength: 0, maxLength: 60 }
        ),
        (ops) => {
          const doc = new Doc("A");
          let liveLength = 0;
          for (const op of ops) {
            if (op.kind === "insert") {
              const index = Math.min(op.rawIndex, liveLength);
              doc.insertLocal(index, op.char);
              liveLength += 1;
            } else if (liveLength > 0) {
              doc.deleteLocal(op.rawIndex % liveLength);
              liveLength -= 1;
            }
          }
          for (let i = 0; i <= liveLength; i += 1) {
            expect(doc.resolveAnchor(doc.anchorAt(i))).toBe(i);
          }
        }
      ),
      { numRuns: 500 }
    );
  });
});

describe("Doc: deleteById / charForId (ARCH §2.4/§8 — undo operates on ids, not positions)", () => {
  it("deleteById removes a specific character regardless of its current visible index", () => {
    const a = new Doc("A");
    const ops = [..."abc"].map((ch) => a.insertLocal(a.text.length, ch));
    const bId = ops[1]!.id; // 'b'

    // A remote insert shifts 'b' away from wherever it "was" — deleteById
    // must still find the same character by id, not by a stale index.
    const b = new Doc("B");
    for (const op of ops) b.receive(op);
    const remoteOps = [..."XY"].map((ch, i) => b.insertLocal(i, ch));
    for (const op of remoteOps) a.receive(op);
    expect(a.text).toBe("XYabc");

    a.deleteById(bId);
    expect(a.text).toBe("XYac");
  });

  it("deleteById is idempotent-by-construction: deleting an already-tombstoned id doesn't throw or double-remove", () => {
    const a = new Doc("A");
    const op = a.insertLocal(0, "x");
    a.deleteById(op.id);
    expect(a.text).toBe("");
    expect(() => a.deleteById(op.id)).not.toThrow();
    expect(a.text).toBe("");
  });

  it("deleteById throws on an id this replica has never seen, same contract as insertBefore", () => {
    const a = new Doc("A");
    expect(() => a.deleteById({ replica: "ghost", counter: 0 })).toThrow();
  });

  it("charForId reads a character's value even after it's been tombstoned", () => {
    const a = new Doc("A");
    const op = a.insertLocal(0, "q");
    expect(a.charForId(op.id)).toBe("q");
    a.deleteById(op.id);
    expect(a.text).toBe("");
    expect(a.charForId(op.id)).toBe("q"); // the tombstone still remembers
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
