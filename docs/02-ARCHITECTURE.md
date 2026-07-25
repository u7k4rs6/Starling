# Starling: Technical Architecture

**Companion to:** [`01-PRD.md`](01-PRD.md)

How Starling is put together: the package graph and the boundaries that CI enforces, the CRDT core (identity, order, merge), the wire format, the deterministic simulator, the relay, the provider, anchors and awareness, and the editor binding.

---

## 1. Package graph

```
packages/
  crdt/       the algorithm. zero deps, no DOM, no ambient clock.
  sim/        deterministic network simulator. test-only.
  relay/      append-only log server. zero CRDT code.
  provider/   client glue: persistence, reconnect, sync loop.
  editor/     ProseMirror binding + undo. headless, node-testable.
  demo/       React app. the only package allowed to touch a browser.
```

Dependencies flow strictly downward: `demo → editor → provider → crdt`, `sim → crdt`, and `relay → nothing`.

**Two CI gates enforce this, and both fail the build rather than warn:**

1. **Core isolation**, enforced two ways:
   - **Structurally, by the compiler.** `packages/crdt`'s `tsconfig.json` sets `"lib": ["ES2022"]` and `"types": []`. With no DOM lib and no ambient `@types/node`, referencing `window`, `document`, `fetch`, `localStorage`, `process`, `Buffer`, or `setTimeout` is a type error, not a style violation — the gate needs no maintenance as new banned names appear, because there is no lib declaring them to reference. Test files are exempt via their own permissive `tsconfig.test.json`: a test is allowed to construct a scenario with real time or real randomness; only the implementation under test is not.
   - **By grep, for what typechecking cannot catch.** `packages/crdt` has empty `dependencies`, `peerDependencies`, and `optionalDependencies` (an optional dependency still ships to consumers). No source file calls `Date.now()` / `new Date(` / `Math.random()` / `performance.now()` / `crypto.randomUUID()` / `crypto.getRandomValues()` / `setTimeout()` / `setInterval()` / `fetch()` / `WebSocket` / `process.hrtime()` / `process.uptime()` / `requestAnimationFrame()`, and references neither `self` / `globalThis` (both banned as indirection — `globalThis.crypto.randomUUID()` reaches the same nondeterminism through a property access no single-symbol grep would catch) nor any DOM global. Time and randomness are injected — `ReplicaId` included: the core never generates one, it is passed in at construction. A CRDT that reads an ambient clock, schedules against real time, or mints its own randomness cannot be tested deterministically, and the simulator in §4 depends on this absolutely.
2. **Relay ignorance.** `packages/relay` contains no import from `packages/crdt` and no occurrence of `ElemId`, `Fugue`, `tombstone`, `originLeft`, `originRight`, or `compareElemIds`. The relay must not know what it is relaying (see §5).

---

## 2. The core: identity, order, merge

### 2.1 Element identity

```ts
type ReplicaId = string;                            // random, assigned at replica creation
type ElemRef = { replica: ReplicaId; counter: number };          // identity only
type ElemId = ElemRef & { clock: number };                       // identity + causal order
```

Every character ever inserted gets an `ElemId` that is globally unique and **never reused**. Position is not identity, and index is not identity: a character that moves because someone typed above it is the same character.

The `counter` is a per-replica sequence number — dense and contiguous, which is what makes state-vector sync exact (§3.2). The `clock` is a Lamport timestamp, and it exists for a reason worth spelling out, because the design initially concluded it was unnecessary.

An early exhaustive search — every origin forest on up to six elements, every causal delivery order, 16,807 forests at n=6 — established that RGA **converges under any total order on identifiers at all**, with or without causal monotonicity. Convergence never needed a Lamport clock. For a while the id was just `(replica, counter)`.

