import type { RelayTransport } from "./transport.js";

/**
 * The subset of the browser `BroadcastChannel` API this hub uses. Declared
 * structurally so tests can pass a deterministic in-memory fake instead of a
 * real cross-tab channel, and so nothing here depends on a browser being
 * present. A real `BroadcastChannel` satisfies it.
 */
export type BroadcastLike = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close?(): void;
};

type AppendMessage = { type: "append"; docId: string; bytes: number[] };

function isAppendMessage(data: unknown): data is AppendMessage {
  if (data === null || typeof data !== "object") return false;
  const m = data as Record<string, unknown>;
  return m.type === "append" && typeof m.docId === "string" && Array.isArray(m.bytes);
}

/**
 * A relay-shaped byte log that lives in the browser instead of on a server, so
 * the demo works with no relay reachable at all. It honours the exact same
 * contract as the HTTP relay (append opaque bytes, get an offset back; read
 * from an offset to the end), so a Provider cannot tell which transport it is
 * driving.
 *
 * The two demo panes share one hub in a single page: both panes' Providers
 * append to and read from the same in-memory log, and converge. A second tab
 * in the same browser gets its own hub, bound to the first through an optional
 * BroadcastChannel: each tab keeps its own log and mirrors the other's appends
 * into it. The two tabs' byte logs can end up in different orders, but because
 * CRDT ops are order-independent and idempotent they still decode to the same
 * document.
 */
export class LocalRelayHub {
  private readonly logs = new Map<string, number[]>();
  private readonly channel: BroadcastLike | null;

  constructor(channel?: BroadcastLike | null) {
    this.channel = channel ?? null;
    this.channel?.addEventListener("message", (event) => {
      if (isAppendMessage(event.data)) this.appendLocal(event.data.docId, Uint8Array.from(event.data.bytes));
    });
  }

  /** A `RelayTransport` view of one room in this hub. Hand each pane its own. */
  transport(docId: string): LocalRelayTransport {
    return new LocalRelayTransport(this, docId);
  }

  /** Append and, if a channel is bound, mirror to other tabs. Returns the
   * offset the bytes were written at, exactly as the relay's POST does. */
  append(docId: string, bytes: Uint8Array): number {
    const offset = this.appendLocal(docId, bytes);
    this.channel?.postMessage({ type: "append", docId, bytes: Array.from(bytes) } satisfies AppendMessage);
    return offset;
  }

  read(docId: string, from: number): Uint8Array {
    const log = this.logs.get(docId) ?? [];
    return new Uint8Array(log.slice(from));
  }

  /** Append without re-broadcasting: used for bytes arriving from another tab,
   * so a mirrored append does not echo back and loop. */
  private appendLocal(docId: string, bytes: Uint8Array): number {
    const log = this.logs.get(docId) ?? [];
    const offset = log.length;
    for (const byte of bytes) log.push(byte);
    this.logs.set(docId, log);
    return offset;
  }
}

/**
 * A `RelayTransport` backed by a `LocalRelayHub` rather than the network. The
 * methods are async to match the interface; the work is synchronous and
 * in-memory.
 */
export class LocalRelayTransport implements RelayTransport {
  constructor(
    private readonly hub: LocalRelayHub,
    private readonly docId: string
  ) {}

  async append(bytes: Uint8Array): Promise<number> {
    return this.hub.append(this.docId, bytes);
  }

  async read(from: number): Promise<Uint8Array> {
    return this.hub.read(this.docId, from);
  }
}
