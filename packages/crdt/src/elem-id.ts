export type ReplicaId = string;

/**
 * An element's *identity*, and nothing else: which replica created it and
 * which of that replica's ops it was. This is the key every lookup in the
 * codebase uses — `byId` maps, `deps` satisfaction, state vectors — and it
 * is all a *reference* to an element ever needs (an insert's origin `l`, a
 * delete's `target`, a cursor anchor). Deliberately carries no ordering
 * information: a reference is resolved by lookup, never compared.
 */
export type ElemRef = {
  replica: ReplicaId;
  counter: number;
};

/**
 * An op's *own* id: identity plus the Lamport clock that orders it against
 * every other element. Only an op's own id needs this — the element a
 * reference points at is already in the tree carrying its own real clock,
 * so references stay `ElemRef` and the clock is never fabricated for them
 * (F-1's fix; see `compareElemIds` below for why a fake ordering value is
 * the exact bug class this split exists to prevent).
 */
export type ElemId = ElemRef & {
  clock: number;
};

/**
 * Narrow a full id to a bare identity reference. Payload references
 * (`InsertPayload.l`, `DeletePayload.target`) and `deps` must be built with
 * this rather than by passing an `ElemId` straight through: the wire format
 * carries no clock for a reference, so an op built with a full id in its
 * payload would not survive `decodeOps(encodeOps(op))` structurally — it
 * would come back carrying one field fewer. Normalizing at construction
 * keeps a locally-created op and its decoded twin identical, which is what
 * the round-trip tests assert and what any deep-equality comparison of ops
 * depends on.
 */
export function toRef(id: ElemRef): ElemRef {
  return { replica: id.replica, counter: id.counter };
}

/**
 * Total order over all ElemIds: Lamport clock first, then a deterministic
 * tiebreak among genuinely concurrent ops. Computable by any replica
 * without coordination (ARCH §2.1).
 *
 * The clock is what makes this order *consistent with causality*, and that
 * consistency is a correctness requirement of the Fugue/RGA sibling-skip
 * rule, not a nicety. The rule places a new element by skipping past
 * same-bucket siblings with higher precedence; that is only right if an op
 * created *after* seeing sibling B always outranks B. This previously
 * compared the bare identity counter — a per-replica sequence number with
 * no causal meaning — so a replica joining an existing document allocated
 * low counters that sorted *beneath* content already there, and its
 * inserts landed in the wrong position (F-1: a joiner typing "big " into
 * "hello world" at index 6 produced "hello world gib"). Convergence held
 * throughout, which is why 1,500 convergence property runs never saw it;
 * intention did not.
 *
 * Equal clocks mean the two ops are concurrent — neither saw the other —
 * so the replica tiebreak decides, arbitrarily but identically everywhere.
 * The final `counter` comparison is unreachable (one replica never issues
 * two ops at the same clock) and is kept only so the order is provably
 * total rather than total-by-argument.
 */
export function compareElemIds(a: ElemId, b: ElemId): number {
  if (a.clock !== b.clock) return a.clock - b.clock;
  if (a.replica < b.replica) return -1;
  if (a.replica > b.replica) return 1;
  return a.counter - b.counter;
}

/**
 * Deterministic hash of an element's identity, used as a treap node's
 * priority (ARCH §2.5). Not `Math.random()`: priority has to be a pure
 * function of the id so every replica computes the identical tree shape for
 * the identical set of elements — that's what makes divergence bugs
 * reproducible instead of dependent on which replica happened to roll
 * which random number. FNV-1a, 32-bit: fast, well-distributed, no
 * ambient anything.
 *
 * Takes `ElemRef`, not `ElemId`: priority is derived from identity only, so
 * adding the Lamport clock (F-1) left every treap's shape byte-identical.
 * Tree balance has nothing to do with document order — see `treap.ts`.
 */
export function hashElemId(id: ElemRef): number {
  const s = `${id.replica}:${id.counter}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
