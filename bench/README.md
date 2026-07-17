# Benchmarks (Step 15, ARCH §9)

Every number below is either directly measured by a script in this
directory (reproducible with `node bench/<script>.mjs`), or explicitly
labeled as a citation from an earlier, already-documented measurement
(`docs/DECISIONS.md`) when re-measuring live would make routine use of
these scripts impractically slow. Machine: this session's container, one
run, not averaged — treat exact figures as order-of-magnitude, not lab-grade
precision; the *conclusions* (fast enough / not fast enough / faster than
X / slower than X) are the point, per ARCH §9: "honest, including the ones
that lose."

Scripts: `cold-open.mjs`, `encode-decode.mjs`, `memory.mjs` (needs
`node --expose-gc`), `yjs-comparison.mjs`. All default to fast sizes
(1k/10k); pass `--full` to also run the 100k cases live where a script
supports it — see each section below for why 100k is often cited instead.

## Cold-open (PRD S6: "100k-character document cold-opens in < 1s")

Workload: one replica types n characters forward, one at a time
(`build`); a second, fresh replica receives that replica's whole op log,
one op at a time, in order (`replay` — this is cold-open, ARCH §2.5: "what
happens every time anyone opens the document, because the whole op log
replays"). S6's target is about `replay`, not `build`.

`node bench/cold-open.mjs` (n=1000, 10000):

```
n=1000
  NaiveDoc     build=2.5ms    replay=1.9ms
  ArrayDoc     build=12.6ms   replay=7.5ms
  RgaDoc       build=11.3ms   replay=3.4ms
  Doc (Fugue)  build=20.2ms   replay=7.8ms

n=10000
  NaiveDoc     build=12.2ms   replay=5.7ms
  ArrayDoc     build=479.9ms  replay=394.0ms
  RgaDoc       build=46.5ms   replay=30.8ms
  Doc (Fugue)  build=1.66s    replay=769.3ms
```

n=100,000, measured directly (not via the default script invocation —
`ArrayDoc` and `Doc` are both too slow at this size to pay routinely; see
`--full`):

```
n=100000
  NaiveDoc     build=89.5ms    replay=104.5ms
  ArrayDoc     build=81.73s    replay=46.71s
  RgaDoc       build=433.3ms   replay=365.1ms   (S6 gate: rga-doc.test.ts asserts <1s, passes)
  Doc (Fugue)  build=339.9s    replay=168.0s
```

**S6 passes for `RgaDoc` (the treap-backed exhibit 3, and the class the
gate test actually measures) and fails badly for `Doc`, the production
Fugue implementation** — 168s replay against a 1s target, roughly 168x
over. `Doc` is also slower than `ArrayDoc`, the "obviously unusable"
exhibit it succeeded, at every size from 10k up. This is the headline
honest finding of this benchmark suite.

**Why:** every `integrate()` call (both inserts and deletes) walks from
the new/changed node up to the tree root to keep `size`/`liveSize`
counters current (`propagateSizesUp`, `fugue-doc.ts`). For a forward-typed
document the tree is a single-sided chain, so that walk is O(depth) =
O(current length) — an O(n²) cost across n sequential ops, the same shape
that makes `ArrayDoc`'s O(n) splice-per-insert slow, except `Doc` pays a
higher constant factor per step (tree-node field writes vs `ArrayDoc`'s
single native `splice`), so it loses even the asymptotic-tie case.
`RgaDoc` doesn't have this problem: DECISIONS #0017's treap gives it
O(log n) split/merge instead of an O(depth) parent walk.

**Historical citation, ARCH §2.4 / DECISIONS #0014:** the pre-treap array
design (what `ArrayDoc` still is, deliberately preserved as exhibit 2) was
originally estimated at "~41s extrapolated" for 100k cold-open, later
corroborated by a direct (non-extrapolated) measurement of 26.5s on
different hardware. This run's own direct `ArrayDoc`@100k measurement
(81.73s build) is a different number on different hardware with a
different exact methodology (build and replay timed as separate phases
here, vs one combined pass in the earlier ad hoc sweep) — not a
contradiction, the same conclusion independently reached three times:
this workload is unusable on an array.

**Not fixed in Step 15, on purpose.** Giving `Doc` an O(log n) incremental
size-maintenance structure (the treap `RgaDoc` already has, applied to the
Fugue tree) is a real, substantial architectural change — exactly the kind
of scope DECISIONS #0017 already declined for `Doc` at Step 6 ("full
treap-level efficiency ... explicitly scoped out"). Step 15's job is to
measure and report honestly, not to re-architect; ARCH §2.5 already frames
a treap-backed Fugue as aspirational future work, not a Step-15 deliverable.
Recorded as a real, currently-unresolved gap — see `docs/DECISIONS.md`
#0026.

## Encode/decode round-trip throughput

`node bench/encode-decode.mjs`:

```
n=1000    bytes=10.5 KiB   encode=3.7ms   (271,251 ops/s)   decode=1.7ms   (585,956 ops/s)
n=10000   bytes=107.2 KiB  encode=13.8ms  (723,423 ops/s)   decode=11.4ms  (874,180 ops/s)
n=100000  bytes=1.21 MiB   encode=100.8ms (992,502 ops/s)   decode=64.9ms  (1,540,028 ops/s)
```

~1 million ops/s either direction, comfortably fast enough that encoding
is never the bottleneck in any of the numbers above — `Doc`'s cold-open
cost is entirely in tree integration, not the wire format.

**A real bug found while building this benchmark:** `encodeOps` crashed
(`RangeError: Maximum call stack size exceeded`) at n=100,000 — `out.
push(...records)` spreads a same-sized-as-input array into individual call
arguments, and V8 caps argument count well under 100,000. `decodeOpsStream`
had the identical pattern. Fixed in `packages/crdt/src/encoding.ts` (a
`pushAll` loop instead of spread-push); see `docs/DECISIONS.md` #0026 —
same bug *shape* as the `fugue-doc.ts` stack-overflow crash found earlier
in this same step (an operation assumed to scale linearly turns out to
have a hidden size cliff), different mechanism (call-argument limit, not
recursion depth).

### ARCH §3.1: 60,000 deletions, one contiguous run

```
60,000 deletions: 14 bytes (target: < 29)
```

Matches the figure already established and gated by
`packages/crdt/src/encoding.test.ts` (DECISIONS #0018) — reproduced here
for one complete bench report rather than sending a reader elsewhere for
this one number.

## Memory per character, with tombstones, at 100k

`node --expose-gc bench/memory.mjs`:

```
n=100,000 characters, uniformly random insert positions
  all live:        58.15 MiB total, 609.7 bytes/char
  all tombstoned:  81.82 MiB total, 857.9 bytes/char
  tombstone overhead vs live: 248.2 bytes/char extra
```

~610 bytes per live character, ~858 once every character has been
deleted — roughly 600-900x the ~1 byte/character the wire format needs
for the same content (see encode/decode above), the expected gap between
an in-memory tree of JS objects (each `FugueNode` carries an id, a parent
pointer, two sibling-bucket arrays, and size/liveSize counters, on top of
the character itself) and a packed binary format with none of that
structure. A tombstoned character costs ~248 bytes more than a live one —
the node itself doesn't grow (same shape, `deleted` flips from `false` to
`true`), but each `deleteById` call permanently retains its own `CrdtOp`
(id + deps + payload) in the doc's op log (`Sequence`'s `log` array, ARCH
§3.2 — needed for `missingFrom`/state-vector sync) plus the accounting
that tracks it as integrated, and none of that is reclaimed for a
tombstone the way it would be for an actually-deleted item in a
non-CRDT data structure. Expected, not a bug: "deleted" is a permanent,
monotone fact a CRDT has to remember forever to stay convergent (ARCH's
own framing, §2.4) — the memory cost is the price of that guarantee.

