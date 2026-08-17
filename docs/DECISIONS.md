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

## 0007 — Core isolation grep exempts `*.test.ts`/`*.spec.ts`, matching the tsconfig split

**Step:** 2

Found while wiring Step 2's new test files, before it could bite: gate 1's
grep half (`tools/gates/core-isolation.mjs`) scanned every `.ts` file under
`packages/crdt/src`, including test files, with no exemption. That
contradicts #0004, which is explicit that tests are exempt from the
ambient-time/randomness restriction — `tsconfig.test.json` exists precisely
because "a test is explicitly allowed to construct a scenario with real time
or real randomness; only the implementation is required to accept them as
arguments." The structural half of gate 1 (the restrictive `tsconfig.json`)
already honored that split by excluding `src/**/*.test.ts`; the grep half
did not. Caught by inspection, not by a failing test, since no test file
had yet used a banned pattern for real — it was a latent inconsistency
between the doc's claim and the gate's behavior, not yet a live bug, and
would have first surfaced as a confusing false-positive gate failure the
first time a property test (Step 3, `fast-check`, seeded) legitimately
needed real randomness to pick a seed.

**Resolved:** `core-isolation.mjs` now skips any file matching
`/\.(test|spec)\.[cm]?[jt]sx?$/` before applying `BANNED_PATTERNS`. Covered
by three new cases in `core-isolation.test.mjs`: a `*.test.ts` and a
`*.spec.ts` file using banned patterns are both clean, and a same-named
non-test file with identical content is still flagged — confirming the
exemption is keyed on the filename suffix, not on some coincidental
substring match.

## 0008 — Two gate tests asserted the bug and had been green since Step 0: a test written the same session as its implementation can certify the implementation's own misconception

**Step:** 2

The finding here is not the grep false positive. It's this: before it was
fixed, `relay-ignorance.test.mjs` contained two passing tests — "flags the
string Fugue" and "flags the string tombstone" — whose fixtures put the
banned word inside a `//` comment and asserted that the gate *should* flag
it. Those tests were written in Step 0, in the same session, by the same
pass, as the gate implementation they were testing. The implementation
scanned raw text including comments; the test was written to match that,
not against the actual requirement ("catch hand-rolled CRDT logic," which a
comment *mentioning* a concept is not). Implementation and test agreed with
each other and had agreed since Step 0, through every subsequent green run
in Steps 0 and 1 — because a test that checks "does the code do what the
code does" instead of "does the code do what it's supposed to do" will
always agree with a same-session implementation, by construction, and green
stops being evidence of anything the moment that happens.

This is exactly the failure "predict before you measure" and "do not tell
me a test passes without knowing why it passes" (`01-PRD.md` §6) exist to
stop, and it happened anyway, because those rules were applied to the
*production* code and the *benchmark* results, not to the *gate tests
written to check the gates*. **Generalization, worth carrying forward past
this one bug:** a test authored in the same pass as the code it tests is at
risk of testing the code's behavior instead of the spec's requirement,
especially for infrastructure like these gates where "the test" and "the
tripwire" are the same artifact and there's no separate spec to check it
against except the prose in `ARCH §1`. The mitigation isn't "write more
tests" — the two bad tests were tests — it's asking, per case, "would this
assertion survive if the implementation had done the wrong thing instead
of the right thing," and for a negative-space check like a gate (proving
absence, not presence), specifically asking whether the fixture represents
something that *should* be legal, not just something the current code
happens to accept or reject.

**The mechanical bug this exposed:** `sequence.ts`'s own doc comment reads
"the abstract base every **document** class... inherits," and gate 1's
`\bdocument\b` DOM-global pattern doesn't distinguish `document.write()`
from English prose about a *document* editor — caught by a failing test
this time (`pnpm run test` failed on `sequence.ts` right after #0007),
which is the version of this mistake going right: the assertion in that
test was written against the actual requirement (packages/crdt has no DOM
global reference), so when the implementation's crude text match violated
that requirement on real prose, the test caught it instead of certifying
it.

**Resolved:** `tools/gates/strip-comments.mjs` blanks `//` and `/* */`
comments (replacing characters with spaces, preserving line count) before
either gate's pattern matching runs, with an option to also blank string and
template contents. Gate 1 (`core-isolation.mjs`) uses the string-blanking
variant, since a banned *call* like `Math.random()` can't mean anything
useful sitting inert inside a string literal. Gate 2 (`relay-ignorance.mjs`)
uses the comments-only variant for both its import-specifier scan and its
banned-string scan — the import check has to see real specifier strings to
work at all, and a string literal containing a banned word (e.g. a
`"tombstone"` JSON key) is still worth flagging, unlike a comment that only
*mentions* the word. The two bad tests were rewritten to put the banned
word in real code (where flagging it is correct), and new cases were added
confirming the same words in a comment — or a commented-out `import` of
`starling-crdt` — are now silently ignored, on both gates.

**Closed in the same breath:** string-blanking in gate 1 means
`eval("Date.now()")` would have its argument blanked, hiding the banned
call from every pattern above. Fix: `eval(` and `new Function(` are now
themselves banned patterns — the mechanism is banned outright regardless of
what string it's handed, which is the only sound response to "the argument
is now opaque to this gate," and `eval` in a CRDT core is a red flag on its
own merits regardless.

Known limitation, documented in `strip-comments.mjs` itself rather than
silently accepted: this is a small state machine, not a real parser — it
doesn't recognize regex literals (a regex containing `//` can be misread as
a line comment start) and, in string-blanking mode, blanks a template
literal's `${...}` interpolations along with the rest of the template. Both
are acceptable for a tripwire over this repo's own source, not a
general-purpose linter.

## 0009 — Vocabulary collision: this project's gate ban lists are a subset of its own domain glossary

**Step:** 2

A generalization worth separating from #0008's specific bug, because it
predicts future bugs of the same shape rather than explaining a past one.
Gate 1 bans `document`, `self`, `window`. Gate 2 bans `Fugue`, `tombstone`,
`originLeft`/`originRight`. Every one of those is either an ordinary
English word or this project's own named vocabulary — and this is a
*document* editor, with *self*-contained replicas, that will eventually
implement *Fugue* for real (Step 6) and talk about *tombstones* constantly
(§2.4 of ARCH) in code that sits right next to, but must never become,
`packages/relay`. A grep-based gate over a codebase whose comments are
permitted to describe the codebase in its own terms will always be a doc
comment away from banning its own domain. This is not fixable in general —
stripping comments (#0008) removes prose from the scan, but any *code*
identifier that legitimately needs one of these words (a local variable
named `self`, a relay log field literally called `origin` for CORS, per
#0002) still has to be handled case by case, the way #0002 and #0008 each
were.

**The actionable form of this finding:** every time a new banned pattern is
added to either gate (as gate 1's list already grew twice — #0001, #0004),
check it against this project's own glossary before committing it, not
just against generic JS globals. A pattern that's safe against `window` and
`fetch` is not automatically safe against a word this project's own prose
uses constantly. No code change from this entry — it's a standing caution
for whoever (agent or human) next edits `BANNED_PATTERNS` or
`BANNED_STRINGS`.

## 0010 — `deps` is a runtime-only field; it never reaches the wire, and it can drift from the payload it describes

**Step:** 2

Two constraints on the `deps: ElemId[]` design from #0006's prediction,
neither a reason to change it, both worth pinning down before Step 7 makes
either one expensive to discover late.

**`deps` must not be encoded.** It is derivable twice over from information
the wire format already has to carry: the causal origin a merge rule needs
is already sitting in the op's own `payload` (RGA/Fugue's `l` field, ARCH
§2.3), and a replica's *own* prior op is implied for free by contiguous
per-replica counters (ARCH §3.2 — "I have up to counter N" already says
"and everything before N"). A field that duplicates information already
present carries zero bits of new information and, at Step 7, would spend a
whole extra `ElemId` per insert in a format that is explicitly fighting for
individual bytes (LEB128 varints, RLE deletions, the 60,000-deletions-in-
29-bytes target). Encoding `deps` would be paying wire cost for a runtime
convenience. **Constraint, logged now so Step 7 doesn't have to rediscover
it under deadline: `deps` is populated by `recordLocalOp`/derived by
whoever constructs an op, used only by `Sequence`'s in-memory causal
buffer, and reconstructed at decode time from the payload and the state
vector — never serialized.** That reconstruction is Step 7's to design, not
Step 2's; nothing here blocks on it.

**`deps` can silently disagree with the payload it's attached to.** Nothing
stops a subclass from emitting an op whose `deps` array doesn't actually
match what its `payload` depends on — a bug that would make causal
buffering do the wrong thing (integrate too early, or block forever on a
dependency that was never real) with no error, because `Sequence` has no
way to check this generically: an empty `deps` is *correct* for `NaiveDoc`
and would be a *bug* for `RgaDoc`. This can only be validated per subclass,
against that subclass's own definition of "actual dependency."

**Resolved:** every doc class owns one test asserting its `deps` match its
payload's real dependencies. Added for `NaiveDoc` now (`naive-doc.test.ts`)
— trivial today, since a `{index, char}` payload has no id to depend on, so
the assertion is just "`deps` is always `[]`" — specifically to establish
the pattern before `RgaDoc` (Step 3) makes it load-bearing: its version of
this test will assert `deps` contains exactly the origin id when one
exists, and `[]` only for a genuinely originless insert.

## 0011 — Step 1 prediction error: an abstract `dependencies(op)` method was wrong; `deps` as data on `Op<Payload>` is strictly better

**Step:** 1→2 (the author's error, logged as requested, not the agent's)

Before Step 2, the prediction on record was that `Sequence`'s causal
buffering would need a second override point — an abstract
`dependencies(op): ElemId[]` alongside `integrate(op)` — to let each
subclass say what an op depends on, since `NaiveOp` and the eventual RGA
`InsertOp` extract dependencies from completely different payload shapes.
That prediction was wrong, and the correction (this agent's, working from
the same prompt) is what actually got built in Step 2: `deps` is a plain
field on the `Op<Payload>` envelope, populated wherever the op is
constructed (already subclass-specific work, since payload construction
already differs per subclass), read generically by the base's causal
buffer. `integrate(op)` stays the *only* override, exactly as ARCH §2.2
requires, with no second abstract method needed.

Worth stating why the wrong prediction happened, not just that it did: a
`dependencies(op)` method reads naturally as "of course each merge
strategy needs to know its own dependencies," which is true, but conflates
*deriving* a dependency (subclass-specific, happens once, at op
construction) with *checking* a dependency (generic, happens on every
`receive()`, belongs in the base). Once those are separated, the derivation
half turns out to already be inside a subclass-specific code path (the
local-edit method), and the checking half needs no polymorphism at all —
just a field to read. The instinct to reach for a virtual method is the
same instinct that would have added a second override point to a base
whose entire pedagogical claim (§2.2 of ARCH, the museum's one-`while`-loop
delta between `RgaDoc` and `Doc`) depends on there being exactly one.

## 0012 — Exhaustive origin-forest search (ARCH §2.1), run before Step 3's merge rule: zero divergence, reproduced exactly, model corrected once along the way

**Step:** 2→3 prep. Reproduction of a prior-build finding whose original code is lost; the search here is a fresh implementation, not a re-run.

**Prediction, disclosed honestly:** by the time this search ran, ARCH §2.1's
stated conclusion had already been read in full during this session's
initial pass over the docs, so a claim of a blind guess would be false. The
independently-reasoned prediction, separate from recall of that passage:
general RGA convergence theory doesn't require the tie-breaking total order
to be causally monotonic, only that it be fixed and computed identically by
every replica — so the prediction was zero divergence, with or without
monotonicity, matching the doc. Genuine uncertainty existed on one point,
not resolved by memory: whether the *simplified* 4-line `integrate()` given
in ARCH §2.3 (which skips forward past **any** higher-precedence element,
not just same-origin siblings) inherits that guarantee, since it is not
textbook RGA with subtree-boundary checking. That part had to be run to
know.

**First attempt undercounted, and the gap was reported rather than
papered over.** A first enumeration modeled "origin forest" as: elements
numbered 0..n-1 in a fixed creation order, each element's origin restricted
to an earlier-numbered element or null. That gives `n!` forests (720 at
n=6) — internally consistent, but not what "origin forest" means. It
conflates two independent constraints: *acyclicity* (what makes a parent
assignment a forest at all) and *causal deliverability* (which is correctly
a property of a *delivery order* being a valid linear extension, checked
separately). Restricting origin choices to "earlier index" silently
smuggled a causal-order assumption into the topology-generation step,
undercounting real structures — e.g. at n=2 it produced 2 forests where 3
actually exist (`{both roots}`, `{A parent of B}`, `{B parent of A}`; the
first model couldn't reach "B parent of A" because it always treated
element 0 as unconditionally rootable only, never a child).

**Corrected model:** an origin forest on n labeled elements is any
acyclic parent-assignment where each element points to *any* other element
or null — no presupposed ordering. The count of these is the generalized
Cayley formula for labeled rooted forests, `(n+1)^(n-1)`. Verified by direct
enumeration against the formula for n=1..6 (`packages/crdt/research/
origin-forest-search.mjs`): exact match at every n, including **16807 at
n=6** — the number this project's own docs cite, reproduced exactly once
the right model was found, not fitted to match.

**Result, under the corrected model:** 18248 origin forests across n=1..6,
each checked against 5 id-rank regimes (identity/monotonic, full reversal,
and 3 seeded-random shuffles — not the full `n!` permutation space; stated
as a representative sample, not silently presented as more exhaustive than
it is), every valid causal delivery order per forest — 91,240
(forest × id-regime) checks, **zero divergences**. ~2.2s to run. RGA's
4-line merge rule, exactly as given in ARCH §2.3 with no subtree-boundary
restriction, converges regardless of delivery order and regardless of
whether the id total order tracks causal order.

**Why this matters beyond confirming a citation:** this is the empirical
basis for §2.1 and §3.2 of ARCH — "the counter is therefore not a Lamport
clock and does not need to be" — which is what lets Step 7's state-vector
sync use contiguous per-replica counters at all. If convergence had turned
out to depend on monotonic ids, the wire-format argument at Step 7 would
have needed a Lamport clock, which ARCH §3.2 explicitly says would break
counter contiguity and make the state vector inexact. Nothing here is new
relative to what ARCH already asserts; what's new is that it was checked
again, independently, from a lost codebase, and reproduced the exact cited
number rather than merely trusting it.

**Harness verified non-vacuous, not just run:** confirmed 3 fully-concurrent
elements have 3! = 6 valid delivery orders (the delivery-order dimension
actually varies); confirmed id-rank actually changes placement for a fixed
forest and delivery order (monotonic vs. reversed ids give different
results — id order is not inert); confirmed three different delivery
orders of the same forest+ids converge to the identical result (the actual
claim, shown concretely, not just counted in aggregate). All three are now
committed tests, not just a conversation transcript.

**Committed as `packages/crdt/research/origin-forest-search.mjs` plus
`origin-forest-search.test.mjs`**, wired into the real test suite (`vitest`
now includes `packages/*/research/**/*.{test,spec}.*`) rather than left as
a throwaway script — it reproduces a specific historical number (16807)
that would otherwise silently rot back into "trust the doc," and a future
change to the merge-rule model belongs under a regression check same as
anything else load-bearing.

Per instruction: no merge rule, `ArrayDoc`, or fast-check property tests
were written this session. This is prerequisite verification for Step 3,
not Step 3 itself.

## 0013 — Wrong prediction, caught by a failing test: a same-replica-known element can still end up positioned after a freshly-inserted one, because cross-replica counters aren't a recency signal

**Step:** 4

Writing an example test for concurrent delete + insert (ARCH §2.4's
warning about a concurrent op referencing a tombstone as origin), the
first draft predicted: replica C, having already synced "abc," inserts
"X" at visible index 2 (intending "between b and c") and ends up with
"abXc." Running it produced `"abcX"` instead — X landed *after* c, not
before it. Traced by hand and confirmed by direct execution (not just
patched to make the test pass): X's origin is "b," the same origin "c"
has, making them RGA siblings; the merge rule's tie-break among siblings
is purely `compareElemIds` on id, which compares `counter` first — c's id
is `{replica: "setup", counter: 2}`, X's is `{replica: "C", counter: 0}`,
and `2 > 0`, so c wins the tie-break and stays to X's left, even though
replica C had already synced c and *intended* X to land before it.

This is not a bug — it is `docs/DECISIONS.md` #0012's own finding
(convergence holds under any total order, causal monotonicity or not)
showing up as a felt surprise instead of an abstract search result. A
replica's counter always starts at 0 and only ever increases *relative to
that replica's own prior ops*; it says nothing about how much of the
document that replica has already read. A replica's first local op can
therefore have a numerically low id even after fully syncing a long
document, and lose tie-breaks against far older content from other
replicas. Same-replica typing never exposes this (a replica's own counter
is always the newest among its own ops), which is exactly why it took a
deliberately cross-replica scenario to surface it.

**Generalization:** origin-based placement (RGA's `l` field) only records
*what came before*, never a right boundary. Two elements sharing an origin
are placed relative to each other by naked id comparison, with no
sensitivity to which one the "current" replica already knew about. This is
the same root cause as ARCH §2.3's documented backward-typing interleaving
anomaly (Step 6, Fugue) — a different symptom of the identical mechanism:
*origin says where you came from, not where you should end up relative to
everything already there.* Worth remembering when Step 6 explains why
Fugue tracks insertion side per element instead of just an origin pointer.

**Separately, a plain test-authoring bug found in the same pass, not
elevated to a "finding":** the delete-commutativity test's `opZ` (the
insert of `"z"`) was created but never captured into a variable, so it was
never delivered to either receiving replica — the assertion failed with an
empty string, which briefly looked like a second algorithmic surprise
before being traced to a missing variable capture. Fixed by capturing and
including it. Distinguishing this from the finding above is the point:
one was "the code did something I didn't predict, and the code was
right"; the other was "the test forgot to send an op." Different failure,
different fix, and conflating them would have meant either debugging the
merge rule for a bug that wasn't there, or writing off a real finding as
"probably just a test bug."

## 0014 — Treap vs array speedup is modest at small n, dramatic at large n; a wrong prediction about *when* the treap wins, and an incidental confirmation of the historical ~41s figure

**Step:** 4b

Predicted going into the S6 benchmark: RgaDoc (treap, O(log n) per op)
would be substantially faster than ArrayDoc (array, O(n) per op) at any
size worth measuring, since O(log n) beats O(n) by definition. Measured at
the scale the committed test uses for its trend check, n=3000: ArrayDoc
22.1ms, RgaDoc 15.9ms — RgaDoc wins, but by ~1.4x, not the dramatic margin
the asymptotic gap suggests. The prediction was wrong in *degree*, not
*direction*.

Checked why rather than shrugging it off: swept n from 1000 to 100000
outside the committed suite (this sweep is not itself committed — the
100k-array leg alone takes real wall-clock time no CI run should pay for
routinely; see below). Ratio (array ms ÷ rga ms) by n: 1000 → 2.66x,
5000 → 3.57x, 20000 → 21.16x, 50000 → 49.39x, 100000 → 69.54x. The
speedup is real and grows essentially without bound, exactly matching
O(n²) (array: O(n) work × n ops) versus O(n log n) (treap: O(log n) work ×
n ops) — `n / log n` grows unboundedly, so the ratio has to keep growing.
At n=3000 the two are close because the treap's constant factor is
higher (object allocation per node, recursive split/merge, a `Map` insert
per op) against array `splice`'s very low constant factor (a single
optimized native memmove) — the crossover where the better asymptotic
complexity actually wins in wall-clock terms is somewhere in the low
thousands to low tens-of-thousands for this implementation, not at
n=3000, and *nowhere near* n=1 the way a naive "O(log n) < O(n) so it's
always faster" reading would suggest.

**Incidental confirmation, not the point of this entry but worth
recording:** the same sweep measured ArrayDoc at n=100000 taking 26.5s —
real wall-clock, not extrapolated. `01-PRD.md` §4 and `02-ARCHITECTURE.md`
§2.5 cite "~41s extrapolated" from the lost prior build. Same order of
magnitude, independently arrived at on different hardware with a fresh
implementation — reasonable corroboration of a number that could otherwise
only be trusted on faith, though it is not a substitute for Step 15's own
committed benchmark run (different machine, different exact workload
shape, and this run's numbers were never intended to be citable — they
were a sanity check for the prediction above, not a benchmark).

**Resolved / committed:** the S6 gate itself (`rga-doc.test.ts`) measures
only RgaDoc at n=100000 (412ms, well under the 1s target) — that is the
actual gate. A second, *committed* test compares ArrayDoc against RgaDoc
at n=3000 (small enough to run every CI invocation without cost) purely
as a trend sanity check, asserting only `rga < array` at that scale, not
a specific ratio — the ratio itself is n-dependent and asserting a number
observed at one n would be asserting an artifact of this run, not a
property. The 1000–100000 sweep that produced the table above is not
committed, by design: routinely paying 26.5s of CI time to reconfirm a
trend that a single fast assertion already covers would be exactly the
kind of unexplained cost §6 of the PRD warns against paying without
knowing why.

## 0015 — `Network`'s delivery order is a direct RNG index pick, not a sort over randomly-assigned priorities; ARCH §4's literal tiebreak rule doesn't apply, by construction

**Step:** 5

ARCH §4 describes the delivery queue as delivering messages "in an order
the RNG chooses," and warns: "tiebreak on sequence number, not on
insertion order into the queue, or the simulator is itself nondeterministic
and you will spend a day finding out." That warning is specific to one
implementation shape: assign each pending message a random priority (or
sort key) and deliver in priority order — which needs an explicit tiebreak
rule for the case where two messages draw the same priority, since relying
on whatever order they happen to sit in when the sort is unstable (or
relying on "insertion order" as an implicit tiebreak, which can silently
mean different things depending on the underlying collection) is exactly
the nondeterminism trap.

`packages/sim/src/network.ts`'s `deliverOne()` doesn't do that. It builds
the list of currently-*deliverable* pending indices (partition-filtered)
and picks one directly via `rng.nextInt(deliverableIndices.length)` — a
single RNG draw per delivery, not a comparison between two random keys.
There is no tie to break, because nothing is ever compared to anything
else; the "randomness" is in which index gets chosen, not in a value
attached to each envelope. This still satisfies the actual requirement the
tiebreak rule protects — delivery order is a pure, reproducible function of
the seed, never of incidental array/Map iteration order — for a different
and simpler reason: `pending` and `partitionOf` are only ever mutated by
`send`/`deliverOne`/`dropOne`/`duplicateOne`/`partition`/`healPartitions`,
in the order the test calls them, so "the current deliverable set" is
itself deterministic before the RNG ever gets involved.

**Resolved:** no code change — this is a design note explaining why
`network.ts` doesn't contain an explicit tiebreak comparator, so a future
reader doesn't go looking for one and conclude ARCH §4's requirement was
missed. If `Network` is ever rewritten to assign priorities up front
(e.g. to support peeking at delivery order before consuming it), the
literal tiebreak rule would become load-bearing again at that point, not
before.

## 0016 — S4 property test: `partition()` used replica names that never matched `send()`'s names, silently no-op'ing the partition; caught by a failing property test, not by inspection

**Step:** 5

`convergence.test.ts`'s S4 property test (many random op sequences, 2
replicas, partition/heal) failed on its first run:

