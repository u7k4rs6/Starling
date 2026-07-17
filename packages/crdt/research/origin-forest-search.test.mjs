import { describe, expect, it } from "vitest";
import {
  applyInOrder,
  enumerateDeliveryOrders,
  enumerateOriginForests,
  runSearch,
} from "./origin-forest-search.mjs";

const result = runSearch({ maxN: 6 });

describe("origin-forest search (ARCH §2.1, docs/DECISIONS.md #0012)", () => {
  it("forest counts match the generalized Cayley formula (n+1)^(n-1) for every n", () => {
    for (const row of result.perN) {
      expect(row.forestCount).toBe(row.expectedForestCount);
    }
  });

  it("n=6 reproduces the historical count of 16807 forests exactly", () => {
    const n6 = result.perN.find((row) => row.n === 6);
    expect(n6.forestCount).toBe(16807);
  });

  it("n=2 enumerates exactly the 3 possible structures: both roots, A-parent-of-B, B-parent-of-A", () => {
    const forests = [...enumerateOriginForests(2)];
    expect(forests).toHaveLength(3);
    expect(forests).toEqual(
      expect.arrayContaining([
        [-1, -1],
        [-1, 0],
        [1, -1],
      ])
    );
  });

  it("RGA's 4-line integrate() converges for every origin forest, every delivery order, every id-rank regime tested, up to n=6", () => {
    expect(result.totalDivergences).toBe(0);
    expect(result.totalChecks).toBeGreaterThan(0); // sanity: the search actually ran something
  });

  it("the harness is not vacuous: 3 fully-concurrent elements have 3! = 6 valid delivery orders", () => {
    const origin = [-1, -1, -1];
    const orders = [...enumerateDeliveryOrders(3, origin)];
    expect(orders).toHaveLength(6);
  });

  it("the harness is not vacuous: id-rank actually changes placement for a fixed forest and delivery order", () => {
    const origin = [-1, -1, -1]; // 3 fully concurrent elements
    const order = [0, 1, 2];
    const monotonic = applyInOrder(order, origin, [0, 1, 2]);
    const reversed = applyInOrder(order, origin, [2, 1, 0]);
    expect(monotonic).not.toEqual(reversed);
  });

  it("the harness is not vacuous: different delivery orders of the same forest+ids do converge to the same result (the actual claim)", () => {
    const origin = [-1, -1, -1];
    const idRank = [0, 1, 2];
    const r1 = applyInOrder([0, 1, 2], origin, idRank);
    const r2 = applyInOrder([2, 0, 1], origin, idRank);
    const r3 = applyInOrder([1, 2, 0], origin, idRank);
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
  });
});
