# Handoff

Everything below is written for you, picking this up cold, not for
another agent. It's a condensed version of `docs/DECISIONS.md` (the real
log — 28 numbered entries, every wrong prediction and every bug included)
plus a section that doesn't exist anywhere else yet: where I'd bet
something breaks first once this is actually running in public.

## What this is

A from-scratch CRDT collaborative text editor (Fugue/RGA), built
strictly to the four spec docs in `docs/` (`01-PRD.md`,
`02-ARCHITECTURE.md`, `03-SECURITY.md`, `04-FRONTEND.md`). All 17 build
steps are done in code — 289 tests, both CI isolation gates green,
`bench/` has committed numbers including an honest loss to Yjs. The two
things *not* done are deploying it and publishing the npm package, both
blocked purely on credentials I don't have — see "What's left" below.

## What was done, step by step

- **0 — Scaffold.** pnpm workspace, TypeScript strict/ESM, Vitest,
  GitHub Actions CI, two custom CI gates (`gate:core-isolation`: the crdt
  package can't touch `Date.now`/`Math.random`/DOM/fetch/etc — determinism
  is enforced by CI, not convention; `gate:relay-ignorance`: the relay
  can't import the crdt package or reference CRDT concepts by name — it's
  a dumb byte log, provably).
- **1 — `NaiveDoc`.** The obviously-wrong baseline: array + naive
  position-based ops. A committed test proves it diverges under
  concurrency. Kept forever as exhibit 1, never used for anything real.
- **2 — `ElemId`/`Sequence`.** The shared id scheme (`{replica, counter}`)
  and abstract base class every real doc class extends.
- **3 — RGA + `ArrayDoc`.** A correct merge rule, array-backed. Exhibit 2:
  correct, but O(n) per op — proven unusable at scale later by `bench/`.
- **4/4b — Tombstones + treap.** Delete-by-flagging (never remove), then
  an order-statistic treap replacing the array so it's actually fast
  (`RgaDoc`, exhibit 3).
- **5 — `packages/sim`.** A deterministic simulator (seeded RNG, virtual
  clock, a delivery queue that drops/duplicates/partitions on purpose) —
  what the convergence property tests run against.
- **6 — Fugue (`Doc`).** Replaces RGA to fix a real bug RGA has:
  concurrent *backward* typing (typing a sentence right-to-left, as two
  people both do at once) interleaves into a jumble under RGA. `Doc` is
  what everything downstream actually uses.
- **7 — Binary encoding.** LEB128 varints, a replica string table,
  run-length-encoded deletion runs (60,000 deletions in 14 bytes),
  state-vector sync (`missingFrom`).
- **8 — `packages/relay`.** An append-only byte log with a read cursor.
  Verified to contain zero CRDT concepts (the gate).
- **9 — `packages/provider`.** Local IndexedDB persistence, the relay
  transport, the sync loop.
- **10 — Offline-first integration test.** Real relay, real IndexedDB,
  end to end: edit offline, reload, reconnect, converge.
- **11 — Anchors + awareness.** Cursors as `{id, side}`, not a number, so
  they survive remote edits and tombstoning. Presence (who's online,
  where their cursor is) over the same relay mechanism, NDJSON, TTL'd.
- **12 — ProseMirror binding.** CRDT ops ↔ PM transactions/steps, headless
  (testable in Node, no browser needed for the binding itself).
- **13 — Undo.** Id-keyed inverse ops, per-replica, no OT, no
  `prosemirror-history`, correct under concurrent remote edits.
- **14 — Demo app.** Two editor panes, verified in a real Chromium via
  Playwright, not just built — six real bugs were found this way that no
  unit test caught (a missing `toDOM` that crashed the editor, offline
  edits silently never persisting, a debounce race, etc).
