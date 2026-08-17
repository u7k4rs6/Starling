/**
 * The client side of ARCH §5's contract: `POST /doc/:id` appends opaque
 * bytes and returns the offset it was written at; `GET /doc/:id?from=N`
 * returns bytes from offset N to the current end. The relay does not parse
 * what it's given (§5) — nothing here does either, byte arrays in, byte
 * arrays out.
 */
export interface RelayTransport {
  append(bytes: Uint8Array): Promise<number>;
  read(from: number): Promise<Uint8Array>;
  /**
   * A token identifying the current server-side log instance, if the transport
   * has one. It changes when the relay restarts and loses its in-memory log, so
   * a `Provider` that sees it change knows its cursor is stale and reconciles.
   * Transports whose log never resets under the client (the in-browser hub)
   * omit this, and the Provider then does no restart handling.
   */
  generation?(): string | undefined;
}

const GENERATION_HEADER = "X-Relay-Generation";

/**
 * A permanent append rejection: the relay will never accept this push, so
 * retrying is pointless. The room's log is frozen at its size cap (507), or this
 * single update exceeds the per-message cap (413). Distinct from a transient
 * failure (a 429 rate limit, a network blip), which a later sync retries. The
 * Provider stops syncing when it sees this, rather than re-offering the same
 * doomed push every tick and holding a free relay awake forever.
 */
export class RelayPermanentError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "RelayPermanentError";
  }
}

export class HttpRelayTransport implements RelayTransport {
  /** The generation token from the most recent response, success or failure. */
  private lastGeneration: string | undefined = undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly docId: string
  ) {}

  generation(): string | undefined {
    return this.lastGeneration;
  }

  async append(bytes: Uint8Array): Promise<number> {
    const res = await fetch(`${this.baseUrl}/doc/${this.docId}`, {
      method: "POST",
      // TS 5.7+'s generic `Uint8Array<ArrayBufferLike>` doesn't structurally
      // match lib.dom.d.ts's (pre-generic) `BodyInit` — verified against
      // this repo's actual toolchain (TS 5.9.3), not assumed; a real
      // Uint8Array is valid fetch body at runtime regardless.
      body: bytes as BodyInit,
    });
    this.captureGeneration(res);
    if (!res.ok) {
      // 507 (log frozen) and 413 (this update alone is over the message cap) are
      // permanent: the same push will keep being rejected, so mark it so the
      // Provider stops retrying instead of polling a full room forever.
      if (res.status === 507 || res.status === 413) {
        throw new RelayPermanentError(res.status, `relay append rejected permanently: ${res.status}`);
      }
      throw new Error(`relay append failed: ${res.status}`);
    }
    const body = (await res.json()) as { offset: number };
    return body.offset;
  }

  async read(from: number): Promise<Uint8Array> {
    const res = await fetch(`${this.baseUrl}/doc/${this.docId}?from=${from}`);
    this.captureGeneration(res);
    if (!res.ok) throw new Error(`relay read failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Record the generation token even on a failed response, so a restart is
   * observable to the Provider whichever call happens to see it first. */
  private captureGeneration(res: Response): void {
    const gen = res.headers.get(GENERATION_HEADER);
    if (gen !== null) this.lastGeneration = gen;
  }
}
