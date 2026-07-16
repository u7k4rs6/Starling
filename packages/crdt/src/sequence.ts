import type { ElemId, ReplicaId } from "./elem-id.js";

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
  deps: ElemId[];
  payload: Payload;
};

/**
 * The abstract base every document class (PRD §4) inherits from Step 2
 * onward. Owns id allocation, the per-replica counter, causal buffering of
 * out-of-order ops, and idempotence. Subclasses override exactly one
 * method: integrate(op) — the merge rule and nothing else (ARCH §2.2).
 */
export abstract class Sequence<Payload> {
  private counter = 0;
  private readonly accepted = new Map<ReplicaId, Set<number>>();
  private readonly integratedIds = new Map<ReplicaId, Set<number>>();
  private readonly pending: Op<Payload>[] = [];

  protected constructor(protected readonly replica: ReplicaId) {}

  protected allocateId(): ElemId {
    const id: ElemId = { replica: this.replica, counter: this.counter };
    this.counter += 1;
    return id;
  }

  protected recordLocalOp(payload: Payload, deps: ElemId[] = []): Op<Payload> {
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

    if (this.dependenciesSatisfied(op)) {
      this.integrateAndDrain(op);
    } else {
      this.pending.push(op);
    }
  }

  private dependenciesSatisfied(op: Op<Payload>): boolean {
    return op.deps.every((dep) => idSetHas(this.integratedIds, dep));
  }

  private integrateAndDrain(op: Op<Payload>): void {
    this.integrate(op);
    idSetAdd(this.integratedIds, op.id);

    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < this.pending.length; i += 1) {
        const next = this.pending[i]!;
        if (this.dependenciesSatisfied(next)) {
          this.pending.splice(i, 1);
          this.integrate(next);
          idSetAdd(this.integratedIds, next.id);
          progressed = true;
          break;
        }
      }
    }
  }

  protected abstract integrate(op: Op<Payload>): void;
}

function idSetHas(map: Map<ReplicaId, Set<number>>, id: ElemId): boolean {
  return map.get(id.replica)?.has(id.counter) ?? false;
}

function idSetAdd(map: Map<ReplicaId, Set<number>>, id: ElemId): void {
  let set = map.get(id.replica);
  if (!set) {
    set = new Set();
    map.set(id.replica, set);
  }
  set.add(id.counter);
}
