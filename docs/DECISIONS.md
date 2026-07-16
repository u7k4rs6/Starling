# Starling: Decision Log

One entry per non-obvious choice, including the ones that got reversed. The
reversals are the interesting entries. See `01-PRD.md` §6.

---

## 0001 — Core isolation gate: add `new Date(`, `crypto.randomUUID`, `crypto.getRandomValues`

**Step:** 0

The gate 1 banned-pattern list as originally written (`02-ARCHITECTURE.md`
§1) covered `Date.now()`, `Math.random()`, and `performance.now()`. Two gaps:

- It missed `new Date(`, an equally-ambient clock read that just doesn't
  route through `Date.now()`.
- It missed `crypto.randomUUID()` and `crypto.getRandomValues()` entirely.

The `crypto` gap was the one that actually mattered. `ElemId = { replica:
ReplicaId; counter: number }` (§2.1 of ARCH), and `ReplicaId` is "random,
assigned at replica creation" per the same section. The obvious first draft
of `Sequence`'s constructor mints its own replica id, and the obvious way to
do that in 2026 TypeScript is `crypto.randomUUID()` — which walks straight
past a `Math.random()` grep while putting real, ungoverned nondeterminism
into the one package required to be deterministic. Gate 1 exists because the
simulator (§4 of ARCH) and the treap's hashed priorities (§2.5) both depend
on the core being a pure function of its inputs; a self-assigned replica id
breaks that as thoroughly as a stray `Date.now()` would, just less obviously,
since it only fires once per replica instead of once per op.

**Resolved:** `ReplicaId` is injected at construction. The core never
generates one — callers (the sim, the provider, the demo) do, and they own
whatever randomness source is appropriate to their layer. The banned-pattern
list in `02-ARCHITECTURE.md` §1 now includes `new Date(`,
`crypto.randomUUID`, and `crypto.getRandomValues`.

## 0002 — Relay ignorance gate: drop bare `origin`, use `originLeft`/`originRight`, add `compareElemIds`

**Step:** 0

The gate 2 banned-string list as originally written (`02-ARCHITECTURE.md`
§1) included the bare word `origin`. This collides with legitimate relay
code: `03-SECURITY.md` §2.3 requires the relay to enforce CORS against
exactly the demo origin ("the relay allows exactly the demo origin. Not
`*`"), which means a correct relay implementation reads
`req.headers.origin`. A gate that fails a correct, in-scope implementation
isn't a tripwire, it's a false-alarm generator, and a gate that cries wolf on
its own required feature is the kind of check that gets `// eslint-disable`d
or silently loosened the first time it's inconvenient — which is exactly the
erosion §5 of the security doc warns about, just arriving from the opposite
direction.

**Resolved:** the banned-string list uses `originLeft` and `originRight` —
Fugue's actual per-element field names for insertion side (§2.3 of ARCH) —
instead of the bare word, and adds `compareElemIds`, the total-order
comparator (§2.1 of ARCH), which has no legitimate reason to appear in relay
code. The import check (no import from `packages/crdt`) remains the real
gate; the string list is a tripwire for hand-rolled CRDT logic that doesn't
go through an import statement, so it has to be tuned for distinctiveness
against real relay vocabulary (CORS, HTTP headers, byte offsets), not just
uniqueness against English.
