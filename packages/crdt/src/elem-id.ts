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

/**
 * Deterministic hash of an ElemId, used as a treap node's priority
 * (ARCH §2.5). Not `Math.random()`: priority has to be a pure function of
 * the id so every replica computes the identical tree shape for the
 * identical set of elements — that's what makes divergence bugs
 * reproducible instead of dependent on which replica happened to roll
 * which random number. FNV-1a, 32-bit: fast, well-distributed, no
 * ambient anything.
 */
export function hashElemId(id: ElemId): number {
  const s = `${id.replica}:${id.counter}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
