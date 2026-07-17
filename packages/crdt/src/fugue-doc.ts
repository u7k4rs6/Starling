import { compareElemIds, type ElemId, type ReplicaId } from "./elem-id.js";
import { Sequence } from "./sequence.js";
import type { CrdtOp, CrdtPayload } from "./ops.js";

type Side = "L" | "R";

type FugueNode = {
  id: ElemId;
  char: string;
  deleted: boolean;
  parent: FugueNode | null;
  /** This node's own children, bucketed by which side of *this* node they
   * were inserted on. Each bucket is kept sorted by descending id — same
   * convention RGA uses for concurrent same-origin siblings (§2.3 of
   * ARCH), just scoped to a much smaller group: only true (parent, side)
   * siblings, never the whole document. That scoping is the entire fix. */
  left: FugueNode[];
  right: FugueNode[];
  size: number;
  liveSize: number;
};

function makeNode(id: ElemId, char: string): FugueNode {
  return { id, char, deleted: false, parent: null, left: [], right: [], size: 1, liveSize: 1 };
}

function bucketSize(nodes: FugueNode[]): number {
  return nodes.reduce((sum, n) => sum + n.size, 0);
}

function bucketLiveSize(nodes: FugueNode[]): number {
  return nodes.reduce((sum, n) => sum + n.liveSize, 0);
}

function recomputeSizes(node: FugueNode): void {
  node.size = 1 + bucketSize(node.left) + bucketSize(node.right);
  node.liveSize = (node.deleted ? 0 : 1) + bucketLiveSize(node.left) + bucketLiveSize(node.right);
}

function propagateSizesUp(node: FugueNode | null): void {
  let cur = node;
  while (cur !== null) {
    recomputeSizes(cur);
    cur = cur.parent;
  }
}

/**
 * Insert `node` into a (parent, side) sibling bucket at the position its
 * id demands, RGA-style: skip past existing same-bucket siblings with
 * higher precedence. This is the "one while loop" — same shape as RGA's
 * skip-forward loop, just scoped to true siblings only.
 *
 * Direction depends on which side of the parent the bucket sits on,
 * because in-order adjacency to the parent is on opposite ends of the two
 * buckets: a right bucket traverses as [parent, R1, R2, ...] — array index
 * 0 is adjacent to the parent — while a left bucket traverses as
 * [..., L2, L1, parent] — the *last* array index is adjacent to the
 * parent. "Highest id ends up closest to the anchor" (RGA's own
 * convention for concurrent same-origin siblings) therefore means
 * descending order for a right bucket, but ascending order for a left
 * one. Getting this backwards doesn't break convergence (any fixed rule
 * converges) — it broke `insertBefore` instead, landing the newest insert
 * on the wrong end of the bucket entirely. See DECISIONS #0017.
 */
function insertIntoBucket(bucket: FugueNode[], node: FugueNode, side: Side): void {
  let i = 0;
  if (side === "R") {
    while (i < bucket.length && compareElemIds(bucket[i]!.id, node.id) > 0) i += 1;
  } else {
    while (i < bucket.length && compareElemIds(bucket[i]!.id, node.id) < 0) i += 1;
  }
  bucket.splice(i, 0, node);
}

function inOrderWalk(forest: FugueNode[], visit: (n: FugueNode) => void): void {
  for (const node of forest) {
    inOrderWalk(node.left, visit);
    visit(node);
    inOrderWalk(node.right, visit);
  }
}

/** Which top-level node's subtree contains the target visible index —
 * each node's own `liveSize` already covers its whole subtree, so this is
 * a plain linear scan across the forest, no subtraction-then-recheck. */
function nodeAtVisibleIndex(forest: FugueNode[], visibleIndex: number): FugueNode | null {
  let remaining = visibleIndex;
  for (const node of forest) {
    if (remaining < node.liveSize) return nodeAtVisibleIndexWithin(node, remaining);
    remaining -= node.liveSize;
  }
  return null;
}

/** `remaining` is already known (by the caller) to be within `node`'s own
 * subtree — breaks it down as left bucket / node itself / right bucket. */
function nodeAtVisibleIndexWithin(node: FugueNode, remaining: number): FugueNode {
  const leftLive = bucketLiveSize(node.left);
  if (remaining < leftLive) {
    // Guaranteed non-null: remaining < leftLive means some left child's
    // subtree contains it, by the same liveSize-scan argument as above.
    return nodeAtVisibleIndex(node.left, remaining) as FugueNode;
  }
  let rest = remaining - leftLive;
  if (rest === 0 && !node.deleted) return node;
  if (!node.deleted) rest -= 1;
  // Guaranteed non-null for the same reason: rest is within node.right's
  // combined liveSize because node.liveSize accounted for it upstream.
  return nodeAtVisibleIndex(node.right, rest) as FugueNode;
}

