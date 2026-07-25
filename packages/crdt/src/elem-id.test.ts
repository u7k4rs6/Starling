import { describe, expect, it } from "vitest";
import { compareElemIds, hashElemId, type ElemId, type ElemRef } from "./elem-id.js";

/**
 * The precedence cases below assert the CLOCK-first contract introduced by
 * F-1. They previously asserted a counter-first contract; that was the bug,
 * not a passing spec — the identity counter carries no causal meaning, so
 * ordering by it let a replica joining an existing document sort its inserts
 * beneath content already there. The structural axioms (totality,
 * antisymmetry, transitivity) are unchanged and still assert exactly what
 * they always did; only which field decides precedence has moved.
 */
describe("compareElemIds", () => {
  it("orders primarily by Lamport clock, regardless of replica or counter", () => {
    // The joiner shape that F-1 got wrong: `b` has a LOWER identity counter
    // but a HIGHER clock, because it was created after seeing `a`. Causality
    // must win over the bare counter.
    const a: ElemId = { replica: "z", counter: 9, clock: 1 };
    const b: ElemId = { replica: "a", counter: 0, clock: 2 };
    expect(compareElemIds(a, b)).toBeLessThan(0);
    expect(compareElemIds(b, a)).toBeGreaterThan(0);
  });

  it("tiebreaks on replica lexicographically when clocks are equal (genuine concurrency)", () => {
    const a: ElemId = { replica: "alice", counter: 5, clock: 5 };
    const b: ElemId = { replica: "bob", counter: 5, clock: 5 };
    expect(compareElemIds(a, b)).toBeLessThan(0);
    expect(compareElemIds(b, a)).toBeGreaterThan(0);
  });

  it("returns 0 for identical ids", () => {
    const a: ElemId = { replica: "alice", counter: 5, clock: 5 };
    const b: ElemId = { replica: "alice", counter: 5, clock: 5 };
    expect(compareElemIds(a, b)).toBe(0);
  });

  it("is a total order: Array.sort is deterministic regardless of starting order", () => {
    const ids: ElemId[] = [
      { replica: "b", counter: 2, clock: 2 },
      { replica: "a", counter: 1, clock: 1 },
      { replica: "a", counter: 2, clock: 2 },
      { replica: "c", counter: 1, clock: 1 },
      { replica: "b", counter: 1, clock: 1 },
    ];
    const shuffled = [ids[3]!, ids[0]!, ids[4]!, ids[1]!, ids[2]!];

    const sortedFromOriginal = [...ids].sort(compareElemIds);
    const sortedFromShuffled = [...shuffled].sort(compareElemIds);

    expect(sortedFromShuffled).toEqual(sortedFromOriginal);
    expect(sortedFromOriginal).toEqual([
      { replica: "a", counter: 1, clock: 1 },
      { replica: "b", counter: 1, clock: 1 },
      { replica: "c", counter: 1, clock: 1 },
      { replica: "a", counter: 2, clock: 2 },
      { replica: "b", counter: 2, clock: 2 },
    ]);
  });

  it("is antisymmetric: compare(a, b) and compare(b, a) have opposite signs", () => {
    const a: ElemId = { replica: "x", counter: 3, clock: 3 };
    const b: ElemId = { replica: "y", counter: 3, clock: 3 };
    expect(Math.sign(compareElemIds(a, b))).toBe(-Math.sign(compareElemIds(b, a)));
  });

  it("is transitive across a replica tiebreak and a clock difference", () => {
    const a: ElemId = { replica: "a", counter: 1, clock: 1 };
    const b: ElemId = { replica: "z", counter: 1, clock: 1 };
    const c: ElemId = { replica: "a", counter: 2, clock: 2 };

    expect(compareElemIds(a, b)).toBeLessThan(0); // a < b: same clock, "a" < "z"
    expect(compareElemIds(b, c)).toBeLessThan(0); // b < c: clock 1 < 2 wins over replica
    expect(compareElemIds(a, c)).toBeLessThan(0); // a < c: transitivity holds
  });

  it("the counter never overrides the clock, even when it points the other way", () => {
    // Pins the exact inversion F-1 was: ordering by counter would put `late`
    // first (counter 0 < 7); ordering by clock — the causal fact — puts it
    // last, which is what the sibling-skip rule needs.
    const early: ElemId = { replica: "A", counter: 7, clock: 3 };
    const late: ElemId = { replica: "A", counter: 0, clock: 99 };
    expect(compareElemIds(early, late)).toBeLessThan(0);
  });
});

describe("hashElemId (ARCH §2.5: treap priority, deterministic, not Math.random)", () => {
  it("is a pure function: the same id always hashes to the same value", () => {
    const a: ElemRef = { replica: "alice", counter: 7 };
    const b: ElemRef = { replica: "alice", counter: 7 };
    expect(hashElemId(a)).toBe(hashElemId(b));
  });

  it("depends on identity only, not on the clock — treap shape is unchanged by F-1", () => {
    // Why this matters: priority decides tree SHAPE, document order is
    // decided by compareElemIds. Had the clock leaked into the hash, adding
    // it would have silently reshaped every treap.
    const ref: ElemRef = { replica: "alice", counter: 7 };
    const withClock: ElemId = { replica: "alice", counter: 7, clock: 42 };
    expect(hashElemId(withClock)).toBe(hashElemId(ref));
  });

  it("two independently-constructed RgaDoc-style ids from different replicas hash differently in the common case", () => {
    // Not a formal collision-resistance proof (a 32-bit hash can and does
    // collide) — just a sanity check that adjacent, similar-looking ids
    // don't trivially hash to the same priority, which would defeat the
    // point of hashing at all.
    const values = new Set<number>();
    for (let counter = 0; counter < 200; counter += 1) {
      for (const replica of ["A", "B", "C"]) {
        values.add(hashElemId({ replica, counter }));
      }
    }
    expect(values.size).toBe(600);
  });

  it("returns a non-negative 32-bit integer", () => {
    const h = hashElemId({ replica: "x", counter: 12345 });
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});
