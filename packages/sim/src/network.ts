import type { SeededRng } from "./rng.js";

export type Envelope<Message> = {
  seq: number;
  from: string;
  to: string;
  message: Message;
};

/**
 * Delivery queue + partition model (ARCH §4, parts 3, and the "must be
 * able to" list: drop, duplicate, reorder arbitrarily, partition the
 * network into groups, heal partitions).
 *
 * Selection is a direct RNG index pick among currently-deliverable pending
 * envelopes, not a sort over randomly-assigned priorities — so there is no
 * tie to break in the first place, which sidesteps rather than needs the
 * literal "tiebreak on sequence number" rule ARCH §4 describes for a
 * priority-queue-shaped implementation. The requirement that rule protects
 * — delivery order is a pure function of the seed, never of incidental
 * collection iteration order — holds here for a different, simpler reason:
 * `seq` is assigned once per envelope at `send()` time and never
 * recomputed, and selection reads only `rng.nextInt` against the *current*
 * deliverable set, which is itself derived deterministically from
 * `pending` (array order = insertion order) and `partitionOf` (a Map, also
 * insertion-ordered and only ever mutated by `partition`/`healPartitions`,
 * never by delivery). See DECISIONS #0015.
 */
export class Network<Message> {
  private readonly rng: SeededRng;
  private readonly pending: Envelope<Message>[] = [];
  private seq = 0;
  private readonly partitionOf = new Map<string, number>();

  constructor(rng: SeededRng) {
    this.rng = rng;
  }

  send(from: string, to: string, message: Message): void {
    this.pending.push({ seq: this.seq, from, to, message });
    this.seq += 1;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Assign replicas to partition groups (1-indexed internally; group 0 is
   * "unpartitioned"/default). Replicas not named in any group keep
   * whatever group they were already in. Two replicas can exchange
   * messages only if they're in the same group. */
  partition(groups: string[][]): void {
    groups.forEach((group, index) => {
      for (const replica of group) this.partitionOf.set(replica, index + 1);
    });
  }

  /** Every replica rejoins the default group; delivery is unconstrained
   * again. Does not itself deliver anything queued during the partition —
   * call `deliverAll` after healing to drain it. */
  healPartitions(): void {
    this.partitionOf.clear();
  }

  private canDeliver(from: string, to: string): boolean {
    return (this.partitionOf.get(from) ?? 0) === (this.partitionOf.get(to) ?? 0);
  }

  /** Deliver one currently-deliverable pending envelope, chosen uniformly
   * at random by the seeded RNG, and remove it from the queue. Envelopes
   * addressed across a partition boundary are left pending (undeliverable
   * right now, not dropped). Returns null if nothing is deliverable. */
  deliverOne(): Envelope<Message> | null {
    const deliverableIndices: number[] = [];
    for (let i = 0; i < this.pending.length; i += 1) {
      const env = this.pending[i]!;
      if (this.canDeliver(env.from, env.to)) deliverableIndices.push(i);
    }
    if (deliverableIndices.length === 0) return null;
    const pick = deliverableIndices[this.rng.nextInt(deliverableIndices.length)]!;
    const [envelope] = this.pending.splice(pick, 1);
    return envelope!;
  }

  /** Deliver every currently-deliverable envelope, one at a time in
   * RNG-chosen order, applying `apply` to each — repeats until nothing
   * deliverable remains (quiescence, for this partition state). */
  deliverAll(apply: (envelope: Envelope<Message>) => void): number {
    let delivered = 0;
    let envelope: Envelope<Message> | null;
    while ((envelope = this.deliverOne()) !== null) {
      apply(envelope);
      delivered += 1;
    }
    return delivered;
  }

  /** Discard one random pending envelope (any partition state) without
   * delivering it. Returns whether anything was dropped. */
  dropOne(): boolean {
    if (this.pending.length === 0) return false;
    this.pending.splice(this.rng.nextInt(this.pending.length), 1);
    return true;
  }

  /** Duplicate one random pending envelope: a copy re-enters the queue
   * with a fresh seq, so it arrives as a second, independent delivery
   * event (exercising idempotence downstream). Returns whether anything
   * was duplicated. */
  duplicateOne(): boolean {
    if (this.pending.length === 0) return false;
    const original = this.pending[this.rng.nextInt(this.pending.length)]!;
    this.pending.push({ ...original, seq: this.seq });
    this.seq += 1;
    return true;
  }
}
