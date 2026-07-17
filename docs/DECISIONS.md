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