```
Counterexample: [[{"char":" ",...}],[{"char":"!",...}],0]
Got AssertionError: expected ' ' to be '!'
```

Traced, not just patched: the test constructed
`new RgaDoc("A")`/`new RgaDoc("B")` and called
`net.partition([["A"], ["B"]])`, but every `net.send(...)` call in the same
test used `replicaName(replicaIndex)` — `"replica-0"` / `"replica-1"` —
never `"A"`/`"B"`. `Network.canDeliver` looks up `partitionOf.get(from)`
and `partitionOf.get(to)`; since neither `"replica-0"` nor `"replica-1"`
was ever a key in that map, both defaulted to group 0 and every message
was, in fact, fully deliverable the entire time — the partition never
applied. The test then called `net.deliverAll(() => {})` immediately
after, intending "nothing is deliverable yet, so this drains 0" — but
since everything actually *was* deliverable, `deliverAll` popped every
envelope off the queue and handed each to the no-op callback, silently
discarding all of them. By the time `healPartitions()` and the real
`deliverAll` ran, the queue was already empty, so neither replica ever
received the other's op — hence `" "` vs `"!"`, each replica showing only
its own local edit.

**Two separate mistakes, not one:** the naming mismatch (root cause), and
the `deliverAll(() => {})` pattern that made the mismatch's symptom
*invisible* instead of loud — a no-op callback can't distinguish "nothing
was deliverable" from "something was deliverable and I threw it away."

**Resolved:** replica construction, `partition()`, and every `send()` in
the property test now all go through the same `replicaName(i)` helper, so
there is one name per replica, used consistently. The
`deliverAll(() => {})` call was replaced with
`expect(net.deliverOne()).toBeNull()` — an assertion that nothing is
deliverable, which fails loudly (rather than silently discarding) if the
partition is ever wrong again. This assertion now runs inside the property
test itself, across 500 generated scenarios, not as a one-off manual
check — it's the mechanism that would have caught this bug immediately
instead of via a downstream text mismatch two steps later.

## 0017 — Fugue (`Doc`): scoped to the documented asymmetry, not the full academic algorithm; a bucket-ordering bug caught by the shared contract test, not the new one

**Step:** 6

Two things worth separating: what `Doc` deliberately does *not* attempt,
and a real bug in what it does attempt.

