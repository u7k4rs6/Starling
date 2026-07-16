export type ReplicaId = string;

export type ElemId = {
  replica: ReplicaId;
  counter: number;
};

/**
 * Total order over all ElemIds: compare counter, tiebreak on replica
 * lexicographically. Deterministic and computable by any replica without
 * coordination — see ARCH §2.1. This ordering has nothing to do with
 * causality; the exhaustive origin-forest search (ARCH §2.1, budgeted for
 * before Step 3's merge rule lands) is what tests whether RGA's merge
 * converges under it regardless.
 */
export function compareElemIds(a: ElemId, b: ElemId): number {
  if (a.counter !== b.counter) return a.counter - b.counter;
  if (a.replica < b.replica) return -1;
  if (a.replica > b.replica) return 1;
  return 0;
}
