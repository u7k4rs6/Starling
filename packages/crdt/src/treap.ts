import { hashElemId, type ElemId } from "./elem-id.js";

/**
 * Order-statistic treap (ARCH §2.5). Not a search tree ordered by a
 * comparable key — an *implicit* treap: position in the in-order traversal
 * IS the document's internal index, maintained by split/merge on COUNT,
 * not by comparing node values. `priority` (hash(ElemId), deterministic)
 * only decides which node becomes the parent in a merge, i.e. tree shape
 * and balance — it has nothing to do with document order.
 *
 * Two counts per node: `size` (subtree size, tombstones included — this is
 * what makes `indexOfNode` O(log n)) and `liveSize` (subtree size counting
 * only non-deleted nodes — this is what makes the visible↔internal mapping
 * O(log n) instead of the O(n) scan ArrayDoc does).
 *
 * Parent pointers let `indexOfNode`/`visibleIndexOfNode` walk *up* from a
 * node to the root to compute its position, without a root-down search —
 * the point being that a lookup starts from a node you already have (via
 * the id→node map in rga-doc.ts), not from the root.
 */
export type TreapNode = {
  id: ElemId;
  char: string;
  deleted: boolean;
  priority: number;
  left: TreapNode | null;
  right: TreapNode | null;
  parent: TreapNode | null;
  size: number;
  liveSize: number;
};

export function makeNode(id: ElemId, char: string): TreapNode {
  return {
    id,
    char,
    deleted: false,
    priority: hashElemId(id),
    left: null,
    right: null,
    parent: null,
    size: 1,
    liveSize: 1,
  };
}

function sizeOf(n: TreapNode | null): number {
  return n ? n.size : 0;
}

function liveSizeOf(n: TreapNode | null): number {
  return n ? n.liveSize : 0;
}

/** Recompute `size`/`liveSize` from children and re-parent them. Every
 * treap mutation below (split, merge, delete) must call this on every node
 * whose children changed, root to leaves order doesn't matter as long as
 * children are updated before their parent reads them. */
function update(n: TreapNode): void {
  n.size = 1 + sizeOf(n.left) + sizeOf(n.right);
  n.liveSize = (n.deleted ? 0 : 1) + liveSizeOf(n.left) + liveSizeOf(n.right);
  if (n.left) n.left.parent = n;
  if (n.right) n.right.parent = n;
}

/** Split `t` into [0, k) and [k, size(t)) by internal index (tombstones
 * counted). Either half may be null. */
export function splitByIndex(t: TreapNode | null, k: number): [TreapNode | null, TreapNode | null] {
  if (t === null) return [null, null];
  const leftSize = sizeOf(t.left);
  if (k <= leftSize) {
    const [l, r] = splitByIndex(t.left, k);
    t.left = r;
    update(t);
    if (l) l.parent = null;
    t.parent = null;
    return [l, t];
  }
  const [l, r] = splitByIndex(t.right, k - leftSize - 1);
  t.right = l;
  update(t);
  if (r) r.parent = null;
  t.parent = null;
  return [t, r];
}

/** Merge two treaps where every element of `a` precedes every element of
 * `b` in document order. Priority decides which becomes parent. */
export function merge(a: TreapNode | null, b: TreapNode | null): TreapNode | null {
  if (a === null) {
    if (b) b.parent = null;
    return b;
  }
  if (b === null) {
    a.parent = null;
    return a;
  }
  if (a.priority > b.priority) {
    a.right = merge(a.right, b);
    update(a);
    a.parent = null;
    return a;
  }
  b.left = merge(a, b.left);
  update(b);
  b.parent = null;
  return b;
}

export function insertAt(root: TreapNode | null, index: number, node: TreapNode): TreapNode {
  const [l, r] = splitByIndex(root, index);
  // node is non-null, so the result of merging it in can never be null.
  return merge(merge(l, node), r) as TreapNode;
}

/** Internal (tombstones-included) index of `node`, via parent pointers —
 * no root-down search. */
export function indexOfNode(node: TreapNode): number {
  let index = sizeOf(node.left);
  let cur = node;
  while (cur.parent !== null) {
    if (cur.parent.right === cur) {
      index += sizeOf(cur.parent.left) + 1;
    }
    cur = cur.parent;
  }
  return index;
}

/** Visible (live-only) index of `node`, via parent pointers. If `node`
 * itself is a tombstone this is "how many live elements precede it." */
export function visibleIndexOfNode(node: TreapNode): number {
  let index = liveSizeOf(node.left);
  let cur = node;
  while (cur.parent !== null) {
    if (cur.parent.right === cur) {
      index += liveSizeOf(cur.parent.left) + (cur.parent.deleted ? 0 : 1);
    }
    cur = cur.parent;
  }
  return index;
}

export function leftmostNode(root: TreapNode | null): TreapNode | null {
  let cur = root;
  while (cur !== null && cur.left !== null) cur = cur.left;
  return cur;
}

/** In-order successor of `node`, amortized O(1) — used to walk forward
 * through concurrent siblings during integrate() without a fresh
 * root-down search at every step. */
export function nextInOrder(node: TreapNode): TreapNode | null {
  if (node.right !== null) return leftmostNode(node.right);
  let cur: TreapNode = node;
  while (cur.parent !== null && cur.parent.right === cur) {
    cur = cur.parent;
  }
  return cur.parent;
}

export function nodeAtInternalIndex(root: TreapNode | null, index: number): TreapNode | null {
  let cur = root;
  let remaining = index;
  while (cur !== null) {
    const leftSize = sizeOf(cur.left);
    if (remaining < leftSize) {
      cur = cur.left;
    } else if (remaining === leftSize) {
      return cur;
    } else {
      remaining -= leftSize + 1;
      cur = cur.right;
    }
  }
  return null;
}

export function nodeAtVisibleIndex(root: TreapNode | null, visibleIndex: number): TreapNode | null {
  let cur = root;
  let remaining = visibleIndex;
  while (cur !== null) {
    const leftLive = liveSizeOf(cur.left);
    if (remaining < leftLive) {
      cur = cur.left;
    } else if (remaining === leftLive && !cur.deleted) {
      return cur;
    } else {
      remaining -= leftLive + (cur.deleted ? 0 : 1);
      cur = cur.right;
    }
  }
  return null;
}

/** Mark a node deleted and propagate the liveSize change up to the root. */
export function markDeleted(node: TreapNode): void {
  node.deleted = true;
  let cur: TreapNode | null = node;
  while (cur !== null) {
    update(cur);
    cur = cur.parent;
  }
}

export function inOrderChars(root: TreapNode | null, onlyLive: boolean): string {
  const parts: string[] = [];
  function walk(n: TreapNode | null): void {
    if (n === null) return;
    walk(n.left);
    if (!onlyLive || !n.deleted) parts.push(n.char);
    walk(n.right);
  }
  walk(root);
  return parts.join("");
}
