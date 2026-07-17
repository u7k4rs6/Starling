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

/**
 * Explicit-stack in-order traversal — not recursive. A tree built by one
 * replica typing forward without pause is a single-sided chain whose
 * depth equals its length; native recursion here means stack depth grows
 * with document length, and real documents exceed JS's call-stack limit
 * (`RangeError: Maximum call stack size exceeded`) well under 30,000
 * characters — found via the Step 15 benchmark, not reasoned out in
 * advance (DECISIONS #0026). Each `FugueNode`'s children are *arrays*
 * (sibling buckets), not single pointers, so this isn't the textbook
 * binary-tree iterative in-order walk: a work item is either "expand
 * this forest" (push its nodes' left-bucket/self/right-bucket work items,
 * in reverse array order so the first array entry ends up on top of the
 * stack — a stack is LIFO, so reverse-pushing is what makes forward
 * array order come out as forward pop order) or "visit this node".
 */
type WorkItem = { kind: "forest"; forest: FugueNode[] } | { kind: "visit"; node: FugueNode };

function pushForestExpansion(stack: WorkItem[], forest: FugueNode[]): void {
  for (let i = forest.length - 1; i >= 0; i -= 1) {
    const node = forest[i]!;
    stack.push({ kind: "forest", forest: node.right });
    stack.push({ kind: "visit", node });
    stack.push({ kind: "forest", forest: node.left });
  }
}

function inOrderWalk(forest: FugueNode[], visit: (n: FugueNode) => void): void {
  const stack: WorkItem[] = [{ kind: "forest", forest }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.kind === "visit") {
      visit(item.node);
    } else {
      pushForestExpansion(stack, item.forest);
    }
  }
}

/**
 * Which node sits at `visibleIndex` — a single path down the tree (no
 * branching search: at each step `liveSize`/bucket comparisons say
 * exactly which child to descend into), so this only ever needed
 * iteration, not the general in-order-walk machinery above. Folded what
 * was two mutually-recursive functions (`nodeAtVisibleIndex` /
 * `nodeAtVisibleIndexWithin`) into one loop for the same crash reason as
 * `inOrderWalk` — same complexity as before (still O(chain length) time
 * for a long single-sided run, just O(1) stack instead of O(chain
 * length) stack), not a performance fix, a correctness one.
 */
function nodeAtVisibleIndex(forest: FugueNode[], visibleIndex: number): FugueNode | null {
  let currentForest = forest;
  let remaining = visibleIndex;
  for (;;) {
    let node: FugueNode | null = null;
    for (const candidate of currentForest) {
      if (remaining < candidate.liveSize) {
        node = candidate;
        break;
      }
      remaining -= candidate.liveSize;
    }
    if (node === null) return null;

    const leftLive = bucketLiveSize(node.left);
    if (remaining < leftLive) {
      currentForest = node.left;
      continue;
    }
    let rest = remaining - leftLive;
    if (rest === 0 && !node.deleted) return node;
    if (!node.deleted) rest -= 1;
    currentForest = node.right;
    remaining = rest;
  }
}

/** Which visible position, relative to the anchored character, the cursor
 * sits at: immediately before it, or immediately after it. Once a
 * character is tombstoned the two collapse to the same visible position
 * (ARCH §7 — the tombstone still holds the position; `insertBefore`'s own
 * comment above notes the identical collapse for the same reason). */
export type AnchorSide = "before" | "after";

/**
 * ARCH §7: "A cursor is not an index, it is an ElemId plus a side... When
 * a remote user inserts text above your cursor, your cursor does not
 * move, because it was never at a number." `id: null` is the one genuine
 * exception — there is no character to point at in a document with no
 * live content yet, so a boundary anchor on an empty doc always resolves
 * to 0 rather than pointing at anything.
 */
export type Anchor = { id: ElemId | null; side: AnchorSide };

