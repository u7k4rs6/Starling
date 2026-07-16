# Starling: Product Requirements

**Status:** kickoff, pre-code
**Repo:** `github.com/u7k4rs6/starling`
**Package:** `starling-crdt` (npm, unscoped)
**Author:** Utkarsh Singh (u7k4rs6)

---

## 0. Read this first

This document is written for an agent with **no access to a prior codebase**. There is no existing Starling repo. Everything below is specification, not description.

An earlier build of this project existed under the name **Palimpsest** and reached roughly 75% completion (13 of 17 steps, 288 passing tests) before the artifact was lost. The code is unrecoverable. The **design decisions are not**, and they are reproduced in this document set as *requirements*, not suggestions.

Several of those decisions are counterintuitive. They were each arrived at by building the obvious thing first, measuring or probing it, and watching it fail. **Do not relitigate them from first principles.** Where a decision looks wrong to you, §2 of `02-ARCHITECTURE.md` explains what evidence produced it. If you think you have a better idea, say so and stop. Do not silently substitute.

The single most common failure mode for this build is an agent that reads "CRDT collaborative editor," pattern-matches to a tutorial, and writes a last-write-wins array with a WebSocket. That artifact is worthless. The value of this project is located entirely in the parts that are hard.

---

## 1. What this is

Starling is a **real-time collaborative text editor built on CRDTs**, written from scratch in TypeScript. Two or more people type into the same document at the same time, from different machines, possibly while disconnected, and the document converges to the same state everywhere without a coordinating server resolving conflicts.

It is a **portfolio artifact**. Its purpose is to demonstrate distributed systems depth, verified rather than asserted, alongside frontend and design competence.

It is not a product. There are no users to acquire, no revenue, no roadmap past v1.

## 2. Why it exists

The portfolio it belongs to already covers OS internals (Flint), LLD/HLD surface (Cairn), systems performance and verification (Shadowbook), ML fundamentals (Cotangent), and supply-chain security (Tessera). Starling covers **distributed data and convergence under concurrency**: the class of problem where correctness is not obvious, cannot be eyeballed, and has to be established by property testing and exhaustive search.

The differentiator is not that it works. Plenty of CRDT demos work. The differentiator is that the repo **shows its own failures**: the naive version, the algorithm that interleaves wrong, the data structure that takes 41 seconds to open a document. Each is preserved, each has a passing test that documents its bug, and each explains why the final design is what it is.

## 3. Success criteria

Starling v1 is done when all of the following are true and independently checkable:

| # | Criterion | How it is verified |
|---|---|---|
| S1 | Two replicas editing concurrently always converge | `fast-check` property test, 1000 runs, 2 replicas |
| S2 | Three replicas editing concurrently always converge | `fast-check` property test, 500 runs, 3 replicas |
| S3 | Convergence holds under arbitrary delivery order | Deterministic sim with seeded RNG, adversarial delivery |
| S4 | Convergence holds under partition and rejoin | Sim: partition, diverge, heal, assert equality |
| S5 | No interleaving on concurrent backward typing | Fugue-specific regression test (see §2.3 of ARCH) |
| S6 | 100k-character document cold-opens in < 1s | Benchmark in `bench/`, committed numbers |
| S7 | The relay contains zero CRDT code | CI grep gate, fails the build |
| S8 | The core package has no dependencies, no DOM, no ambient clock | CI isolation check, fails the build |
| S9 | Offline edits survive reload and reconcile on reconnect | Integration test, and demonstrable in the live demo |
| S10 | Cursors survive remote edits above them | Anchor test: remote insert before anchor, assert position |
| S11 | Undo is correct under concurrency | Undo test: remote edit interleaved with local undo |
| S12 | `npm install starling-crdt` gives a working CRDT | Publish dry-run, then real publish at v0.1.0 |

**Non-goals, explicitly:** rich text beyond ProseMirror's basic schema, authentication as a product feature, multi-document workspaces, mobile apps, operational transformation of any kind, beating Yjs on benchmarks.

## 4. The museum (required, not optional)

The repo keeps its own dead ends. This is a **deliverable**, not debris.

Three exhibits, each in the codebase, each with a passing test that documents the failure:

1. **`NaiveDoc`** — a plain array of characters with index-based insert. Test proves two concurrent inserts at the same index produce divergent documents. This is the thing everyone writes first.
2. **`ArrayDoc`** — correct RGA merge, array-backed storage. Test proves convergence. Benchmark proves it is unusable: cold-open of 100k characters extrapolates to ~41 seconds.
3. **`RgaDoc`** — correct and fast, but interleaves. Test documents the backward-typing anomaly (§2.3 of ARCH).

`Doc` (Fugue over an order-statistic treap) is the survivor. It differs from `RgaDoc` by approximately one `while` loop, and that is the point: the museum makes the delta visible.

**Requirement:** all four share one abstract `Sequence` base and all four run against the same test suite. This is the end state, not an invariant that holds at every rung of the build ladder (§5): `Sequence` is Step 2's own deliverable, so `NaiveDoc` is necessarily built without it at Step 1 and joins the base when Step 2 lands. Once it has, if a change to the base breaks an exhibit, the exhibit was load-bearing and the change is wrong.

