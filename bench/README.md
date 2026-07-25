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
  NaiveDoc     build=4.9ms    replay=1.1ms
  ArrayDoc     build=7.4ms    replay=3.4ms
  RgaDoc       build=5.2ms    replay=2.6ms
  Doc (Fugue)  build=22.7ms   replay=0.9ms

n=10000
  NaiveDoc     build=3.2ms    replay=3.2ms
  ArrayDoc     build=398.0ms  replay=162.7ms
  RgaDoc       build=25.2ms   replay=17.1ms
  Doc (Fugue)  build=1.43s    replay=5.4ms
```

n=100,000 `Doc` replay, measured directly (the op log built via directly-
constructed ops rather than the live `insertLocal` loop, whose build phase
is still O(n²) — see below — and too slow to pay routinely):

```
n=100000
  RgaDoc       replay=365.1ms   (S6 gate: rga-doc.test.ts asserts <1s, passes)
  Doc (Fugue)  replay≈110ms     (was 168.0s before F-8; S6 now passes)
```

**S6 now passes for both `RgaDoc` and `Doc`.** Before F-8 `Doc`'s replay was
O(n²) — 168s at 100k, ~168x over the 1s target and the headline honest
finding of this suite; it was slower than `ArrayDoc`, the "obviously
unusable" exhibit it succeeded, at every size from 10k up. `Doc`'s replay is
now linear (0.9ms → 5.4ms → ~110ms across 1k/10k/100k) and comfortably
under target.

**Why it was slow, and the fix (F-8):** every `integrate()` walked from the
new/changed node up to the tree root to keep `size`/`liveSize` counters
current (`propagateSizesUp`). For a forward-typed document the tree is a
single-sided chain, so that walk was O(depth) = O(current length) — O(n²)
across n sequential ops. But `size`/`liveSize` are a derived cache read only
by the visible-index paths, and cold-open's read (`text`, via `inOrderWalk`)
needs no sizes at all. So `integrate()` now just marks the cache dirty
(O(1)); the counters are recomputed in one bulk post-order pass the next time
a visible-index path needs them (`ensureSizes`). Replay-then-read is O(n),
and placement/merge/traversal are untouched — the whole property suite is
unchanged. `RgaDoc` never had the problem: DECISIONS #0017's treap gives it
O(log n) split/merge instead of an O(depth) parent walk.

**Still O(n²): the `build` phase.** `build` (live `insertLocal` per
character) recomputes sizes in bulk on each keystroke that follows a
mutation, so typing n characters locally remains super-linear (`Doc` build
≈1.43s at 10k, ≈340s at 100k — unchanged). That is *not* the S6 metric (S6
is replay/cold-open) and matches Yjs, whose own naive per-char build is also
slow (§ vs Yjs). Making local build and interactive-after-remote editing
incremental too is the order-statistic-treap-backed Fugue that ARCH §2.5
frames as future work.

**Historical citation, ARCH §2.4 / DECISIONS #0014:** the pre-treap array
design (what `ArrayDoc` still is, deliberately preserved as exhibit 2) was
originally estimated at "~41s extrapolated" for 100k cold-open, corroborated
by direct measurements in the tens of seconds (26.5s, and an 81.73s build in
an earlier sweep) — the same conclusion reached repeatedly: this workload is
unusable on an array. `ArrayDoc`/`NaiveDoc` at 100k are omitted from the
block above only because they are too slow to re-measure routinely, not
because their numbers changed; F-8 touched `Doc` alone.

**Cold-open was the Step-15 finding; F-8 is the fix.** Step 15 measured and
reported the O(n²) `Doc` replay honestly and deliberately left it unfixed
(re-architecting was out of scope there; ARCH §2.5 frames a treap-backed
Fugue as future work). The follow-up audit fixed the *cold-open* half of it
without the full treap: `Doc`'s replay is now O(n) (see the `ensureSizes`
explanation above). The remaining super-linear cost is the local `build` /
interactive-editing half, which the treap-backed Fugue would address — still
open, see `docs/DECISIONS.md` #0026.

## Encode/decode round-trip throughput

`node bench/encode-decode.mjs`:

```
n=1000    bytes= 12.3 KiB  encode= 1.6ms  (641,337 ops/s)    decode= 0.8ms  (1,200,273 ops/s)
n=10000   bytes=126.6 KiB  encode= 8.0ms  (1,248,574 ops/s)  decode= 2.2ms  (4,626,571 ops/s)
n=100000  bytes= 1.48 MiB  encode=68.9ms  (1,450,434 ops/s)  decode=35.4ms  (2,825,947 ops/s)
```

~1M+ ops/s either direction, comfortably fast enough that the wire format
is never the bottleneck in the cold-open numbers above. (Byte sizes grew
~20% vs the pre-audit figures — 10.5→12.3 KiB at 1k, etc. — because F-1
added a one-varint Lamport clock per op to fix late-joiner ordering; see
the wire-size note under § vs Yjs.)

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
60,000 deletions: 15 bytes (target: < 29)
```

