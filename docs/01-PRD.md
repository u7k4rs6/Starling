# Starling: Product Requirements

**Repo:** `github.com/u7k4rs6/Starling` · **Package:** `starling-crdt` (npm, unscoped) · **Author:** Utkarsh Singh (u7k4rs6) · **License:** MIT

---

## 0. Orientation

Starling is a real-time collaborative text editor built on CRDTs, written from scratch in TypeScript. This document set is the design record: what the project is, why each decision was made, and the evidence behind the ones that are counterintuitive.

The project began under the name Palimpsest and reached roughly three-quarters of its planned scope before that build was lost. The code was unrecoverable; the design decisions were not, and they are reproduced across these documents. Several are counterintuitive — each was reached by building the obvious thing first, measuring or probing it, and watching it fail. Where a decision reads as surprising, [§2 of the architecture doc](02-ARCHITECTURE.md) gives the evidence that produced it.

The value of the project lives in the parts that are hard. A CRDT collaborative editor is easy to mistake for a tutorial exercise, a last-write-wins array that merges edits by position, but that version is worthless: it diverges the moment two people edit at once. Everything worth reading here is in avoiding that failure and proving it was avoided.

---

## 1. What this is

Starling is a **real-time collaborative text editor built on CRDTs**. Two or more people type into the same document at the same time, from different machines, possibly while disconnected, and the document converges to the same state everywhere without a coordinating server resolving conflicts.

It is a **portfolio artifact**: its purpose is to demonstrate distributed-systems depth — verified rather than asserted — alongside frontend and design competence. It is not a product. There are no users to acquire, no revenue, and no roadmap past v1.

## 2. Why it exists

Starling covers **distributed data and convergence under concurrency**: the class of problem where correctness is not obvious, cannot be eyeballed, and has to be established by property testing and exhaustive search rather than by inspection.

The differentiator is not that it works — plenty of CRDT demos work. It is that the repository **shows its own failures**: the naive version that diverges, the algorithm that interleaves wrong, the data structure that took 168 seconds to open a document that should open in under one. Each is preserved, each has a passing test that documents its bug, and each explains why the final design is what it is.

## 3. Success criteria

Starling v1 is defined by the following, each true and independently checkable:

| # | Criterion | How it is verified |
|---|---|---|
| S1 | Two replicas editing concurrently always converge | `fast-check` property test, 1000 runs, 2 replicas |
| S2 | Three replicas editing concurrently always converge | `fast-check` property test, 500 runs, 3 replicas |
| S3 | Convergence holds under arbitrary delivery order | Deterministic simulator with seeded RNG, adversarial delivery |
| S4 | Convergence holds under partition and rejoin | Simulator: partition, diverge, heal, assert equality |
| S5 | No interleaving on concurrent backward typing | Fugue-specific regression test (see [ARCH §2.3](02-ARCHITECTURE.md)) |
| S6 | 100k-character document cold-opens in < 1s | Committed benchmark numbers in [`bench/`](../bench) |
| S7 | The relay contains zero CRDT code | CI gate, fails the build otherwise |
| S8 | The core package has no dependencies, no DOM, no ambient clock | CI isolation gate, fails the build otherwise |
| S9 | Offline edits survive reload and reconcile on reconnect | Integration test against a real relay and real IndexedDB |
| S10 | Cursors survive remote edits above them | Anchor test: remote insert before an anchor, assert position |
| S11 | Undo is correct under concurrency | Undo test: remote edit interleaved with local undo |
| S12 | `npm install starling-crdt` gives a working CRDT | Published at v0.1.0 with provenance |

**Non-goals, explicitly:** rich text beyond ProseMirror's basic schema, authentication as a product feature, multi-document workspaces, mobile apps, operational transformation of any kind, and beating Yjs on benchmarks.

## 4. The museum

The repository keeps its own dead ends, on purpose. They are part of the artifact, not debris.

Three exhibits live in the codebase, each with a passing test that documents its failure:

1. **`NaiveDoc`** — a plain array of characters with index-based insert. Its test proves that two concurrent inserts at the same index produce divergent documents. This is the thing almost everyone writes first.
2. **`ArrayDoc`** — a correct RGA merge over array-backed storage. Its test proves convergence; the benchmarks prove it is unusable, with cold-open cost growing far past what any real document could tolerate.
3. **`RgaDoc`** — correct and fast, but it interleaves. Its test documents the backward-typing anomaly ([ARCH §2.3](02-ARCHITECTURE.md)).

