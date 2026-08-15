import { decodeOps, decodeOpsStreamPartial, Doc, encodeOps, type ElemId, type ReplicaId, type StateVector } from "starling-crdt";
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
  /** The relay generation token seen on the last sync, or undefined before the
   * first response (or on a transport that has no generation, e.g. the local
   * hub). A change means the relay restarted onto a fresh log. */
  private knownGeneration: string | undefined = undefined;
  /** Serialises `sync()` — see the method for why overlapping runs corrupt
   * the read cursor. Same one-promise-chain shape `IndexedDbPersistence`
   * uses to force strict call-order execution. */
  private syncChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly _doc: Doc,
    private readonly persistence: Persistence,
    private transport: RelayTransport,
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
    return this._doc.text;
  }

  /**
   * The shared `Doc` this provider syncs and persists. Exposed so a
   * higher layer (the editor binding, `packages/editor`) can drive local
   * edits and read anchors directly against the *same* instance instead
   * of Provider growing a parallel, editor-shaped API surface it has no
   * other reason to own — Provider's own job stays network/persistence
   * glue (ARCH §6), not a facade over every `Doc` method a caller might
   * want. `transactionToOps`/`opsToSteps`/`anchorAt`/`resolveAnchor`
   * (`packages/editor`) all take a `Doc` directly for this reason
   * (DECISIONS #0023) — this getter is what lets a caller give them the
   * *right* one instead of constructing an unrelated second `Doc` that
   * would silently diverge from whatever this provider is syncing.
   * `insertLocal`/`deleteLocal`/`insertBefore` below remain for callers
   * that only need single-character edits and don't want to manage
   * persistence timing themselves.
   */
  get doc(): Doc {
    return this._doc;
  }

  /** ARCH §6 / 04-FRONTEND.md F-panel: "Pending op counter per replica...
   * cheap to build, disproportionately convincing." Exactly the snippet
   * ARCH §6 gives for the whole offline story — not a separate tracked
   * count, computed fresh each call. */
  pendingCount(): number {
    return this._doc.missingFrom(this.lastPushedVector).length;
  }

  insertLocal(visibleIndex: number, char: string): Promise<void> {
    this._doc.insertLocal(visibleIndex, char);
    return this.persistNow();
  }

  deleteLocal(visibleIndex: number): Promise<void> {
    this._doc.deleteLocal(visibleIndex);
    return this.persistNow();
  }

  insertBefore(tombstoneId: ElemId, char: string): Promise<void> {
    this._doc.insertBefore(tombstoneId, char);
    return this.persistNow();
  }

  /**
   * Public so a caller driving `.doc` directly (the editor binding,
   * DECISIONS #0025) can persist a local edit immediately, the same as
   * `insertLocal`/`deleteLocal`/`insertBefore` above already do for
   * themselves. This matters independent of network state, not just as
   * a convenience: persistence must never depend on `sync()` having run,
   * because `sync()` is exactly the call an offline replica *skips* —
   * and "offline edits survive reload" (ARCH §6, S9) requires them
   * persisted the moment they're made, not only once a connection comes
   * back. Idempotent to call redundantly (it's a full resave of current
   * state, not an append), so callers that also get it "for free" via
   * `sync()`'s own final call don't need to worry about calling it twice.
   */
  persistNow(): Promise<void> {
    return this.persistence.save({
      opLogBytes: encodeOps(this._doc.missingFrom(new Map())),
      lastPushedVectorEntries: [...this.lastPushedVector.entries()],
      relayReadOffset: this.relayReadOffset,
    });
  }

  /**
   * Sync against the relay. Safe to call concurrently: runs are serialised
   * (see below). The returned promise resolves when *this* call's sync has
   * completed.
   */
  sync(): Promise<void> {
    // Serialise: two runs that interleave both read from the same
    // `relayReadOffset` and then each advance it, double-counting the delta
    // and skipping bytes that were never applied — permanent, silent data
    // loss. An interval tick firing again before the previous sync's awaits
    // resolve (exactly the demo's loop) is how that happens. Chaining every
    // call onto one promise runs them strictly one at a time, in call order.
    const result = this.syncChain.then(() => this.syncNow());
    // The chain swallows failures so one bad sync doesn't reject every future
    // one; the returned promise still rejects for *this* caller.
    this.syncChain = result.catch(() => undefined);
    return result;
  }

  /**
   * Move this replica onto a different transport, then reconcile against it.
   * The demo does this when a visitor who has been editing in local-only mode
   * clicks share: the document already holds all their ops, but the read
   * cursor and the last-pushed vector are relative to the old (local) log and
   * mean nothing in the new one, which may be empty or already hold an
   * unrelated history at different offsets.
   *
   * So the handoff resets both: the read cursor to 0, to read the new log from
   * the start, and the last-pushed vector to empty, so `missingFrom` re-derives
   * every local op as owed to the new transport. The follow-up sync then pulls
   * whatever the new log already contains (nothing, or someone else's history)
   * and pushes the whole local history across. Convergence and idempotence do
   * the rest: no op is lost (all are re-offered) and none is double-applied
   * (receive dedupes by id, and the wire log only appends).
   *
   * Routed through the same chain as `sync()` so it cannot interleave with an
   * in-flight poll and read a cursor that is about to be reset out from under
   * it. Resolves once the reconciling sync has completed.
   */
  switchTransport(transport: RelayTransport): Promise<void> {
    const result = this.syncChain.then(async () => {
      this.transport = transport;
      this.relayReadOffset = 0;
      this.lastPushedVector = new Map();
      // The new transport has its own (or no) generation; forget the old one so
      // the first sync adopts it fresh instead of mistaking it for a restart.
      this.knownGeneration = undefined;
      await this.syncNow();
    });
    this.syncChain = result.catch(() => undefined);
    return result;
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
  /**
   * Notice a relay restart and reconcile against the fresh log. The transport
   * reports the log instance's generation token; when it changes, our read
   * cursor points into a log that no longer exists and our last-pushed vector
   * claims a history the new log never received. Reset both, exactly as
   * `switchTransport` does, so the next read starts from the new log's beginning
   * and the next push re-offers our whole local history. CRDT receive dedupes,
   * so replaying it costs nothing but bytes.
   *
   * Returns true when a reset happened. On the first generation seen, and when
   * the transport has no generation at all (the local hub), it just records and
   * returns false.
   */
  private adoptGenerationAndMaybeReset(): boolean {
    const generation = this.transport.generation?.();
    if (generation === undefined) return false;
    if (this.knownGeneration === undefined) {
      this.knownGeneration = generation;
      return false;
    }
    if (generation === this.knownGeneration) return false;
    this.knownGeneration = generation;
    this.relayReadOffset = 0;
    this.lastPushedVector = new Map();
    return true;
  }

  private async syncNow(): Promise<void> {
    let pulled: Uint8Array;
    try {
      pulled = await this.transport.read(this.relayReadOffset);
    } catch (err) {
      // A read can fail because the relay restarted onto a fresh log and our
      // cursor is now past its end. The generation token the transport captured
      // on that same (failed) response tells us which: if it changed, reconcile
      // and read the new log from the start; otherwise it is a genuine network
      // error, so propagate it and let the next tick retry.
      if (!this.adoptGenerationAndMaybeReset()) throw err;
      pulled = await this.transport.read(this.relayReadOffset);
    }
    // A read that *succeeded* can still have crossed a restart: the fresh log
    // may already have grown past our stale offset, so those bytes are from a
    // different log at a misaligned offset. Detect the generation change before
    // applying anything and re-read from the reset cursor.
    if (this.adoptGenerationAndMaybeReset()) {
      pulled = await this.transport.read(this.relayReadOffset);
    }
    if (pulled.length > 0) {
      // Decode only whole blobs and advance the cursor by exactly what was
      // consumed. A relay read can end mid-blob (the log is unframed bytes,
      // ARCH §5); advancing by the full response length past an undecodable
      // tail would skip real ops, and throwing on it would wedge every
      // future sync — and its push/persist half — on the same offset.
      const { ops, bytesConsumed } = decodeOpsStreamPartial(pulled);
      for (const op of ops) this._doc.receive(op);
      for (const op of ops) {
        const known = this.lastPushedVector.get(op.id.replica) ?? -1;
        if (op.id.counter > known) this.lastPushedVector.set(op.id.replica, op.id.counter);
      }
      this.relayReadOffset += bytesConsumed;
    }

    const missing = this._doc.missingFrom(this.lastPushedVector);
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
