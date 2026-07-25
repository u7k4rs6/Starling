import { compareElemIds, toRef, type ElemRef, type ReplicaId } from "./elem-id.js";
import { Sequence } from "./sequence.js";
import type { CrdtOp, CrdtPayload } from "./ops.js";
import {
  type TreapNode,
  indexOfNode,
  inOrderChars,
  insertAt,
  leftmostNode,
  makeNode,
  markDeleted,
  nextInOrder,
  nodeAtInternalIndex,
  nodeAtVisibleIndex,
} from "./treap.js";

/**
 * Museum exhibit 3 (PRD §4), correct AND fast: same RGA merge rule as
 * `ArrayDoc` (exhibit 2) — `integrate()` differs from `ArrayDoc`'s by
 * storage only, not logic — but backed by the order-statistic treap
 * (ARCH §2.5) instead of an array, so `indexOf` and insert are O(log n).
 * Target: S6, 100k-character cold-open under 1s (bench/, Step 15).
 *
 * Still interleaves on concurrent backward typing (ARCH §2.3) — that is
 * this exhibit's own bug, preserved once Fugue replaces it for `Doc` at
 * Step 6. Do not fix the interleaving here; that deletes the exhibit.
 */
export class RgaDoc extends Sequence<CrdtPayload> {
  private root: TreapNode | null = null;
  private readonly byId = new Map<string, TreapNode>();

  constructor(replica: ReplicaId) {
    super(replica);
  }

  get text(): string {
    return inOrderChars(this.root, true);
  }

  private static key(id: ElemRef): string {
    return `${id.replica}:${id.counter}`;
  }

  private nodeForId(id: ElemRef): TreapNode {
    const node = this.byId.get(RgaDoc.key(id));
    if (!node) throw new RangeError("RgaDoc: id not found");
    return node;
  }

  /** Visible index → the id of the live element immediately before it, or
   * null for "insert at the very start." O(log n) via the treap's live
   * subtree counts (ARCH §2.5) — the mapping ArrayDoc does in O(n). */
  private originForVisibleIndex(visibleIndex: number): ElemRef | null {
    if (visibleIndex === 0) return null;
    const node = nodeAtVisibleIndex(this.root, visibleIndex - 1);
    if (!node) throw new RangeError(`visible index ${visibleIndex} out of range`);
    return toRef(node.id);
  }

  insertLocal(visibleIndex: number, char: string): CrdtOp {
    const l = this.originForVisibleIndex(visibleIndex);
    return this.recordLocalOp({ type: "insert", l, char }, l === null ? [] : [l]);
  }

  /** ARCH §2.4: the inverse of del(id) is insertBefore(tombstoneId, char),
   * not a revive — same semantics as ArrayDoc's, O(log n) here. */
  insertBefore(tombstoneId: ElemRef, char: string): CrdtOp {
    const node = this.nodeForId(tombstoneId);
    const idx = indexOfNode(node);
    const prev = idx === 0 ? null : nodeAtInternalIndex(this.root, idx - 1) ?? null;
    const l = prev === null ? null : toRef(prev.id);
    return this.recordLocalOp({ type: "insert", l, char }, l === null ? [] : [l]);
  }

  deleteLocal(visibleIndex: number): CrdtOp {
    const node = nodeAtVisibleIndex(this.root, visibleIndex);
    if (!node) throw new RangeError(`visible index ${visibleIndex} out of range`);
    const target = toRef(node.id);
    return this.recordLocalOp({ type: "delete", target }, [target]);
  }

  protected integrate(op: CrdtOp): void {
    if (op.payload.type === "delete") {
      // op.payload.target is guaranteed already integrated: deps: [target]
      // (DECISIONS #0010) buffers this op until it is.
      const node = this.nodeForId(op.payload.target);
      markDeleted(node);
      return;
    }

    const { l, char } = op.payload;
    // l, if not null, is guaranteed already integrated for the same reason.
    // Walk forward via in-order successor (amortized O(1) per step) rather
    // than re-descending from the root at every candidate — the point of
    // having parent pointers at all.
    let at: number;
    let candidate: TreapNode | null;
    if (l === null) {
      at = 0;
      candidate = leftmostNode(this.root);
    } else {
      const originNode = this.nodeForId(l);
      at = indexOfNode(originNode) + 1;
      candidate = nextInOrder(originNode);
    }
    while (candidate !== null && compareElemIds(candidate.id, op.id) > 0) {
      at += 1;
      candidate = nextInOrder(candidate);
    }

    const newNode = makeNode(op.id, char);
    this.root = insertAt(this.root, at, newNode);
    this.byId.set(RgaDoc.key(op.id), newNode);
  }
}
