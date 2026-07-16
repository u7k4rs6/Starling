# Starling: Technical Architecture

**Companion to:** `01-PRD.md`
**Audience:** an implementing agent with no repo access and no memory of the prior build

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

Dependency direction is strictly downward: `demo → editor → provider → crdt`, and `sim → crdt`, and `relay → nothing`.

**Two CI gates enforce this and both must fail the build, not warn:**

1. **Core isolation.** `packages/crdt` has an empty `dependencies` block, imports no DOM globals, and calls no `Date.now()` / `new Date(` / `Math.random()` / `performance.now()` / `crypto.randomUUID()` / `crypto.getRandomValues()`. Time and randomness are injected — `ReplicaId` included: the core never generates one, it is passed in at construction. A CRDT that reads an ambient clock or mints its own randomness cannot be tested deterministically, and the sim in §4 depends on this absolutely. (`docs/DECISIONS.md` #0001 — the original list missed `new Date(` and both `crypto` calls; the `crypto` gap was the one that mattered, since `ReplicaId` is exactly the kind of value a first draft would reach for `crypto.randomUUID()` to generate.)
2. **Relay ignorance.** `packages/relay` contains no import from `packages/crdt` and no occurrence of the strings `ElemId`, `Fugue`, `tombstone`, `originLeft`, `originRight`, `compareElemIds`. The relay must not know what it is relaying. See §5. (`docs/DECISIONS.md` #0002 — the original list banned the bare word `origin`, which collides with the legitimate `req.headers.origin` CORS check required by §2.3 of the security doc.)

---

## 2. The core: identity, order, merge

### 2.1 Element identity

```ts
type ReplicaId = string;              // random, assigned at replica creation
type ElemId = { replica: ReplicaId; counter: number };
```

Every character ever inserted gets an `ElemId` that is globally unique and **never reused**. Position is not identity. Index is not identity. A character that moves because someone typed above it is the same character.

`compareElemIds(a, b)` is a **total order** over all ids: compare `counter`, tiebreak on `replica` lexicographically. Total, deterministic, and computable by any replica without coordination.

**Finding from the prior build, reproduce it, do not skip it.** Before implementing the merge rule, run an exhaustive search: every origin forest on up to six elements, every causal delivery order. The prior build did this and got a result that contradicted its own architecture doc.

> RGA converges under **any** total order on identifiers at all. Zero divergence across all 16,807 forests at n=6, with or without causal monotonicity.

The counter is therefore **not a Lamport clock and does not need to be**. Convergence does not depend on the clock. This matters later (§3.2), where sync wants contiguous counters and a Lamport clock would forbid them. Because convergence never needed the clock, sync wins that argument for free. Write this finding into `docs/DECISIONS.md`.

### 2.2 The abstract `Sequence`

All four document classes (§4 of PRD) inherit one base that owns: id allocation, the counter, causal buffering of out-of-order ops, idempotence (applying the same op twice is a no-op), and the local editing API.

Subclasses override exactly one method: `integrate(op)`. That is the merge rule and nothing else.

The consequence is that `RgaDoc` and `Doc` differ by roughly one `while` loop. This is deliberate and is a deliverable: the museum only teaches if the delta is small enough to read.

### 2.3 Fugue, and why not RGA

**RGA's merge rule** is four lines. Insert after your origin, then skip forward past any concurrent elements with a higher-precedence id:

```ts
protected override integrate(op: InsertOp): void {
  let at = op.l === null ? 0 : this.indexOf(op.l) + 1;
  while (at < this.elems.length && compareElemIds(this.elems[at]!.id, op.id) > 0) at += 1;
  this.place(at, op);
}
```

It converges. It is also **wrong in a way users can see.**

**The backward-typing anomaly.** Two people each type a word backwards (each new character inserted to the *left* of the previous one, which is what happens when you type into the start of a line, or when a user pastes-and-fixes). Under RGA, the two words **interleave**, character by character, into an unreadable mess. Both replicas agree on the mess, so convergence tests pass and the bug ships.

Convergence is not correctness. Agreeing on garbage is still agreeing.

**Fugue** fixes this by tracking, for each element, whether it was inserted to the left or right of its origin, and keeping same-side siblings grouped. Concurrent runs stay contiguous instead of shuffling.

**Requirement:** Step 6 must *first* write a test that demonstrates the interleaving under `RgaDoc`, watch it fail to be readable, and only then implement Fugue. The failing artifact is exhibit 3. Do not delete `RgaDoc` after Fugue lands.

### 2.4 Deletion is a tombstone

Deleted characters are marked, never removed. The `ElemId` must stay resolvable forever, because a concurrent op may reference it as an origin and an anchor may point at it.

Consequence: two indices exist, and confusing them is the most likely bug in this codebase.

- **Internal index** — position among all elements, tombstones included
- **Visible index** — position among live elements only, which is what the user and ProseMirror see

The mapping between them is not free, which is what forces §2.5.

**`del(id)` is idempotent and commutative for free**, because two replicas deleting the same character emit the *same operation*. "Deleted" is a monotone fact, not a value. Preserve this property. It is load-bearing for §3.1.

**Therefore: revive is not a thing.** The inverse of `del(id)` is **not** reviving that id. It is inserting a **new** character immediately before the tombstone, which is still sitting exactly where the old one was: `Sequence.insertBefore(id, char)`.

The prior build's architecture doc originally said "revive that ID" and proposed a last-write-wins register per element. That was wrong, and the reason is worth keeping. An LWW register would preserve identity, but it would cost the run-length encoded delete set (§3.1: 60,000 deletions in 29 bytes, which works *only* because "deleted" is monotone) and it would cost the free commutativity above. Position is restored perfectly either way. Identity is not, so a comment anchored to revived text does not come back. Yjs makes the same trade.

### 2.5 The order-statistic treap

**Do not store the sequence in an array.** The prior build did, measured it, and had to rip it out at step 4b.

The array gives O(n) `indexOf` for origin lookup and O(n) splice per insert. Benchmarked cold-open of a 100k-character document **extrapolated to ~41 seconds**. Cold-open is the common case: it is what happens every time anyone opens the document, because the whole op log replays.

Replace with an **order-statistic treap**:

- **Hashed priorities.** Priority is `hash(ElemId)`, not `Math.random()`. This is required, not stylistic: it keeps the core deterministic (§1 gate 1) and it makes the tree shape identical on every replica, which makes divergence bugs reproducible.
- **Parent pointers.** Needed to walk upward from a node to compute its index without a root-down search.
- **Subtree size counts**, maintained on rotation. These give O(log n) `indexOf` and O(log n) index-to-node.
- **Two counts per node**, actually: total subtree size and *live* subtree size. The live count is what makes the visible↔internal mapping in §2.4 O(log n) instead of O(n).

Target: S6, 100k cold-open under 1 second.

---

## 3. Wire format

### 3.1 Binary encoding

JSON is not acceptable here, and not for performance reasons alone: designing the binary format is what surfaced the clock conflict in §2.1.

- **LEB128 varints** for all integers. Counters are small and dense; they should cost one byte.
- **Replica tables.** A document has few replicas and many ops. Intern `ReplicaId` strings into a per-message table and reference them by index.
- **Run-length encoded deletions.** Deletions cluster: a user selects a paragraph and hits delete, producing thousands of contiguous ids from one replica with consecutive counters. RLE collapses this. Target from the prior build, reproduce it as a benchmark assertion: **60,000 deletions encode in 29 bytes.**

This is the compression that dies if §2.4's monotone-fact property is traded away. The encoding and the algebra are coupled.

### 3.2 State-vector sync

A **state vector** is `Map<ReplicaId, highestContiguousCounter>`. It summarises everything a replica has, in bytes proportional to the number of replicas, not the number of ops.

Sync is: send your vector, receive everything you are missing. `doc.missingFrom(theirVector) → ops`.

**This requires contiguous counters.** If replica A's counters are 1, 2, 3, 7, 9 then "I have up to 9" is a lie and "I have up to 3" is wasteful. Contiguity makes the vector exact.

A Lamport clock would break contiguity, since it jumps forward on receipt of remote ops. §2.1 established that convergence does not need a Lamport clock. So counters stay contiguous and per-replica, and sync gets to be exact. **Record this in the decision log as the moment two requirements collided and the exhaustive search resolved it.**

---

## 4. The simulator

`packages/sim` is how S3 and S4 get verified. Test-only, never shipped.

Three parts:

1. **Seeded RNG.** Every run is reproducible from a seed. On failure, print the seed. The seed goes in the bug report and the regression test.
2. **Virtual clock.** No `setTimeout`, no real time. Time advances because the test says so. This is why §1 gate 1 exists.
3. **Delivery queue.** Holds in-flight messages and delivers them in an order the RNG chooses. **Tiebreak on sequence number**, not on insertion order into the queue, or the simulator is itself nondeterministic and you will spend a day finding out.

The sim must be able to: drop messages, duplicate messages, reorder arbitrarily, partition the network into groups, and heal partitions. Convergence assertions run after healing and after quiescence.

---

## 5. The relay

An **append-only log with a cursor**. That is the entire design.

```
POST /doc/:id     append opaque bytes, return offset
GET  /doc/:id?from=N   stream bytes from offset N
```

The relay does not parse ops. It does not merge. It does not validate. It does not know what a CRDT is. It appends bytes and hands back bytes from an offset.

This is enforced by CI (§1 gate 2) because it is the single most valuable structural claim the project makes: **the server is dumb, so the server cannot be the authority, so there is no authority.** Every time someone adds "just a little validation" to a relay, the system quietly becomes client-server and the whole argument collapses.

Storage for v1: in-memory log plus append to disk. No database. Replay on boot.

---

## 6. The provider

Client-side glue. Owns the socket, the local persistence, and the sync loop.

**The discovery worth preserving:** there is no offline queue.

The instinct is to buffer unsent ops in a queue while disconnected and flush on reconnect. That queue is a second source of truth, it can disagree with the document, and reconciling it is a bug farm.

It is unnecessary. The document already knows what it has, and the state vector already knows what the server has. The entire offline story is:

```ts
const missing = doc.missingFrom(lastPushedVector);
```

Reconnect, ask the relay for its cursor, compute the delta, push. Disconnection is not a special state. It is just a long gap between syncs. **Do not build a queue.**

Local persistence: IndexedDB in the browser, holding the encoded op log plus the last-pushed vector. Reload replays it.

---

## 7. Anchors and awareness

Two different lifetimes, and conflating them is a design error.

**Anchors are permanent.** A cursor is not an index, it is an `ElemId` plus a side (before/after that character). When a remote user inserts text above your cursor, your cursor does not move, because it was never at a number. It was pointing at a character, and that character has not moved either. This is S10 and it is the thing that makes collaborative editing feel non-hostile.

Anchors survive tombstoning: the anchored character can be deleted and the anchor still resolves, because the tombstone is still there holding the position.

**Awareness is ephemeral.** Presence (who is here, where is their cursor, what colour are they) is last-write-wins per replica, with a TTL, and is **never persisted and never written to the op log**. A user who closes their laptop should evaporate, not leave a ghost in the document forever.

Awareness travels over the same relay, on a separate channel, and the relay still does not know what it means.

---

## 8. Editor binding and undo

**The binding is headless and testable in node.** ProseMirror's model layer does not need a browser; only its view layer does. Bind to the model, test the whole thing in Vitest with no jsdom. If the binding needs a DOM to be tested, it is wrong.

The binding maps ProseMirror transactions to CRDT ops and CRDT changes back to ProseMirror steps, using visible indices at the boundary and `ElemId`s everywhere inside.

**Undo transforms nothing.**

This is the punchline of the whole project and it should be a section in the README. Operational transformation exists, in large part, to make undo work under concurrency: you have to transform the inverse operation against everything that happened since, or you undo the wrong thing.

With a CRDT, undo of "insert x" is "delete the element with *this id*". That id is still that id. It does not matter what happened in between, who else typed, or how the indices moved. There is nothing to transform. The undo manager keeps a stack of `ElemId`s and inverse ops, and applies them directly.

Per §2.4, undo of a delete is `insertBefore(tombstoneId, char)`, not a revive.

Undo is **per-replica**: undo pulls back *your* last edit, not the last edit globally. This falls out of the id-based design for free and is the correct behaviour anyway.

---

## 9. Benchmarks (step 15)

Committed numbers in `bench/README.md`, honest, including the ones that lose.

- Cold-open: 1k / 10k / 100k characters. Target < 1s at 100k (S6). Include the pre-treap array number (~41s extrapolated) as the comparison.
- Encode/decode round-trip throughput.
- The 60k-deletions-in-29-bytes assertion (§3.1).
- Memory per character, with tombstones, at 100k.
- **Comparison against Yjs on the same workloads.** Expect to lose. Report it anyway, the way Cotangent reported being 5-7x slower than cuBLAS. An honest loss against a mature library is more credible than a suspicious win, and a fabricated win is the fastest way to fail an interview.
