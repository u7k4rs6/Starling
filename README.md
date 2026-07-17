# Starling

A real-time collaborative text editor built on CRDTs, from scratch, in
TypeScript. Two or more people type into the same document at the same
time, from different machines, possibly while disconnected, and the
document converges to the same state everywhere — no coordinating
server resolving conflicts.

This is a portfolio artifact, not a product. Its value is in the parts
that are hard: convergence under concurrency, verified rather than
asserted, and a repo that **shows its own failures** — the naive
implementation that diverges, the algorithm that interleaves wrong, the
data structure that takes minutes to open a document that should open
in under a second. Each is preserved, each has a test that documents its
bug, and `docs/DECISIONS.md` is a running, numbered log of every one of
those findings — including the ones that didn't get fixed, and why.

Full spec: [`docs/01-PRD.md`](docs/01-PRD.md) (product requirements),
[`docs/02-ARCHITECTURE.md`](docs/02-ARCHITECTURE.md) (the CRDT algorithm,
encoding, sync protocol), [`docs/03-SECURITY.md`](docs/03-SECURITY.md),
[`docs/04-FRONTEND.md`](docs/04-FRONTEND.md). Every non-obvious decision
made while building it, in order, with the evidence that produced it:
[`docs/DECISIONS.md`](docs/DECISIONS.md).

## What's here

| Package | What it is |
|---|---|
| [`packages/crdt`](packages/crdt) | The CRDT core. Published to npm as [`starling-crdt`](https://www.npmjs.com/package/starling-crdt). No dependencies, no DOM, no ambient clock (enforced by a CI gate). `Doc` (Fugue) is the one to use; `RgaDoc`, `ArrayDoc`, `NaiveDoc` are preserved reference implementations — a museum of what didn't work or doesn't scale, benchmarked honestly alongside it. |
| `packages/editor` | ProseMirror binding: CRDT ops ↔ PM transactions/steps, an undo manager with no OT and no `prosemirror-history`. |
| `packages/provider` | Local persistence (IndexedDB), the relay transport, the sync loop, presence/awareness. |
| `packages/relay` | An append-only log with a byte cursor. Contains zero CRDT code (enforced by a CI gate) — it doesn't know what a character, a tombstone, or an ElemId is. |
| `packages/demo` | Two editor panes side by side, connection toggles, remote cursors, offline mode. |
| `packages/sim` | A deterministic simulator (seeded RNG, virtual clock, delivery queue with drops/duplicates/partitions) that convergence property tests run against. |
| [`bench/`](bench) | Committed, reproducible benchmark numbers — cold-open latency, memory, wire size, a head-to-head against Yjs. Honest about the losses. |

## Quickstart

```
pnpm install
pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run gates
```

Run the demo locally (two browser tabs, same document, edit concurrently):

```
pnpm --filter @starling/demo run dev:relay   # terminal 1
pnpm --filter @starling/demo run dev         # terminal 2
```

Use just the CRDT core:

```
npm install starling-crdt
```

See [`packages/crdt/README.md`](packages/crdt/README.md) for usage.

## Success criteria

Every claim below is independently checkable — that's the point. Status
reported the same way the rest of this repo reports a benchmark: plainly,
including where it falls short.

| # | Criterion | Status |
|---|---|---|
| S1 | Two replicas editing concurrently always converge | ✅ `fast-check`, 1000 runs |
| S2 | Three replicas editing concurrently always converge | ✅ `fast-check`, 500 runs |
| S3 | Convergence holds under arbitrary delivery order | ✅ `packages/sim`, seeded RNG |
| S4 | Convergence holds under partition and rejoin | ✅ `packages/sim` |
| S5 | No interleaving on concurrent backward typing | ✅ Fugue-specific regression test |
| S6 | 100k-character document cold-opens in < 1s | ⚠️ Passes for `RgaDoc` (412ms). **Fails for `Doc`**, the production class — 168s, ~168x over target. Not fixed; see `bench/README.md` and DECISIONS #0026. |
| S7 | The relay contains zero CRDT code | ✅ CI gate, fails the build otherwise |
| S8 | The core package has no dependencies, no DOM, no ambient clock | ✅ CI gate, fails the build otherwise |
| S9 | Offline edits survive reload and reconcile on reconnect | ✅ Integration test. Demonstrable locally; not currently live at a public URL — see `docs/DEPLOY.md` and DECISIONS #0027. |
| S10 | Cursors survive remote edits above them | ✅ Anchor test |
| S11 | Undo is correct under concurrency | ✅ Undo test |
| S12 | `npm install starling-crdt` gives a working CRDT | ⚠️ Publish dry-run passes (`packages/crdt`, v0.1.0-ready). Real publish blocked on npm credentials this environment doesn't have — see DECISIONS #0027. |

**Non-goals, explicitly:** rich text beyond ProseMirror's basic schema,
authentication, multi-document workspaces, mobile apps, operational
transformation of any kind, beating Yjs on benchmarks.

## License

MIT — see [`LICENSE`](LICENSE).
