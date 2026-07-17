/**
 * Seeded RNG (ARCH §4, part 1). Every run is reproducible from a seed: on
 * a test failure, printing `rng.seed` (and the seed it was constructed
 * with) is enough to replay the exact same sequence of "random" choices.
 * mulberry32 — small, fast, well-distributed enough for simulation, and
 * critically a pure function of its internal state, unlike `Math.random()`
 * which cannot be seeded or replayed.
 */
export type SeededRng = {
  readonly seed: number;
  /** Next value in [0, 1). */
  next(): number;
  /** Next integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
  /** True with probability `p` (default 0.5). */
  chance(p?: number): boolean;
};

export function createSeededRng(seed: number): SeededRng {
  let state = seed;
  const next = (): number => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed,
    next,
    nextInt: (maxExclusive: number) => Math.floor(next() * maxExclusive),
    chance: (p = 0.5) => next() < p,
  };
}
