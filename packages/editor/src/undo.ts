import type { CrdtOp, Doc, ElemId } from "starling-crdt";

type UndoEntry = { kind: "insert"; id: ElemId } | { kind: "delete"; tombstoneId: ElemId; char: string };

/**
 * ARCH §8 / FRONTEND §1.4: "Undo transforms nothing." No OT-style
 * transform against intervening ops, because there is nothing to
 * transform — undo of "insert x" is "delete the element with *this id*"
 * (`Doc.deleteById`), and undo of a delete is "insert a *new* character
 * before the tombstone" (`Doc.insertBefore`, ARCH §2.4's "revive is not a
 * thing"). Both target an id, not a position, so neither cares what
 * happened to the document in between recording and undoing — that's the
 * whole point.
 *
 * Deliberately has no ProseMirror awareness (no `Transaction`/`Step`
 * import): it operates purely on `Doc`, the same way `binding.ts`'s
 * `positions.ts` keeps visible indices from crossing into ElemId
 * territory. `undo()` returns the raw `CrdtOp[]` it just created; turning
 * those into ProseMirror steps is the caller's job via `opToStep`
 * (`binding.ts`) — the same function `opsToSteps` uses for remote ops,
 * reused here for undo's own local ones instead of duplicated.
 *
 * Per-replica by construction, not by a replica check: this stack only
 * ever holds entries `record()` was called with, and nothing in this
 * package ever calls `record()` for a remote op (`opsToSteps` never
 * touches it) — "your last edit, not the last edit globally" falls out
 * of what the caller chooses to record, not a runtime filter.
 *
 * No redo: not named anywhere in the docs this project is built from: a
 * feature added because "editors usually have it" would be exactly the
 * kind of undocumented scope this whole build has been avoiding.
 */
export class UndoManager {
  private readonly stack: UndoEntry[][] = [];

  /** Call once per local transaction, with exactly the ops
   * `transactionToOps` returned for it — one call, one undo step,
   * matching ordinary editor UX (undo an entire typed/pasted burst at
   * once, not one character at a time). A transaction with no ops (e.g.
   * a selection-only change) should not be recorded — pushing an empty
   * batch would make `canUndo()` true for a no-op undo. */
  record(ops: CrdtOp[], doc: Doc): void {
    if (ops.length === 0) return;
    const entries: UndoEntry[] = ops.map((op) =>
      op.payload.type === "insert"
        ? { kind: "insert", id: op.id }
        : { kind: "delete", tombstoneId: op.payload.target, char: doc.charForId(op.payload.target) }
    );
    this.stack.push(entries);
  }

  canUndo(): boolean {
    return this.stack.length > 0;
  }

  /**
   * Pops the last recorded batch and applies its inverse to `doc`, entry
   * by entry in reverse — the standard "undo the last sub-edit of the
   * batch first" order, same as undoing a multi-step edit anywhere else.
   * Throws if the stack is empty; check `canUndo()` first, same
   * convention as `Doc`'s own id-lookup methods failing loudly rather
   * than silently no-op'ing.
   *
   * `onOp`, if given, is called immediately after *each* sub-op is
   * created — not after the whole batch. This matters, not just as a
   * convenience: `opToStep` (`binding.ts`) computes a position via
   * `doc.resolveAnchor`, which reflects the *entire current tree*. If a
   * caller instead waited for `undo()` to finish and then called
   * `opToStep` on the returned array, every op in the batch would already
   * be fully integrated by the time any position was computed — the same
   * "pre-integrating the whole batch" hazard `opsToSteps` was written to
   * avoid (DECISIONS #0023), here on undo's own ops instead of remote
   * ones. `onOp` is what lets the caller interleave correctly, the same
   * shape `opsToSteps`'s own loop already uses internally.
   */
  undo(doc: Doc, onOp?: (op: CrdtOp) => void): CrdtOp[] {
    const entries = this.stack.pop();
    if (entries === undefined) throw new Error("editor: nothing to undo");
    const inverseOps: CrdtOp[] = [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i]!;
      const op = entry.kind === "insert" ? doc.deleteById(entry.id) : doc.insertBefore(entry.tombstoneId, entry.char);
      inverseOps.push(op);
      onOp?.(op);
    }
    return inverseOps;
  }
}