`Doc` (Fugue over an order-statistic treap) is the survivor. It differs from `RgaDoc` by approximately one `while` loop, and that is the point: the museum makes the delta visible.

All four share one abstract `Sequence` base and all four run against the same test suite, so a change to the base that breaks an exhibit means the exhibit was load-bearing and the change is wrong.

**The two-beat lesson.** `NaiveDoc`'s divergence test still passes *after* it is moved onto the shared `Sequence` base — and that is deliberate, not an oversight:

1. **Without identity**, `NaiveDoc` merges by raw index. Applying two concurrent inserts at the same index is not commutative — `apply(a)∘apply(b) ≠ apply(b)∘apply(a)` — because there is no element identity to reconcile the two against. It diverges.
2. **With identity, it still diverges.** Once `NaiveDoc` sits on `Sequence` it has a unique `ElemId` per character, idempotent re-application, and causal delivery, exactly like every other exhibit. It still diverges, because none of that touches the merge rule: its `integrate(op)` still places by raw index and ignores the id it was handed.

That second beat is the sharpest statement the museum makes of "position is not identity" ([ARCH §2.4](02-ARCHITECTURE.md)): identity alone buys nothing if the merge rule does not use it. Making `NaiveDoc` converge by teaching its `integrate` to use the id would simply reinvent `ArrayDoc` and delete the exhibit that makes the lesson visible.

## 5. How it was built

Starling was built in seventeen numbered steps, one at a time, each stopping to report findings before the next began — a discipline that surfaced roughly seventeen specification errors along the way, precisely because it paused. The steps, and the gate each had to clear:

| Step | Deliverable | Gate |
|---|---|---|
| 0 | Monorepo scaffold: pnpm workspace, TypeScript strict, Vitest, GitHub Actions CI | CI green on empty suite |
| 1 | `NaiveDoc` + divergence test (museum exhibit 1) | Test proves divergence |
| 2 | `ElemId = (replicaId, counter)`, `compareElemIds`, abstract `Sequence` | Unit tests on ordering |
| 3 | RGA merge rule, `ArrayDoc` (museum exhibit 2), `fast-check` property tests | S1, S2 pass |
| 4 | Tombstone deletion, visible↔internal index mapping | Delete/undelete tests |
| 4b | Order-statistic treap replaces the array | S6 passes, exhibit 2 preserved |
| 5 | `packages/sim`: seeded RNG, virtual clock, delivery queue | S3, S4 pass |
| 6 | Fugue replaces RGA; `RgaDoc` preserved as exhibit 3 | S5 passes |
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

A subsequent correctness/security audit added a further set of numbered findings on top of these; they are logged in [`DECISIONS.md`](DECISIONS.md) and summarized in the README.

## 6. Principles

The project was built under a small set of working principles, and they account for most of the good decisions:

- **Predict before you measure.** State what a benchmark or probe is expected to show, run it, then report the delta. A wrong prediction is itself a finding and gets written down.
- **Property tests over example tests** wherever a property is statable — `fast-check`, seeded, with the seed committed on any failure so it replays exactly.
- **Incidental coverage is not coverage.** A line executed only by an unrelated test is untested, and is called out as such.
- **No convenient explanations.** If a test passes for a reason that has not been verified, it has not passed; the mechanism is checked.
- **A decision log.** [`DECISIONS.md`](DECISIONS.md) carries one entry per non-obvious choice, including the ones that were later reversed — the reversals are the interesting entries.
- **No extra features.** The scope in §3 is the scope.

## 7. Stack

- TypeScript, strict mode, ESM only
- pnpm workspace monorepo
- Vitest + `fast-check` for property testing
- ProseMirror for the editor surface (binding only, headless and node-testable)
- React for the demo app only, never in the core
- GitHub Actions CI

The core package (`packages/crdt`) has **zero runtime dependencies**, enforced in CI rather than by convention.

## 8. Naming

The project was renamed from Palimpsest. The old name described overwriting, and the entire point of a CRDT is that nobody overwrites anybody — so the name argued against the project.

A starling murmuration is thousands of birds with no leader and no central coordination, following purely local rules, and the flock stays coherent regardless. That is a CRDT, exactly.

For the record: `starling` was already taken on npm (a dormant 2015 IoT emulator), so the package ships as `starling-crdt` and the repository lives under the personal account. A Starling game-engine framework and an OpenStack edge-infra project named StarlingX both exist; neither is a real collision for a CRDT library, and the bare word is kept out of package metadata where it would compete.