That was correct about *convergence* and wrong about *intention*. Ordering by the bare counter meant a replica joining an existing document allocated low counters that sorted beneath content already there, so its inserts landed in the wrong place — every replica agreed, on the wrong answer. The fix (finding F-1) was to add the Lamport `clock` and order by it, so an op created after seeing another element always sorts above it. Identity stayed `(replica, counter)` — split out as `ElemRef`, used for every lookup and for sync — while ordering moved to the clock. `compareElemIds` compares `clock` first, then breaks genuine concurrency (equal clocks) on `replica`. The counter stays contiguous, so §3.2's sync argument still holds; that is exactly why identity and ordering are separate fields.

### 2.2 The abstract `Sequence`

All four document classes inherit one base that owns id allocation, the per-replica counter and Lamport clock, causal buffering of out-of-order ops, idempotence (applying the same op twice is a no-op), and the local editing API. Subclasses override exactly one method: `integrate(op)` — the merge rule and nothing else.

The consequence is that `RgaDoc` and `Doc` differ by roughly one `while` loop. That is deliberate: the museum only teaches if the delta is small enough to read.

`NaiveDoc` sits on this base too. Once it does, it has a real `ElemId` per character, idempotence, and causal delivery — everything `ArrayDoc` has — and it *still* diverges, because its `integrate(op)` places by raw index and ignores the id. That is the sharpest demonstration in the repository that identity and a correct merge rule are two separate things: having identity is not the same as a merge rule that uses it (the two-beat lesson in [PRD §4](01-PRD.md)).

### 2.3 Fugue, and why not RGA

**RGA's merge rule** is four lines — insert after your origin, then skip forward past any concurrent elements with a higher-precedence id:

```ts
protected override integrate(op: InsertOp): void {
  let at = op.l === null ? 0 : this.indexOf(op.l) + 1;
  while (at < this.elems.length && compareElemIds(this.elems[at]!.id, op.id) > 0) at += 1;
  this.place(at, op);
}
```

It converges. It is also **wrong in a way users can see.**

**The backward-typing anomaly.** Two people each type a word backwards — each new character inserted to the *left* of the previous one, which is what happens when you type into the start of a line, or paste-and-fix. Under RGA the two words **interleave**, character by character, into an unreadable mess. Both replicas agree on the mess, so convergence tests pass and the bug ships. Convergence is not correctness; agreeing on garbage is still agreeing.

**Fugue** fixes this by tracking, for each element, whether it was inserted to the left or right of its origin, and keeping same-side siblings grouped, so concurrent runs stay contiguous instead of shuffling. `RgaDoc` is kept as exhibit 3, with a test that pins the interleaved output as a literal string — because fixing that file would delete the evidence.

### 2.4 Deletion is a tombstone

Deleted characters are marked, never removed. The `ElemId` stays resolvable forever, because a concurrent op may reference it as an origin and an anchor may point at it.

Two indices therefore coexist, and confusing them is the most likely bug in this codebase:

- **Internal index** — position among all elements, tombstones included.
- **Visible index** — position among live elements only, which is what the user and ProseMirror see.

The mapping between them is not free, which is what forces §2.5.

`del(id)` is **idempotent and commutative for free**, because two replicas deleting the same character emit the *same operation*. "Deleted" is a monotone fact, not a value — and that property is load-bearing for §3.1.

**So revive is not a thing.** The inverse of `del(id)` is not reviving that id; it is inserting a **new** character immediately before the tombstone, which is still sitting exactly where the old one was: `insertBefore(id, char)`. An earlier design proposed a last-write-wins register per element to make revive work, and it was wrong: an LWW register would preserve identity, but it would cost the run-length-encoded delete set (§3.1: tens of thousands of deletions in a handful of bytes, which works *only* because "deleted" is monotone) and the free commutativity above. Position is restored perfectly either way; identity is not, so a comment anchored to revived text does not come back. Yjs makes the same trade.

### 2.5 The order-statistic treap

The sequence is not stored in a plain array. An array gives O(n) `indexOf` for origin lookup and O(n) splice per insert, and since cold-open replays the whole op log every time anyone opens the document, that O(n)-per-op cost compounds into an unusable open time at scale (`ArrayDoc` demonstrates it).