**Scope, stated honestly rather than overclaimed.** The published Fugue
algorithm (Weidner & Kleppmann) is a general tree-CRDT with a precise rule
(closer to YATA's "left-origin/right-origin" comparison) for resolving
arbitrary interleaving patterns. Implementing that exactly from memory,
under real risk of a subtly wrong recollection, was judged higher-risk
than the alternative actually taken: derive, by hand, the specific
mechanism that fixes *the documented case* — S5 is "no interleaving on
concurrent backward typing," not "no interleaving under any conceivable
concurrent edit pattern." The mechanism: `insertLocal` anchors forward
typing to the *left* neighbor with side `R` (RGA's own convention,
unchanged) but anchors "insert at visible index 0" to the *right* neighbor
with side `L` instead of also using `R` — so repeated same-replica
backward-typing chains through a *new* origin every keystroke (each
character's origin is the previous character, which has no other left-
child yet) rather than repeatedly competing at one shared anchor. Two
replicas each backward-typing their own word therefore build two
independent chains, rooted at two *different* top-level siblings, and
`integrate()`'s tie-break is scoped to true `(origin, side)` siblings only
— so the two chains never interleave with each other; only the two
chains' *roots* (one tie-break, not one per character) decide which whole
word comes first. Verified by hand for the 2-word and 3-word case before
writing any code, then confirmed by running it (see `fugue-doc.ts`'s
architecture comment and `rga-doc.test.ts`'s companion failing-to-be-
readable proof). This is a real fix for the documented anomaly, not a
claim to have reimplemented the full paper — a future step that needs the
general case should treat this as a starting point, not a finished
implementation.

**The bug, caught by the *existing* shared contract test, not a new
one.** `Doc`'s very first test run failed on `doc-contract.test-helpers.ts`'s
`insertBefore` case — expected `"aBc"`, got `"Bac"`. Traced by hand:
`insertIntoBucket` inserted every new (always highest-id) sibling at array
index 0 in both the left and right buckets. For a *right* bucket, index 0
is correct — in-order traversal is `[parent, R0, R1, ...]`, so array-first
is parent-adjacent. For a *left* bucket, traversal is
`[..., L1, L0, parent]` — array-*last* is parent-adjacent, the opposite
end. Always inserting fresh siblings at index 0 therefore put every new
left-child as far from its anchor as possible instead of closest, which
had gone unnoticed until a bucket held more than one sibling — every
insertion up to that point in testing had built one-element buckets
(exactly the shape backward-typing produces, by design), so the ordering
direction never mattered until `insertBefore` added a second sibling to an
already-occupied bucket. **This is the same class of gap the origin-forest
search and DECISIONS #0013 already surfaced twice: a rule that's correct
for every case actually exercised so far can still be wrong, and the gap
only shows up once a test exercises the specific shape that reveals it.**

**Resolved:** `insertIntoBucket` takes the bucket's side and compares in
the direction that keeps "highest id ends up closest to the anchor" true
for *both* bucket kinds — descending for right buckets (unchanged),
ascending for left buckets (the fix). `insertBefore` itself was also
switched from anchoring as the tombstone's left-child to its right-child,
for the same reason, once the corrected direction made either choice
correct and right was the more natural reading of "insert next to this
now-invisible anchor." Full suite re-run clean afterward: 153 tests,
including 500 fresh property-test runs cross-checking `Doc` against a
plain-array reference for single-replica sequences, and the two- and
three-word interleaving-prevention proofs.

## 0018 — Step 7: op log added to `Sequence`; `TextEncoder`/`TextDecoder` confirmed unavailable under gate 1; 60,000 deletions measured at 14 bytes; one more wrong test assertion, distinguished from a real bug

**Step:** 7

**A base-class addition, checked against all four exhibits before trusting
it.** `missingFrom(theirVector)` (ARCH §3.2) needs to return actual past
ops, not just current tree state, and nothing in `Sequence` retained ops
after `integrate()` absorbed them — `accepted`/`integratedIds` track *which
ids* were seen, never the op payloads. Added a `log: Op<Payload>[]`,
appended in `integrateAndDrain`, plus `getStateVector()` (walks
`integratedIds` per replica to find the highest contiguous counter — a
real computation, not the stored max, because a gap is possible: nothing
in the causal-buffering logic guarantees a replica's own counters arrive
gap-free, only that an op's declared `deps` are satisfied first, and nothing
requires "my own counter N-1" to be among them) and `missingFrom()`. Per
PRD §4's own rule ("if a change to the base breaks an exhibit, the exhibit
was load-bearing and the change is wrong"), this is exactly the kind of
change that could have silently broken something — full suite re-run
clean, plus new tests added at both layers: the abstract base
(`sequence.test.ts`, using the `LogSequence` test double, including a
deliberate-gap case proving the vector doesn't lie when there's a hole)
and the shared contract (`doc-contract.test-helpers.ts`, exercised against
real `ArrayDoc`/`RgaDoc`/`Doc` instances with real insert/delete payloads
and causal chains, not just the toy payload the base's own tests use).

**`TextEncoder`/`TextDecoder` checked, not assumed, before deciding they
were unavailable.** Wire encoding needs UTF-8. Wrote a one-line file
using both under `packages/crdt`'s tsconfig and ran `tsc` directly against
it: `TS2304: Cannot find name 'TextEncoder'` / `'TextDecoder'` — confirmed
absent under `lib: ["ES2022"]` + `types: []`, exactly as the structural
half of gate 1 (DECISIONS #0004) intends. This is the gate doing its job
on a genuinely-reached-for global (encoding needs *some* UTF-8 mechanism,
and `TextEncoder` is the obvious first instinct), not a hypothetical.
Wrote a manual codepoint-based UTF-8 codec instead (`encodeUtf8`/
`decodeUtf8` in `encoding.ts`), verified by a 1000-run fast-check property
test round-tripping arbitrary strings, including multi-byte and
surrogate-pair code points.

**Prediction confirmed, closely.** Before running the 60,000-deletions
benchmark test, predicted "roughly 12-20 bytes, comfortably under the
cited 29" from counting the header, record type, four varuints, and a
3-byte count varuint by hand. Measured: 14 bytes. The docs' own cited
figure (29 bytes) was not independently re-derived or matched exactly —
noted honestly in the test name itself rather than implied — but the
qualitative claim (a single contiguous run of 60,000 deletions collapses
to a small constant, not 60,000 individual records) reproduces with room
to spare.

**A second wrong-assertion-not-a-bug, same shape as DECISIONS #0013's.**
A "replica table dedup" test asserted `encoded byte length < 20 ×
"solo".length` (80 bytes) for 20 insert ops sharing one replica id;
measured 185. Before treating this as an encoder bug, did the arithmetic
the assertion should have done first: 20 insert records each carry ~8-9
bytes of real per-op data (record type, id, origin presence + id, side,
char-length + char) *regardless* of how well the replica table dedups —
the assertion compared total output size against a number with no
principled relationship to what dedup actually saves. Rewrote the test to
check the actual claim directly: encode 20 ops sharing one long,
deliberately-distinctive replica id, and assert that id's UTF-8 byte
sequence appears in the output exactly once (a literal substring count),
not that some unrelated size bound holds. This is now the third time in
this log a hand-estimated numeric assertion turned out to be the wrong
thing to assert (#0013 for converged-string content, #0014 for the
ArrayDoc/RgaDoc ratio at one n, this one for total encoded size) — worth
naming as a pattern: a test asserting "this specific number" should assert
a number the code being tested actually determines, not one a human
free-hand estimated from an unrelated quantity.

## 0019 — Step 8: `packages/relay`, append-only log with cursor; a real bug this time, not a bad assertion — `req.destroy()` on an oversized body killed the connection before the 413 could be written

Built `LogStore` (UUID-validated doc ids, append/read with sequential
byte offsets, the three SECURITY §2.1 resource bounds — 1MB/message,
50MB/doc log frozen not evicted once reached, 10,000 docs with LRU
eviction — plus disk persistence and `replayFromDisk`), `RateLimiter`
(sliding window, injectable clock), `ConnectionLimiter` (per-IP count),
and `createRelayServer` (plain `node:http`, zero dependencies, per ARCH
§5). Gate 2 (relay ignorance) was the thing at risk here — every file was
written checking each addition against the ban list as it went, rather
than writing first and hoping the gate would catch it after.

Unlike the last three log entries, this one is a genuine implementation
bug, not a hand-estimated assertion. `readBodyWithCap` capped body size
by calling `req.destroy()` the moment `total > maxBytes`, on the
reasoning that destroying the stream stops it from doing any more work.
An integration test posting a body one byte over `MAX_MESSAGE_BYTES` and
asserting a 413 response failed instead with `fetch failed` /
`SocketError: other side closed` — the client never got a response at
all. Traced: `req` (`IncomingMessage`) and `res` (`ServerResponse`) share
the same underlying `Socket`; `destroy()` on the request tears down that
socket immediately, so by the time `handleRequest` tries to
`res.writeHead(413, ...)` there is no connection left to write to. The
cap was doing its one real job — refusing to accumulate more than
`maxBytes` in the `chunks` array, which is the actual OOM protection —
but destroying the transport was an unrelated and wrong way to enforce
it. Fixed by dropping `destroy()`: on overflow, set a `rejected` flag,
stop pushing further chunks (so memory use still stays capped) and reject
the promise, but leave the socket alone so `handleRequest` can write the
413 normally. The remaining request bytes are drained by the still-live
`data` listener and discarded — cheap, and the connection closes normally
once the client finishes sending. Left a comment on this at the fix site,
since a future reader's first instinct (mine included, ten minutes
earlier) is the same wrong "destroy stops the attack" reasoning; SECURITY
§4 already scopes bandwidth/CPU exhaustion beyond the memory cap as
out-of-bounds for a demo relay, so nothing further is owed here.

Full suite (crdt + sim + relay): 221 tests, all green, including the
now-passing 413 case. Both gates re-run clean. One live smoke check on
gate 2 before committing: temporarily added a function named
`isTombstone` to `packages/relay/src/index.ts` and confirmed the gate
still passed — read `relay-ignorance.mjs` afterward to check this wasn't
a false negative rather than assume it: the check is
`codeText.includes(needle)` against the literal, lowercase `"tombstone"`,
and `isTombstone` contains `"Tombstone"` (capital T), which is a
different string under `includes`. Not a gate weakness worth fixing —
`isTombstone` was a name I made up for the probe, not something a relay
implementation would plausibly need — but worth confirming by reading the
gate rather than guessing, since "the gate looked lenient" and "the gate
is lenient" are not the same claim. Reverted the file; `git status`
afterward showed only the intended two-line `index.ts` diff plus the new
relay files, nothing left from the probe.

## 0020 — Step 9: `packages/provider`, local persistence + reconnect + sync loop; S9 demonstrated with in-process doubles, a real crdt-package gap found by predicting the relay's actual data model before writing the pull path

Built `Provider` (owns a `Doc`, a `Persistence`, a `RelayTransport`; no
offline queue, exactly ARCH §6's `doc.missingFrom(lastPushedVector)`),
`InMemoryPersistence` and `IndexedDbPersistence` (real IndexedDB, tested
against `fake-indexeddb` rather than mocked away — a real implementation
under test, the same principle as Step 8 testing `LogStore` against a
real disk directory instead of a stubbed filesystem), and
`HttpRelayTransport` (`fetch` against the exact §5 contract). Per the
ladder's own split — Step 9's gate is "S9 passes," Step 10's is "S9
demonstrable" — S9 ("offline edits survive reload and reconcile on
reconnect") is already proven at this step, with the provider's own
in-memory doubles (`InMemoryPersistence`, a `FakeRelay` shared-byte-log
stand-in built in `provider.test.ts`); Step 10 is where a real relay and
a real browser storage layer run together end to end, not where S9 first
becomes true.

**A real gap in the crdt package, found by predicting the data shape
before writing code, not by hitting a bug afterward.** Before writing
`Provider.sync()`'s pull half, worked out on paper what a `GET
/doc/:id?from=N` response actually contains once more than one client has
pushed to the same doc: ARCH §5 says the relay "appends bytes and hands
back bytes from an offset" with no framing of its own, so that response
is the raw concatenation of however many separate `POST` bodies (each one
its own `encodeOps` blob) landed since offset N — not one blob.
`decodeOps` as it stood decoded exactly one blob and silently stopped,
dropping everything appended after it, because its own `recordCount`
loop has no reason to know a second blob follows. Predicted this would be
a real problem before it manifested as a failing test, not after — and
fixed it at the source rather than routing around it in the provider:
refactored `decodeOps` onto a position-aware primitive
(`decodeOpsFrom(bytes, pos)`, unexported) and added `decodeOpsStream`,
which loops that primitive until the buffer is exhausted. Predicted the
loop would "just work" with no edge cases, since every blob is
self-delimiting by construction (its own replica table + record count
say exactly how many bytes it occupies) — verified via a 500-run
fast-check property test concatenating up to 6 independently-encoded
op batches and confirming `decodeOpsStream` recovers the flat
concatenation exactly, plus the empty-buffer case (a doc nobody has ever
pushed to). Prediction held on the first run, no surprise. This is a
crdt-package (wire-format) addition, not a provider-local workaround —
correctly scoped, since "what does concatenating two blobs decode to" is
a property of the format itself, and any future consumer reading a
growing append-only byte log needs the same answer. Both gates re-run
clean; the addition introduces no ambient time/randomness/DOM reference,
so gate 1 was never at risk.

**Persistence stores a fresh full-log re-encode, not raw historical relay
bytes — sidesteps the concatenated-blob problem entirely for the reload
path.** `doc.missingFrom(new Map())` (an empty vector covers nothing, so
"missing from it" is the entire integrated log) gives the complete op set
on demand; `persistNow()` calls `encodeOps` on that fresh each save. This
is always a single self-contained blob, decoded with plain `decodeOps`
on reload — `decodeOpsStream` is needed only for `RelayTransport.read`'s
output, which genuinely does span multiple pushes over time. Keeping the
two paths on the right primitive (single-blob for "the whole doc, encoded
once," stream for "raw bytes off an append-only wire") avoids reaching for
the more general tool where the narrower one already fits.

**`lastPushedVector` must be updated for pulled ops too, not just pushed
ones — checked by mutation, not left to trust.** The sync loop pulls
before it pushes (ARCH §6's own ordering: "reconnect, ask the relay for
its cursor, compute the delta, push"). If ops received during the pull
weren't also folded into `lastPushedVector`, the very next call to
`doc.missingFrom(lastPushedVector)` would still count them as "ours to
push," and the replica would immediately re-encode and re-append content
it just downloaded — silently, since `Sequence.receive` is idempotent so
nothing would look wrong locally, only the relay log would grow without
bound. Wrote a test asserting the relay log's byte length is unchanged
after a second replica pulls once and then syncs again with nothing new
of its own. Before trusting the green run, mutation-tested it: deleted
the pulled-ops-into-`lastPushedVector` update, reran — the "does not
re-push" test failed exactly as predicted (extra bytes appended), along
with, separately, both S9 reload tests failing under an independent
mutation (a persistence save that dropped the op log to empty) — restored
the real code afterward and confirmed a clean rerun. Both mutations were
reverted before committing; neither survives in the shipped code.

**TypeScript 5.7+'s generic `Uint8Array<ArrayBufferLike>` doesn't
structurally satisfy lib.dom.d.ts's `BodyInit`, checked against this
repo's actual toolchain (TS 5.9.3) rather than assumed from general
awareness of the issue.** `fetch(url, { method: "POST", body: bytes })`
failed to typecheck (`TS2769`) once `HttpRelayTransport` was written
against a real `Uint8Array`. Verified this wasn't a design mistake on my
part — a plain `Uint8Array` genuinely is a valid runtime fetch body —
before reaching for a cast; fixed narrowly at the one call site
(`bytes as BodyInit`) with a comment naming the mismatch, rather than
loosening a type more broadly to make the error disappear.

**`provider`'s own tsconfig adds `"lib": ["DOM"]`, scoped to that package
only.** Needed for `indexedDB` and `fetch`'s DOM-flavored types (already
available via `@types/node` without DOM, as relay's tests already showed,
but `IDBDatabase`/`IDBOpenDBRequest` etc. are DOM-only). Checked, not
assumed, that this doesn't collide with `@types/node`'s own overlapping
declarations (`fetch`, `Response`, ...) before writing real code against
it: compiled a throwaway probe file referencing both `indexedDB.open` and
`fetch` under `lib: ["ES2022", "DOM"]` plus the ambient `@types/node`
already in the workspace — clean, no duplicate-declaration errors — then
deleted the probe. `packages/crdt`'s `lib: []`/`types: []` restriction
(gate 1) is untouched; this only loosens `provider`, which was never
gated.

243 tests (22 new: 3 in `packages/crdt/src/encoding.test.ts` for
`decodeOpsStream`, 19 across `packages/provider`'s three test files).
Lint, typecheck, and both gates clean.

## 0021 — Step 10: offline-first integration test, real relay + real IndexedDB; the runtime prediction held, the build-graph friction was a genuine surprise

Added `packages/provider/src/offline-first.test.ts`: the same "offline
edits survive reload and reconcile on reconnect" scenario Step 9 already
proved against in-process doubles, rebuilt against the real things — a
real `createRelayServer` (`packages/relay`, bound to `127.0.0.1:0`, real
HTTP) and real `IndexedDbPersistence` (backed by `fake-indexeddb`, the
same implementation Step 9's `persistence.test.ts` already exercises
directly, not a new mock). Two replicas, two independent
`IndexedDbPersistence`/`HttpRelayTransport` pairs, one shared real relay:
A writes "hello" offline, reloads (new `Provider`, same doc id, same
fake-IndexedDB backing store), reconnects and pushes over real HTTP; B
pulls and sees "hello"; B appends "!" and pushes; A pulls it back. Stated
the prediction in the test file itself before running: since `Provider`'s
logic, `HttpRelayTransport` against a real server, and `IndexedDbPersistence`
against a real IndexedDB API were each independently verified in Steps 8
and 9, assembling them should reproduce the doubles' result exactly, with
no new algorithmic finding to make here — this step is about the pieces
fitting together, not about discovering new behavior. Ran clean first
try; mutation-tested it anyway rather than trust a first green run alone
(commented out the reconnect call and the pendingCount assertion after
it) — the reconciliation assertion failed exactly as predicted (`b.text`
empty instead of `"hello"`, since nothing had reached the relay), then
reverted the mutation. The runtime prediction held without qualification.

**What wasn't predicted: `tsc -b`'s project-boundary enforcement, not a
CRDT or sync-loop question at all.** The test imports `createRelayServer`
from `packages/relay/src/server.js` via a relative path — deliberately
not a package dependency; ARCH §1's graph has no `provider → relay` edge
and adding one as even a devDependency would misstate what a browser
bundle of `provider` needs. That relative import runs fine under Vitest
(esbuild transpiles per-file, no project-reference awareness), but
`tsc -b` — used for the real `pnpm run typecheck`, not Vitest — enforces
that every file a composite project's sources reach must live under that
project's own `rootDir`; reaching into `packages/relay/src` from inside
`packages/provider/src`'s build failed with `TS6059`/`TS6307`. This
wasn't something reasoned about in advance and confirmed — it surfaced
directly as the typecheck failure, the honest order of events. Root
cause once seen: `tsc -b`'s composite-project model and a plain relative
import crossing a package boundary are fundamentally in tension, same
family of problem `packages/crdt/tsconfig.test.json` already exists to
solve (Step 7/Step 8 era) for a different reason (relaxed lib/types for a
test file, not a cross-package reach) — recognized the shape and reused
the pattern rather than inventing a new one: excluded
`src/offline-first.test.ts` from `packages/provider/tsconfig.json`'s main
build, and added a standalone `packages/provider/tsconfig.test.json`
(`composite: false`, `noEmit: true`, including that one test file plus
`packages/relay/src/**/*.ts` minus relay's own test files) run as a third
step in the root `typecheck` script. `packages/provider/package.json`
still declares only `starling-crdt` — the dependency graph itself never
changed, only what the standalone typecheck pass is allowed to *see*.

**Where the test lives, and why not a new top-level `tests/` package.**
Considered a root-level `tests/integration/` directory (parallel to
`packages/` and `tools/`) before writing this. Rejected empirically, not
on style grounds: pnpm's default workspace linking is strict (no
hoisting to the root `node_modules` for a package's own deps), confirmed
by checking that `fake-indexeddb` — a real devDependency of
`packages/provider` — isn't resolvable from the repo root at all
(`ls node_modules/fake-indexeddb` — not found; only inside
`packages/provider/node_modules/fake-indexeddb`, symlinked there for
that package specifically). A test file physically outside any package
couldn't resolve `import "fake-indexeddb/auto"` by bare specifier without
either becoming a new declared workspace package (a 7th package outside
ARCH §1's six-package graph — real scope creep for a single test file)
or falling back to a deep relative import into another package's
`node_modules` (fragile, and exactly the kind of thing gate 1's own
grep-ban on indirection would frown on in spirit even where it doesn't
literally apply). Placing the file inside `packages/provider/src/`
sidesteps both: every bare specifier it needs (`starling-crdt`,
`fake-indexeddb`) already resolves correctly there, and only the one
cross-package relative import (`createRelayServer`) needed the
`tsc -b` workaround above.

244 tests (1 new). Lint, typecheck (all three steps), and both gates
clean; `gate:relay-ignorance` only scans `packages/relay/src`, so a test
elsewhere importing from it doesn't touch that gate's scope at all.

## 0022 — Step 11: anchors (S10) + awareness; a real bug in new code, caught by the property test my own hand-trace failed to anticipate, plus two test-authoring bugs from the same wrong assumption

Added `Anchor`/`AnchorSide` and `Doc.anchorAt`/`Doc.resolveAnchor` (ARCH
§7 / S10: "a cursor is not an index, it is an ElemId plus a side"),
and `packages/provider`'s `AwarenessClient` (ARCH §7's ephemeral
presence: LWW per replica, TTL, never persisted, never in the op log,
over "the same relay, on a separate channel").

**`countLiveBefore` had a real bug, found by the property test, not
predicted in advance.** Before writing it, hand-traced the intended
algorithm (walk the tree, accumulate live counts strictly before a
target node) against three cases — mid-chain, first node, a tombstoned
node — all using a flat right-child chain with no non-empty left
buckets anywhere near the target, and all confirmed correct by hand.
Wrote the code, wrote a round-trip property test (`resolveAnchor(anchorAt(i))
=== i` for every valid `i`, across trees produced by 500 random
insert/delete sequences), and it failed on the very first shrunk
counterexample: two inserts of the same character both at index 0 (a
2-node left-leaning chain). Root cause: the function added a node's own
left-bucket live count to the running total *after* checking whether that
node was the target, so a target whose own left bucket held live content
returned the accumulated total from *before* that content was counted —
undercounting by exactly the live size of the target's own left bucket.
Every hand-traced case had an empty left bucket sitting under the target,
so the bug was invisible to hand-verification and would have shipped
silently without the property test; fixed by moving the
`acc += bucketLiveSize(node.left)` line before the `node === target`
check, re-verified by hand against the original three traces (unaffected,
since they all had empty left buckets — the reorder is a no-op exactly
where the original reasoning was checked, and the fix exactly where it
wasn't) and against the counterexample (now returns the correct 1, not
0). This is the pattern the whole session has been watching for in the
opposite direction — DECISIONS #0013/#0014/#0018/#0021 all found a wrong
*test* assertion and confirmed the *implementation* was fine; this is the
first Step in a while where the property test caught the implementation
being wrong instead, which is exactly what a property test is for and
worth naming as a genuine positive result, not just noting the bug.

**Two test-authoring bugs from the same wrong assumption, found while
writing (not from the property test) — logged rather than quietly fixed
in place, per the standing pattern.** Two hand-written anchor tests had
two independent `Doc` instances each build content from scratch (one
"world", one "hello ") with no causal relationship to each other, then
merged, asserting the merged order matched real-world intuition ("hello"
should end up before "world" since it was meant to represent an insert
happening first"). That assumption is false: two *independent* root-level
insertions have no causal order, so Fugue's id tie-break (not arrival,
not intent) decides where they land relative to each other. One test
happened to pass anyway, because the specific replica names chosen
("B" sorting after "A") produced the tie-break result the test wanted by
coincidence, not because the reasoning was right. A second test built the
mirror-image scenario with the same flawed setup and got the *other*
tie-break outcome, failing outright and exposing the assumption. Fixed
both by making the "remote" replica actually receive the first replica's
ops *before* typing its own — the realistic shape of "insert relative to
existing content" (one shared history, not two independently-built ones
merging) and the only way to get a deterministic before/after relationship
out of Fugue at all, since `insertLocal`'s origin is always relative to
whatever that replica has already integrated.

**Awareness's wire format is newline-delimited JSON, not the crdt
package's binary encoding, and that's a deliberate scope boundary, not
an oversight.** ARCH §3.1's byte-budget concern (the 60k-deletions
target, LEB128 varints, a hand-rolled UTF-8 codec) is specifically about
the CRDT op log, whose per-character cost matters. Presence pings don't
have that volume, so NDJSON's simplicity (self-delimiting via `\n`, no
custom framing needed, unlike the concatenated-blob problem
`decodeOpsStream` exists to solve for the content channel — see #0020)
was chosen over reusing or extending the crdt wire format for a payload
shape that format was never designed for. "Never persisted" was enforced
structurally rather than tested: `AwarenessClient` has no
`Persistence`-shaped constructor argument at all, so there is nothing to
assert an absence of.

**Channel-id selection for awareness is the caller's responsibility, left
unresolved on purpose.** ARCH §7 says awareness travels "over the same
relay, on a separate channel" but doesn't say how that channel's id
relates to the content doc's id, and the relay validates every id as a
strict UUID (SECURITY §2.2) — `${docId}:awareness}` is not a valid one.
Considered deriving a second UUID deterministically from the first
(bit-twiddling a fixed nibble) and rejected it: ARCH specifies no such
scheme, and inventing one now would be exactly the kind of undocumented
design decision this log exists to flag, for a problem that has an
obviously simpler answer — a caller (the demo app, Step 14) can just mint
and store a second UUID alongside the first. `AwarenessClient` takes
whatever `RelayTransport` it's given, same as `Provider`'s content sync.

Mutation-tested both of `AwarenessClient`'s non-obvious behaviors before
trusting green: disabling the LWW timestamp comparison (`|| true`)
broke exactly the out-of-order test designed to catch it; disabling the
TTL filter broke both TTL tests. Both reverted before committing.

258 tests (14 new: 7 anchor tests in `packages/crdt/src/fugue-doc.test.ts`,
7 in `packages/provider/src/awareness.test.ts`). Lint, typecheck, and
both gates clean — the anchor code adds no ambient time/randomness/DOM
reference, so gate 1 was never at risk from this step.

## 0023 — Step 12: ProseMirror binding (`packages/editor`), headless; a scaffold-guess dependency corrected, and a third instance of the "independently-built docs aren't the same doc" test bug

Built the whole of FRONTEND §1: a minimal single-paragraph, no-marks
`Schema` (`schema.ts`) matching the CRDT's own flat-character-sequence
model one to one; `positions.ts` (`pmPosToVisibleIndex`/
`visibleIndexToPmPos`, the one place visible-index/PM-position
conversion happens, per FRONTEND §1.2's "visible indices exist only at
the boundary, and die inside it"); and `binding.ts`
(`transactionToOps`, `opsToSteps`, `pmDocFromDoc`, `pmPosToAnchor`/
`anchorToPmPos` for §1.3's anchor-based selection). All of it runs
against plain `prosemirror-model`/`-state`/`-transform` — no
`prosemirror-view`, no DOM, no jsdom — satisfying F1 by dependency
absence rather than test-environment discipline (checked directly: a
test imports `"prosemirror-view"` via a non-literal specifier — a
literal would make `tsc` try to resolve it at typecheck time, defeating
the point — and asserts the import rejects, since `packages/editor`'s
own `node_modules` genuinely has no such symlink).

**Corrected a Step 0 scaffold guess: `packages/editor` depends on
`starling-crdt` directly, not `@starling/provider`.** ARCH §1's diagram
(`demo → editor → provider → crdt`) was read literally at Step 0 and
`packages/editor/package.json` was scaffolded with `@starling/provider`
as its only workspace dependency. Building the actual binding surfaced
that it doesn't touch `Provider` at all — `transactionToOps`/`opsToSteps`
work directly against a `Doc` (calling `insertLocal`/`deleteLocal`/
`receive`/`anchorAt`/`resolveAnchor`, none of which `Provider` exposes;
its own surface is deliberately narrow and network-focused, ARCH §6).
Read the graph's own separately-stated `sim → crdt` edge (outside the
main `demo → editor → provider → crdt` chain) as precedent that a
skip-level edge is allowed when a package's actual job needs it — `sim`
needs raw CRDT types for the same reason `editor` does here, and neither
is a violation of "strictly downward," only same-direction shortcuts.
Removed the unused `@starling/provider` dependency and its matching
`tsconfig.json` project reference, added `starling-crdt` and a reference
to `../crdt` instead. (`Provider` and the editor binding remain two
separate consumers of one shared `Doc` instance — wiring them together
is Step 14's job, not this one's.)

**`opsToSteps` integrates and computes each op's position one at a time,
not the whole batch up front — reasoned out before writing it, not found
by a failing test.** Each PM step's position must be expressed relative
to the PM document *as the caller's own steps-so-far have built it up*,
but `Doc.resolveAnchor` always reflects the *entire* current tree. Pre-
integrating a whole remote batch before computing any positions would
make an early op's computed position already account for a later op's
insertion — correct against the CRDT's final state, wrong against the
partially-rebuilt PM document at the point that early step is actually
applied. Interleaving `doc.receive(op)` with position computation, one
op at a time, keeps the two document representations in lockstep at
every intermediate point, not just at the end. Documented as a
precondition rather than defended against: ops must arrive in
dependency-satisfying order, which every existing producer of a CRDT op
stream in this codebase (`Sequence.log`, `missingFrom`, `decodeOpsStream`)
already guarantees by construction (DECISIONS #0006, #0020) — an op
handed to `opsToSteps` out of that order is the caller's bug, and
`resolveAnchor` throwing on an unintegrated id is the same "fail loudly,
not softly" behavior `insertBefore` already has elsewhere in `Doc`.

**A third instance of the "two independently-built docs aren't the same
document" test bug (see #0022) — this time in a delete test, and the
sharpest version yet.** A test built `a` and `b` as two *separate* `Doc`s
that each independently typed "hello" via their own local inserts,
producing entirely different `ElemId`s per replica despite rendering
identical text, then tried to replay one of `a`'s delete ops (naming an
`a`-specific target id) into `b`. `resolveAnchor` correctly threw "id not
found" — not a binding bug, a test bug: a delete op only means anything
to a replica that has already integrated the specific insert it targets,
and two replicas typing the same string independently never do. Fixed by
having `b` receive `a`'s insert ops first (`a.missingFrom(new Map())`,
reused from DECISIONS #0020's "empty vector means everything" trick),
*then* replaying the delete generated by a later transaction on `a`. This
is now three occurrences of the same underlying mistake across two steps
(#0022's two anchor tests, this one) — worth stating as a standing rule
rather than re-deriving it per test from here on: **whenever a test needs
two replicas to "have the same content," one must receive the other's
actual ops; typing matching-looking text independently on each is never
equivalent, no matter how obvious it looks in the assertion.**

Mutation-tested the position boundary math (`visibleIndexToPmPos` off by
one) before trusting the suite: broke 3 of the 11 binding tests exactly
as expected (a step-application failure, a delete landing on the wrong
character, the anchor test's resolved position off by one), confirming
they're load-bearing and not passing for an unrelated reason. Reverted
before committing.

269 tests (11 new, all in `packages/editor/src/binding.test.ts`). Lint,
typecheck, and both gates clean.

## 0024 — Step 13: undo manager, S11; a genuine algorithmic finding surfaced by a wrong test prediction, correctly told apart from a bug

Added two small `Doc` primitives undo needs and doesn't already have:
`deleteById(id)` (delete a specific character regardless of its current
visible index — `deleteLocal` only takes a visible index, and undo
fundamentally operates on ids, same reasoning as `resolveAnchor` in
DECISIONS #0022) and `charForId(id)` (read a — possibly tombstoned —
character's value; undoing a delete needs to know what was deleted, and
the tombstone, never actually removed from the tree, is the only place
that value still lives). Refactored `binding.ts`'s `opsToSteps` to split
out `opToStep` (pure: PM step for an *already-integrated* op) from the
`doc.receive` + position-computation loop around it — undo's own ops are
integrated the moment `deleteById`/`insertBefore` create them, so reusing
`opsToSteps` (which calls `receive` again) would be wrong, not just
redundant; `opToStep` alone is exactly the reusable half. Built
`UndoManager` (`packages/editor`, per FRONTEND §1.4's placement) as a
per-batch LIFO stack of `{kind: "insert", id}` / `{kind: "delete",
tombstoneId, char}` entries, undone in reverse within a batch (last
sub-edit first). No ProseMirror import in the file at all — undo
operates purely on `Doc`, turning its output into PM steps is the
caller's job via the newly-exported `opToStep`. No redo: not named
anywhere in the four spec docs, so not built.

**A wrong hand-derived test prediction that turned into a real, useful
algorithmic finding — told apart from a bug by measuring before
concluding, the same discipline as DECISIONS #0013/#0014/#0018/#0021/#0022/#0023.**
The S11 test built replica A's "hello", had replica B (having already
received it) insert "XXX" at visible index 3 (structurally anchored to
the first 'l'), and predicted the merged text would render
`"helXXXlo"` — X's appearing between the two 'l's, matching the origin.
Measured `"helloXXX"` instead: X's rendered at the very *end*. Traced by
direct measurement (a throwaway script, not further hand-tracing, after
two wrong hand-traces already in one sitting) rather than guessing
again: "hello" is a right-child chain (h→e→l₁→l₂→o); X's origin is l₁
with side "R", landing in l₁'s right *bucket* — which already contains
l₂ (with counter 3) as an existing sibling. Right buckets sort
*descending* by id (`compareElemIds`: counter first, replica as
tiebreak), and B's fresh id has counter 0 (B has made no local edit
before this point, so its own counter starts at 0 regardless of how many
ops it has *received*) — lower than l₂'s counter 3, so X sorts *after*
l₂'s entire subtree (which includes 'o') in the bucket, not before it.
This is correct, deterministic Fugue behavior, not a bug: verified by
reproducing the *opposite* outcome (`"helXlo"`) in an isolated script
where B built "hello" itself first, giving its own subsequent inserts
higher counters than the existing chain — same code, different id
history, different (still fully deterministic) rendered order. The
general shape worth naming: **inserting "at visible index N" places a
new character as an `(origin, side)` sibling, tie-broken by id against
whatever else is already anchored to that same origin — it does not
guarantee landing at index N in the final tree the moment anything else
is already chained there with a higher-sorting id, even when that
something else arrived first.** Fixed the test by asserting content via
a code-point multiset (`codePointCounts`, added to this file) rather
than the specific rendered string, since the test's actual claim (undo
removes exactly the right characters regardless of where a
structurally-nested remote insert renders) never depended on the exact
visual position in the first place — the wrong assertion was in what was
checked, not in a flawed test design.

Mutation-tested the core "undo targets ids, not positions" claim:
swapped `doc.deleteById(entry.id)` for `doc.deleteLocal(0)` (a position-
based stand-in) and reran — 3 of 10 tests failed as expected (the LIFO
test, the within-batch-reverse-order test, and the restore-property
test), confirming they'd catch a regression to position-based undo.
Reverted before committing.

283 tests (14 new: 4 `Doc.deleteById`/`charForId` tests in
`packages/crdt/src/fugue-doc.test.ts`, 10 in the new
`packages/editor/src/undo.test.ts`). Lint, typecheck, and both gates
clean.

## 0025 — Step 14: demo app, verified in a real Chromium via Playwright, not just built; six real bugs found by actually running it, none of them findable by unit tests alone

Built `packages/demo`: React + Vite, `EditorPane` (owns one replica's
`Doc`/`Provider`/`AwarenessClient`/ProseMirror `EditorView`, wired
together — Step 9's DECISIONS #0020 note ("wiring Provider and the
editor binding together is Step 14's job") finally cashed in), two
panes plus a query-param-triggered solo third-replica view, connection
toggles, pending counters, coloured remote cursors as widget
decorations, a debounced sync/awareness poll loop, and the visual
direction (near-monochrome shell, amber/teal as the only colour,
self-hosted `@fontsource/space-grotesk` + `@fontsource/jetbrains-mono`
— no Google Fonts CDN, SECURITY §1). This entry is long because this
step, more than any other, produced findings a unit-test-only approach
would not have caught: this repo has a real Chromium pre-installed, so
FRONTEND §2.3's three demonstrations and F3-F7 were driven end to end
with Playwright (`packages/demo/e2e/demo.spec.ts`) against the actual
built app, not inferred from the pieces' own unit tests being green.
Every one of the six bugs below was found by that suite failing first,
not by inspection.

**1. `schema.ts` had no `toDOM`, and nothing through Step 12 could have
noticed.** The first real `EditorView` mount threw `node.type.spec.toDOM
is not a function` — Step 12's binding was verified against the model
layer only (FRONTEND §1.1, deliberately no `EditorView` in the loop), so
a schema missing the DOM-rendering half of its node specs typechecked,
built, and passed all 22 binding/undo tests without a single test ever
constructing a view to expose the gap. Fixed by adding `toDOM`/`parseDOM`
to `paragraph` (text nodes need neither, matching
`prosemirror-schema-basic`'s own `text` spec). Worth naming plainly: this
is exactly the kind of gap "headless, node-testable" is structurally
unable to catch, by design — Step 12's own tests were never wrong, they
were just never going to see this.

**2. Cross-test relay-state leakage in the e2e suite, not a sync bug —
looked exactly like one at first.** Playwright's `webServer` starts the
dev relay once for the whole run; `config.ts`'s `DOC_ID` was a fixed
constant (matching FRONTEND §2.5's "no document list"), so every test
after the first inherited whatever text prior tests had already pushed.
First symptom looked like a genuine convergence failure. Traced with a
throwaway console-logging script before touching any source: two
replicas typing different strings converged correctly; the "wrong" text
was just accumulated history. Fixed by adding a `?doc=`/`?awareness=`
URL-param override to `config.ts` (validated as UUID-shaped, silently
ignored if malformed or absent — a stray visitor's URL never breaks
anything), used only by the e2e suite (`beforeEach` mints a fresh pair
per test) and carried forward by the third-replica button so a solo tab
joins the *same* document instead of silently falling back to the fixed
default.

**3. The core bug: offline edits were never persisted, because
persistence only ever happened inside `sync()` — and `sync()` is exactly
the call an offline replica skips.** `Provider`'s own
`insertLocal`/`deleteLocal`/`insertBefore` each call a private
`persistNow()` after mutating `.doc`; `EditorPane` drives `.doc` directly
through the editor binding instead (DECISIONS #0023's whole point — the
binding needs `Doc`'s full API, not Provider's narrow network-facing
one), which never touched `persistNow()` at all. Local edits were
visible in the UI immediately (`.doc.text` is live) and looked completely
normal until reload, at which point everything typed while offline was
silently gone — the F6 e2e test caught it on the very first run.
Confirmed the mechanism by reading IndexedDB directly after typing
offline: `opLogBytes` was the *empty* `encodeOps([])` blob, two bytes,
despite visible on-screen text. Fixed by making `persistNow()` public on
`Provider` and calling it from `EditorPane` after every local edit
(typing and undo both) regardless of online state — persistence must
never depend on network state, which is the entire point of "offline
edits survive reload" (ARCH §6, S9). Added a regression test at the
`Provider` level (`provider.test.ts`): edit `.doc` directly, call
`persistNow()`, reconstruct a fresh `Provider` from the same
persistence, assert the reload sees it — mutation-tested by commenting
out the `persistNow()` call, confirmed it fails exactly as expected.

**4. `IndexedDbPersistence.save()` could commit out of call order under
concurrent calls — a real race, found by the fix above exposing it.**
Once every keystroke started calling `persistNow()`, reload tests
recovered only a *prefix* of what was typed (e.g. "never-" instead of
"never-left-this-browser") — not corruption, a partial, in-order-looking
truncation, which was the tell. `save()` opens and closes its own
IndexedDB connection on every call; nothing guaranteed the transaction
from the *last* call was also the one to *commit* last once several were
in flight at once. Fixed by serializing every `load()`/`save()` call
through one `Promise` chain on the instance, forcing strict call-order
execution — the general fix (protects any caller, not just this one
call pattern), at the layer that owns the invariant. Honest caveat: a
concurrency regression test was added
(`persistence.test.ts`, "N unawaited save() calls... resolve in call
order") and mutation-tested by removing the queue — it did **not**
reproduce the failure under `fake-indexeddb`, three runs in a row.
`fake-indexeddb`'s internal scheduling is apparently deterministic
enough not to exhibit the interleaving real browser IndexedDB does. The
fix's actual confirmation is the e2e suite (a real Chromium) going from
failing to passing, not the unit test — logged plainly rather than
implying the unit test proves what it doesn't; it stays because it
documents the invariant and may still catch other ordering violations,
not because it caught this one.

**5. Debounced persistence, for a second reason beyond fix #4's queue.**
Even serialized, dozens of sequential full IndexedDB open+transaction+
close cycles for one typed sentence take long enough that a reload
shortly after typing stops can still land before the queue drains —
found by the same F6 test still failing (now with more of the string
recovered, not none) after fix #4 alone. `EditorPane` now coalesces
`persistNow()` calls into one, ~250ms after the last local edit, which
is both the performance fix (one write instead of dozens) and what
closes the reload-race window in practice; the e2e test itself was
adjusted to wait past the debounce before reloading, matching FRONTEND
§2.3.3's own framing ("reload the page while offline with pending
ops" — a believable pause, not a zero-latency race the app never
promised to win).

**6. `UndoManager`'s own documented contract — "one call, one undo step,
matching ordinary editor UX, not one character at a time" — was never
actually honored by the code driving it.** `EditorPane` called
`undoManager.record()` once per `dispatchTransaction`, and ordinary
typing produces one ProseMirror transaction per keystroke, so a single
Ctrl-Z undid exactly one character ("hello" → "hell"), not the word —
the F4 e2e test caught this directly. Not a bug in `UndoManager` itself
(Step 13's own unit tests, all still green, verify precisely what
`record()`/`undo()` do per call) — the gap was between what its docstring
promised and how the only real caller actually drove it. Fixed by
buffering local ops in `EditorPane` and flushing them as one `record()`
call after a 500ms pause, with an immediate flush before `undo()` itself
runs (so a burst still being typed isn't stranded un-recorded by an
undo that arrives before the pause window closes) — grouping policy
lives at the UI layer, matching how real editors decide "what counts as
one undo step" as a UX choice, not a core-mechanism one.

**Two things chased that turned out not to be bugs, logged for the same
reason the real ones were.** First: clicking pane B to type into it (an
artifact of both replicas sharing one browser tab in the e2e suite — a
real second user's separate browser would never do this to pane A's
focus) moves DOM focus away from pane A, so the F3 test's follow-up
keystroke initially typed nowhere useful; fixed the *test*
(`.focus()`, not `.click()`, to reclaim focus without repositioning the
already-anchor-correct selection) rather than the app. Second, a fourth
instance of the DECISIONS #0022/#0024 pattern: F3 asserted the merged
text couldn't *start* with `"!"`, assuming `"hello "` would render before
`"world"` — measured `"!worldhello "` instead, B's insert (causally
anchored before A's cursor) rendering *after* it in the final string
because of Fugue's counter tie-break, not intent or arrival order. The
test's actual claim (the cursor followed the character it was anchored
to, proven by `"!world"` landing adjacent) never needed the ordering
assumption; removed it rather than construct an artificial scenario to
force a specific rendered string.

Design choices made without a specific doc citation, stated plainly:
fixed `DOC_ID`/`AWARENESS_ID` UUIDs (FRONTEND §2.5's "no document list"
read literally — one demo, one document, always); each pane's
`IndexedDbPersistence` key is `${docId}:${paneId}`, not just `docId` —
two "independent replicas" sharing one physical browser need separate
local-storage namespaces for something that would, in reality, be two
separate devices; a stable per-pane replica id in `localStorage`
(generated once, kept across reloads — S9 requires *the same* replica
resuming, not a fresh one); the third-replica view reuses one of the
two accent colours rather than needing a third, since the point being
demonstrated (two is not a special case) doesn't need three
simultaneously-visible ones to make it; two self-hosted type families
via `@fontsource` (Space Grotesk for display/UI text, JetBrains Mono for
editor content and numeric readouts) rather than three separate
families for FRONTEND §3's "one display face, one text face, one
mono" — a defensible reading of that line, not a literal one, given
this demo's own minimalism mandate.

**A seventh fix, found by reasoning while wiring `runUndo`, before any
Playwright run — not part of the "six bugs the suite caught" count
above.** Writing `EditorPane`'s undo handler surfaced the same pre-batch-
integration hazard `opsToSteps` was built to avoid (DECISIONS #0023),
this time on `UndoManager.undo()`'s own output: converting a whole
batch's ops to PM steps *after* `undo()` had already fully applied all of
them would compute each step's position against the already-fully-undone
tree, not the tree as it stood right after the *previous* step — wrong
for anything beyond a simple contiguous-prefix batch. Fixed by giving
`undo()` an `onOp` callback invoked immediately after each sub-op is
created (`undo.ts`), the same interleaving discipline `opsToSteps`
already has. Verified with a sharper test than Step 13's original:
undoing two non-adjacent inserts with unrelated live content between
them — hand-predicted the exact wrong result a non-interleaved version
would produce ("xBz" instead of "xyz") before writing the fix, then
confirmed it by temporarily reverting to the post-hoc form and getting
that exact string. Lands in `packages/editor/src/undo.test.ts` (Step
13's file) since it's `UndoManager`'s own contract, even though the gap
was found while building Step 14.

299 tests (11 new e2e specs run via `playwright test`, not `vitest` —
outside the 288-test `pnpm run test` count above; 5 new unit tests: 2
concurrency tests in `persistence.test.ts`, 2 in `provider.test.ts`
(the `.doc`-exposure test and the `persistNow()` regression test), and
1 in `undo.test.ts` — the non-adjacent-inserts `onOp` interleaving test
from the seventh fix above). Lint, typecheck (a fourth standalone step,
`packages/demo/tsconfig.e2e.json`, mirroring the
Step 7/10 pattern for out-of-normal-scope test files — here because the
e2e suite needs DOM lib types `tsc -b`'s composite build doesn't carry),
and both gates clean. The e2e suite itself isn't part of `pnpm run
test`/CI's normal vitest run (Playwright, a different runner, a real
browser) — run via `pnpm --filter @starling/demo run e2e`, documented
here rather than silently absent from the numbers above.

## 0026 — Step 15: benchmark suite finds two real crash bugs and one genuine, honestly-reported performance miss (`Doc` fails S6 by ~168x, loses to Yjs by ~36,800x on cold-open) — none of it fixed beyond the crashes, by design

**Step:** 15

Built `bench/` (`cold-open.mjs`, `encode-decode.mjs`, `memory.mjs`,
`yjs-comparison.mjs`, this directory's own `README.md` with the committed
numbers) per ARCH §9's checklist. Predicted going in, based on the S6
gate already passing (`rga-doc.test.ts`, `RgaDoc`@100k, 412ms) and `Doc`
being "the correctness-focused successor" to `RgaDoc`: `Doc` would be in
the same ballpark, plausibly a bit slower from Fugue's extra tree-shape
bookkeeping, but nowhere near a 1s target's order of magnitude. Wrong, in
a way worth recording as a finding in its own right, distinct from the two
crash bugs below.

**Bug 1 (crash): `fugue-doc.ts`'s tree-walking functions were recursive,
one stack frame per character, on the exact tree shape a real user
produces by typing forward without pausing (a single-sided chain, depth =
document length).** `nodeAtVisibleIndexWithin`/`nodeAtVisibleIndex`
(`insertLocal`/`deleteLocal`/`anchorAt`), `inOrderWalk` (the `.text`
getter), and `countLiveBefore` (`resolveAnchor`) all crashed
(`RangeError: Maximum call stack size exceeded`) well under 30,000
characters — found by a throwaway benchmarking script during this step,
not reasoned out in advance, and not caught by any of the 288 existing
tests because none of them build a document anywhere near that long.
This is not a cold-open-only problem: `insertLocal` calls
`nodeAtVisibleIndex` too, so a single replica typing a moderately long
document *live* would have hit this, in production, with no remote peer
involved at all. Fixed by rewriting all three as explicit-stack
iteration (`WorkItem`/`pushForestExpansion` in `fugue-doc.ts`) —
complexity-preserving (still O(chain length) per call), O(1) stack
depth instead of O(chain length). Verified primarily by the existing
26-test suite (including its 500-run property tests) passing unchanged
after the rewrite, given this session's four prior wrong hand-derivations
of Fugue behavior (#0022, #0023, #0024 ×2) — trusting the property tests
to catch a semantic slip was judged more reliable than trusting a fifth
hand-trace. `countLiveBefore`'s rewrite gives up the old recursive
version's O(1)-skip-whole-uninteresting-sibling-subtree shortcut for a
walk-every-node-until-found approach — an explicit, accepted complexity
trade (crash-safety on the shape that was actually crashing, a long thin
chain, matters more here than an optimization for wide trees this
function was never the bottleneck for). A dedicated regression test
(`fugue-doc.test.ts`, "no stack overflow on a long single-sided chain")
now builds a 20,000-character forward chain — via directly-constructed
ops fed through `receive()`, not 20,000 live `insertLocal` calls, to
isolate "does the traversal blow the stack" from "how slow is a
Doc-typing-forward workload" (that second question is this entry's next
finding) — and exercises all three fixed functions at maximum depth.

**Bug 2 (crash, same shape, different mechanism): `encoding.ts`'s
`encodeOps`/`decodeOpsStream` used `dest.push(...src)` to concatenate
arrays whose size scales with op count.** `out.push(...records)` crashed
building `bench/encode-decode.mjs` at n=100,000 — V8 rejects a spread (or
`apply`) call once the argument count passes roughly 65,000-125,000,
because spread-into-call passes each element as its own call argument and
the engine caps argument count, not recursion depth. Same underlying
*shape* of bug as #1 above (an array/tree operation silently assumed to
scale cleanly with input size turns out to have a hidden cliff at a
specific size) via a different, unrelated mechanism — worth naming as a
pattern, not a coincidence: any manual re-encoding of "build up a
big array, then hand it to a native array/call operation" is a candidate
for this same class. Fixed with a `pushAll` loop (`encoding.ts`) at
both sites, plus the two smaller-scale identical-pattern call sites
(`out.push(...strBytes)`, `records.push(...charBytes)`, both
per-string/per-character and so not actually at risk at any realistic
size, fixed anyway rather than leaving a second instance of a
now-identified landmine pattern sitting in the same file). All 17
existing `encoding.test.ts` tests, including the §3.1 60,000-deletions
property test, pass unchanged.

**The honest performance finding, not a bug: `Doc` fails S6 by roughly
168x, and is measurably slower than `ArrayDoc` — the exhibit it succeeded
specifically for being unusably slow — at every size from 10,000
characters up.**

```
n=1000    NaiveDoc 2.5ms    ArrayDoc 12.6ms    RgaDoc 11.3ms    Doc 20.2ms   (build)
n=10000   NaiveDoc 12.2ms   ArrayDoc 479.9ms   RgaDoc 46.5ms    Doc 1.66s    (build)
n=100000  NaiveDoc 89.5ms   ArrayDoc 81.73s    RgaDoc 433.3ms   Doc 339.9s   (build)
                                                RgaDoc 365.1ms   Doc 168.0s   (replay/cold-open)
```

(`NaiveDoc`'s speed is irrelevant to correctness — it diverges under
concurrency, PRD §4 exhibit 1 — included only for scale.) Root cause:
every `integrate()` call, insert or delete, calls `propagateSizesUp`,
which walks from the changed node to the tree root to keep `size`/
`liveSize` current. For a forward-typed document that walk is O(current
depth) = O(current length), making a full n-character build (or,
identically, a full cold-open replay of one) O(n²) — the same asymptotic
shape that makes `ArrayDoc`'s O(n) splice-per-insert bad, except `Doc`
pays a higher constant factor per step (tree-node traversal and field
writes vs. `ArrayDoc`'s single native `memmove`-backed `splice`), so it
loses even the case where the two are asymptotically tied. `RgaDoc`
doesn't have this problem — DECISIONS #0017's treap gives it O(log n)
split/merge instead of an O(depth) parent-chain walk, and that's the
only exhibit the committed S6 gate (`rga-doc.test.ts`) actually measures.
**The gate has always been honest about what it tests; it was never
claimed to cover `Doc` itself, and this entry is the first time anyone
checked.**

**Also measured against Yjs (`yjs@13.6.31`, added as a root
devDependency), per ARCH §9's explicit instruction to report losses:**

```
n=100000  Yjs build=130.6s  replay=4.6ms    wire=100,015 B (1.00 bytes/char)
          Doc build=339.9s  replay=168.0s
```

Doc's cold-open is ~36,800x slower than Yjs's at 100k, and our wire
format costs ~12.7 bytes/character against Yjs's ~1.0 (ARCH §3.1 only
specifies run-length-encoding for *deletions*; consecutive same-replica
*inserts* get no equivalent compression here, while Yjs's update format
deltas them by construction — a real, narrower-than-Yjs scope, not a
bug). One nuance, not a mitigating factor: Yjs's own naive
one-char-at-a-time `insert` loop is *also* slow to build (130.6s,
actually slower than `Doc`'s own build) — the difference is architectural,
not "Yjs is fast at everything": Yjs pays a real cost once, on the
writer, and every reader's cold-open stays cheap regardless of how the
document was typed, because its size/index bookkeeping isn't
recomputed by walking on every single reader's `integrate()` the way
`Doc`'s currently is.

**Deliberately not fixed here: `Doc`'s O(n²) forward-typing cost.**
Giving `Doc` an O(log n) incremental size-maintenance structure (a
treap-backed Fugue tree, matching what `RgaDoc` already has) is a
genuine architectural change, not a benchmark-suite task, and DECISIONS
#0017 already declined exactly this scope for `Doc` at Step 6 ("full
treap-level efficiency ... explicitly scoped out"); ARCH §2.5 frames a
treap-backed Fugue as aspirational future work in its own words. Step
15's job, per ARCH §9, is to measure and report honestly — "including
the ones that lose" — not to close every gap a measurement surfaces.
Recorded here as a known, currently-real limitation rather than quietly
worked around.

**Three methodology bugs, caught by the measurements themselves, on the
way to a trustworthy `bench/memory.mjs` — the most extended "predict,
measure, get an impossible number, investigate" chain of this step.**

First: building the 100,000-character test document by typing forward
(this suite's default workload) pays the same O(n²) `propagateSizesUp`
cost as the cold-open finding above, for no reason — a `FugueNode`'s
memory footprint doesn't depend on tree depth. Fixed by inserting at
uniformly random positions instead (a deterministic PRNG, `mulberry32`
in `bench/lib.mjs`, not `Math.random()`, so the number stays reproducible
run to run) — a bushy, shallow tree, under a second to build.

Second: measuring "all live" and "all tombstoned" as two phases of one
long-running process (build, measure; delete everything, measure again)
produced a *negative* tombstone overhead — tombstoned heap usage measured
smaller than live. Impossible: tombstones are never removed from the tree
(`fugue-doc.ts`'s own comments on `deleteById` are explicit the node
stays, just flagged, and each delete additionally retains its own
`CrdtOp` in the doc's op log), so the true number can only go up.
Re-measuring at 10% increments through the delete pass instead of only
before/after resolved it: heap usage climbed monotonically and
reproducibly across three separate runs (~57 → ~81 MiB) when
`global.gc()` was interleaved *during* the deletes, every time — but
collapsed to a nonsensical ~4 MiB whenever the deletes ran as one
uninterrupted synchronous burst with `gc()` only called at the end.
`deleteById`'s own churn apparently needs V8's incremental GC scheduled
*during* a long synchronous mutation loop, not several `gc()` calls
stacked afterward, to report a `heapUsed` worth trusting — not
independently root-caused past that empirical finding.

Third, a smaller version of the same trap: even with interleaving, one
*more* `gc()`-and-measure call strictly after the last checkpoint
reintroduced the same collapse. Fixed by reporting the final checkpoint's
own reading as the "tombstoned" figure, rather than a fresh measurement
taken afterward.

**Numbers** (`bench/memory.mjs`, n=100,000, uniformly random insert
positions):

```
all live:       58.15 MiB total, 609.7 bytes/char
all tombstoned: 81.82 MiB total, 857.9 bytes/char
tombstone overhead vs live: 248.2 bytes/char extra
```

~600-900x the wire format's ~1 byte/character (expected — an in-memory
tree of JS objects, each carrying an id, a parent pointer, two
sibling-bucket arrays, and size/liveSize counters, against a packed
binary format with none of that structure). The ~248 bytes/character
tombstone overhead is the permanently-retained delete `CrdtOp` (id +
deps + payload) plus its integration bookkeeping, not a larger node —
the price ARCH §2.4 already names for staying convergent: "deleted" has
to be remembered forever, never actually reclaimed.

**Design choices made without a specific doc citation, stated plainly:**
`bench/` scripts are plain Node ESM (`.mjs`), not part of the vitest
suite or CI — these are measurements to read, not assertions to pass or
fail (the one genuinely-assertable figure, the §3.1 60,000-deletions
byte budget, already has its own `encoding.test.ts` gate; the bench
script just reprints it for one complete report). `bench/` was added to
`pnpm-workspace.yaml`-adjacent resolution by making it depend on
`starling-crdt` and `yjs` as *root* devDependencies (`pnpm add -D -w`)
rather than giving `bench/` its own `package.json` — Node's ancestor-
`node_modules` resolution then finds both from any script under
`bench/` without a fourth workspace package existing solely to hold two
dependency declarations. Every script that would take minutes at
n=100,000 by default (`Doc`/`ArrayDoc` cold-open, the Yjs comparison)
defaults to 1k/10k and requires an explicit `--full` flag for the
100k case, or (for `Doc`@100k specifically, ~500s) isn't re-run live by
the script at all — the already-measured, directly-obtained number is
cited in `bench/README.md` instead, the same precedent DECISIONS #0014
set for `ArrayDoc`@100k.

## 0027 — Step 16: deploy is prepared but not completed — no hosting credentials or repo-admin access exist in this environment, and neither can be conjured by "keep going"

**Step:** 16

PRD's acceptance criterion for this step is blunt: "Public URL works."
That did not happen. What follows is the honest account of what was
built, and — more importantly, matching this project's whole ethos of
reporting losses rather than papering over them (ARCH §9, DECISIONS
#0026) — exactly what wasn't, and why.

**What actually blocks a public URL here, checked before concluding
anything:** this session has git push access to the repository and,
intermittently, GitHub API tools (`mcp__github__*`) for issues/PRs/
files/branches — but no tool exposed by that server can flip a
repository's Settings → Pages → Source toggle (checked the full tool
list; the closest are file/branch/PR operations, none of them a
repository-settings write), and no environment variable, config file, or
credential for any hosting provider (Vercel, Cloudflare, Fly.io, Render,
Railway, or otherwise) exists anywhere in this container (checked: no
matching env vars, no `*.toml`/`vercel.json`/`netlify.toml` in the repo).
Both gaps are structural, not something to reason past — a repo-settings
toggle needs admin-level API access this session's GitHub tools don't
expose, and a relay needs an actual paid-or-free hosting *account*,
which by definition doesn't exist until a human creates one. Asked the
user directly how to proceed (host it myself given credentials, prep
config and let the user deploy, or skip live deploy and document the
gap) — the question was declined and met with the same standing
instruction that has carried this entire build: keep going
autonomously. Reconciling that instruction with a hole no amount of
"keep going" can close without external input: build everything that
*is* achievable inside this environment, all the way to the last step
that requires a credential or a click only a human can make, and
document that boundary as precisely as the rest of this log documents
everything else — not silently, and not by claiming a URL exists that
doesn't.

**What was built, all the way to that boundary:**

- `packages/relay/scripts/serve.mjs` — the production entrypoint
  `packages/demo/scripts/dev-relay.mjs` (Step 14) was always a
  local-dev-only stand-in for (its own comment already said so:
  "Step 16 ... is where a real hosted relay replaces this default").
  Binds `0.0.0.0` (every interface, not just loopback), requires
  `RELAY_ALLOWED_ORIGIN` explicitly (refuses to start without it —
  a production relay silently defaulting to `localhost` would defeat
  SECURITY §2.3's CORS check for the one case, an actual public
  deployment, where getting it wrong matters most), and closes
  cleanly on `SIGTERM`/`SIGINT` (most container platforms expect
  that, not a hard kill, on redeploy/scale-down). Verified it actually
  boots and routes a request end-to-end (`curl` against a locally-run
  instance), not just that it typechecks.
- `packages/relay/Dockerfile` — unusually small because
  `packages/relay/package.json`'s own `"dependencies"` is `{}` (the
  "relay ignorance" boundary, DECISIONS #0019, means it never imports
  anything, npm or otherwise, beyond `node:http`): a build stage that
  runs `tsc`, then a final stage that copies only `dist/`, `scripts/`,
  and `package.json` — no `node_modules` in the shipped image at all.
  Portable to any container host (Fly.io, Render, Railway, a bare VM
  with Docker).
- `.github/workflows/deploy-demo.yml` — builds `packages/demo` as a
  static site and publishes it to GitHub Pages via the official
  `actions/{configure-pages,upload-pages-artifact,deploy-pages}`
  actions. `workflow_dispatch` only, deliberately not on every push to
  `main` — a demo redeploy is a visible action against a URL a real
  person might currently be using, not something that should happen as
  a side effect of unrelated work landing on the default branch.
- `packages/demo/vite.config.ts` — `base: "/Starling/"` under a new
  `GITHUB_PAGES=true` env flag the workflow sets (a GitHub Pages
  *project* site is served from `/<repo>/`, not the domain root; local
  `vite`/`vite build` — dev, e2e — are unaffected, still root-based).
  Verified by actually running `GITHUB_PAGES=true vite build` and
  checking the emitted `index.html` references `/Starling/assets/...`,
  not a hand-read of the config.
- `docs/DEPLOY.md` — the concrete runbook for the two manual steps
  above (enable Pages source; host the relay, set
  `RELAY_ALLOWED_ORIGIN` there and `VITE_RELAY_URL` as a repo Actions
  variable) plus the deploy trigger itself, written so whoever *does*
  have the access this session doesn't can finish Step 16 in minutes,
  not by re-deriving any of the above from scratch.

**Not claimed:** S12 does not pass (that's Step 17's criterion, `npm
install starling-crdt` — unaffected by any of this). No demo is live at
any URL right now. No relay is running anywhere but this container's
own throwaway test invocation. The PRD's own acceptance line for this
step, "Public URL works," is not satisfied, and won't be until a human
completes `docs/DEPLOY.md`'s three one-time steps.

## 0028 — Step 17: README, docs, and `starling-crdt` v0.1.0 prepared for publish — dry-run passes, the real `npm publish` hits the same class of blocker Step 16 did

**Step:** 17

Checked before writing anything: `npm whoami` inside this container
returns `ENEEDAUTH` — no npm account, no `NPM_TOKEN`, no credential of
any kind for the npm registry exists here, the same structural gap
DECISIONS #0027 already hit for hosting. S12's own PRD wording anticipates
exactly this split — "Publish dry-run, then real publish at v0.1.0" are
two separate clauses — so this entry does the half that's actually
achievable inside this environment, verifies it directly rather than by
inspection, and is explicit about the half that isn't.

**`packages/crdt` is publish-ready.** `"private": true` removed,
version bumped `0.0.0` → `0.1.0`, `description`/`license`/`repository`/
`homepage`/`keywords`/`engines` added, `"files": ["dist"]` kept exactly
as SECURITY §3 specifies ("ship build output only"). A package-level
`packages/crdt/README.md` written (SECURITY §3's Cotangent precedent:
"v0.1.0 shipped with a blank package page because the readme field was
missing... check the rendered page on a dry-run before tagging") — its
usage examples were not just written, they were run:
`insertLocal`/`receive`/`text`/`anchorAt`/`resolveAnchor` against the
actual built `dist/`, and separately `encodeOps`/`decodeOps`/
`missingFrom` (the first attempt at verifying the encode/decode round-
trip used `JSON.stringify` equality and reported a false failure — key
ordering differs between the literal op object and the object
`decodeOps` reconstructs, not a real mismatch; `assert.deepStrictEqual`
confirmed the round-trip is correct, a small instance of the same
"verify the verification method, not just the claim" discipline the
rest of this log applies to real bugs). `LICENSE` (MIT — no license was
specified anywhere in the four spec docs; chosen as the ecosystem-normal
default for a small library, same category as Yjs's own, and stated
here rather than left as an unexplained file) added at both repo root
and inside `packages/crdt/` — npm only auto-includes a package's own
`LICENSE`/`README` from *its own directory* at publish time, not a
monorepo root one, so a root-only copy would have shipped a tarball
missing it despite `git`'s own root `LICENSE` looking sufficient at a
glance.

**Verified with `npm publish --dry-run`** (works without any npm login —
only the real `publish` needs auth): 43 files, 32.9 kB packed / 121.1 kB
unpacked, contents exactly `dist/*`, `LICENSE`, `README.md`,
`package.json` — no test files, no source-map-to-nowhere issue, nothing
from `bench/` or `research/`. This is the artifact S12 actually measures
("`npm install starling-crdt` gives a working CRDT") short of the
registry round-trip itself.

**`.github/workflows/publish-crdt.yml`** added: triggered by a
`crdt-v*` tag push (not every push to `main` — a publish is effectively
irreversible, a different risk category than a Pages redeploy), runs
`packages/crdt`'s own tests plus the core-isolation gate, dry-runs again
(fails the job before anything irreversible if the file list ever looks
wrong), then `npm publish --provenance --access public` using an
`NPM_TOKEN` secret that does not exist in this repository as committed —
SECURITY §3's own recommendation ("Use npm's provenance flag... given
Tessera it would be strange not to"), ready to run the moment a human
adds that one secret.

**Top-level `README.md`** written: what the project is, the package
table, a quickstart, and — deliberately, matching how `bench/README.md`
already reports S6 — an honest S1-S12 status table rather than a blanket
"done." Two rows carry a ⚠️, not a ✅: S6 (`Doc` fails cold-open by
~168x, `RgaDoc` passes; DECISIONS #0026) and S12 itself (dry-run passes,
real publish blocked; this entry). Every other criterion is a real ✅,
independently re-checked against the actual committed tests/gates before
being written down, not carried over from memory of having built them
weeks of conversation ago.

**Not claimed:** `starling-crdt` is not live on the npm registry.
`npm install starling-crdt` has not been run against a real published
package by this session — there is no real published package to install
yet. `docs/DEPLOY.md` §5 is the runbook for whoever has npm publish
rights to finish this in two commands.

## 0029 - Deploy, Phase 1: a transport interface plus an in-browser fallback, so the demo never depends on the relay being awake

The demo is going to a live public URL backed by a free relay host (Render's free web service) that spins down after 15 minutes of inactivity and takes about a minute to wake. The requirement is that a visitor, often on a phone, understands the demo in under a minute without the relay necessarily being up. So the transport had to become swappable, and a serverless fallback had to exist.

The `RelayTransport` interface (`append(bytes) -> offset`, `read(from) -> bytes`) already existed from Step 9, and `HttpRelayTransport` was already the only implementation, so nothing was hardwired to a URL. Phase 1 adds `LocalRelayHub` / `LocalRelayTransport`: a relay-shaped byte log that lives in the browser. It honours the exact relay contract, so a `Provider` cannot tell the difference. The two demo panes in one page share a single hub and converge through it with no network at all; a second tab in the same browser gets its own hub, joined to the first by an optional `BroadcastChannel` that mirrors appends between them. The two tabs' byte logs can differ in order, which is fine because CRDT ops are order-independent and idempotent. All of this is pure and node-testable (a deterministic fake stands in for `BroadcastChannel`), so both transport paths are covered without a browser.

**Wake policy: local-only by default, relay only on intent.** Render's free tier grants 750 instance-hours per workspace per month, and a service that never sleeps burns 24 * 31 = 744 of them, essentially the whole budget. So the relay must not be woken on an ordinary page load. `decideTransportMode` reaches for the relay only when the visitor arrived through a shared link (a room id in the URL) or explicitly clicked to share; every other visit stays purely local and wakes nothing. The arithmetic on the remaining budget: the relay is awake for a session's active time plus a 15-minute idle tail before it spins down, so an isolated 10-minute collaboration costs about 10 + 15 = 25 minutes, roughly 0.42 instance-hours. Even 100 genuine share sessions in a month is about 42 hours, under 6 percent of the 750. Exhausting the budget would take on the order of 1,800 isolated sessions a month, which a portfolio demo will not see; the one thing that would blow it, an always-awake relay, is exactly what the local-only default prevents.

**Adaptive polling with a hard stop, not a fixed 700 ms.** The provider syncs by polling the relay over HTTP, so a fixed fast interval keeps a phone radio and a sleeping-prone relay busy long after anyone stops typing. `nextSyncDecision` returns 400 ms while the page is visible and changed within the last 3 seconds (imperceptible collaboration lag, and well under the relay's 100-per-second per-IP cap) and 2 seconds when visible but idle.

The backgrounded case needed more than a slower interval. A poll is an inbound request, and Render only spins a free service down after 15 minutes with no inbound request, so any hidden-tab polling at all, even every 15 seconds, holds the relay awake for as long as the tab stays open. A single shared link left open in a background tab overnight would cost 24 instance-hours, a week 168, which is 22 percent of the monthly budget from one distracted visitor. That, not the session model, is the real worst case. So a hidden tab polls for a 2-minute grace window and then stops entirely, resuming on the next `visibilitychange`. The grace is longer than a glance at another tab, so an active collaborator is never cut off, and far shorter than the 15-minute spin-down, so a forgotten tab caps the relay's awake time at about 2 + 15 = 17 minutes total.

Instance-hour arithmetic against the 750-hour budget, redone with the forgotten tab alongside the session rows:

| Traffic in a month | Awake cost | Share of 750 h |
|---|---|---|
| One forgotten background tab | 2 min grace + 15 min spin-down, about 0.28 h, once | under 0.1 percent |
| 30 real 10-minute share sessions | 30 * (10 + 15) min, about 12.5 h | about 1.7 percent |
| 100 real 10-minute share sessions | about 42 h | about 5.6 percent |
| 500 real 10-minute share sessions | about 208 h | about 28 percent |

The forgotten tab, previously unbounded, is now the cheapest row. On the local transport the delay costs nothing, since its reads are in-memory, so the schedule only matters against a real relay.

**Room ids are 128-bit capabilities in the URL fragment.** The relay has no authentication (SECURITY section 1), so whoever holds a room's link can read and write it. A guessable or sequential id would let a stranger walk the namespace and read other people's documents, so `generateRoomId` draws 128 bits from `crypto.getRandomValues` and formats them in the 8-4-4-4-12 hex shape the relay validates. That shape check does not constrain the RFC-4122 version and variant nibbles, so all 128 bits stay random rather than the 122 a v4 UUID would leave. The id lives in the URL fragment, never the query string. A fragment is not sent in any HTTP request, so the id stays out of the GitHub Pages access logs and out of referrer headers to third parties. It does not, however, hide the id from the relay: the relay receives it as a path segment in `POST /doc/:id`, and Render logs request paths, so a room id is visible to whoever runs the relay. That is unavoidable, since the relay needs the id to route, and acceptable, since the relay is exactly the party a room is shared through. The user-facing consequence, that anyone with the link can read the room, is stated plainly in the UI.

**The demo's partition controls will be separate code from the tested partition logic.** `packages/sim` cannot drive the live UI: it shuffles, drops, and partitions in-process `CrdtOp` envelopes delivered through `receive`, a different world from the demo's asynchronous byte transport. Phase 2's disconnect, latency, drop, and reorder controls reimplement those concepts as `ControllableTransport`, a `RelayTransport` wrapper at the seam where the UI can toggle them live. This is a deliberate duplication and worth recording as a risk: the partition behaviour the property tests verify and the partition behaviour a visitor sees are now two separate pieces of code that can drift. The README must not imply the simulator powers the demo; it powers the tests.

## 0030 - Deploy, Phase 2: the demo is two local replicas by default, with an in-place handoff to the relay on share

Phase 2 turns the pieces from Phase 1 into the page a visitor actually sees. The whole demo lives on one screen: two replicas of one document (panes A and B), a control panel that degrades their links, a convergence strip, and a share control. The shape follows from the goal, a recruiter understanding it on a phone in under a minute without the relay necessarily being up.

**Both replicas run in the browser, syncing through one in-browser log.** On an ordinary visit each pane's `Provider` syncs through a `ControllableTransport` wrapping a view of the same `LocalRelayHub`. There is no network, so the page is instantly live and never waits on a cold relay, which is the default experience by design. Typing in one pane appears in the other because they share the hub, and the whole break-it story plays out locally.

**The controls are the `ControllableTransport` state, made visible.** Cutting a pane's link sets `connected: false` on that pane's link; the latency, packet-loss, and reordering sliders set `latencyMs`, `dropRate`, and `reorderRate` on both. A cut or dropped call rejects, the sync loop catches it and retries later, and the state vector re-offers anything unsent, so the document diverges while a control is engaged and heals the moment it is released, with no conflict prompt and no lost keystroke. That is the single thing the demo exists to show.

**The convergence strip compares documents, not bytes.** It reads each pane's `provider.text` and reports converged when the two strings are equal. That is the honest question for a CRDT: two replicas can hold the same document while their underlying logs differ in order and length, and that should read as converged. A visitor can check the claim against the two editors with their own eyes.

**Both panes poll their link independently.** In local mode the reads are in-memory, so independence is free. In relay mode, after a share, each pane holds its own `HttpRelayTransport` to the same room and polls it on its own adaptive schedule, so a visitor with the page open and both panes visible drives two request streams, not one. At the active cadence that is two syncs per pane per 400 ms window, about 5 requests per second per pane and about 10 per second for the visitor, well under the relay's 100-per-second per-IP cap. Sharing one poll and fanning out locally would halve that, but it would also couple the two panes' partition state, which is exactly what the controls need to keep separate (cutting A's link must not stop B's polling). Independence keeps the controls honest at a request cost the cap absorbs.

**Share is an in-place handoff, not a reload.** Clicking share builds a new `ControllableTransport` around a relay transport for each pane, carries the current control settings onto it, and calls `Provider.switchTransport`, which resets the read cursor and last-pushed vector (meaningless across logs) and reconciles: the local history replays into the relay room, whatever the room already held is pulled in, and both sides converge with no op lost or duplicated. Nothing remounts, so the editors and their controls keep working across the switch. A visitor who instead arrives through a shared link starts in relay mode directly. The handoff is specified and tested in `packages/provider/handoff.test.ts` for both an empty and a pre-existing relay room.

**Persistence is in-memory, and awareness and reload-persistence were dropped from the demo.** The demo uses `InMemoryPersistence`, so every load starts clean rather than surfacing a previous visitor's text from IndexedDB, which is the more predictable public-demo behaviour. The library still ships `IndexedDbPersistence` and it is still covered by unit tests; the demo just does not use it. The remote-cursor and awareness channel from the earlier in-app build was removed too, to keep one content channel per pane and halve the relay request budget. Both are affordances, not the point being shown, and can be re-added later.

**The theme is warm and yellow, deviating from FRONTEND section 3's near-monochrome shell.** The original aesthetic was a muted network instrument for an in-app control; the public demo trades it for a higher-contrast, mobile-first look a stranger can read at a glance on a phone. Colour still carries meaning: the two replicas keep their two identity colours, and the accent is spent on convergence and the share action.

## 0031 - Deploy, Phase 3: a per-document generation token, so neither a restart nor an eviction can silently split a room

The relay runs its log in memory, and the free host (Render) has no persistent disk and spins the process down after 15 minutes idle. So a room that goes quiet and comes back finds the relay restarted with an empty log, while both clients still hold a read cursor into the old log and a last-pushed vector claiming their whole history is already uploaded. The read at the stale cursor finds nothing new and the vector suppresses the re-push that would repair it: the room is permanently split, with no error shown. Two idle collaborators returning to their document is exactly the scenario, and it is silent, which is the worst kind.

The fix is a generation token. The relay returns it on every response (`X-Relay-Generation`, exposed to cross-origin script via `Access-Control-Expose-Headers`). The client records it and compares on each response; when it changes, the log it was reading no longer exists, so it resets the read cursor to 0, clears the last-pushed vector, and re-pushes its full local history. That is exactly the reconciliation `switchTransport` already performs for the local-to-relay handoff, so the same code path is reused rather than written twice. CRDT `receive` dedupes by op id, so replaying a history that partly survived costs bytes, not correctness: no op is lost (all are re-offered) and none is duplicated (receive is idempotent).

For the client to *notice* the reset, the stale read must return a readable response, not an error. So an out-of-range `from` (past the end of the current log) now returns 200 with an empty body, not 416. This is the deliberate answer to a question the wire protocol left unspecified. The only way a well-behaved client's cursor gets ahead of the log is that the log reset under it, so "you asked for bytes past the end, here are zero" plus the changed token is precisely the signal it needs; a hard 416 would instead throw on the client and wedge every future sync on the same offset. The store's internal contract is unchanged (`read` still reports out-of-range); only the HTTP layer's rendering of it changed, and its test with it.

**The token is per document, not per boot.** An earlier draft made it per boot, which covers a full restart but not an LRU eviction: lowering `MAX_DOCS` from 10,000 to 128 for the memory budget (#0032) did not add eviction, it made the eviction that Phase 0 already found *reachable* for the first time. An evicted room is recreated with an empty log while the process keeps running, so a per-boot token would not change, and a returning client would read empty, see a matching token, and conclude it is in sync: the same silent split, arriving through eviction instead of restart. So each document's log instance carries its own random token, assigned every time the log is created (a first append, a re-hydration, a boot replay), and the response for a doc with no resident instance falls back to the boot token. This subsumes the per-boot design (a restart gives every document a fresh instance and so a fresh token) and closes the eviction case: a recreated room has a different token than the one it replaced, so a client whose cursor is stale, even at an offset that happens to land inside the shorter new log, sees the change and reconciles before applying a byte. The eviction path is tested end to end in `packages/provider/relay-integration.test.ts`: fill to `MAX_DOCS`, evict a room holding two live clients with non-empty state, and both reconcile and converge with no lost or duplicated ops.

One accepted cost: because an absent doc reports the boot token, a client that is the first to populate a relay room (or the first to read an evicted-and-recreated one) sees the token move from the boot value to the room's own token once and reconciles once more than strictly needed. That extra pass re-pushes a small, bounded history and is idempotent, so the document is always correct; it is redundant bytes, not a wrong result. Removing it entirely would need a distinguished "absent" marker the client special-cases, which is not worth the cross-package coupling for a demo.

**Reconciliation amplification, measured and bounded.** The relay log is opaque append-only bytes and does not dedupe (that is the whole "relay ignorance" boundary); CRDT dedupe happens client-side on `receive`. So a reconciliation that re-pushes appends real bytes to the log, and the worry is that with N clients in a room, a restart makes all N re-push the full history, growing the log by N copies. Two things bound it. First, a client reconciling against a *non-empty* log does not re-push everything: `syncNow` folds the ops it just pulled into `lastPushedVector` before computing `missingFrom`, so it pushes only what the log is actually missing. The full re-push happens only against an *empty* log, which is exactly the restart/eviction case (no persistent disk). Second, in that case the amplification is bounded by the number of clients that read the empty log before any of them fills it: staggered, the first client re-pushes and the rest read a full log and push nothing; only fully concurrent readers each push a copy. Measured with three clients and a 900-op document across five simulated restarts: staggered leaves one copy (about 10 KB), fully concurrent leaves three (about 30 KB, 1.45% of the 2 MB cap), and it does not accumulate across restarts because each restart empties the log. So the growth is ops times clients per restart in the worst case, not ops times reconciliations times clients, and it is far under the cap for any realistic demo document. This is the "push only what the log is missing" option, already realised by the existing sync logic; relay-side dedupe was rejected because it would break the ignorance boundary (and its CI gate), and single-client election was rejected because a stateless byte-log relay has no coordinator to run it. The trade-off accepted is a bounded, non-cumulative burst of duplicate bytes on a concurrent cold-start, which the freeze cap and the frozen-room handling (#0034) backstop if a document is ever large enough for it to matter.

## 0032 - Deploy, Phase 3: caps derived for 512 MB and about 10 requests per visitor per second

Phase 2 changed the load the relay sees, and the old caps predated any of it. Two corrections.

**Memory: worst case must fit 512 MB, not just typical use.** The old caps (`MAX_LOG_BYTES_PER_DOC` 50 MB, `MAX_DOCS` 10,000) allowed a worst case of 500 GB resident, which only ever "worked" because real documents are tiny. The requirement is that the pathological case, every resident doc frozen at its maximum, fits the free host's 512 MB. Recomputed: `MAX_DOCS` 128 times `MAX_LOG_BYTES_PER_DOC` 2 MB is 256 MB of log bytes. A read copies one doc's log through `Buffer.concat` (a transient up to 2 MB per concurrent read, tens of MB under load), and Node itself wants roughly 100 to 150 MB, so the total lands near 420 MB with headroom under 512. `MAX_MESSAGE_BYTES` stays at 1 MB, comfortably above any single sync delta, so a paste never wedges a client by exceeding it; 2 MB per doc is about 200,000 characters, far past any demo document. 128 resident rooms is the ceiling before the LRU drops the coldest, and a portfolio demo does not approach it.

**Rate limits: appends are limited, reads are not.** A visitor now runs two independently polling panes, about 10 reads per second in total at the active cadence. Reads are deliberately left unlimited: rate-limiting them would punish everyone behind a shared address (an office, a carrier CGNAT) for ordinary use, and reads are cheap. Appends are the limited requests, and they happen only when there is an edit to push, roughly 2.5 to 5 per second per actively typing visitor. So the per-IP append ceiling of 100/s clears about 20 to 40 simultaneously typing visitors on one address before it bites, which absorbs an office or CGNAT of realistic size; the "100/s is only ten visitors" worry assumed reads counted, and they do not. A second ceiling was added per document (60/s), so one room cannot be driven far past what a handful of typists produce no matter how the appenders' addresses spread.

**The per-IP limit only works behind the proxy if it is told about the proxy.** Render terminates TLS at one edge and forwards with `X-Forwarded-For`. Left at the default `trustedProxyDepth` 0, every visitor's request arrives from the proxy's single socket address and they all share one append budget, which would tighten the limit into the demo's own traffic far worse than any office. So the production entrypoint reads `RELAY_TRUSTED_PROXY_DEPTH` (set to 1 on Render, via `render.yaml`) and the per-IP limit follows the real client from the forwarded header. Health checks are exempt from both limits and carry no origin, so a liveness probe never spends an append budget.

**Behaviour at every boundary these caps made reachable.** Lowering the caps turned four limits from unreachable into reachable, so each one's behaviour at the edge is now defined and tested, not incidental.

- *The per-doc size cap rejects, it does not truncate.* At `MAX_LOG_BYTES_PER_DOC` the log freezes: the append that would cross 2 MB is refused, and every later append to that doc is refused too, with the log left exactly as it was (`store.ts`, and the freeze test in `store.test.ts`). It never drops bytes off the front, so no client's cursor is ever invalidated by the cap, which would have been the same silent-split class as an untracked eviction. A frozen doc simply stops accepting new ops; the document is not corrupted, and a client's cursor stays valid against the bytes that are there.
- *A rejected append is retried, not dropped.* A 429 (per-IP or per-doc) and a 413 (too large) both surface to the client as a thrown append, which rejects that sync. The op is not lost: the Provider never advanced its last-pushed vector past it, so the very next sync re-derives it through `missingFrom` and re-offers it. The sync interval is the backoff. `packages/provider/relay-integration.test.ts` drives a real append to a 429 and asserts the op still lands on a peer once the one-second window refills. (The 413/freeze case is the exception: a frozen doc rejects forever by design, so those ops never land, which is the wall doing its job, not a lost op.)
- *2 MB is about 170,000 typed ops.* Measured across workloads, not just the favourable one: a sequential insert at the end encodes to 12.4 bytes, an interior insert to 12.3, mixed edit churn to 10.6, and inserts with 50% deletes to 8.2 (a delete/tombstone op is *smaller* than an insert, since it carries an id but no character or origin). So 12.4 bytes/op is the conservative figure for inserts, not an understatement, and a 2 MB log holds roughly 170,000 insert ops. The log is append-only and never compacted, so that is cumulative over a room's whole life. By typing alone that is on the order of five hours of continuous keystrokes; a demo session is minutes and a few thousand ops, and a room is spun down or evicted long before.
- *Paste changes the picture, but not for a curious visitor.* A paste emits one op per character in a single message (capped at `MAX_MESSAGE_BYTES` 1 MB). An article of about 5,000 characters is about 61 KB, so roughly 33 such pastes fill a 2 MB room. A single max-message paste is about 84,500 characters (about 1 MB), so two of those freeze a room directly. Freeze is therefore reachable, but by deliberately pasting two roughly-book-chapter-sized blobs, not by an article or by curiosity. Raising the cap trades against the 512 MB memory budget (`MAX_DOCS` times the cap), so the cap stays at 2 MB and the deliberate-abuse case is handled where it belongs, in the UI: a frozen room is a visible terminal state with a recovery, not a silent one (#0034).

## 0033 - Deploy, Phase 3: the e2e run uses the system browser, so its version is not pinned

The demo's Playwright e2e suite is real evidence that the deployed page works in a browser, but it is not reproducible from the lockfile. Playwright ships no build for this environment's OS, so its own pinned Chromium cannot be installed here; the config points `executablePath` at a system Chrome (`/usr/bin/google-chrome`, overridable via `PW_CHROME_PATH`). That browser's version is whatever the machine happens to have, outside version control, so a green "6/6 passed" is a true statement about the browser it ran against, not a build-reproducible guarantee that pins to a specific engine. This is a known limitation of the evidence, recorded so the passing count is not read as more than it is. On a host where Playwright's managed Chromium installs, dropping the `executablePath` override restores a lockfile-pinned browser and closes the gap.

## 0034 - Deploy, Phase 3: a frozen room is a terminal state the client stops on and the UI shows

A room whose log hits the 2 MB freeze cap is a real end state, reachable by deliberate large pastes (#0032). Both halves of it needed defining, because both were wrong by default.

**The client must distinguish permanent from transient and stop.** A rejected append can be transient (a 429 rate limit, a network blip), which the next sync should retry, or permanent (507, the log is frozen; or 413, this single update is over the message cap), which no retry will ever clear. Before this, both threw the same generic error and the sync loop re-offered the same doomed push every tick. On a frozen room that means a single visible tab keeps issuing requests forever, and any inbound request resets Render's 15-minute spin-down timer, so one frozen tab would hold the free instance awake around the clock and reopen the very instance-hour hole Phase 1 closed. So the transport now throws a distinct `RelayPermanentError` for 507 and 413, and the Provider, on seeing it, sets a `syncBlocked` flag that makes `sync()` a no-op: no more reads, no more pushes, no more requests. Transient failures still throw and still retry, unchanged. The demo's sync loop stops rescheduling once `isSyncBlocked()` is true, so the tab goes quiet and the relay can sleep.

**One final read before it stops.** The block must not drop the tail of the log. `syncNow` reads and then pushes, so the read in the freezing sync ran before the freeze, but an op another client landed between that read and the failing push sits past this replica's cursor and would never be pulled once sync stops. Since the log is frozen the instant the push is refused, it will not change again, so a single final read at the current cursor leaves this replica with the complete final state before it blocks. Without it, "your edits stay on this device" would quietly be a lie about the last op or two that reached the log just before the freeze. Tested directly: a transport that lands a concurrent op right after the read but before the push, and an assertion that the frozen-out client still ends up with it.

**The user must be told, or it is silent divergence with a new trigger.** The document is local-first, so after a freeze the visitor keeps typing and keeps seeing their own text, while their edits quietly stop reaching anyone else, which is exactly the silent split this whole phase set out to abolish, arriving through a full room instead of a lost log. So a frozen room surfaces a terminal banner ("This room is full. Syncing has stopped.") that states plainly that new edits stay on this device, and offers the obvious recovery: start a fresh room, which reloads into a clean local-only session by dropping the room id from the URL. Both halves are tested: an SDK test asserts sync blocks and issues no further appends after a freeze (`relay-integration.test.ts`), and an e2e test fills a shared room (the e2e relay runs with a small freeze cap so a paragraph suffices) and asserts the banner appears and the fresh-room button returns to a clean session.

## 0035 - Deploy, Phase 4: share wakes the relay before handing over, so a cold start is acknowledged, not broken

Production's common case is a relay asleep for hours: the free instance spun down after 15 minutes idle, and the first request takes about 50 to 60 seconds to return while Render wakes it. Every test until now ran against a relay answering instantly, so this window had never been exercised, and the naive share flow handled it badly. The first version of `onShare` immediately moved both panes onto the relay transport and then awaited the reconciling sync. Against a sleeping relay that await blocks for the better part of a minute, during which the two panes are pointed at a dead transport and no longer converge with each other, so a visitor typing in one pane sees nothing appear in the other and the demo looks hung, at the exact moment they clicked the one button that promises collaboration.

So share now wakes the relay before handing over. `onShare` keeps both panes on the local hub, issues a `GET /health` to wake the instance, and only once that returns does it build the relay transports and call `switchTransport`. Three things fall out of that order. The editor stays fully usable the whole time, because the panes are still on the in-browser hub and still converging locally. The wait is shown rather than hidden: a spinner and a line that says the relay is waking, that it can take up to a minute, and that editing still works. And the upgrade is silent when it lands, because the panes were already converged on the same document, so replaying that history into the relay changes nothing a visitor can see. A probe that fails (blocked, unreachable) falls through to the handover anyway, where the local hub remains the never-appears-broken floor.

This was verified locally against a relay rigged to delay its first response, since the real Render wake could not be exercised without the live deployment: a bare visit issued zero relay requests, the cold-start share showed the waking state while both panes kept converging on text typed during the wait, and the handover completed silently once the delayed relay answered. The measurement against the real sleeping instance, its actual wake time, and a real device over cellular are the live checks that remain for the deployed URL (DEPLOY.md).
