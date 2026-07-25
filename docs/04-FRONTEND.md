# Starling: Editor & Demo

**Companion to:** [`01-PRD.md`](01-PRD.md), [`02-ARCHITECTURE.md`](02-ARCHITECTURE.md), [`03-SECURITY.md`](03-SECURITY.md)

---

## 0. Two surfaces

There are two frontend surfaces, with opposite requirements, and the design keeps them apart:

- **`packages/editor`** is the ProseMirror binding — library code, headless, node-testable, with no opinions about pixels.
- **`packages/demo`** is a React app whose entire job is to make a stranger understand, in a few seconds, that something unusual is happening. It is the only artifact in the repository a non-engineer will look at.

The second never leaks into the first.

---

## 1. `packages/editor`: the binding

### 1.1 Headless

ProseMirror's model layer (`prosemirror-model`, `prosemirror-state`, `prosemirror-transform`) has no DOM dependency; only `prosemirror-view` does. The binding targets the model layer only, so the whole of `packages/editor` is testable in Vitest with no jsdom, no happy-dom, no browser. A test that needs a DOM would mean the binding has leaked.

This matters beyond tidiness: the interesting bugs in a collaborative editor are concurrency bugs, and concurrency bugs need the deterministic simulator ([ARCH §4](02-ARCHITECTURE.md)), which runs in node. The binding runs in node too, or it never gets tested against the thing most likely to break it.

### 1.2 The boundary

The binding is the translation layer between two coordinate systems, and it is where index confusion ([ARCH §2.4](02-ARCHITECTURE.md)) would bite:

- **ProseMirror speaks visible positions** — integers, live characters only.
- **The CRDT speaks `ElemId`s** — tombstones included, positions meaningless.

The rule is that **visible indices exist only at the boundary and die inside it.** The moment a ProseMirror step enters the binding, its positions become `ElemId`s; nothing downstream of the binding ever sees an integer position, and an `ElemId` never escapes upward into a ProseMirror step. Two directions:

- `transactionToOps(tr)` — ProseMirror transaction in, CRDT ops out.
- `opsToSteps(ops)` — remote CRDT ops in, ProseMirror steps out, applied without disturbing the local selection except as §1.3 requires.

### 1.3 Selection is anchors

Per [ARCH §7](02-ARCHITECTURE.md), the local selection is stored as anchors (`ElemId` + side), not positions. When remote ops arrive, the selection is **recomputed from the anchors**, not transformed — there is nothing to transform. A remote insert 500 characters above your cursor does not move your cursor, because your cursor was never at position 500; it was pointing at a character. This is S10, and it is the single most-felt property in the product: every collaborative editor that jitters your cursor when someone types above you is failing exactly this.

### 1.4 Undo

Per [ARCH §8](02-ARCHITECTURE.md), the undo manager keeps a stack of inverse ops keyed by `ElemId` and applies them directly. It transforms nothing, and it is per-replica. `prosemirror-history` is deliberately not used: it is an OT-shaped undo built for a world where positions move, and wiring it in would import the exact problem this project exists to demonstrate the absence of. The hand-written undo manager is smaller than that integration would be — and it is the punchline.

---

## 2. `packages/demo`: the app

### 2.1 The five-second job

Someone opens the demo from a link and will not read the README first — they have to *see* it work before they read anything. So the demo is not "an editor" (an editor looks like a textarea and proves nothing). It is **two editors side by side, in one page, with a wire between them you can cut.**

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

Two panes, two independent replicas, two connection toggles. Both are live editors; type in either.

### 2.3 The three demonstrations, in order of impact

**1. Concurrent typing.** Type in both panes at once. Text appears in both, and each replica's cursor is visible in color, moving. This is the baseline, and every competitor demo has it.

**2. The offline toggle** — the one that matters, and it is one click:

- Flip A offline. Its indicator goes hollow and its pending counter starts climbing.
- Type in A, and type *different* text in B, in the same paragraph, overlapping.
- The panes are now visibly divergent, side by side, and that divergence is left on screen for a beat — most demos hide this state, and showing it is what makes the merge legible.
- Flip A online. The pending counter drains to zero and both panes converge to the same text. No conflict dialog, no "choose a version," no flicker of one document overwriting the other.

**3. Reload survival.** Reload the page while A is offline with pending ops. The text is still there (IndexedDB, [ARCH §6](02-ARCHITECTURE.md)); come back online and it reconciles. This proves the persistence layer without a word of explanation.

### 2.4 Affordances

- **A connection toggle per replica** — a switch, not a button, its state readable at a glance.
- **A pending-op counter per replica** (`doc.missingFrom(lastPushedVector).length`). Watching it climb while offline and drain on reconnect makes an invisible mechanism visible — cheap to build, disproportionately convincing.
- **Remote cursors and selections**, colored per replica with the replica label. They are ephemeral ([ARCH §7](02-ARCHITECTURE.md)): when a replica goes offline, its cursor fades after the TTL rather than sitting there forever.
- **A "third replica" button** that opens the same document in a new tab, for anyone who wants to check that two is not a special case.

### 2.5 What the demo is not

No toolbar, no bold/italic/headings beyond ProseMirror's basic schema, no file menu, no document list, no dark-mode toggle, no landing page. Each of those is a day of work that adds zero signal about distributed systems, and the demo is judged on whether the merge is legible, not on whether it has features. It is meant to read as an instrument, not a text editor.

---

## 3. Visual direction

The demo reads as a **network instrument** — closer to a packet inspector or an oscilloscope than to Google Docs.

- **Type.** One display face with character, one text face, one mono. No system stack (it reads as unfinished), and everything self-hosted ([SECURITY §1](03-SECURITY.md): no third-party requests, so no Google Fonts).
- **Color.** A near-monochrome shell where color carries exactly one meaning — replica identity. Two replicas, two colors (amber and teal). Connection state is form, not hue: a filled dot for online, hollow for offline. If color ever meant two things here, it would mean nothing.
- **Motion.** Almost none, with one exception: the convergence moment, when A comes back online and the panes reconcile, gets a beat — the incoming text arrives with a brief highlight that decays. Everything else is instant. The whole animation budget is spent on the two seconds that matter.
- **Density.** Tight. The pending counters, the vector state, the op count are visible without hunting. An instrument shows its readings.

---

## 4. Deploy

- The relay is **stateful** ([ARCH §5](02-ARCHITECTURE.md)), so this is not a static deploy: a host that runs a Node process with a volume (Fly.io, Render, Railway), or a Cloudflare Durable Object per document. The Durable Object model maps to the design almost exactly — one object, one append-only log, one document — and is the cheaper answer when the log stays in memory with periodic flush.
- The demo is static and can go anywhere; same origin as the relay where possible, which makes [SECURITY §2.3](03-SECURITY.md)'s CORS rule trivial.
- **Cold start matters.** A visitor who clicks a link and waits eight seconds for a machine to wake has already closed the tab, so keep a machine warm or use Durable Objects.
- A live demo that 404s months later is worse than no demo, so the hosting choice favors durability over novelty.

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
| F8 | Demo loads zero third-party resources ([SECURITY §1](03-SECURITY.md)) |
| F9 | Lighthouse performance is not embarrassing on a cold load |