- **15 — Benchmarks.** `bench/` — cold-open, encode/decode, memory,
  Yjs comparison. Found and fixed two real crash bugs along the way
  (stack overflow on long documents; a V8 argument-count limit in the
  encoder). Headline honest finding: `Doc` misses the 100k-cold-open
  target by ~168x and loses to Yjs by ~36,800x on the same metric —
  `RgaDoc` (not what's actually used) passes fine. See "Where it's
  fragile" below, this is the big one.
- **16 — Deploy prep.** Relay production entrypoint + Dockerfile, a
  GitHub Pages workflow for the demo, `docs/DEPLOY.md`. Not actually
  deployed — no hosting credentials existed in the environment this was
  built in.
- **17 — Publish prep.** `packages/crdt` bumped to v0.1.0, publish-ready
  (`npm publish --dry-run` verified clean: 43 files, 33 kB, exactly
  `dist/` + `README.md` + `LICENSE`), a tag-triggered publish workflow
  with npm provenance. Not actually published — no npm account existed
  in the environment this was built in.

Every non-obvious decision behind the above, including the wrong
predictions and what they revealed, is in `docs/DECISIONS.md` as a
numbered log (28 entries). If something above looks like it needs
explaining, that's where the explanation is.

## What's left (yours to do)

Full runbook: `docs/DEPLOY.md`. Short version:

1. **Host the relay** somewhere that runs a Node process (Fly.io, Render,
   Railway, a VM — `packages/relay/Dockerfile` is ready, zero runtime deps
   so the image is tiny). Set `RELAY_ALLOWED_ORIGIN` to wherever the demo
   ends up.
2. **Enable GitHub Pages**: repo Settings → Pages → Source → GitHub
   Actions (one click, needs your admin access). Set the
   `VITE_RELAY_URL` repo Actions variable to the relay's URL. Run the
   "Deploy demo" workflow.
3. **Publish `starling-crdt`**: `cd packages/crdt && npm login && npm
   publish --provenance --access public` — or add an `NPM_TOKEN` repo
   secret and push a `crdt-v0.1.0` tag to let CI do it with a proper
   provenance attestation.

## Where I suspect it's fragile or bad

Ranked roughly by how much I'd worry about each, most first. These are
things I noticed while building, not things I've been told are wrong —
treat them as a punch list, not a confession.

1. **`Doc`'s cold-open cost is O(n²) for a long, forward-typed document —
   168 seconds at 100k characters, against a 1-second target.** Root
   cause: every single edit walks from the changed node to the tree root
   to keep size counters current (`propagateSizesUp` in
   `packages/crdt/src/fugue-doc.ts`), and that walk is as deep as the
   document is long for the single-most-common editing shape (one person
   typing forward without pausing). `RgaDoc` doesn't have this problem
   (it has a treap, O(log n)) but isn't what the app actually uses. This
   is the single biggest real risk if this ever handles a genuinely long
   document (think: a multi-page doc, not a demo paragraph) — it will
   get slow to open, not gracefully, but badly. Fixing it for real means
   giving `Doc` the same treap-backed structure `RgaDoc` already has —
   a real chunk of work, not a quick patch. See `bench/README.md` and
   DECISIONS #0026 for the numbers.

2. **Nothing anywhere ever compacts or snapshots the op log.** Client
   persistence (`packages/provider/src/persistence.ts`) re-serializes
   the *entire* history on every save and replays the *entire* history
   on every load. The relay's log (`packages/relay/src/store.ts`) only
   ever appends, forever, for both the document channel and the
   awareness/presence channel (cursor positions, published roughly twice
   a second while online — that channel has no server-side pruning of
   stale entries at all, only client-side TTL filtering on read). This
   compounds problem #1: a long-lived, heavily-edited document doesn't
   just get slow to open, its storage (browser and relay disk) grows
   without bound too. There's no garbage collection of tombstones or old
   awareness messages anywhere in this codebase.

3. **The relay trusts `req.socket.remoteAddress` directly for both rate
   limiting and connection limiting** (`packages/relay/src/server.ts`),
   with no `X-Forwarded-For`/proxy handling. Almost every hosting
   platform (Fly.io, Render, Railway, anything behind a load balancer or
   CDN) puts a proxy in front of your app, at which point every request
   looks like it's coming from the proxy's one IP — the per-IP limits
   effectively become one shared global limit across every real user.
   If you deploy behind a platform that sets `X-Forwarded-For`, this
   needs a code change before the rate/connection limits mean what they
   look like they mean.

4. **No authentication, by design, and that's a real exposure once
   public, not just a caveat.** Anyone with the document URL can read
   and destroy the entire document — this is called out in
   `docs/03-SECURITY.md` ("Malicious peer / vandalism ... same as any
   link-shared doc") as an accepted, explicit non-goal, but it's worth
   restating plainly: once you have a real public URL, anyone who finds
   it (or is sent it) can wipe it. Fine for a portfolio demo people are
   pointed at; not fine if you expect it to survive being poked at
   randomly.

5. **The demo has one fixed, hardcoded document id.** Every visitor to
   the deployed URL edits the *same* document (FRONTEND §2.5's "no
   document list," taken literally). Combined with #4, this means the
   demo is one shared canvas anyone can scribble on or clear. If you
   want isolation per visitor, that's a real feature to add, not a
   config flag.

6. **The wire format doesn't compress consecutive inserts, only
   consecutive deletes.** ~12.7 bytes per character for ordinary typing,
   against Yjs's ~1 byte/char (`bench/README.md`). Not wrong per the
   spec (ARCH §3.1 only asked for run-length-encoded *deletions*), but a
   real cost on top of #2's unbounded growth — every character anyone
   ever types costs more wire/storage bytes than it needs to.

7. **Single relay instance, in-memory rate/connection state.** If you
   ever run more than one relay instance behind a load balancer for
   redundancy or scale, the two instances won't share rate-limit or
   connection-count state — same issue as #3, one more reason it'd need
   attention before scaling out.

8. **Only tested in one browser engine.** The e2e suite
   (`packages/demo/e2e`) runs against the pre-installed Chromium via
   Playwright. Nothing here has been checked against Firefox or Safari.
   ProseMirror itself is cross-browser-solid, but the binding code
   (`packages/editor`) hasn't been exercised outside Chromium.

9. **No operational visibility.** The relay has hard rate/connection
   limits with explicit errors (deliberately, per SECURITY §2.1 — "a
   limit that logs and continues is not a limit"), but there's no
   metrics/error-tracking/logging setup for actually noticing when those
   limits are getting hit in production, or diagnosing anything else
   that goes wrong once it's live.

10. **Undo/anchors/presence are newer, less exhaustively fuzzed than the
    core CRDT.** Steps 1-8 (the actual convergence algorithm) have
    thousands of property-test runs behind them. Steps 11-14 (anchors,
    undo, the demo wiring) have real but much smaller test suites, plus
    whatever the six Playwright-caught bugs in Step 14 already shook
    out. I'd trust the core CRDT's correctness far more than I'd trust
    the newer surface area under genuinely adversarial concurrent use.

None of the above are things I noticed and left broken on purpose — #1
and #2 in particular are the ones I'd fix first if this were going
somewhere real, and neither is a quick patch. The rest are mostly
"acceptable for a portfolio demo, worth knowing about before you point
it at strangers."
