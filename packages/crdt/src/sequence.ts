import type { ElemId, ElemRef, ReplicaId } from "./elem-id.js";

/**
 * Every op is an envelope: an id the base allocates, the causal
 * dependencies (other ElemIds) that must already be integrated before this
 * op can be, and a payload whose shape is entirely up to the subclass.
 * `deps` is data, not a virtual method — it keeps `integrate(op)` the only
 * override point (ARCH §2.2) even though op construction differs per
 * subclass: a subclass that needs no causal dependency (NaiveDoc) just
 * passes `[]` when it builds its own op via `recordLocalOp`.
 *
 * `deps` is runtime-only (DECISIONS #0010): it must never be serialized at
 * Step 7. It's derivable from information the wire format already carries
 * — the payload's own origin reference, and a replica's own prior op via
 * contiguous per-replica counters (ARCH §3.2) — so encoding it would spend
 * a whole extra ElemId per op in a format fighting for individual bytes.
 * Reconstruct it at decode time; don't encode it.
 */
export type Op<Payload> = {
  id: ElemId;
  /** Identity references only: a dep is *looked up* in `integratedIds`,
   * never compared for order, so `ElemRef` is the whole requirement. */
  deps: ElemRef[];
  payload: Payload;
};

/**
 * `Map<ReplicaId, highestContiguousCounter>` (ARCH §3.2): for each
 * replica, the highest N such that counters 0..N from that replica have
 * all been integrated, with no gap. A replica absent from the map means
 * none of its ops have been integrated yet. This is a summary of
 * everything a replica has, in bytes proportional to replica count, not
 * op count — the whole point of state-vector sync.
 */
export type StateVector = Map<ReplicaId, number>;

/**
 * The abstract base every document class (PRD §4) inherits from Step 2
 * onward. Owns id allocation, the per-replica counter, causal buffering of
 * out-of-order ops, and idempotence. Subclasses override exactly one
 * method: integrate(op) — the merge rule and nothing else (ARCH §2.2).
 */
export abstract class Sequence<Payload> {
  private counter = 0;
  /**
   * Lamport clock, the *ordering* half of an id — strictly separate from
   * `counter`, which is the *identity* half. Advances on every op this
   * replica sees (`observeClock`, from `receive`) as well as every op it
   * creates, so an op created after seeing element B always outranks B.
   * That is the property `compareElemIds` needs and the bare identity
   * counter never had (F-1).
   */
  private lamport = 0;
  private readonly accepted = new Map<ReplicaId, Set<number>>();
  private readonly integratedIds = new Map<ReplicaId, Set<number>>();
  private readonly pending: Op<Payload>[] = [];
  /** Every integrated op, in integration order — needed by `missingFrom`
   * (ARCH §3.2). Deps are not re-derivable from the tree alone once
   * integrated, so this is a real log, not just a derived view. */
  private readonly log: Op<Payload>[] = [];

  protected constructor(protected readonly replica: ReplicaId) {}

  /** Identity advances after stamping, the clock before it — so a
   * replica's own op always has `clock > counter`, and two ops from one
   * replica never share a clock (what makes `compareElemIds`'s final
   * counter tiebreak unreachable). */
  protected allocateId(): ElemId {
    this.lamport += 1;
    const id: ElemId = { replica: this.replica, counter: this.counter, clock: this.lamport };
    this.counter += 1;
    return id;
  }

  protected recordLocalOp(payload: Payload, deps: ElemRef[] = []): Op<Payload> {
    const op: Op<Payload> = { id: this.allocateId(), deps, payload };
    this.receive(op);
    return op;
  }

  /**
   * Accept a local or remote op. Idempotent: an op whose id has already
   * been accepted (whether already integrated or still pending on a
   * dependency) is a no-op the second time, so duplicate delivery — which
   * the sim (ARCH §4) is required to be able to do — can never
   * double-integrate anything.
   */
  receive(op: Op<Payload>): void {
    if (idSetHas(this.accepted, op.id)) return;
    idSetAdd(this.accepted, op.id);
    this.reserveOwnId(op.id);
    this.observeClock(op.id);

    if (this.dependenciesSatisfied(op)) {
      this.integrateAndDrain(op);
    } else {
      this.pending.push(op);
    }
  }

