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

## 0003 — `passWithNoTests: false`

**Step:** 0

`vitest.config.ts` was written with `passWithNoTests: true` so the Step 0
gate — "CI green on an empty suite" — would hold with zero product tests. It
stopped being an honest representation of that intent the moment real tests
existed: by the end of Step 0, `tools/gates/*.test.mjs` already had 23 tests
in it. A flag that means "succeed even if nothing ran" sitting in a repo that
already has things running is not a relaxed default, it is a config that
would silently stop noticing if every test file were deleted or the test
glob stopped matching — which is exactly the "convenient explanation for why
a test passes" the project's own working requirements (`01-PRD.md` §6) rule
out.

**Resolved:** `passWithNoTests: false`. If the suite is ever actually empty
again, CI fails until a real test (or an explicit, reasoned exception) exists
— the green light stays evidence of something instead of becoming evidence
of nothing.

## 0004 — Core isolation gate, split into a structural half and a grep half; grep list extended; peer/optional deps included

**Step:** 0

Gate 1 was pure grep. Two problems with that:

- Grep only catches what someone wrote as a literal name. `packages/crdt`'s
  `tsconfig.json` didn't restrict `lib` or `types`, so `window`, `document`,
  `process`, `Buffer`, and every DOM/Node ambient global were legal
  references as far as the compiler was concerned; the grep list was the
  only thing standing between the core and any of them, and grep lists need
  to be remembered and extended by hand every time a new ambient name
  matters (as #0001 already demonstrated once).
- The list itself had a real hole even within its own approach:
  `setTimeout`/`setInterval` were absent. ARCH §4's virtual clock exists so
  the sim can control time; a core that calls `setTimeout(retry, 1000)`
  bypasses that clock by *scheduling* against real time, not by *reading*
  it, so it walks straight past every clock-read pattern (`Date.now()`,
  `performance.now()`) the original list had. Same category of bug as the
  `crypto.randomUUID()` gap in #0001: nondeterminism that doesn't look like
  a clock read.

**Resolved**, two changes:

1. **Structural.** `packages/crdt/tsconfig.json` now sets `"lib": ["ES2022"]`
   and `"types": []`. No DOM lib, no ambient `@types/node` — referencing
   `window`, `fetch`, `localStorage`, `process`, `Buffer`, or `setTimeout`
   in `src/` is now a type error, enforced by the typecheck gate that
   already has to run, with no separate list to maintain. Test files are
   excluded from this config (`tsconfig.json` excludes `src/**/*.test.ts`)
   and get their own `tsconfig.test.json` — permissive `types: ["node"]`,
   not composite, `noEmit` — because a test is explicitly allowed to
   construct a scenario with real time or real randomness; only the
   implementation is required to accept them as arguments.
2. **Grep, kept as a second, independent gate.** Extended with
   `setTimeout`, `setInterval` (the hole above), `fetch`, `WebSocket` (I/O
   the core must never perform — the relay/provider boundary exists so the
   core doesn't have to know a network exists), `process.hrtime`,
   `process.uptime` (more ambient clocks), `requestAnimationFrame`, and
   `self` / `globalThis` (banned as indirection: `globalThis.crypto
   .randomUUID()` reaches the exact same nondeterminism as
   `crypto.randomUUID()` through a property access that no single-symbol
   pattern would match, and `self` is the same trick under Worker-flavored
   code). The grep half is deliberately kept even though the structural
   half now covers most of the same ground — the structural gate only holds
   as long as `tsconfig.json` keeps `types: []`, and a future edit that
   quietly adds `"types": ["node"]` for some unrelated reason should still
   get caught by something. Two gates that partially overlap are not
   redundant when the point is that neither depends on the other staying
   correct.

Also: `package.json`'s `dependencies`, `peerDependencies`, and
`optionalDependencies` must all be empty, not just `dependencies`. An
optional dependency still ships in the published tarball and still resolves
for any consumer whose environment satisfies it — "zero runtime
dependencies" (`01-PRD.md` §7, `03-SECURITY.md` §3) meant zero, and the
`dependencies`-only check was checking a proxy for that claim, not the claim.

## 0005 — Pin `onlyBuiltDependencies: []`; the esbuild postinstall-skip investigated, not assumed

**Step:** 0

`pnpm install` at the end of Step 0 printed: `Ignored build scripts:
esbuild@0.21.5` — pnpm 10's default is to refuse dependency
install/postinstall/preinstall scripts unless the package is allow-listed.
Vitest (which depends on esbuild) worked anyway. Before relying on that,
the mechanism was checked rather than assumed:

- `esbuild@0.21.5`'s `package.json` declares `optionalDependencies` for
  every `@esbuild/<platform>-<arch>` package and a `postinstall: node
  install.js`.
- `@esbuild/linux-x64` (the package matching this container) was present in
  `node_modules/.pnpm` after install, resolved as an ordinary
  platform-matched optional dependency — pnpm/npm resolve
  `optionalDependencies` during normal install, which is dependency
  resolution, not a build script. `@esbuild/linux-x64`'s own `package.json`
  has no `scripts` field at all; it is prebuilt binary content, nothing to
  run.
- Reading `install.js`: it calls `require.resolve('@esbuild/<platform>/bin/
  esbuild')` first, and only falls through to a network download if that
  resolution *fails* (the documented failure case is a `node_modules`
  copied across platforms, e.g. built on macOS and shipped to a Linux
  Docker image). `bin/esbuild` (the binary vitest actually invokes) runs
  the identical resolution logic itself, independent of whether
  `install.js` ever ran.
- pnpm's own state file (`node_modules/.modules.yaml`) confirms this run:
  `ignoredBuilds: ["esbuild@0.21.5"]`, `pendingBuilds: []` — the script was
  skipped outright, not deferred — and the full `lint`/`typecheck`/`test`/
  gate sequence still passed, which is the empirical half of the check.

So: the postinstall script is a *fallback download path* for a
resolution that normally already succeeds via `optionalDependencies`, not
the *acquisition* mechanism. Skipping it is safe for esbuild specifically,
and — more to the point — this is exactly the "no install scripts" property
`03-SECURITY.md` §3 asks for, already true by pnpm 10's default rather than
by anything this repo did.

**Resolved:** `onlyBuiltDependencies: []` added to `pnpm-workspace.yaml`,
explicit and empty. The protection existed by default before this change;
after it, the empty allow-list is a committed, reviewable invariant instead
of an inherited default that a future pnpm major (or an unreviewed one-line
addition) could silently change out from under the project.

## 0006 — `NaiveDoc` shares `Sequence` from Step 2 onward, not from Step 1; the retrofit is the best exhibit, not bookkeeping

**Step:** 1→2 (spec correction, author's error not the agent's)

`01-PRD.md` §4 and `02-ARCHITECTURE.md` §2.2 both stated "all four [document
classes] share one abstract `Sequence` base" without qualification. Read
literally at Step 1, this is false: `01-PRD.md` §5's own ladder makes
`ElemId` / `compareElemIds` / abstract `Sequence` **Step 2's** deliverable,
so at Step 1 — when `NaiveDoc` (exhibit 1) is built — the base does not
exist yet to share. The spec asserted an end state as if it were true at
every point along the ladder that produces that end state, which is the
kind of contradiction §0 of the PRD asks to be caught and stopped on rather
than silently resolved either direction (build `Sequence` early and batch
two ladder steps, or quietly drop `NaiveDoc` off the base to make the
literal reading of Step 1 self-consistent).

The correct resolution turned out to be more than a wording fix. `NaiveDoc`
moving onto `Sequence` at Step 2 — gaining a real `ElemId`, idempotence, and
causal delivery, all the machinery the other three exhibits get — and
**still diverging**, because `integrate(op)` still ignores the id and places
by raw index, is the sharpest version of "position is not identity"
(`02-ARCHITECTURE.md` §2.4) the museum makes: identity alone buys nothing:
a merge rule has to *use* it. The ladder's ordering — forced by "one step
per session," not chosen for this reason — produces a two-beat
demonstration (Step 1: no identity, doesn't commute, diverges. Step 2: has
identity, still doesn't commute, still diverges) that a same-session build
of `Sequence` would have collapsed into one beat and made invisible.

**Resolved:**
- `01-PRD.md` §4: the "share one abstract base" requirement is now stated
  as the state from Step 2 onward, with the two-beat lesson spelled out
  explicitly and a warning against "fixing" `NaiveDoc` once it's on the
  base and still fails to converge.
- `02-ARCHITECTURE.md` §2.2: same timing clarification, plus a note on why
  `NaiveDoc` belongs on the base for exactly the reason it still breaks
  after joining it.
- `01-PRD.md` §4's exhibit 1 test was renamed to name the diagnosis —
  `apply()` is not commutative — instead of only the symptom
  (divergence), since commutativity is the through-line every later step
  (RGA, Fugue, the fast-check property tests in Step 3) is chasing.

(Filed as #0006 rather than #0003 as originally requested — #0003 through
#0005 were already used by the Step 0 correction round logged earlier in
this file.)