/**
 * Count of live (non-tombstoned) nodes strictly before `target` in the
 * tree's in-order sequence. Built on the same explicit-stack traversal
 * `inOrderWalk` uses, for the same reason (DECISIONS #0026: a
 * mutually-recursive version of this crashed past a few thousand
 * characters on a single-sided chain) — walking node by node until
 * `target` is found, rather than the earlier recursive version's
 * `bucketLiveSize`-skip of whole sibling subtrees known not to contain
 * it. That's a real, deliberately-accepted complexity trade: crash-safe
 * and O(chain length) for the long-thin-chain shape that was actually
 * crashing is what matters here, not preserving an O(1)-per-sibling
 * shortcut for wide trees this function was never the bottleneck for
 * (`resolveAnchor`, not the cold-open path `nodeAtVisibleIndex` serves).
 * O(1) stack depth regardless, which is the property that matters.
 */
function countLiveBefore(forest: FugueNode[], target: FugueNode): number {
  const stack: WorkItem[] = [{ kind: "forest", forest }];
  let acc = 0;
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.kind === "forest") {
      pushForestExpansion(stack, item.forest);
      continue;
    }
    if (item.node === target) return acc;
    if (!item.node.deleted) acc += 1;
  }
  throw new Error("Doc: countLiveBefore target not found in tree");
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

  /** ARCH §8: undo of "insert x" is "delete the element with *this id*" —
   * a specific id, not "whatever's at index N now" (§7's same reasoning
   * that made `resolveAnchor` necessary applies here too: intervening
   * remote edits can move the visible index this character sits at
   * around freely). Idempotent the same way any delete is (ARCH §2.4):
   * deleting an id that's already tombstoned (e.g., someone else deleted
   * it concurrently with a pending local undo) still records a delete op
   * rather than special-casing it away — "deleted" is already a monotone
   * fact once true, so this is redundant, not wrong. */
  deleteById(id: ElemId): CrdtOp {
    this.nodeForId(id); // throws if unresolvable — same contract as insertBefore
    return this.recordLocalOp({ type: "delete", target: id }, [id]);
  }

  /** The character a (possibly tombstoned) id was inserted with — needed
   * by undo (ARCH §2.4): undoing a delete means inserting *a new*
   * character with the same value next to the tombstone, and the
   * tombstone itself (never actually removed from the tree) is the only
   * place that original value still lives. */
  charForId(id: ElemId): string {
    return this.nodeForId(id).char;
  }

  private liveLength(): number {
    return bucketLiveSize(this.rootChildren);
  }

  /** ARCH §7 / S10: pin a cursor to whichever character currently sits at
   * `visibleIndex`, not to the number itself. `visibleIndex` may equal the
   * document's current live length (cursor at the very end): there is no
   * character *at* that position to point "before", so the anchor instead
   * points *after* the last live character — still a specific id, not a
   * number, so a later insert past the live end doesn't drag this anchor
   * along with it. Only a genuinely empty document has no character at
   * all to anchor to (`id: null`, see `Anchor`). */
  anchorAt(visibleIndex: number): Anchor {
    const length = this.liveLength();
    if (!Number.isInteger(visibleIndex) || visibleIndex < 0 || visibleIndex > length) {
      throw new RangeError(`visible index ${visibleIndex} out of range`);
    }
    const atIndex = nodeAtVisibleIndex(this.rootChildren, visibleIndex);
    if (atIndex !== null) return { id: atIndex.id, side: "before" };
    if (length === 0) return { id: null, side: "before" };
    const last = nodeAtVisibleIndex(this.rootChildren, length - 1)!;
    return { id: last.id, side: "after" };
  }

  /** The anchor's *current* visible index — recomputed from the tree's
   * present shape every call, never cached, because the whole point (ARCH
   * §7) is that it can change out from under the caller as remote ops
   * arrive. Deliberately does not special-case an id this replica has
   * never seen: `nodeForId` throws, same as `insertBefore` does for an
   * unresolvable tombstone id — an anchor is only ever meaningful relative
   * to ops this replica has actually integrated. */
  resolveAnchor(anchor: Anchor): number {
    if (anchor.id === null) return 0;
    const node = this.nodeForId(anchor.id);
    // countLiveBefore won't throw its "not found" error here: every node
    // reachable via `byId` was spliced into this same tree by `integrate`,
    // in the same call — the two never drift apart, so a node `nodeForId`
    // found is always findable by `countLiveBefore`'s walk too.
    const before = countLiveBefore(this.rootChildren, node);
    return anchor.side === "after" ? before + (node.deleted ? 0 : 1) : before;
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