`RgaDoc` uses an **order-statistic treap** instead:

- **Hashed priorities.** Priority is `hash(ElemId)`, not `Math.random()` — required, not stylistic: it keeps the core deterministic (§1) and makes the tree shape identical on every replica, so divergence bugs reproduce.
- **Parent pointers**, to walk upward from a node and compute its index without a root-down search.
- **Subtree size counts**, maintained on rotation, giving O(log n) `indexOf` and index-to-node — with two counts per node, total subtree size and *live* subtree size, the live count being what makes the visible↔internal mapping O(log n).

`Doc` (Fugue) is a tree of same-side sibling buckets rather than a treap. It meets the S6 cold-open target (100k under 1s) by maintaining its size counters lazily — recomputing them in one bulk pass only when a visible-index query needs them, rather than walking to the root on every op (finding F-8). Giving Fugue the full order-statistic-treap structure `RgaDoc` already has, so that local editing is incremental too, is scoped as future work.

---

## 3. Wire format

### 3.1 Binary encoding

The wire format is binary, not JSON — and not only for performance: designing it is what surfaced the identity/ordering split in §2.1.

- **LEB128 varints** for all integers. Counters are small and dense and should cost one byte.
- **Replica tables.** A document has few replicas and many ops, so `ReplicaId` strings are interned into a per-message table and referenced by index.
- **Run-length-encoded deletions.** Deletions cluster: a user selects a paragraph and hits delete, producing thousands of contiguous ids from one replica with consecutive counters. RLE collapses this — 60,000 deletions encode in 15 bytes, against a 29-byte budget.

This compression is what would die if §2.4's monotone-fact property were traded away. The encoding and the algebra are coupled. (The Lamport clock from §2.1 is stored as `clock − counter`, a value that stays ~1 byte for a mostly-solo replica no matter how old the document gets, rather than widening with the absolute clock.)

### 3.2 State-vector sync

A **state vector** is `Map<ReplicaId, highestContiguousCounter>`. It summarizes everything a replica has, in bytes proportional to the number of replicas, not the number of ops. Sync is: send your vector, receive everything you are missing — `doc.missingFrom(theirVector) → ops`.

This requires **contiguous counters**. If replica A's counters are 1, 2, 3, 7, 9 then "I have up to 9" is a lie and "I have up to 3" is wasteful; contiguity makes the vector exact. Ordering by a Lamport clock would break contiguity, since a Lamport value jumps forward on receipt of remote ops — which is exactly why identity (`counter`, contiguous) and ordering (`clock`, causal) are kept as separate fields on the id (§2.1). Sync reads the counter and stays exact; placement reads the clock and stays causal.

---

## 4. The simulator

`packages/sim` is how S3 and S4 are verified. It is test-only and never shipped. Three parts:

1. **Seeded RNG.** Every run is reproducible from a seed; on failure the seed is printed, and it goes into the bug report and the regression test.
2. **Virtual clock.** No `setTimeout`, no real time — time advances because the test says so. This is why the core-isolation gate (§1) exists.
3. **Delivery queue.** Holds in-flight messages and delivers them in an RNG-chosen order, tie-broken on a stable sequence number rather than on collection iteration order, so the simulator itself is deterministic.

The simulator can drop messages, duplicate them, reorder arbitrarily, partition the network into groups, and heal partitions. Convergence assertions run after healing and after quiescence.

---

## 5. The relay

An **append-only log with a cursor**. That is the entire design.

```
POST /doc/:id          append opaque bytes, return offset
GET  /doc/:id?from=N    return bytes from offset N to the current end
```

The relay does not parse ops. It does not merge, validate, or know what a CRDT is. It appends bytes and hands back bytes from an offset.

This is enforced by CI (§1) because it is the single most valuable structural claim the project makes: **the server is dumb, so the server cannot be the authority, so there is no authority.** Every time a little validation creeps into a relay, the system quietly becomes client-server and the whole argument collapses.