/**
 * Museum survivor (PRD §4): Fugue over a tree, differing from `RgaDoc`'s
 * merge rule by tracking, per element, which side of its origin it was
 * inserted on, and tie-breaking only among true same-(origin, side)
 * siblings instead of the whole document (ARCH §2.3). That one change is
 * what keeps concurrent backward-typed runs contiguous instead of
 * interleaving character-by-character — see `fugue-doc.test.ts` for the
 * proof, and `rga-doc.test.ts` (exhibit 3, unmodified) for the failure
 * this fixes.
 *
 * Correctness-first implementation: lookups walk the tree (O(subtree
 * size), degrading to O(n) for a long single-sided chain — e.g. a long
 * run of backward typing) rather than the O(log n) an order-statistic
 * treap would give. ARCH §2.5 describes the aspirational "Fugue over an
 * order-statistic treap"; Step 6's own gate is S5 (no interleaving), not a
 * performance target — see DECISIONS #0017 for why full treap-level
 * efficiency was scoped out of this step rather than silently claimed.
 */
export class Doc extends Sequence<CrdtPayload> {
  private readonly rootChildren: FugueNode[] = [];
  private readonly byId = new Map<string, FugueNode>();

  constructor(replica: ReplicaId) {
    super(replica);
  }

  get text(): string {
    const parts: string[] = [];
    inOrderWalk(this.rootChildren, (n) => {
      if (!n.deleted) parts.push(n.char);
    });
    return parts.join("");
  }

  private static key(id: ElemId): string {
    return `${id.replica}:${id.counter}`;
  }

  private nodeForId(id: ElemId): FugueNode {
    const node = this.byId.get(Doc.key(id));
    if (!node) throw new RangeError("Doc: id not found");
    return node;
  }

  /** Visible index → (origin id, side) for a new insertion. Inserting at
   * the very start of existing content anchors LEFT of what's currently
   * there (`l` = element at position 0, side "L") instead of RGA's single
   * always-append-right convention — that asymmetry is what turns
   * repeated "insert at 0" (backward typing) into a left-leaning chain
   * per replica, instead of a flat sibling group tie-broken by id against
   * every other replica's chain at once. */
  private originForVisibleIndex(visibleIndex: number): { l: ElemId | null; side: Side } {
    if (visibleIndex === 0) {
      const following = nodeAtVisibleIndex(this.rootChildren, 0);
      return following === null ? { l: null, side: "R" } : { l: following.id, side: "L" };
    }
    const preceding = nodeAtVisibleIndex(this.rootChildren, visibleIndex - 1);
    if (preceding === null) throw new RangeError(`visible index ${visibleIndex} out of range`);
    return { l: preceding.id, side: "R" };
  }

  insertLocal(visibleIndex: number, char: string): CrdtOp {
    const { l, side } = this.originForVisibleIndex(visibleIndex);
    return this.recordLocalOp({ type: "insert", l, side, char }, l === null ? [] : [l]);
  }

  /** ARCH §2.4: the inverse of del(id) is insertBefore(tombstoneId, char),
   * not a revive. Origin is the tombstone itself, side "R": a right
   * bucket's array-first position is adjacent to its parent (see
   * `insertIntoBucket`), so the freshly-allocated (highest-id) new node
   * lands immediately next to the tombstone regardless of whatever else
   * is already in that bucket. The tombstone itself never renders, so
   * "immediately after the tombstone" and "immediately before it" are the
   * same visible position — what matters is landing adjacent to the
   * anchor, not which literal side. */
  insertBefore(tombstoneId: ElemId, char: string): CrdtOp {
    this.nodeForId(tombstoneId); // throws if unresolvable
    return this.recordLocalOp({ type: "insert", l: tombstoneId, side: "R", char }, [tombstoneId]);
  }

  deleteLocal(visibleIndex: number): CrdtOp {
    const node = nodeAtVisibleIndex(this.rootChildren, visibleIndex);
    if (!node) throw new RangeError(`visible index ${visibleIndex} out of range`);
    return this.recordLocalOp({ type: "delete", target: node.id }, [node.id]);
  }

  protected integrate(op: CrdtOp): void {
    if (op.payload.type === "delete") {
      // op.payload.target is guaranteed already integrated: deps: [target]
      // (DECISIONS #0010) buffers this op until it is.
      const node = this.nodeForId(op.payload.target);
      node.deleted = true;
      propagateSizesUp(node);
      return;
    }

    const { l, char } = op.payload;
    const side: Side = op.payload.side ?? "R";
    const newNode = makeNode(op.id, char);

    if (l === null) {
      insertIntoBucket(this.rootChildren, newNode, side);
      newNode.parent = null;
    } else {
      // l is guaranteed already integrated for the same reason as delete.
      const parent = this.nodeForId(l);
      const bucket = side === "L" ? parent.left : parent.right;
      insertIntoBucket(bucket, newNode, side);
      newNode.parent = parent;
    }

    propagateSizesUp(newNode.parent ?? newNode);
    this.byId.set(Doc.key(op.id), newNode);
  }
}
