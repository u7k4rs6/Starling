import { compareElemIds, toRef, type ElemId, type ElemRef, type ReplicaId } from "./elem-id.js";
import { Sequence } from "./sequence.js";
import type { CrdtOp, CrdtPayload } from "./ops.js";

export type { CrdtOp, CrdtPayload, DeletePayload, InsertPayload } from "./ops.js";

type Elem = { id: ElemId; char: string; deleted: boolean };

/**
 * Museum exhibit 2 (PRD §4). Correct RGA merge, array-backed storage.
 * `integrate()` is exactly ARCH §2.3's four lines for the insert case,
 * unmodified: insert after the origin, then skip forward past concurrent
 * elements with higher-precedence ids. That skip compares against the
 * *internal* array, tombstones included — a deleted element still occupies
 * a structural position and is still a valid concurrent-sibling reference,
 * per ARCH §2.4. It is also unusable at scale (linear `indexOfId`); see
 * naive-doc.ts's sibling comment in array-doc history for why that stays.
 *
 * Deletion (ARCH §2.4, Step 4): a deleted element is tombstoned, never
 * removed — its `ElemId` must stay resolvable forever, because a
 * concurrent op may still reference it as an origin, and `insertBefore`
 * (below) may still need to find it. `del` is idempotent and commutative
 * for free: marking `deleted = true` twice has the same effect as once,
 * because "deleted" is a monotone fact, not a value to reconcile.
 *
 * Revive is not a thing. The inverse of deleting an element is not
 * reviving its id — it's `insertBefore(tombstoneId, char)`, a brand new
 * element with a brand new id, placed next to where the tombstone still
 * sits. Position is restored; identity is not.
 */
export class ArrayDoc extends Sequence<CrdtPayload> {
  private readonly elems: Elem[] = [];

  constructor(replica: ReplicaId) {
    super(replica);
  }

  get text(): string {
    return this.elems
      .filter((e) => !e.deleted)
      .map((e) => e.char)
      .join("");
  }

  /** Visible index → the internal id of the live element immediately
   * before it, or null for "insert at the very start." O(n): this is the
   * exact mapping ARCH §2.5's treap makes O(log n) via a live-subtree
   * count, at Step 4b, not here. */
  private originForVisibleIndex(visibleIndex: number): ElemRef | null {
    if (visibleIndex === 0) return null;
    let seen = 0;
    for (const e of this.elems) {
      if (e.deleted) continue;
      seen += 1;
      if (seen === visibleIndex) return toRef(e.id);
    }
    throw new RangeError(`visible index ${visibleIndex} out of range`);
  }

  insertLocal(visibleIndex: number, char: string): CrdtOp {
    const l = this.originForVisibleIndex(visibleIndex);
    return this.recordLocalOp({ type: "insert", l, char }, l === null ? [] : [l]);
  }

  /** ARCH §2.4: the inverse of del(id) is insertBefore(tombstoneId, char),
   * not a revive. Origin is the tombstone's own internal predecessor, so
   * the new element lands in the same neighborhood the tombstone still
   * marks. (Guaranteed convergent, not guaranteed to land strictly to the
   * tombstone's left under concurrent inserts nearby — that precision is
   * Fugue's job, Step 6, not this exhibit's.) */
  insertBefore(tombstoneId: ElemRef, char: string): CrdtOp {
    const idx = this.indexOfId(tombstoneId);
    if (idx === -1) throw new RangeError("insertBefore: tombstone id not found");
    const l = idx === 0 ? null : toRef(this.elems[idx - 1]!.id);
    return this.recordLocalOp({ type: "insert", l, char }, l === null ? [] : [l]);
  }

  deleteLocal(visibleIndex: number): CrdtOp {
    let seen = 0;
    for (const e of this.elems) {
      if (e.deleted) continue;
      if (seen === visibleIndex) {
        const target = toRef(e.id);
        return this.recordLocalOp({ type: "delete", target }, [target]);
      }
      seen += 1;
    }
    throw new RangeError(`visible index ${visibleIndex} out of range`);
  }

  private indexOfId(id: ElemRef): number {
    return this.elems.findIndex((e) => e.id.replica === id.replica && e.id.counter === id.counter);
  }

  protected integrate(op: CrdtOp): void {
    if (op.payload.type === "delete") {
      // op.payload.target is guaranteed already integrated: deps: [target]
      // (DECISIONS #0010) buffers this op until it is.
      const idx = this.indexOfId(op.payload.target);
      this.elems[idx]!.deleted = true;
      return;
    }

    const { l, char } = op.payload;
    // l, if not null, is guaranteed already integrated for the same reason.
    let at = l === null ? 0 : this.indexOfId(l) + 1;
    while (at < this.elems.length && compareElemIds(this.elems[at]!.id, op.id) > 0) {
      at += 1;
    }
    this.elems.splice(at, 0, { id: op.id, char, deleted: false });
  }
}
