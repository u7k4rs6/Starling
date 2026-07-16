# Starling: Editor & Demo Spec

**Companion to:** `01-PRD.md`, `02-ARCHITECTURE.md`, `03-SECURITY.md`

---

## 0. What this document is for

Two surfaces, and they have opposite requirements.

- **`packages/editor`** is the ProseMirror binding. It is library code. It is headless, node-testable, and it has no opinions about pixels.
- **`packages/demo`** is a React app whose entire job is to make a stranger understand, in under five seconds, that something unusual is happening. It is the only artifact in this repo a non-engineer will ever look at, and it is the thing that gets linked from the resume.

Do not let the second one leak into the first.

---

## 1. `packages/editor`: the binding

### 1.1 Headless is a hard requirement

ProseMirror's model layer (`prosemirror-model`, `prosemirror-state`, `prosemirror-transform`) has no DOM dependency. Only `prosemirror-view` does.

The binding targets the model layer only. The whole of `packages/editor` is testable in Vitest **with no jsdom, no happy-dom, no browser**. If a test needs a DOM, the binding has leaked and the fix is in the binding, not the test.

This matters beyond tidiness: the interesting bugs in a collaborative editor are concurrency bugs, and concurrency bugs need the deterministic simulator (§4 of ARCH). The sim runs in node. So the binding runs in node, or the binding never gets tested against the thing most likely to break it.

### 1.2 The boundary

The binding is the translation layer between two coordinate systems, and this is where index confusion (§2.4 of ARCH) will bite.

- **ProseMirror speaks visible positions.** Integers, live characters only.
- **The CRDT speaks `ElemId`s.** Tombstones included, positions meaningless.

The rule: **visible indices exist only at the boundary, and die inside it.** The moment a ProseMirror step enters the binding, its positions become `ElemId`s. Nothing downstream of the binding ever sees an integer position. If an `ElemId` ever escapes upward into a ProseMirror step, that is the same bug from the other direction.

Two directions to implement:

- `transactionToOps(tr)` — ProseMirror transaction in, CRDT ops out
- `opsToSteps(ops)` — remote CRDT ops in, ProseMirror steps out, applied without disturbing the local selection except as §1.3 requires

### 1.3 Selection is anchors

Per §7 of ARCH, the local selection is stored as anchors (`ElemId` + side), not positions.

When remote ops arrive, the selection is **recomputed from the anchors**, not transformed. There is nothing to transform. A remote insert 500 characters above your cursor does not move your cursor, because your cursor was never at position 500. It was pointing at a character.

This is S10, and it is the single most felt property in the product. Every collaborative editor that jitters your cursor when someone types above you is failing exactly this.

### 1.4 Undo

Per §8 of ARCH: the undo manager keeps a stack of inverse ops keyed by `ElemId` and applies them directly. It transforms nothing. It is per-replica.

Do not use `prosemirror-history`. It is an OT-shaped undo built for a world where positions move, and wiring it in would import the exact problem this project exists to demonstrate the absence of. Write the undo manager. It is smaller than the integration would be, and it is the punchline.

---

## 2. `packages/demo`: the app

### 2.1 The five-second job

A recruiter, a hiring manager, or a stranger from a link opens this. They will not read the README first. They have to *see* it work before they will read anything.

So the demo is not "an editor." An editor looks like a textarea and proves nothing. The demo is **two editors side by side, in one page, with a wire between them you can cut.**

### 2.2 Layout

```
┌─────────────────────────────────────────────────────────┐
│  starling            [replica A ●]  [replica B ●]        │
├────────────────────────────┬────────────────────────────┤
│                            │                            │
│   editor pane A            │   editor pane B            │
│   (cursor: amber)          │   (cursor: teal)           │
│                            │                            │
│                            │                            │
├────────────────────────────┴────────────────────────────┤
│  [ A: online  ◉────  ]     [ B: online  ◉────  ]        │
│  ops pending: 0             ops pending: 0               │
└─────────────────────────────────────────────────────────┘
```

Two panes, two independent replicas, two connection toggles. Both are live editors. Type in either.

### 2.3 The three demonstrations, in order of impact

**1. Concurrent typing.** Type in both panes at once. Text appears in both. Cursors of the other replica visible in colour, moving. This is the baseline and every competitor demo has it.

