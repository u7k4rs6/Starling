// Shared helpers for the bench/ scripts (Step 15, ARCH §9). Every script
// here is a plain Node ESM file run directly with `node bench/x.mjs`, not
// through vitest — these are measurements to read, not assertions to pass
// or fail (the one exception, the §3.1 byte-budget figure, already has its
// own vitest assertion in packages/crdt/src/encoding.test.ts; this suite
// just re-reports that number alongside the others for one README).

export function now() {
  return performance.now();
}

export function fmtMs(ms) {
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

// A tiny deterministic PRNG (mulberry32) — not `Math.random()` — so a
// script that needs "random" positions (bench/memory.mjs) still produces
// the same numbers on every run, matching this project's general
// determinism discipline (ARCH §4's own RNG requirement for the
// simulator) rather than reporting a benchmark figure that silently
// varies run to run.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A fixed, reproducible source text for every "type this forward" workload
// across all bench scripts — same shape DECISIONS #0014/#0018's ad hoc
// measurements used (plain lowercase + spaces, no unicode edge cases;
// those are the crdt package's *correctness* tests' job, not this one's).
export function sourceText(n) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz          ";
  let out = "";
  for (let i = 0; i < n; i += 1) {
    out += alphabet[i % alphabet.length];
  }
  return out;
}