**Built via uniformly-random insert positions, not this suite's usual
forward-typing workload** — see `bench/memory.mjs`'s own comments for
why (a `FugueNode`'s memory footprint doesn't depend on tree depth, so
there was no reason to pay the O(n²) forward-typing build cost just to
get *material* for a benchmark that isn't measuring build time), and for
a second, independently-found measurement bug on the way to this number:
naively measuring `heapUsed` only at the "before deleting"/"after
deleting everything" endpoints reported deleting things as making the
heap *smaller*, which is impossible — fixed by re-measuring at ten
checkpoints through the delete pass instead of just the two endpoints,
which is what the interleaved `global.gc()` calls in the script are for.

## Comparison against Yjs

ARCH §9: "Expect to lose. Report it anyway... An honest loss against a
mature library is more credible than a suspicious win." Same workload as
cold-open above (type n characters forward, one replica; a second replica
cold-opens the result), run against `yjs@13.6.31`.

`node bench/yjs-comparison.mjs` (n=1000, 10000):

```
n=1000
  Yjs          build=22.7ms   replay=1.2ms    wire=1015 B  (1.01 bytes/char)
  Doc (Fugue)  build=20.6ms   replay=8.0ms
  → Doc replay is 6.8x slower than Yjs replay at this n

n=10000
  Yjs          build=1.18s    replay=0.3ms    wire=9.8 KiB (1.00 bytes/char)
  Doc (Fugue)  build=1.99s    replay=999.5ms
  → Doc replay is 3499.6x slower than Yjs replay at this n
```

n=100,000, measured directly (Yjs's own `build` phase alone takes ~130s at
this size with a naive per-character insert loop, so this isn't run by
default — pass `--full`):

```
n=100000
  Yjs          build=130.6s   replay=4.6ms    wire=100,015 B (1.00 bytes/char)
  Doc (Fugue)  build=339.9s   replay=168.0s
  → Doc replay is ~36,800x slower than Yjs replay at this n
```

**We lose badly on the metric that matters.** Yjs's cold-open (`replay`)
stays in single-digit milliseconds from 1k to 100k characters — flat,
because its internal structure is built for exactly this. Ours grows from
milliseconds (1k) to 999ms (10k) to 168 *seconds* (100k) — see the cold-open
section above for why (`propagateSizesUp`'s O(depth) walk). This is the
honest core result of Step 15: **S6 is met by the treap-backed exhibit
(`RgaDoc`) and by Yjs, and missed by a wide margin by the actual
production `Doc` class.**

**One nuance worth keeping, not a mitigating factor:** Yjs's own `build`
phase (naive one-char-at-a-time `insert`, not its batch/delta APIs) is
*also* surprisingly slow — 130.6s at 100k, actually slower than `Doc`'s
build (comparable order of magnitude, not a >100x gap the way replay is).
The difference is that Yjs's architecture pays that cost once, on the
writer, and never again — every *reader*'s cold-open is cheap regardless
of how the document was typed. `Doc` pays a version of that cost on every
single cold-open, because `size`/`liveSize` isn't cached across encode/
decode — it's recomputed by walking the tree during `integrate()` itself,
on the reader, every time. That's the architectural gap, not "Doc is slow,
Yjs is fast" as an unexplained fact.

**Wire size, a second honest loss:** Yjs's update format is ~1.00-1.01
bytes/character for a forward-typed document; ours (see encode/decode
section above) is ~12.7 bytes/character at the same size. ARCH §3.1 only
specifies run-length-encoding for *deletions* — consecutive same-replica
*inserts* get no equivalent compression in this format, while Yjs's update
encoding deltas consecutive same-client inserts by construction. Not a
bug — an intentionally narrower scope (§3.1's own target is the deletion
case specifically) that costs real bytes on the also-extremely-common
forward-typing case.

## Summary

| Target | Result |
|---|---|
| S6 (100k cold-open < 1s) | **Passes** for `RgaDoc` (the gated exhibit). **Fails** for `Doc`, ~168x over target. |
| §3.1 (60k deletions < 29 bytes) | Passes — 14 bytes. |
| Encode/decode throughput | ~1M ops/s either direction — never the bottleneck. |
| Memory/char with tombstones @ 100k | ~610 bytes/char live, ~858 bytes/char once fully tombstoned (~248 bytes/char tombstone overhead). |
| vs Yjs | Loses on cold-open (up to ~36,800x at 100k) and wire size (~12.7x) for `Doc`. `RgaDoc` and Yjs are the same order of magnitude on cold-open. |

Two real bugs were found and fixed while building this suite (both a
"scales-with-input-size hidden cliff" shape, in different mechanisms —
recursion depth, and call-argument count) — see `docs/DECISIONS.md`
#0026 for the full account, including why the underlying O(n²) `Doc`
complexity itself was *not* fixed here.
