# starling-crdt

A from-scratch [Fugue](https://arxiv.org/abs/2305.00583)/RGA CRDT for
collaborative plain text. No runtime dependencies. A compact binary wire
format (LEB128 varints, run-length-encoded deletion runs — 60,000
deletions in 14 bytes). Tombstone-based deletion. Id-based anchors for
cursors and undo that survive concurrent remote edits, not raw offsets.

This package is the CRDT core of [Starling](https://github.com/u7k4rs6/Starling),
a full collaborative editor (ProseMirror binding, a relay server, offline-
first persistence, presence). Most people building an editor want that
whole stack, not this package alone — see the main repository's
[`docs/`](https://github.com/u7k4rs6/Starling/tree/main/docs) for the
full architecture. This package is what you'd reach for if you want the
CRDT algorithm itself, decoupled from everything else.

## Install

```
npm install starling-crdt
```

## Usage

```ts
import { Doc } from "starling-crdt";

const a = new Doc("replica-a");
const b = new Doc("replica-b");

// Local edits return an op — send it to other replicas however you like
// (a WebSocket, an HTTP relay, a file). This package has no networking
// opinions of its own.
const op1 = a.insertLocal(0, "h");
const op2 = a.insertLocal(1, "i");
b.receive(op1);
b.receive(op2);

a.text; // "hi"
b.text; // "hi" — converges regardless of delivery order or duplicates

// A cursor as an id + side, not a number — stays attached to the same
// character even after concurrent edits shift what index it's at.
const anchor = a.anchorAt(1);
a.insertLocal(0, "!");
a.resolveAnchor(anchor); // 2, not 1 — followed the character it anchored to
```

### Encoding, for wire transport or disk persistence

```ts
import { encodeOps, decodeOps } from "starling-crdt";

const bytes = encodeOps([op1, op2]); // Uint8Array
const ops = decodeOps(bytes);
```

### Sync: only send what a peer is missing

```ts
// `theirVector`: what the other replica already told you it has.
const missing = a.missingFrom(theirVector);
const bytes = encodeOps(missing);
```

## What's in the box

- `Doc` — the Fugue-based implementation. This is the one to use.
- `RgaDoc` — an RGA implementation with an order-statistic treap for
  O(log n) operations. Kept as a working alternative; `Doc` fixes a
  correctness gap RGA has under concurrent backward typing (interleaving),
  which is why it's the default.
- `NaiveDoc`, `ArrayDoc` — reference implementations that are either
  incorrect under concurrency (`NaiveDoc`) or correct but algorithmically
  unusable at scale (`ArrayDoc`, O(n) per operation). Not for production
  use — kept for the same reason a museum keeps a "before" exhibit next
  to the real one: `bench/` in the main repository benchmarks all four
  side by side, honestly, including the ones that lose.

## Honest performance note

`Doc` currently has an O(n²) worst case for a single replica typing a
long document forward without pausing (see the main repository's
`bench/README.md` and `docs/DECISIONS.md` #0026 for the full,
unflattering measurement — 168 seconds to cold-open a 100,000-character
forward-typed document, against a 1-second target). `RgaDoc` doesn't
have this problem and is faster in that specific scenario. If your
workload is large single-session forward typing and cold-open latency
matters, benchmark both against your actual workload before picking one.

## License

MIT
