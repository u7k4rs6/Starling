import { describe, expect, it } from "vitest";
import { Doc } from "./fugue-doc.js";

/**
 * Regression harness for F-2 (ElemId reuse after reload → silent local edit
 * loss + genuine cross-replica divergence).
 *
 * Root cause is the same counter as F-1. Replaying a persisted op log into a
 * fresh Doc with the SAME replica id goes through `receive`, which never
 * touches `counter`, so the counter restarts at 0. The next locally-created
 * op is then issued with an id already used by an earlier op. Idempotence is
 * keyed on id, so the collision is silently dropped.
 *
 * The demo deliberately keeps the replica id stable across reloads (so
 * pending ops resume), which makes this fire on every reload of the shipped
 * demo.
 *
 * FIXED (Batch 1). `Sequence.reserveOwnId` now advances the identity counter
 * past any own-op arriving through `receive`, so replay can no longer leave
 * the counter behind the log. These cases were `it.fails` while the bug
 * stood; they are plain `it` assertions now.
 *
 * Note this is the identity counter ONLY — F-1 (non-causal element ordering,
 * same counter, different consequence) is a separate finding and is still
 * pinned as failing in `fugue-intention.test.ts`.
 */

/** Simulate persist + reload: return the op log, and a fresh Doc with the
 * same replica id that has replayed that log (as Provider.create does). */
function persistAndReload(replica: string, base: string): { log: ReturnType<Doc["insertLocal"]>[]; reloaded: Doc } {
  const live = new Doc(replica);
  const log = [...base].map((ch, i) => live.insertLocal(i, ch));
  const reloaded = new Doc(replica); // same id, fresh counter
  for (const op of log) reloaded.receive(op);
  return { log, reloaded };
}

describe("F-2 mode 1: an edit made after reload is silently lost", () => {
  it("the reloaded doc reproduces its own persisted content", () => {
    const { reloaded } = persistAndReload("A", "hello");
    expect(reloaded.text).toBe("hello");
  });

  it("typing after reload appears in the text", () => {
    const { reloaded } = persistAndReload("A", "hello");
    reloaded.insertLocal(5, "!");
    expect(reloaded.text).toBe("hello!");
  });

  it("the op allocated after reload does not reuse an existing id", () => {
    const { log, reloaded } = persistAndReload("A", "hello");
    const op = reloaded.insertLocal(5, "!");
    const collides = log.some((o) => o.id.replica === op.id.replica && o.id.counter === op.id.counter);
    expect(collides).toBe(false);
  });
});

describe("F-2 mode 2: a colliding post-reload op causes divergence by delivery order", () => {
  it("two peers given the same op set converge regardless of order", () => {
    const { log, reloaded } = persistAndReload("X", "hi");
    // Before the fix this reused X:0 (already the 'h' in the log); it now
    // allocates past the whole replayed log instead.
    const postReload = reloaded.insertLocal(2, "!");

    const p1 = new Doc("p1");
    for (const op of log) p1.receive(op);
    p1.receive(postReload);

    const p2 = new Doc("p2");
    p2.receive(postReload); // arrives first: buffered until its dep lands
    for (const op of log) p2.receive(op);

    expect(p1.text).toBe(p2.text);
    // Asserted explicitly, not just cross-peer equality: two empty docs
    // would satisfy convergence alone. Before the fix these were "hi" and
    // "" — convergent-looking only if you never check the content.
    expect(p1.text).toBe("hi!");
  });
});
