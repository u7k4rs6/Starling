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
