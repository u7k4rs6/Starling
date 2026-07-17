import { decodeOps, decodeOpsStream, Doc, encodeOps, type ElemId, type ReplicaId, type StateVector } from "starling-crdt";
import type { Persistence } from "./persistence.js";
import type { RelayTransport } from "./transport.js";

/**
 * Client-side glue (ARCH §6): owns the doc, local persistence, and the
 * sync loop against the relay. Deliberately has no offline queue — "the
 * document already knows what it has, and the state vector already knows
 * what the server has," so the entire offline story is
 * `doc.missingFrom(lastPushedVector)`, computed on demand, never buffered
 * separately. Disconnection is not a special state, just a long gap
 * between `sync()` calls.
 */
export class Provider {
  private lastPushedVector: StateVector;
  private relayReadOffset: number;

  private constructor(
    private readonly doc: Doc,
    private readonly persistence: Persistence,
    private readonly transport: RelayTransport,
    lastPushedVector: StateVector,
    relayReadOffset: number
  ) {
    this.lastPushedVector = lastPushedVector;
    this.relayReadOffset = relayReadOffset;
  }

  /** ARCH §6: "Reload replays it." Loads whatever was last persisted (or
   * starts empty for a brand-new doc) and replays the op log into a fresh
   * `Doc` before anything else touches it. */
  static async create(replica: ReplicaId, persistence: Persistence, transport: RelayTransport): Promise<Provider> {
    const doc = new Doc(replica);
    const persisted = await persistence.load();
    if (persisted === null) {
      return new Provider(doc, persistence, transport, new Map(), 0);
    }
    for (const op of decodeOps(persisted.opLogBytes)) doc.receive(op);
    return new Provider(
      doc,
      persistence,
      transport,
      new Map(persisted.lastPushedVectorEntries),
      persisted.relayReadOffset
    );
  }

  get text(): string {
    return this.doc.text;
  }

  /** ARCH §6 / 04-FRONTEND.md F-panel: "Pending op counter per replica...
   * cheap to build, disproportionately convincing." Exactly the snippet
   * ARCH §6 gives for the whole offline story — not a separate tracked
   * count, computed fresh each call. */
  pendingCount(): number {
    return this.doc.missingFrom(this.lastPushedVector).length;
  }

  insertLocal(visibleIndex: number, char: string): Promise<void> {
    this.doc.insertLocal(visibleIndex, char);
    return this.persistNow();
  }

  deleteLocal(visibleIndex: number): Promise<void> {
    this.doc.deleteLocal(visibleIndex);
    return this.persistNow();
  }

  insertBefore(tombstoneId: ElemId, char: string): Promise<void> {
    this.doc.insertBefore(tombstoneId, char);
    return this.persistNow();
  }

  private persistNow(): Promise<void> {
    return this.persistence.save({
      opLogBytes: encodeOps(this.doc.missingFrom(new Map())),
      lastPushedVectorEntries: [...this.lastPushedVector.entries()],
      relayReadOffset: this.relayReadOffset,
    });
  }

  /**
   * "Reconnect, ask the relay for its cursor, compute the delta, push"
   * (ARCH §6), in that order: pull first so a push never re-derives a
   * delta against a vector that's already stale.
   *
   * Ops just pulled are marked as known-to-the-relay directly from their
   * own ids, not by copying `doc.getStateVector()` wholesale — the doc's
   * full vector also covers this replica's own not-yet-pushed local
   * edits, which still need to go out.
   */
  async sync(): Promise<void> {
    const pulled = await this.transport.read(this.relayReadOffset);
    if (pulled.length > 0) {
      const ops = decodeOpsStream(pulled);
      for (const op of ops) this.doc.receive(op);
      for (const op of ops) {
        const known = this.lastPushedVector.get(op.id.replica) ?? -1;
        if (op.id.counter > known) this.lastPushedVector.set(op.id.replica, op.id.counter);
      }
      this.relayReadOffset += pulled.length;
    }

    const missing = this.doc.missingFrom(this.lastPushedVector);
    if (missing.length > 0) {
      await this.transport.append(encodeOps(missing));
      for (const op of missing) {
        const known = this.lastPushedVector.get(op.id.replica) ?? -1;
        if (op.id.counter > known) this.lastPushedVector.set(op.id.replica, op.id.counter);
      }
    }

    await this.persistNow();
  }
}
