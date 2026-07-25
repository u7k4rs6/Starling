<div align="center">

<img src="docs/assets/hero.svg" alt="Starling: two replicas type at once, go offline, and the document converges everywhere. No server decides." width="100%">

<br/>

![tests](https://img.shields.io/badge/tests-328%20green-f5c518?style=flat-square&labelColor=131518)
![runtime deps](https://img.shields.io/badge/runtime%20deps-0-f5c518?style=flat-square&labelColor=131518)
![ci gates](https://img.shields.io/badge/ci%20gates-2%20enforced-f5c518?style=flat-square&labelColor=131518)
![node](https://img.shields.io/badge/node-%E2%89%A522-8a8f98?style=flat-square&labelColor=131518)
![license](https://img.shields.io/badge/license-MIT-8a8f98?style=flat-square&labelColor=131518)

**[Why it exists](#why-this-exists) · [The exhibit](#convergence-is-not-correctness) · [Architecture](#architecture) · [Quickstart](#quickstart) · [Benchmarks](#benchmarks-including-the-losses) · [Scorecard](#scorecard) · [Findings](#findings)**

</div>

<br/>

## Why this exists

A real-time collaborative text editor built on CRDTs, from scratch, in TypeScript. Two or more people type into the same document at the same time, from different machines, possibly while disconnected, and the document converges to the same state everywhere, with no coordinating server resolving conflicts.

This is a portfolio artifact, not a product. Its value is in the parts that are hard: convergence under concurrency, verified rather than asserted, and a repo that **shows its own failures**. The naive implementation that diverges. The algorithm that interleaves wrong. The data structure that took 168 seconds to open a document that should open in under one. Each one is preserved, each one has a test that documents its bug, and [`docs/DECISIONS.md`](docs/DECISIONS.md) is a running, numbered log of all 28 of those findings, including the ones that were never fixed and why.

```ts
import { Doc } from "starling-crdt";

const a = new Doc("replica-a");
const b = new Doc("replica-b");

b.receive(a.insertLocal(0, "h"));
b.receive(a.insertLocal(1, "i"));

a.text; // "hi"
b.text; // "hi", regardless of delivery order, duplicates or drops

// A cursor is an id plus a side, never an integer offset.
const anchor = a.anchorAt(1);
a.insertLocal(0, "!");
a.resolveAnchor(anchor); // 2, having followed the character it was attached to
```

<br/>

## Convergence is not correctness

<img src="docs/assets/convergence.svg" alt="Two replicas each type a word backward at the same time. RGA converges on the jumble dollrloewh. Fugue converges on the clean concatenation ollehdlrow." width="100%">

Every CRDT in this repo converges. That was never the hard part. The hard part is converging on the document a human meant to write.

Two replicas each type a word backward, at index 0, with no knowledge of each other. RGA agrees with itself perfectly and produces `dollrloewh`. Fugue agrees with itself too, and produces `ollehdlrow`: each writer's run left whole, in one order or the other, never zipped together.

That single difference is why `Doc` (Fugue) is the class that ships and `RgaDoc` is kept as an exhibit. The jumble is pinned as an assertion in [`rga-doc.test.ts`](packages/crdt/src/rga-doc.test.ts) on purpose, because fixing the bug in that file would delete the evidence.

<br/>

## Architecture

<img src="docs/assets/architecture.svg" alt="Architecture: demo, editor, provider and crdt in the browser; the relay is an append-only byte log; a deterministic simulator drives the property tests. Two CI gates enforce the boundaries." width="100%">

| Package | What it is |
|---|---|
| [`packages/crdt`](packages/crdt) | The CRDT core, published as `starling-crdt`. No dependencies, no DOM, no ambient clock, all three enforced by a CI gate. `Doc` (Fugue) is the one to use. `RgaDoc`, `ArrayDoc` and `NaiveDoc` are preserved reference implementations, benchmarked honestly alongside it. |
| [`packages/editor`](packages/editor) | ProseMirror binding: CRDT ops to and from PM transactions and steps, plus an undo manager with no OT and no `prosemirror-history`. |
| [`packages/provider`](packages/provider) | Local persistence (IndexedDB), the relay transport, the sync loop, presence and awareness. |
| [`packages/relay`](packages/relay) | An append-only log with a byte cursor. Contains zero CRDT code, enforced by a CI gate. It does not know what a character, a tombstone or an `ElemId` is. |
| [`packages/demo`](packages/demo) | Two editor panes side by side, connection toggles, remote cursors, offline mode. |
| [`packages/sim`](packages/sim) | A deterministic simulator: seeded RNG, virtual clock, a delivery queue that drops, duplicates, reorders and partitions. The convergence properties run against this. |
| [`bench/`](bench) | Committed, reproducible benchmark numbers: cold-open latency, memory, wire size, and a head to head against Yjs. |

The two dashed walls in the diagram are `tools/gates/core-isolation.mjs` and `tools/gates/relay-ignorance.mjs`. They run in about a second, they run in CI, and they fail the build. They exist because a boundary that lives only in an architecture document is a boundary that quietly stops being true.

<br/>

## Quickstart

```bash
pnpm install
pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run gates
```

Run the demo locally, then open two browser tabs on the same document and edit concurrently:

```bash
pnpm --filter @starling/demo run dev:relay   # terminal 1
pnpm --filter @starling/demo run dev         # terminal 2
```

Use just the CRDT core, with no editor, no relay and no browser:

```bash
npm install starling-crdt
```

See [`packages/crdt/README.md`](packages/crdt/README.md) for the full API. Benchmarks are reproducible with `pnpm run bench`.

<br/>

## Offline is not an error state

<img src="docs/assets/offline.svg" alt="Timeline: two replicas exchange ops, the network partitions and both keep editing locally, then on rejoin only the missing ops ship and both converge." width="100%">

Edits apply to the local document first and are persisted to IndexedDB before anything touches the network, so a partition is not a failure mode to recover from. It is a longer gap between syncs. On rejoin, state vectors are compared and only the missing ops ship, never the whole log.

Convergence under arbitrary delivery order, duplicates, drops and partitions is proved as a property against [`packages/sim`](packages/sim), with a seeded RNG so every counterexample replays exactly.

<br/>

## Benchmarks, including the losses

<img src="docs/assets/bench.svg" alt="Cold-open of a 100,000 character document on a log scale: Yjs 4.6ms, Doc 110ms, RgaDoc 365ms, the 1 second budget, and Doc before the F-8 fix at 168,000ms." width="100%">

| Measurement | Result |
|---|---|
| Cold-open, 100k characters | `Doc` ~110 ms, `RgaDoc` 365 ms, Yjs 4.6 ms. Budget was 1 s. |
| Cold-open before the F-8 fix | `Doc` 168 s, about 168x over budget and about 36,800x Yjs. Measured, published, then fixed. |
| Encode and decode | ~1M+ ops/s either direction. Never the bottleneck. |
| 60,000 deletions on the wire | 15 bytes, against a 29 byte budget. |
| Memory at 100k characters | ~610 bytes/char live, ~858 once fully tombstoned. Tombstones are permanent by definition. |
| Wire size, forward typing | ~13.6 bytes/char against Yjs at ~1.00. **Still losing.** Deletions are run-length encoded; consecutive same-replica inserts are not. |
| Local build, 100k characters | Still super-linear. F-8 fixed the read path, not the write path. |

Full method, machine caveats and the reasoning behind each number: [`bench/README.md`](bench/README.md).

<br/>

## The four implementations

The core ships one CRDT and keeps three more, because a claim like "this data structure does not scale" is worth more when the unscalable one is still in the repo, still passing its own tests, still being benchmarked next to the winner.

| Class | Status | What it is kept to prove |
|---|---|---|
| `NaiveDoc` | Diverges | Concurrent edits at the same index do not converge. The baseline failure everything else is measured against. |
| `ArrayDoc` | Correct, unusable | O(n) per operation. Correct at every size and unusable well before 100k. |
| `RgaDoc` | Correct, interleaves | An order-statistic treap gives it O(log n) operations and the best cold-open here, and it still zips concurrent runs together. |
| `Doc` | Ships | Fugue. Fixes the interleaving, matches the budget after F-8, still loses on wire size. |

<br/>

## Scorecard

Every claim below is independently checkable. That is the point. Status is reported the same way this repo reports a benchmark: plainly, including where it falls short.

| # | Criterion | Status |
|---|---|---|
| S1 | Two replicas editing concurrently always converge | ✅ `fast-check`, 1000 runs |
| S2 | Three replicas editing concurrently always converge | ✅ `fast-check`, 500 runs |
| S3 | Convergence holds under arbitrary delivery order | ✅ `packages/sim`, seeded RNG |
| S4 | Convergence holds under partition and rejoin | ✅ `packages/sim` |
| S5 | No interleaving on concurrent backward typing | ✅ Fugue regression test, plus a mid-document intention property |
| S6 | 100k-character document cold-opens in under 1s | ✅ `Doc` ~110 ms, `RgaDoc` 365 ms. Was 168 s and failing; see F-8 below |
| S7 | The relay contains zero CRDT code | ✅ CI gate, fails the build otherwise |
| S8 | The core has no dependencies, no DOM, no ambient clock | ✅ CI gate, fails the build otherwise |
| S9 | Offline edits survive reload and reconcile on reconnect | ✅ Integration test against a real relay and real IndexedDB. Not live at a public URL yet: that needs a host and a repo-admin click, runbook in [`docs/DEPLOY.md`](docs/DEPLOY.md) |
| S10 | Cursors survive remote edits above them | ✅ Anchor test |
| S11 | Undo is correct under concurrency | ✅ Undo test |
| S12 | `npm install starling-crdt` gives a working CRDT | ✅ Published as [`starling-crdt@0.1.0`](https://www.npmjs.com/package/starling-crdt), with provenance and zero runtime dependencies |

<br/>

## Findings

Twenty-eight numbered decisions, then a full audit pass on top of them. The suite went from 289 tests to 328 in the process. A representative sample:

| ID | What happened |
|---|---|
| F-1 | `ElemId` ordered by a bare per-replica counter, so a replica joining an existing document placed its inserts in the wrong place. Convergence always held. Intention did not. Fixed with a Lamport clock in the id, one varint per op on the wire. |
| F-2 | Replaying a persisted log into a fresh `Doc` with the same replica id restarted the counter and reissued live ids, silently dropping edits after a reload. |
| F-6 | The reason F-1 and F-2 both hid: the suite asserted convergence and never intention, and never exercised editing after receiving. Both properties now exist, with a coverage proof. |
| F-8 | The 168 second cold-open. Every integration walked the tree to the root to keep size counters fresh, which is O(n²) on a forward-typed document. The counters are a cache nobody reads during replay, so they became lazy. Replay is now O(n). |
| F-4 | A disk-persisted document evicted from the relay's memory cache was served as empty and could desync on the next append. |
| 0026 | `encodeOps` crashed at 100,000 ops because `push(...records)` spreads an array into call arguments and V8 caps that. Same bug shape as an earlier stack overflow, different mechanism: an operation assumed to be linear turning out to have a hidden size cliff. |
| 0016 | An S4 property test partitioned replica names that `send()` never used, so the partition silently did nothing. Caught by a failing property, not by reading it. |
| 0008 | Two gate tests had been green since Step 0 and were both asserting the bug. A test written in the same session as its implementation can certify the implementation's own misconception. |

<details>
<summary><b>Still open, on purpose</b></summary>

<br/>

- The local build and interactive-editing path is still super-linear. The fix is a treap-backed Fugue, scoped as future work in `docs/02-ARCHITECTURE.md` §2.5, and unbuilt.
- No compaction or snapshotting. The op log grows forever, which is fine for a demo document and not fine for a real one.
- Wire size on forward typing, about 14x Yjs. The Lamport clock is already delta-encoded; insert-run compression, matching the encoding deletions already get, is the remaining lever.
- No authentication and no defence against a malicious peer. Out of scope by design, stated in `docs/03-SECURITY.md` §4.

</details>

<br/>

## Deliberate non-goals

Rich text beyond ProseMirror's basic schema. Authentication. Multi-document workspaces. Mobile apps. Operational transformation of any kind. Beating Yjs on benchmarks.

<br/>

## The documents

| File | What is in it |
|---|---|
| [`docs/01-PRD.md`](docs/01-PRD.md) | Product requirements and the twelve success criteria above |
| [`docs/02-ARCHITECTURE.md`](docs/02-ARCHITECTURE.md) | The CRDT algorithm, the wire encoding, the sync protocol |
| [`docs/03-SECURITY.md`](docs/03-SECURITY.md) | Threat model and the parts left out of it on purpose |
| [`docs/04-FRONTEND.md`](docs/04-FRONTEND.md) | The demo's interaction model |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Every non-obvious decision, in order, with the evidence that produced it |
| [`HANDOFF.md`](HANDOFF.md) | Where I would bet this breaks first once it is running in public |

<br/>

<div align="center">

MIT licensed. Built step by step, one finding at a time.

</div>
