import { describe, expect, it } from "vitest";
import { compareElemIds, hashElemId, type ElemId } from "./elem-id.js";

describe("compareElemIds", () => {
  it("orders primarily by counter, regardless of replica", () => {
    const a: ElemId = { replica: "z", counter: 1 };
    const b: ElemId = { replica: "a", counter: 2 };
    expect(compareElemIds(a, b)).toBeLessThan(0);
    expect(compareElemIds(b, a)).toBeGreaterThan(0);
  });

  it("tiebreaks on replica lexicographically when counters are equal", () => {
    const a: ElemId = { replica: "alice", counter: 5 };
    const b: ElemId = { replica: "bob", counter: 5 };
    expect(compareElemIds(a, b)).toBeLessThan(0);
    expect(compareElemIds(b, a)).toBeGreaterThan(0);
  });

  it("returns 0 for identical ids", () => {
    const a: ElemId = { replica: "alice", counter: 5 };
    const b: ElemId = { replica: "alice", counter: 5 };
    expect(compareElemIds(a, b)).toBe(0);
  });

  it("is a total order: Array.sort is deterministic regardless of starting order", () => {
    const ids: ElemId[] = [
      { replica: "b", counter: 2 },
      { replica: "a", counter: 1 },
      { replica: "a", counter: 2 },
      { replica: "c", counter: 1 },
      { replica: "b", counter: 1 },
    ];
    const shuffled = [ids[3]!, ids[0]!, ids[4]!, ids[1]!, ids[2]!];

    const sortedFromOriginal = [...ids].sort(compareElemIds);
    const sortedFromShuffled = [...shuffled].sort(compareElemIds);

    expect(sortedFromShuffled).toEqual(sortedFromOriginal);
    expect(sortedFromOriginal).toEqual([
      { replica: "a", counter: 1 },
      { replica: "b", counter: 1 },
      { replica: "c", counter: 1 },
      { replica: "a", counter: 2 },
      { replica: "b", counter: 2 },
    ]);
  });

  it("is antisymmetric: compare(a, b) and compare(b, a) have opposite signs", () => {
    const a: ElemId = { replica: "x", counter: 3 };
    const b: ElemId = { replica: "y", counter: 3 };
    expect(Math.sign(compareElemIds(a, b))).toBe(-Math.sign(compareElemIds(b, a)));
  });

  it("is transitive across a counter tiebreak and a counter difference", () => {
    const a: ElemId = { replica: "a", counter: 1 };
    const b: ElemId = { replica: "z", counter: 1 };
    const c: ElemId = { replica: "a", counter: 2 };

    expect(compareElemIds(a, b)).toBeLessThan(0); // a < b: same counter, "a" < "z"
    expect(compareElemIds(b, c)).toBeLessThan(0); // b < c: counter 1 < 2 wins over replica
    expect(compareElemIds(a, c)).toBeLessThan(0); // a < c: transitivity holds
  });
});

describe("hashElemId (ARCH §2.5: treap priority, deterministic, not Math.random)", () => {
  it("is a pure function: the same id always hashes to the same value", () => {
    const a: ElemId = { replica: "alice", counter: 7 };
    const b: ElemId = { replica: "alice", counter: 7 };
    expect(hashElemId(a)).toBe(hashElemId(b));
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
