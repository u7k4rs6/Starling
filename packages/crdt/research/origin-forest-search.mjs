#!/usr/bin/env node
// Exhaustive origin-forest search, ARCH §2.1 — run BEFORE Step 3's merge
// rule was written, as required: "before implementing the merge rule, run
// an exhaustive search... reproduce it, do not skip it." The prior build's
// version of this script is lost along with the rest of Palimpsest; this
// is a fresh implementation, not a re-run of historical code. It happens
// to reproduce the historical forest count exactly (16807 at n=6) once the
// right enumeration model was found — see docs/DECISIONS.md #0012.
//
// Question under test: does RGA's convergence (same final sequence
// regardless of delivery order) depend on the total order used to
// tiebreak concurrent elements being causally monotonic (id order tracks
// creation/causal order), or does convergence hold under ANY total order?
//
// Model:
//   - n elements, each optionally pointing to exactly one other element as
//     its "origin" (or null = insert at the very start). A valid ORIGIN
//     FOREST is any such assignment that is acyclic — nothing here
//     presupposes a fixed creation-order index restricting who can be
//     whose origin; the count of these on n labeled elements is the
//     generalized Cayley formula (n+1)^(n-1) (verified below, not just
//     asserted).
//   - For a given forest, a valid DELIVERY ORDER is any permutation of the
//     n elements consistent with "an element's origin (if any) is
//     delivered before the element itself" — a linear extension of the
//     forest's partial order.
//   - idRank is a total order over the n elements' ids, independent of the
//     forest structure. idRank = identity is "causally monotonic" (id
//     order agrees with creation-index order); anything else is not.
//
// The merge rule under test is exactly ARCH §2.3's 4-line RGA integrate(),
// unmodified — including that it skips forward past ANY higher-precedence
// element, not just same-origin siblings. That simplification (and
// whether it still converges) is precisely what's in question; a "fixed"
// version that only skips same-origin siblings would not be testing the
// algorithm this project's museum exhibit 3 is going to preserve.
//
// Run: node packages/crdt/research/origin-forest-search.mjs

function isAcyclic(n, parent) {
  for (let start = 0; start < n; start += 1) {
    let cur = start;
    let steps = 0;
    while (parent[cur] !== -1) {
      cur = parent[cur];
      steps += 1;
      if (steps > n) return false; // cycle
    }
  }
  return true;
}

/** Every acyclic parent-assignment on n labeled elements: (n+1)^(n-1) of them. */
export function* enumerateOriginForests(n) {
  const choicesPerElement = [];
  for (let i = 0; i < n; i += 1) {
    const choices = [-1];
    for (let j = 0; j < n; j += 1) if (j !== i) choices.push(j);
    choicesPerElement.push(choices);
  }
  const origin = new Array(n).fill(-1);
  function* rec(i) {
    if (i === n) {
      if (isAcyclic(n, origin)) yield origin.slice();
      return;
    }
    for (const choice of choicesPerElement[i]) {
      origin[i] = choice;
      yield* rec(i + 1);
    }
  }
  yield* rec(0);
}

/** Every linear extension of the forest's causal partial order. */
export function* enumerateDeliveryOrders(n, origin) {
  const delivered = new Array(n).fill(false);
  const order = [];
  const isAvailable = (i) => !delivered[i] && (origin[i] === -1 || delivered[origin[i]]);
  function* rec(remaining) {
    if (remaining === 0) {
      yield order.slice();
      return;
    }
    for (let i = 0; i < n; i += 1) {
      if (isAvailable(i)) {
        delivered[i] = true;
        order.push(i);
        yield* rec(remaining - 1);
        order.pop();
        delivered[i] = false;
      }
    }
  }
  yield* rec(n);
}

/** ARCH §2.3's RGA merge rule, unmodified. Exported for direct testing. */
export function integrate(elems, opIndex, origin, idRank) {
  const originIdx = origin[opIndex];
  let at = originIdx === -1 ? 0 : elems.indexOf(originIdx) + 1;
  while (at < elems.length && idRank[elems[at]] > idRank[opIndex]) at += 1;
  elems.splice(at, 0, opIndex);
}

export function applyInOrder(order, origin, idRank) {
  const elems = [];
  for (const opIndex of order) integrate(elems, opIndex, origin, idRank);
  return elems;
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Deterministic PRNG (mulberry32) — reproducible, not Math.random(), since
// this script's whole point is a reproducible finding with a seed anyone
// can rerun, same spirit as ARCH §4's simulator.
function mulberry32(seed) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledCopy(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const MAX_N = 6;
const RANDOM_ID_SAMPLES_PER_FOREST = 3; // + monotonic + full-reversal = 5 regimes/forest
const SEED = 1234567;

export function runSearch({ maxN = MAX_N, randomIdSamples = RANDOM_ID_SAMPLES_PER_FOREST, seed = SEED } = {}) {
  const rng = mulberry32(seed);
  const perN = [];
  let totalForests = 0;
  let totalChecks = 0;
  let totalDivergences = 0;
  const examples = [];

  for (let n = 1; n <= maxN; n += 1) {
    let forestCount = 0;
    let checks = 0;
    let divergences = 0;
    const identityIds = Array.from({ length: n }, (_, i) => i);

    for (const origin of enumerateOriginForests(n)) {
      forestCount += 1;
      const regimes = [identityIds, identityIds.slice().reverse()];
      for (let s = 0; s < randomIdSamples; s += 1) regimes.push(shuffledCopy(identityIds, rng));

      const deliveryOrders = [...enumerateDeliveryOrders(n, origin)];

      for (const idRank of regimes) {
        checks += 1;
        let reference = null;
        for (const order of deliveryOrders) {
          const result = applyInOrder(order, origin, idRank);
          if (reference === null) {
            reference = result;
          } else if (!arraysEqual(reference, result)) {
            divergences += 1;
            if (examples.length < 5) examples.push({ n, origin: origin.slice(), idRank: idRank.slice() });
            break;
          }
        }
      }
    }

    const expectedForestCount = Math.pow(n + 1, n - 1);
    perN.push({ n, forestCount, expectedForestCount, checks, divergences });
    totalForests += forestCount;
    totalChecks += checks;
    totalDivergences += divergences;
  }

  return { perN, totalForests, totalChecks, totalDivergences, examples };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const start = Date.now();
  const result = runSearch();
  for (const row of result.perN) {
    const ok = row.forestCount === row.expectedForestCount ? "match" : "MISMATCH";
    console.log(
      `n=${row.n}: ${row.forestCount} forests ((n+1)^(n-1)=${row.expectedForestCount}, ${ok}), ` +
        `${row.checks} forest×id-regime checks, ${row.divergences} divergences`
    );
  }
  console.log(`\nTotal forests n=1..${MAX_N}: ${result.totalForests} (docs/DECISIONS.md #0012 cites 16807 at n=6)`);
  console.log(`Total forest×id-regime checks: ${result.totalChecks}`);
  console.log(`Total divergences: ${result.totalDivergences}`);
  console.log(`Elapsed: ${Date.now() - start}ms`);
  if (result.examples.length > 0) {
    console.log("\nDivergence examples:");
    console.log(JSON.stringify(result.examples, null, 2));
  }
  if (result.totalDivergences > 0) process.exitCode = 1;
}
