import { describe, expect, it } from "vitest";
import { createSeededRng } from "./rng.js";

describe("createSeededRng", () => {
  it("is reproducible: the same seed produces the identical sequence", () => {
    const a = createSeededRng(42);
    const b = createSeededRng(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("different seeds produce different sequences", () => {
    const a = createSeededRng(1);
    const b = createSeededRng(2);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it("next() stays within [0, 1)", () => {
    const rng = createSeededRng(7);
    for (let i = 0; i < 1000; i += 1) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("nextInt(n) stays within [0, n) and hits every value across enough draws", () => {
    const rng = createSeededRng(99);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i += 1) {
      const v = rng.nextInt(5);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(5);
      seen.add(v);
    }
    expect(seen).toEqual(new Set([0, 1, 2, 3, 4]));
  });

  it("chance(p) is roughly p over many draws", () => {
    const rng = createSeededRng(123);
    let trueCount = 0;
    const N = 5000;
    for (let i = 0; i < N; i += 1) if (rng.chance(0.3)) trueCount += 1;
    expect(trueCount / N).toBeGreaterThan(0.25);
    expect(trueCount / N).toBeLessThan(0.35);
  });

  it("exposes the seed it was constructed with, for reporting on failure", () => {
    const rng = createSeededRng(2026);
    expect(rng.seed).toBe(2026);
  });
});