  /**
   * Never reissue an id this replica has already used — including ids it
   * only ever learns about by *receiving its own ops back*. That is the
   * reload path: `Provider.create` (ARCH §6, "Reload replays it") replays a
   * persisted op log into a fresh instance carrying the SAME replica id, so
   * every one of this replica's prior ops arrives through `receive`, never
   * through `allocateId`. Without this the counter restarts at 0 and the
   * next local edit is allocated an id the log already contains; since
   * idempotence is keyed on id (see `receive` above), that edit is silently
   * dropped locally, and peers handed the same op set converge to different
   * text depending on delivery order (F-2).
   *
   * Applied at *acceptance* rather than at integration, so an own-op still
   * buffered on an unsatisfied dependency reserves its counter too — a
   * pending op's id is just as spent as an integrated one's.
   *
   * Identity only. `counter` feeds `allocateId` and nothing else: this does
   * not touch element ordering (`compareElemIds`) or state-vector semantics
   * (`getStateVector` derives from `integratedIds`, not from `counter`).
   */
  private reserveOwnId(id: ElemId): void {
    if (id.replica !== this.replica) return;
    if (id.counter >= this.counter) this.counter = id.counter + 1;
  }

  /**
   * The Lamport half of the same idea, for *every* op rather than only this
   * replica's own: having seen a clock, this replica's next op must exceed
   * it, so its id sorts above everything it has observed. That is what makes
   * `compareElemIds`'s order consistent with causality (F-1).
   *
   * Applied at acceptance, alongside `reserveOwnId` and for the same reason:
   * an op buffered on an unsatisfied dependency has still been *seen*, and a
   * local edit made before that dependency arrives must still outrank it.
   */
  private observeClock(id: ElemId): void {
    if (id.clock > this.lamport) this.lamport = id.clock;
  }

  private dependenciesSatisfied(op: Op<Payload>): boolean {
    return op.deps.every((dep) => idSetHas(this.integratedIds, dep));
  }

  private integrateAndDrain(op: Op<Payload>): void {
    this.integrate(op);
    idSetAdd(this.integratedIds, op.id);
    this.log.push(op);

    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < this.pending.length; i += 1) {
        const next = this.pending[i]!;
        if (this.dependenciesSatisfied(next)) {
          this.pending.splice(i, 1);
          this.integrate(next);
          idSetAdd(this.integratedIds, next.id);
          this.log.push(next);
          progressed = true;
          break;
        }
      }
    }
  }

  /** ARCH §3.2. Recomputed from `integratedIds` each call — cheap enough
   * not to bother caching before a benchmark says otherwise (Step 15). */
  getStateVector(): StateVector {
    const vector: StateVector = new Map();
    for (const [replica, counters] of this.integratedIds) {
      let highest = -1;
      while (counters.has(highest + 1)) highest += 1;
      if (highest >= 0) vector.set(replica, highest);
    }
    return vector;
  }

  /** Every op this replica has integrated that `theirVector` doesn't yet
   * cover — the entire offline story (ARCH §6): "reconnect, ask the relay
   * for its cursor, compute the delta, push." No queue, just this. */
  missingFrom(theirVector: StateVector): Op<Payload>[] {
    return this.log.filter((op) => op.id.counter > (theirVector.get(op.id.replica) ?? -1));
  }

  protected abstract integrate(op: Op<Payload>): void;
}

function idSetHas(map: Map<ReplicaId, Set<number>>, id: ElemRef): boolean {
  return map.get(id.replica)?.has(id.counter) ?? false;
}

function idSetAdd(map: Map<ReplicaId, Set<number>>, id: ElemRef): void {
  let set = map.get(id.replica);
  if (!set) {
    set = new Set();
    map.set(id.replica, set);
  }
  set.add(id.counter);
}
