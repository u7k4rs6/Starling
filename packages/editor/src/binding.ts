import { Fragment, Node as PMNode, Slice } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import { ReplaceStep, Step } from "prosemirror-transform";
import type { Anchor, CrdtOp } from "starling-crdt";
import { Doc } from "starling-crdt";
import { pmPosToVisibleIndex, visibleIndexToPmPos } from "./positions.js";
import { schema } from "./schema.js";

/** FRONTEND §1.2: build the initial ProseMirror document from a `Doc`'s
 * current text — the "cold open" case, before any transaction has
 * happened locally. */
export function pmDocFromDoc(doc: Doc): PMNode {
  const text = doc.text;
  return schema.node("doc", null, [
    schema.node("paragraph", null, text.length > 0 ? [schema.text(text)] : []),
  ]);
}

/**
 * FRONTEND §1.2: "transactionToOps(tr) — ProseMirror transaction in,
 * CRDT ops out." Mutates `doc` as a side effect: `Doc.insertLocal`/
 * `deleteLocal` allocate ids from `doc`'s own counter and integrate
 * immediately (DECISIONS #0006 established this is how every exhibit's
 * "record a local op" works, not a separable compute-then-apply pair), so
 * there is no way to produce "the ops this transaction implies" without
 * also applying them to this specific `doc`.
 *
 * Only `ReplaceStep` is supported, matching `schema.ts`'s flat
 * single-paragraph, no-marks shape — that's the only step type ordinary
 * typing/deleting/pasting plain text produces against it. Anything else
 * means the binding's own schema contract was violated upstream, and
 * throwing is the honest response, not a silent no-op.
 */
export function transactionToOps(tr: Transaction, doc: Doc): CrdtOp[] {
  const ops: CrdtOp[] = [];
  for (const step of tr.steps) {
    if (!(step instanceof ReplaceStep)) {
      throw new Error(`editor: unsupported step type "${step.constructor.name}" — only plain-text ReplaceStep is supported by this schema`);
    }
    const fromIndex = pmPosToVisibleIndex(step.from);
    const toIndex = pmPosToVisibleIndex(step.to);

    // Deleting a range of N characters is N single-element deletes, all
    // at the same visible index: each deletion shifts everything after
    // it down by one, so the range's start index never moves.
    for (let i = fromIndex; i < toIndex; i += 1) {
      ops.push(doc.deleteLocal(fromIndex));
    }

    const insertedText = step.slice.content.textBetween(0, step.slice.content.size);
    for (let i = 0; i < insertedText.length; i += 1) {
      ops.push(doc.insertLocal(fromIndex + i, insertedText[i]!));
    }
  }
  return ops;
}

/**
 * The pure half of `opsToSteps`: given an op that is *already* integrated
 * into `doc` (the caller integrated it, or it was always local), compute
 * the ProseMirror step that reflects it. Split out from `opsToSteps` so
 * the undo manager (Step 13) can reuse the exact same position math for
 * ops it creates directly via `doc.deleteById`/`doc.insertBefore` — those
 * are integrated the moment they're created (same as any local op,
 * DECISIONS #0006), so calling `doc.receive` on them again would be
 * wrong, not just redundant (idempotent, but the wrong shape of call to
 * make from code that already knows the op is local).
 */
export function opToStep(op: CrdtOp, doc: Doc): Step {
  if (op.payload.type === "insert") {
    const visibleIndex = doc.resolveAnchor({ id: op.id, side: "before" });
    const pos = visibleIndexToPmPos(visibleIndex);
    const slice = new Slice(Fragment.from(schema.text(op.payload.char)), 0, 0);
    return new ReplaceStep(pos, pos, slice);
  }
  const visibleIndex = doc.resolveAnchor({ id: op.payload.target, side: "before" });
  const pos = visibleIndexToPmPos(visibleIndex);
  return new ReplaceStep(pos, pos + 1, Slice.empty);
}

/**
 * FRONTEND §1.2: "opsToSteps(ops) — remote CRDT ops in, ProseMirror steps
 * out." Integrates each op into `doc` (`doc.receive`) immediately before
 * computing its position via `opToStep`, one op at a time — not the whole
 * batch up front — because each step's position must be expressed
 * relative to the ProseMirror document *as it stands after the previous
 * steps in this same batch*, and `Doc.resolveAnchor` always reflects the
 * *full* current tree. Pre-integrating the whole batch would make an
 * early op's position already account for a later op's insertion,
 * producing a position valid against the *final* tree but wrong against
 * the PM document the caller is incrementally building up by applying
 * these steps in order.
 *
 * Precondition (not defended against here): ops must already be in
 * dependency-satisfying order, exactly as `Sequence.log`/`missingFrom`
 * always produce them (DECISIONS #0006, #0018) — every other consumer of
 * a CRDT op stream in this codebase relies on the same ordering. An op
 * received out of order is silently buffered by `Sequence` rather than
 * integrated (by design — see `sequence.ts`), and `resolveAnchor` on its
 * own just-buffered id would throw, the same way `insertBefore` already
 * throws on an unresolvable id elsewhere in `Doc`.
 */
export function opsToSteps(ops: CrdtOp[], doc: Doc): Step[] {
  const steps: Step[] = [];
  for (const op of ops) {
    doc.receive(op);
    steps.push(opToStep(op, doc));
  }
  return steps;
}

/**
 * FRONTEND §1.3 / ARCH §7: "the local selection is stored as anchors...
 * recomputed from the anchors, not transformed." These two functions are
 * the selection half of the same visible-index/ElemId boundary
 * `positions.ts` names for content edits — capture a PM position as an
 * anchor before it can go stale, and recompute a PM position from an
 * anchor after the document (local or remote) has changed.
 */
export function pmPosToAnchor(doc: Doc, pmPos: number): Anchor {
  return doc.anchorAt(pmPosToVisibleIndex(pmPos));
}

export function anchorToPmPos(doc: Doc, anchor: Anchor): number {
  return visibleIndexToPmPos(doc.resolveAnchor(anchor));
}
