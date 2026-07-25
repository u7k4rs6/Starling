import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Doc } from "./fugue-doc.js";

/**
 * Regression harness for F-1 (non-causal ElemId ordering → inserts land in
 * the wrong position for any replica that joins an existing document).
 *
 * Root cause: `Sequence.counter` is a bare per-replica sequence number that
 * only advances on local allocation and never on receive, so a late joiner
 * allocates counters 0,1,2… that sort BENEATH content already in the doc.
 * The Fugue/RGA sibling-skip rule is only correct when id order is
 * consistent with causality; here it is not.
 *
 * The existing suite is blind to this because every property test asserts
 * ONLY `new Set(texts).size === 1` (convergence), never where text landed
 * (intention). A CRDT that appends every char to the end in a fixed order
 * passes every convergence run. These tests assert intention.
 *
 * FIXED (Batch 2). `ElemId` now carries a Lamport `clock` and
 * `compareElemIds` orders by it, so an op created after seeing an element
 * always outranks it. These cases were `it.fails` while the bug stood; they
 * are plain `it` assertions now.
 */

/** Type a whole string into a doc, one local insert per char, left to right. */
function type(doc: Doc, startIndex: number, s: string): void {
  let i = startIndex;
  for (const ch of s) {
    doc.insertLocal(i, ch);
    i += 1;
  }
}

/** A fresh replica that has fully received `base` from another replica and
 * is now quiescent (its text equals base, nothing pending). */
function joinerHolding(base: string): Doc {
  const author = new Doc("author");
  const ops = [...base].map((ch, i) => author.insertLocal(i, ch));
  const joiner = new Doc("joiner");
  for (const op of ops) joiner.receive(op);
  return joiner;
}

describe("F-1: a control that already works isolates the bug to foreign history", () => {
  it("a single replica typing all three chars itself preserves intention", () => {
    const d = new Doc("solo");
    d.insertLocal(0, "A");
    d.insertLocal(1, "B");
    d.insertLocal(1, "t");
    expect(d.text).toBe("AtB"); // passes today: no foreign op in history
  });
});

describe("F-1: inserts by a replica that joined an existing document", () => {
  it("a quiescent joiner reproduces the base before editing", () => {
    // The join itself was never the broken part — only the edit that
    // followed it. Kept as the control that isolates which half moved.
    expect(joinerHolding("AB").text).toBe("AB");
    expect(joinerHolding("hello world").text).toBe("hello world");
  });

  it("minimal: joiner holding 'AB' inserts 't' at index 1 → should be 'AtB'", () => {
    const joiner = joinerHolding("AB");
    joiner.insertLocal(1, "t");
    expect(joiner.text).toBe("AtB"); // today: "ABt"
  });

  it("joiner holding 'hello world' inserts 'big ' at index 6 → should be 'hello big world'", () => {
    const joiner = joinerHolding("hello world");
    type(joiner, 6, "big ");
    expect(joiner.text).toBe("hello big world"); // today: "hello world gib"
  });
});

describe("F-1 / ARCH §2.3: non-interleaving must hold mid-document, not only at index 0", () => {
  it("a joiner inserting a word into the middle keeps it contiguous", () => {
    // The existing non-interleaving test only covers backward typing at
    // index 0 from FRESH replicas. This is the same guarantee, mid-document,
    // from a joiner — which is where it currently fails.
    const joiner = joinerHolding("cat");
    type(joiner, 1, "dog"); // intended: c + dog + at = "cdogat"
    expect(joiner.text).toBe("cdogat");
  });
});

describe("F-1: intention property — the single highest-value missing test", () => {
  const charArb = fc.constantFrom(..."abcdefg");
  const markerArb = fc.constantFrom("X", "Y", "Z");

  it(
    "a joiner's single insert lands exactly where a solo editor's would",
    () => {
      fc.assert(
        fc.property(
          fc.array(charArb, { minLength: 1, maxLength: 8 }).map((cs) => cs.join("")),
          markerArb,
          fc.nat(),
          (base, marker, kRaw) => {
            const k = kRaw % (base.length + 1); // valid insert index 0..len
            const joiner = joinerHolding(base);
            joiner.insertLocal(k, marker);
            const intended = base.slice(0, k) + marker + base.slice(k);
            expect(joiner.text).toBe(intended);
          }
        ),
        { numRuns: 500 }
      );
    }
  );
});