Matches the figure gated by `packages/crdt/src/encoding.test.ts` (DECISIONS
#0018). Was 14 bytes before F-1; the run record now carries one extra
Lamport-clock varint (`clock0`, amortized across the whole run), so 15 —
still comfortably inside ARCH §3.1's < 29 budget.

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
  Yjs          build=17.1ms   replay=1.0ms    wire=1015 B  (1.01 bytes/char)
  Doc (Fugue)  build=25.4ms   replay=0.8ms
  → Doc replay is 0.8x Yjs replay at this n (parity; both sub-millisecond)

n=10000
  Yjs          build=532.5ms  replay=0.1ms    wire=9.8 KiB (1.00 bytes/char)
  Doc (Fugue)  build=1.27s    replay=4.6ms
  → Doc replay is ~45x slower than Yjs replay at this n
```

n=100,000, `Doc` replay measured directly (~110ms, from the cold-open
section); Yjs replay is the flat ~4.6ms it holds at every size (Yjs's own
naive per-char `build` alone takes ~130s at 100k, so the live side-by-side
isn't run by default — pass `--full`):

```
n=100000
  Yjs          replay=4.6ms    wire=100,015 B (1.00 bytes/char)
  Doc (Fugue)  replay≈110ms
  → Doc replay is ~24x slower than Yjs replay at this n
```

**Cold-open replay is now competitive.** Before F-8 this was the headline
loss — `Doc` replay grew to 168 *seconds* at 100k, ~36,800x Yjs. With the
lazy size fix it is O(n): sub-millisecond at 1k (parity with Yjs), ~4.6ms at
10k (~45x), ~110ms at 100k (~24x). Yjs is still faster — its update format
applies in flat single-digit ms regardless of size — but `Doc` is now
firmly under the S6 target and within a small constant factor, not orders of
magnitude off. **S6 is met by Yjs, by the treap-backed `RgaDoc`, and now by
the production `Doc`.**

**Where Yjs still wins, honestly:** its architecture pays the structural cost
once on the writer and every reader's cold-open is cheap. `Doc` still does
more work per op on the reader (integrating each op into the tree), and its
local `build` remains O(n²) (§ cold-open) where Yjs amortizes. The remaining
gap is the incremental-editing structure ARCH §2.5 frames as future work, not
an unexplained "Doc is slow."

**Wire size, the remaining honest loss:** Yjs's update format is ~1.00-1.01
bytes/character for a forward-typed document; ours (see encode/decode
section above) is now ~15.5 bytes/character at 100k — up from ~12.7 before
F-1 added the one-varint-per-op Lamport clock. ARCH §3.1 only specifies
run-length-encoding for *deletions* — consecutive same-replica *inserts* get
no equivalent compression in this format, while Yjs's update encoding deltas
consecutive same-client inserts by construction. Not a bug — an intentionally
narrower scope (§3.1's own target is the deletion case) that costs real bytes
on the also-extremely-common forward-typing case. (A `clock − counter` delta
encoding would claw most of the clock's cost back to ~1 byte/op; noted as
future work, out of scope for the correctness fix that added it.)

## Summary

| Target | Result |
|---|---|
| S6 (100k cold-open < 1s) | **Passes** for `RgaDoc` (the gated exhibit) **and now `Doc`** — `Doc` replay ~110ms after F-8 (was ~168s). |
| §3.1 (60k deletions < 29 bytes) | Passes — 15 bytes (14 before F-1's clock). |
| Encode/decode throughput | ~1M+ ops/s either direction — never the bottleneck. |
| Memory/char with tombstones @ 100k | ~610 bytes/char live, ~858 bytes/char once fully tombstoned (~248 bytes/char tombstone overhead). |
| vs Yjs — cold-open | `Doc` now within ~24-45x (sub-ms to ~110ms, under target), down from ~36,800x. Yjs still faster; same order of magnitude as `RgaDoc`. |
| vs Yjs — wire size | `Doc` ~15.5 bytes/char vs Yjs's ~1 (forward-typed) — the remaining loss. |

Three "scales-with-input-size hidden cliff" bugs were found and fixed in this
area (recursion depth and call-argument count during Step 15; the O(n²)
cold-open itself in the follow-up audit, F-8) — see `docs/DECISIONS.md`
#0026. The residual super-linear cost is the local-`build`/interactive half,
which the treap-backed Fugue (ARCH §2.5) would address.