**The two-beat lesson (do not refactor this away).** `NaiveDoc`'s divergence test still passes *after* the Step 2 retrofit, and that is the point, not an oversight a future cleanup should "fix":

1. **Step 1, no identity.** `NaiveDoc` merges by raw index. `apply()` is not commutative — `apply(a)∘apply(b) ≠ apply(b)∘apply(a)` for two concurrent inserts at the same index — because there is no element identity to reconcile the two inserts against. It diverges.
2. **Step 2, has identity, still diverges.** `NaiveDoc` moves onto `Sequence`. It now has a unique `ElemId` per character, idempotent re-application, and causal delivery, same as every other exhibit. It **still** diverges, because none of that touches the merge rule — `NaiveDoc`'s `integrate(op)` still places by raw index and ignores the id it was handed. Commutativity lives in the merge rule, not in having identity.

That second beat is the sharpest statement the museum makes of "position is not identity" (§2.4 of ARCH): identity alone buys you nothing if the merge rule doesn't use it. A future contributor who sees `NaiveDoc` sitting on the same `Sequence` base as `Doc` and still failing to converge, and "fixes" it by making `integrate` id-aware, has just reinvented `ArrayDoc` and deleted the exhibit that made the lesson visible.

## 5. Build ladder

Seventeen steps. **One step per session. Stop at each. Do not batch.**

Report findings, wait for confirmation, then commit. This is a standing rule and it is not negotiable: the previous build caught roughly seventeen specification errors precisely because it stopped.

| Step | Deliverable | Gate |
|---|---|---|
| 0 | Monorepo scaffold: pnpm workspace, TypeScript strict, Vitest, GitHub Actions CI | CI green on empty suite |
| 1 | `NaiveDoc` + divergence test (museum exhibit 1) | Test proves divergence |
| 2 | `ElemId = (replicaId, counter)`, `compareElemIds`, abstract `Sequence` | Unit tests on ordering |
| 3 | RGA merge rule, `ArrayDoc` (museum exhibit 2), `fast-check` property tests | S1, S2 pass |
| 4 | Tombstone deletion, visible↔internal index mapping | Delete/undelete tests |
| 4b | Order-statistic treap replaces the array | S6 passes, exhibit 2 preserved |
| 5 | `packages/sim`: seeded RNG, virtual clock, delivery queue | S3, S4 pass |
| 6 | Fugue replaces RGA. Preserve `RgaDoc` as exhibit 3 | S5 passes |
| 7 | Binary encoding (LEB128, replica tables, RLE deletions) + state-vector sync | Round-trip property test |
| 8 | `packages/relay`: append-only log with cursor | S7 passes |
| 9 | `packages/provider`: local persistence, reconnect, sync loop | S9 passes |
| 10 | Offline-first integration test | S9 demonstrable |
| 11 | Anchors (cursors) + awareness (presence, ephemeral) | S10 passes |
| 12 | ProseMirror binding, headless, testable in node | Binding tests pass in node |
| 13 | Undo manager | S11 passes |
| 14 | Demo app: two-pane, presence, offline toggle | Runs locally |
| 15 | Benchmark suite, committed numbers, honest comparison to Yjs | `bench/README.md` with real numbers |
| 16 | Deploy: relay hosted, demo live at a URL | Public URL works |
| 17 | README, docs, `npm publish starling-crdt@0.1.0` | S12 passes |

## 6. Working requirements

These are the rules the previous build ran under. They produced the good decisions. Keep them.

- **Predict before you measure.** State what you expect the benchmark or the probe will show, then run it, then report the delta. A prediction that was wrong is a finding and gets written down.
- **Property tests over example tests** wherever the property is statable. `fast-check`, seeded, with the seed committed on failure.
- **Incidental coverage is not coverage.** A line executed by an unrelated test is untested. Say so when it happens.
- **No convenient explanations.** If a test passes for a reason you have not verified, it has not passed. Check the mechanism.
- **A decision log.** `docs/DECISIONS.md`, one entry per non-obvious choice, including the ones that got reversed. The reversals are the interesting entries.
- **No extra features.** The scope in §3 is the scope. If something seems missing, raise it, do not build it.

## 7. Stack

- TypeScript, strict mode, ESM only
- pnpm workspace monorepo
- Vitest + `fast-check` for property testing
- ProseMirror for the editor surface (binding only, headless and node-testable)
- React for the demo app only, never in the core
- GitHub Actions CI

The core package (`packages/crdt`) has **zero runtime dependencies**. This is enforced in CI, not by convention.

## 8. Naming

Renamed from Palimpsest. The old name described overwriting, and the entire point of a CRDT is that nobody overwrites anybody, so the name argued against the project.

Starling is a murmuration: thousands of birds, no leader, no central coordination, purely local rules, and the flock stays coherent regardless. That is a CRDT, exactly, and the README should open with it.

Note for the record: `starling` is taken on npm (a dead 2015 IoT emulator) and `github.com/starling` is a dormant account, so the package ships as `starling-crdt` and the repo lives under the personal account. There is a Starling Framework (a game engine) and a StarlingX (OpenStack edge infra). Neither is a real collision for a CRDT library, but do not use the bare word in package metadata where it would compete.
