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
    if (!res.ok) throw new Error(`relay append failed: ${res.status}`);
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