**2. The offline toggle.** This is the one that matters and it must be one click, not a menu.

- Flip A offline. Its indicator goes hollow, its pending counter starts climbing.
- Type in A. Type *different* text in B, in the same paragraph, overlapping.
- The panes are now visibly divergent, side by side, which is the point: **let the divergence sit on screen for a beat.** Most demos hide this state. Showing it is what makes the merge legible.
- Flip A online. Pending counter drains to zero. Both panes converge to the same text. No conflict dialog. No "choose a version." No flicker of one document being overwritten by the other.

**3. Reload survival.** Reload the page while A is offline with pending ops. The text is still there (IndexedDB, §6 of ARCH). Come back online, it reconciles. This proves the persistence layer without a word of explanation.

### 2.4 Required affordances

- **Connection toggle per replica.** A switch, not a button. State must be readable at a glance.
- **Pending op counter per replica.** `doc.missingFrom(lastPushedVector).length`. Watching this climb while offline and drain on reconnect makes an invisible mechanism visible. Cheap to build, disproportionately convincing.
- **Remote cursors and selections**, coloured per replica, with the replica label. Ephemeral, per §7 of ARCH: when a replica goes offline, its cursor fades out after the TTL rather than sitting there forever. Getting this right is a detail nobody notices and everybody would notice if it were wrong.
- **A "third replica" button** that opens the same doc in a new tab, for anyone who wants to check that two is not a special case.

### 2.5 What not to build

No toolbar. No bold/italic/headings beyond what ProseMirror's basic schema gives free. No file menu. No document list. No dark mode toggle. No landing page.

Every one of those is a day of work that adds zero signal about distributed systems, and the demo is judged on whether the merge is legible, not on whether it has features. **If the demo looks like a text editor, it has failed.** It should look like an instrument.

---

## 3. Visual direction

The demo should read as a **network instrument**, not a document app: closer to a packet inspector or an oscilloscope than to Google Docs.

- **Type.** One display face with character, one text face, one mono. Do not use the system stack, it reads as unfinished. Self-host everything (§1 of SECURITY: no third-party requests, so no Google Fonts).
- **Colour.** Near-monochrome shell. Colour carries **one** meaning and nothing else: replica identity. Two replicas, two colours (amber and teal, or pick two, but only two). Connection state is form, not hue: filled dot for online, hollow for offline. If colour ever means two things in this UI, it means nothing.
- **Motion.** Almost none, with one exception. The convergence moment, when A comes back online and the panes reconcile, gets a beat: the incoming text arrives with a brief highlight that decays. Everything else is instant. The whole animation budget of this project is spent on the two seconds that matter.
- **Density.** Tight. The pending counters, the vector state, the op count should be visible without hunting. An instrument shows its readings.

Reference the transit/wayfinding instinct from the algorithms workbench if it helps, but it is a different project and this one is colder.

---

## 4. Deploy (step 16)

- The relay is **stateful** (§5 of ARCH), so this is not a static deploy. Fly.io with a volume, or a Cloudflare Durable Object per document. The Durable Object model maps to the design almost exactly (one object, one append-only log, one document), and is the cheaper answer if the log stays in-memory with periodic flush.
- The demo is static and can go anywhere. Same origin as the relay if possible, which makes §2.3 of SECURITY's CORS rule trivial.
- **Cold start matters.** A recruiter clicking a link and waiting 8 seconds for a Fly machine to wake has already closed the tab. Keep a machine warm or use Durable Objects.
- The URL goes in the README, the repo About, and the resume. A live demo that 404s six months from now is worse than no demo, so pick the boring hosting.

---

## 5. Frontend acceptance

| # | Criterion |
|---|---|
| F1 | `packages/editor` test suite runs in node with zero DOM shims |
| F2 | No `ElemId` appears in any ProseMirror step; no raw index appears below the binding |
| F3 | Remote insert above a local cursor does not move the cursor (S10) |
| F4 | Undo after an interleaved remote edit undoes the local edit only (S11) |
| F5 | Offline toggle produces visible divergence, then visible convergence, with no dialog |
| F6 | Reload while offline preserves pending ops (S9) |
| F7 | An offline replica's cursor disappears after TTL and does not persist |
| F8 | Demo loads zero third-party resources (§1 of SECURITY) |
| F9 | Lighthouse performance is not embarrassing on a cold load |