Storage is an in-memory log with append-to-disk and replay on boot — no database. (Because the log is durable on disk, the in-memory copy is a bounded cache over it: an evicted document is re-hydrated from disk on the next access rather than served as empty — finding F-4.)

---

## 6. The provider

Client-side glue: it owns the transport, the local persistence, and the sync loop. The design decision worth preserving is that **there is no offline queue.**

The instinct is to buffer unsent ops in a queue while disconnected and flush on reconnect. That queue is a second source of truth, it can disagree with the document, and reconciling it is a bug farm. It is also unnecessary — the document already knows what it has, and the state vector already knows what the server has, so the entire offline story is:

```ts
const missing = doc.missingFrom(lastPushedVector);
```

Reconnect, ask the relay for its cursor, compute the delta, push. Disconnection is not a special state; it is a long gap between syncs. Local persistence is IndexedDB, holding the encoded op log plus the last-pushed vector, and reload replays it. (The sync loop serializes its runs so overlapping calls cannot corrupt the read cursor, and tolerates a torn or malformed relay tail instead of wedging on it — finding F-5.)

---

## 7. Anchors and awareness

Two different lifetimes, and conflating them is a design error.

**Anchors are permanent.** A cursor is not an index; it is an `ElemId` plus a side (before or after that character). When a remote user inserts text above your cursor, your cursor does not move, because it was never at a number — it was pointing at a character, and that character has not moved either. This is S10, and it is what makes collaborative editing feel non-hostile. Anchors survive tombstoning: the anchored character can be deleted and the anchor still resolves, because the tombstone is still there holding the position.

**Awareness is ephemeral.** Presence — who is here, where their cursor is, what color they are — is last-write-wins per replica, with a TTL, and is never persisted and never written to the op log. A user who closes their laptop should evaporate, not leave a ghost in the document forever. Awareness travels over the same relay on a separate channel, and the relay still does not know what it means.

---

## 8. Editor binding and undo

**The binding is headless and testable in node.** ProseMirror's model layer needs no browser; only its view layer does. The binding targets the model, so the whole of `packages/editor` is testable in Vitest with no jsdom — which matters because the interesting bugs in a collaborative editor are concurrency bugs, and the simulator that provokes them runs in node.

The binding maps ProseMirror transactions to CRDT ops and CRDT changes back to ProseMirror steps, using visible indices at the boundary and `ElemId`s everywhere inside.

**Undo transforms nothing** — and this is the punchline of the whole project. Operational transformation exists, in large part, to make undo work under concurrency: the inverse operation has to be transformed against everything that happened since, or it undoes the wrong thing. With a CRDT, undo of "insert x" is "delete the element with *this id*". That id is still that id, regardless of what happened in between, who else typed, or how the indices moved. There is nothing to transform: the undo manager keeps a stack of `ElemId`s and inverse ops and applies them directly. Undo of a delete is `insertBefore(tombstoneId, char)`, not a revive (§2.4). Undo is per-replica — it pulls back *your* last edit, not the last edit globally — which falls out of the id-based design for free and is the correct behavior anyway. `prosemirror-history` is deliberately not used: it is an OT-shaped undo built for a world where positions move, and wiring it in would import the exact problem this project exists to demonstrate the absence of.

---

## 9. Benchmarks

Committed, reproducible numbers live in [`bench/README.md`](../bench/README.md), honest ones included:

- Cold-open at 1k / 10k / 100k characters, against the < 1s-at-100k target (S6), with the pre-fix numbers kept for comparison.
- Encode/decode round-trip throughput.
- The 60k-deletions RLE assertion (§3.1).
- Memory per character, with tombstones, at 100k.
- **A comparison against Yjs on the same workloads.** Yjs wins on cold-open replay and on wire size; the numbers are reported anyway, because an honest loss against a mature library is more credible than a suspicious win.
