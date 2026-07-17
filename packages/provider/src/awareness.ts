import type { ReplicaId } from "starling-crdt";
import type { RelayTransport } from "./transport.js";

/**
 * ARCH §7: "Presence... is last-write-wins per replica, with a TTL, and
 * is never persisted and never written to the op log... Awareness
 * travels over the same relay, on a separate channel, and the relay
 * still does not know what it means."
 *
 * "Separate channel" here means a distinct relay doc id, not a distinct
 * protocol — `AwarenessClient` takes whatever `RelayTransport` the caller
 * hands it, exactly like `Provider`'s content sync does. ARCH never
 * specifies how the awareness channel's id relates to the content doc's
 * id, and the relay validates every id as a UUID (SECURITY §2.2) with no
 * room for a derived suffix like `${docId}:awareness` — so this is left
 * to the caller (e.g., a second UUID minted and stored alongside the
 * content doc's own id), not invented here.
 *
 * `data` is deliberately untyped: awareness payload shape (cursor
 * position, display name, colour, ...) is an editor/demo-level concern
 * (Steps 12+), not something the provider layer should constrain.
 */
export type AwarenessState = {
  replica: ReplicaId;
  data: unknown;
  timestamp: number;
};

/**
 * Presence over the relay's append-only byte log, reusing it purely as a
 * broadcast pipe: each `publish` appends one newline-delimited JSON
 * record (self-delimiting, unlike the CRDT wire format there is no
 * volume/byte-budget pressure here to justify a hand-rolled binary
 * encoding — ARCH §3.1's byte target is specifically about ops). LWW
 * happens locally: whichever record for a given replica has the highest
 * `timestamp` wins, regardless of arrival order (the relay's own append
 * order is not delivery order, same principle §4's sim already exercises
 * for ops). "Never persisted" is enforced by omission: this class has no
 * `Persistence`-shaped dependency at all, so there is nothing to load on
 * reload — every process starts with no known peers and rebuilds its view
 * purely from what it polls off the relay from here on.
 */
export class AwarenessClient {
  private readonly peers = new Map<ReplicaId, AwarenessState>();
  private readOffset = 0;

  constructor(
    private readonly replica: ReplicaId,
    private readonly transport: RelayTransport,
    private readonly ttlMs: number,
    private readonly now: () => number
  ) {}

  async publish(data: unknown): Promise<void> {
    const state: AwarenessState = { replica: this.replica, data, timestamp: this.now() };
    this.peers.set(this.replica, state); // visible to this client's own peerStates() immediately
    const bytes = new TextEncoder().encode(`${JSON.stringify(state)}\n`);
    await this.transport.append(bytes);
  }

  /** Pulls whatever's new since the last poll and folds it into local
   * LWW state. Malformed lines (a genuinely different message format on
   * the same channel, a torn write) are skipped rather than thrown on —
   * awareness is best-effort by design (ARCH §7's whole point is that
   * losing a stale presence update is fine, it's about to evaporate
   * anyway), unlike the content log where every op matters. */
  async poll(): Promise<void> {
    const chunk = await this.transport.read(this.readOffset);
    if (chunk.length === 0) return;
    this.readOffset += chunk.length;
    const text = new TextDecoder().decode(chunk);
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let state: AwarenessState;
      try {
        state = JSON.parse(line) as AwarenessState;
      } catch {
        continue;
      }
      const existing = this.peers.get(state.replica);
      if (existing === undefined || state.timestamp >= existing.timestamp) {
        this.peers.set(state.replica, state);
      }
    }
  }

  /** Excludes any replica whose newest known update is older than the
   * TTL — "a user who closes their laptop should evaporate" (ARCH §7).
   * Filtered on read, not garbage-collected on a timer: no ambient clock
   * driving background work, consistent with everything else in this
   * codebase being pull-based rather than callback-scheduled. */
  peerStates(): AwarenessState[] {
    const cutoff = this.now() - this.ttlMs;
    return [...this.peers.values()].filter((p) => p.timestamp >= cutoff);
  }
}
