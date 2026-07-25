import { describe, expect, it } from "vitest";
import type { ElemId } from "./elem-id.js";
import {
  indexOfNode,
  inOrderChars,
  insertAt,
  makeNode,
  markDeleted,
  nextInOrder,
  nodeAtInternalIndex,
  nodeAtVisibleIndex,
  type TreapNode,
  visibleIndexOfNode,
} from "./treap.js";

// Clock mirrors the counter here: these are a single synthetic replica's
// sequential ops, which is exactly the shape allocateId produces.
function id(counter: number): ElemId {
  return { replica: "T", counter, clock: counter + 1 };
}

/** Reference in-order array, tombstones included, for cross-checking the
 * treap's O(log n) machinery against an O(n) brute-force ground truth. */
function toArray(root: TreapNode | null): TreapNode[] {
  const out: TreapNode[] = [];
  function walk(n: TreapNode | null): void {
    if (!n) return;
    walk(n.left);
    out.push(n);
    walk(n.right);
  }
  walk(root);
  return out;
}

describe("treap: structural correctness against a brute-force reference", () => {
  it("insertAt at every position, for many sizes, matches array.splice semantics", () => {
    let root: TreapNode | null = null;
    const reference: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const at = i % (reference.length + 1); // cycle through every valid position
      const ch = String.fromCharCode(97 + (i % 26));
      root = insertAt(root, at, makeNode(id(i), ch));
      reference.splice(at, 0, ch);
      expect(inOrderChars(root, false)).toBe(reference.join(""));
    }
  });

  it("indexOfNode matches the brute-force in-order position for every node, after many inserts", () => {
    let root: TreapNode | null = null;
    for (let i = 0; i < 40; i += 1) {
      const at = (i * 7) % (i + 1); // varied, deterministic positions
      root = insertAt(root, at, makeNode(id(i), "x"));
    }
    const nodes = toArray(root);
    nodes.forEach((n, expectedIndex) => {
      expect(indexOfNode(n)).toBe(expectedIndex);
    });
  });

  it("nodeAtInternalIndex is the inverse of indexOfNode", () => {
    let root: TreapNode | null = null;
    for (let i = 0; i < 30; i += 1) {
      root = insertAt(root, (i * 3) % (i + 1), makeNode(id(i), "x"));
    }
    const nodes = toArray(root);
    nodes.forEach((n, i) => {
      expect(nodeAtInternalIndex(root, i)).toBe(n);
    });
    expect(nodeAtInternalIndex(root, nodes.length)).toBeNull();
  });

  it("markDeleted updates liveSize on the node and every ancestor, verified via visibleIndexOfNode", () => {
    let root: TreapNode | null = null;
    const nodes: TreapNode[] = [];
    for (let i = 0; i < 20; i += 1) {
      const n = makeNode(id(i), "x");
      root = insertAt(root, i, n); // sequential append
      nodes.push(n);
    }
    // Delete every third node; visible index of survivors should shift down.
    for (let i = 0; i < nodes.length; i += 3) markDeleted(nodes[i]!);

    const liveNodesInOrder = toArray(root).filter((n) => !n.deleted);
    liveNodesInOrder.forEach((n, expectedVisibleIndex) => {
      expect(visibleIndexOfNode(n)).toBe(expectedVisibleIndex);
    });
  });

  it("nodeAtVisibleIndex is the inverse of visibleIndexOfNode, skipping tombstones", () => {
    let root: TreapNode | null = null;
    const nodes: TreapNode[] = [];
    for (let i = 0; i < 25; i += 1) {
      const n = makeNode(id(i), "x");
      root = insertAt(root, i, n);
      nodes.push(n);
    }
    for (let i = 1; i < nodes.length; i += 2) markDeleted(nodes[i]!);

    const liveNodesInOrder = toArray(root).filter((n) => !n.deleted);
    liveNodesInOrder.forEach((n, visibleIndex) => {
      expect(nodeAtVisibleIndex(root, visibleIndex)).toBe(n);
    });
    expect(nodeAtVisibleIndex(root, liveNodesInOrder.length)).toBeNull();
  });

  it("nextInOrder walks the same sequence as a brute-force in-order traversal", () => {
    let root: TreapNode | null = null;
    for (let i = 0; i < 35; i += 1) {
      root = insertAt(root, (i * 5) % (i + 1), makeNode(id(i), "x"));
    }
    const reference = toArray(root);
    let cur: TreapNode | null = reference[0] ?? null;
    const walked: TreapNode[] = [];
    while (cur !== null) {
      walked.push(cur);
      cur = nextInOrder(cur);
    }
    expect(walked).toEqual(reference);
  });

  it("inOrderChars(onlyLive: true) matches a brute-force filter of the reference array", () => {
    let root: TreapNode | null = null;
    const nodes: TreapNode[] = [];
    for (let i = 0; i < 15; i += 1) {
      const n = makeNode(id(i), String.fromCharCode(97 + i));
      root = insertAt(root, i, n);
      nodes.push(n);
    }
    markDeleted(nodes[2]!);
    markDeleted(nodes[7]!);
    markDeleted(nodes[14]!);
    const expected = toArray(root)
      .filter((n) => !n.deleted)
      .map((n) => n.char)
      .join("");
    expect(inOrderChars(root, true)).toBe(expected);
  });
});
