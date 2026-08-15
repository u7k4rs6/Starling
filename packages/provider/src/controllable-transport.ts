import type { RelayTransport } from "./transport.js";

/**
 * The live state of one pane's link. The demo mutates this from its controls so
 * a visitor can partition a pane, slow it down, or make it lossy and watch the
 * document diverge and then reconverge, with no conflict dialog and no lost
 * keystrokes.
 */
export type LinkState = {
  /** false partitions the link: every call fails until it is reconnected. */
  connected: boolean;
  /** Artificial delay applied to each call, in milliseconds. */
  latencyMs: number;
  /** Probability in [0, 1] that an append is dropped in flight. */
  dropRate: number;
  /** Probability in [0, 1] that an append is held back so a later one overtakes it. */
  reorderRate: number;
};

export const DEFAULT_LINK_STATE: LinkState = {
  connected: true,
  latencyMs: 0,
  dropRate: 0,
  reorderRate: 0,
};

/**
 * A `RelayTransport` that sits between a Provider and a real transport (the
 * local hub, or the HTTP relay) and degrades it on command. This is not the
 * simulator: `packages/sim` shuffles in-process op envelopes for the property
 * tests, whereas this reimplements the same ideas at the transport seam where
 * the demo can toggle them live. The two are deliberately separate code and can
 * drift; see DECISIONS #0029.
 *
 * The degradations rely on the sync protocol being reliable underneath them. A
 * dropped or partitioned append rejects rather than silently vanishing, so the
 * Provider never marks it pushed and re-offers it on the next sync; the state
 * vector turns a lossy link into eventual delivery. Reordering has no effect on
 * the converged document at all, which is the point being demonstrated.
 */
export class ControllableTransport implements RelayTransport {
  private link: LinkState;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly inner: RelayTransport,
    link: Partial<LinkState> = {},
    deps: { random?: () => number; sleep?: (ms: number) => Promise<void> } = {}
  ) {
    this.link = { ...DEFAULT_LINK_STATE, ...link };
    this.random = deps.random ?? Math.random;
    this.sleep = deps.sleep ?? ((ms) => (ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))));
  }

  get state(): LinkState {
    return this.link;
  }

  setState(patch: Partial<LinkState>): void {
    this.link = { ...this.link, ...patch };
  }

  /** Pass the inner transport's generation token straight through, so a
   * relay restart is still observable when the demo wraps the relay in this. */
  generation(): string | undefined {
    return this.inner.generation?.();
  }

  async append(bytes: Uint8Array): Promise<number> {
    if (!this.link.connected) throw new Error("link partitioned");
    if (this.link.dropRate > 0 && this.random() < this.link.dropRate) {
      // Dropped in flight. Rejecting (rather than resolving with a fake offset)
      // is what keeps it correct: the Provider leaves it unpushed and re-offers
      // it next sync, so the document converges despite the loss.
      throw new Error("link dropped an append");
    }
    let delay = this.link.latencyMs;
    if (this.link.reorderRate > 0 && this.random() < this.link.reorderRate) {
      delay += this.link.latencyMs + 50; // held back so a later append can land first
    }
    await this.sleep(delay);
    if (!this.link.connected) throw new Error("link partitioned"); // partitioned mid-flight
    return this.inner.append(bytes);
  }

  async read(from: number): Promise<Uint8Array> {
    if (!this.link.connected) throw new Error("link partitioned");
    await this.sleep(this.link.latencyMs);
    if (!this.link.connected) throw new Error("link partitioned");
    return this.inner.read(from);
  }
}
