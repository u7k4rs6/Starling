# @starling/provider

Client-side glue for `starling-crdt`: it owns a `Doc`, persists it locally
(`IndexedDbPersistence`), and syncs it against a relay over the `RelayTransport`
interface (`append(bytes) -> offset`, `read(from) -> bytes`). The offline story
is entirely `doc.missingFrom(lastPushedVector)`, computed on demand; disconnection
is just a long gap between `sync()` calls, not a special state.

```ts
import { Provider, HttpRelayTransport, IndexedDbPersistence } from "@starling/provider";

const provider = await Provider.create(
  "replica-id",
  new IndexedDbPersistence("my-doc"),
  new HttpRelayTransport("https://relay.example", "room-id")
);

await provider.insertLocal(0, "h");
await provider.sync(); // pull, apply, push the delta
provider.text; // "h"
```

`sync()` is safe to call concurrently (runs serialize) and is what you call on a
timer to keep a replica live.

## The sync-loop contract (read this before writing your own loop)

`Provider` gives you `sync()`, but it does **not** ship the loop that decides
*when* to call it. That is deliberate: cadence is a UI concern (foreground vs
background, recent activity, battery, a relay's rate limits). The library ships
the decision function, `nextSyncDecision`, and you write the loop around it. If
you do, honour this contract, because getting it wrong is subtle and was a real
bug in this repo's own demo.

`nextSyncDecision(activity)` returns one of two things:

- `{ poll: true, delayMs }`: call `sync()` again after `delayMs`.
- `{ poll: false }`: **stop.** Do not schedule another tick. It returns this
  when a hidden tab has been idle past a grace window, because on a free relay a
  poll is an inbound request and endless polling holds the instance awake. You
  are expected to resume later on some external signal (a `visibilitychange`
  back to visible, a fresh local edit, whatever fits your app).

**Track "stopped" with an explicit boolean, never by the presence or absence of
a timer handle.** The trap: a natural-looking loop stores the `setTimeout` id in
a `timer` variable and, on stop, just does not set a new one; then it tries to
detect "am I stopped?" with `if (timer === undefined)`. But `timer` still holds
the id of the timer that just fired to run the stopping tick, so it is never
`undefined` at that point, and the resume never fires. The loop dies silently
and permanently. A handle is a resource to clean up, not a state to read; keep
the state in its own flag:

```ts
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;

function schedule(activity) {
  const decision = nextSyncDecision(activity);
  if (decision.poll) {
    stopped = false;
    timer = setTimeout(tick, decision.delayMs);
  } else {
    stopped = true; // explicit, not "timer is undefined"
  }
}

function onResumeSignal() {
  if (stopped) {
    stopped = false;
    void tick();
  }
}
```

Also wrap the `sync()` in your tick so a transient failure (a rate-limit `429`, a
network blip) does not kill the loop: catch it, and let the next tick retry, since
`missingFrom` re-derives the unsent delta and the state vector was never advanced
past it. A `RelayPermanentError` (`507` frozen room, `413` oversized) is the one
exception, terminal by design; stop and surface it rather than retrying forever.
