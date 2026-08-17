import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { ConnectionLimiter } from "./connection-limit.js";
import { RateLimiter } from "./rate-limit.js";
import { LogStore, MAX_MESSAGE_BYTES } from "./store.js";

/** SECURITY §2.1: blunt limits, hard errors, no soft warnings.
 *
 * The rate limits apply to appends (POST) only; reads (GET) are unlimited. A
 * visitor's steady traffic is almost all reads (each of two panes polls up to
 * ~2.5 times a second, about 10 reads per second for the visitor), and rate-
 * limiting those would punish everyone behind a shared address (an office or
 * carrier CGNAT) for ordinary use. Appends happen only when there is an edit to
 * push, roughly 2.5 to 5 per second per actively typing visitor, so the per-IP
 * append cap of 100/s clears about 20 to 40 simultaneously typing visitors on
 * one address before it bites. See DECISIONS #0032. */
const MAX_CONNECTIONS_PER_IP = 20;
const APPEND_RATE_PER_SECOND = 100;
/** A second ceiling per document, so one room cannot be driven far past what a
 * handful of typists produce (about 5/s) no matter how the appenders' IPs
 * spread. Well above human use, well below a script. */
const APPEND_RATE_PER_SECOND_PER_DOC = 60;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export type RelayOptions = {
  /** SECURITY §2.3: exactly the demo origin, never "*". */
  allowedOrigin: string;
  dataDir?: string;
  /** Resident-doc ceiling before the LRU evicts, defaults to MAX_DOCS. */
  maxDocs?: number;
  /** Per-document log freeze size in bytes, defaults to MAX_LOG_BYTES_PER_DOC. */
  maxLogBytesPerDoc?: number;
  maxConnectionsPerIp?: number;
  appendRatePerSecond?: number;
  /** Per-document append ceiling, defaults to APPEND_RATE_PER_SECOND_PER_DOC. */
  appendRatePerSecondPerDoc?: number;
  idleTimeoutMs?: number;
  /**
   * How many reverse proxies sit in front of the relay. 0 (default) trusts
   * only the socket peer and ignores `X-Forwarded-For` entirely. Set it to
   * the real hop count on a platform that terminates TLS / load-balances in
   * front of this process (Fly.io, Render, Railway, a CDN), so SECURITY
   * §2.1's per-IP append limit is applied to the real client rather than
   * collapsing to one shared limit at the proxy's single address. Only raise
   * it when the fronting proxies are trusted to append (not pass through) a
   * client-supplied XFF — see `clientKey`.
   */
  trustedProxyDepth?: number;
};

const DOC_PATH_RE = /^\/doc\/([^/?]+)\/?$/;

/**
 * The rate-limit identity for a request. With `trustedProxyDepth` 0 (the
 * default) this is the socket peer address and nothing else — `X-Forwarded-
 * For` is attacker-controlled, so honouring it unconditionally would let
 * anyone forge their rate-limit identity with a header, which is strictly
 * worse than the proxy-collapse it would fix. Only when the operator has
 * declared how many trusted proxies front the relay do we read XFF, and even
 * then never past the furthest address those hops vouch for.
 */
function clientKey(req: IncomingMessage, trustedProxyDepth: number): string {
  const socketAddr = req.socket.remoteAddress ?? "unknown";
  if (trustedProxyDepth <= 0) return socketAddr;
  const raw = req.headers["x-forwarded-for"];
  const forwarded = (Array.isArray(raw) ? raw.join(",") : raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  // Addresses nearest-to-farthest from the server: the socket peer, then the
  // XFF chain read right-to-left (each proxy appends the address it received
  // from). The real client sits `trustedProxyDepth` hops out. Clamp so a
  // short or absent XFF falls back to the furthest still-trusted address
  // instead of reading a forgeable, client-supplied entry beyond it.
  const nearestFirst = [socketAddr, ...forwarded.reverse()];
  const index = Math.min(trustedProxyDepth, nearestFirst.length - 1);
  return nearestFirst[index]!;
}

/** The response header carrying the relay's per-boot generation token. A client
 * reads it to notice a restart (see below) and reconcile. */
const GENERATION_HEADER = "X-Relay-Generation";

function setCors(req: IncomingMessage, res: ServerResponse, allowedOrigin: string): void {
  if (req.headers.origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    // Non-safelisted response headers are hidden from cross-origin script
    // unless named here, so the browser client can only read the generation
    // token if we expose it explicitly.
    res.setHeader("Access-Control-Expose-Headers", GENERATION_HEADER);
  }
}

/**
 * SECURITY §2.3: "the relay allows exactly the demo origin." CORS response
 * headers alone don't enforce that — they only govern whether a browser
 * lets script *read the response*. A cross-origin `fetch` that POSTs a
 * `BufferSource` body with no custom headers is a CORS "simple request", so
 * it is sent with no preflight and the append *executes on the server*
 * regardless of whether the response is readable. That is exactly the "any
 * page on the internet can drive a user's browser into appending to
 * documents" vector §2.3 names.
 *
 * So state-changing requests are rejected server-side when they carry a
 * mismatched Origin. A missing Origin is allowed: browsers always attach one
 * to a POST, so no-Origin means a non-browser client (curl, another server,
 * the Node provider) — and those are already inside the "peers are trusted /
 * anyone with the link can write" model (SECURITY §1, §4). Origin-checking
 * defends the browser-CSRF case only, and this is the whole of that defence.
 */
function isOriginAllowed(req: IncomingMessage, allowedOrigin: string): boolean {
  const origin = req.headers.origin;
  return origin === undefined || origin === allowedOrigin;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": bytes.length });
  res.end(bytes);
}

/**
 * Reads the request body up to `maxBytes`. On overflow this stops
 * *accumulating* immediately (never buffers more than the cap — that's
 * the actual OOM protection, SECURITY §2.1) but does not `destroy()` the
 * socket: destroying an `IncomingMessage` tears down the shared
 * connection before a response can be written on it, which turns a clean
 * 413 into a raw connection reset the client can't distinguish from a
 * crash. The remaining bytes are drained and discarded instead — cheap,
 * and correct, since bandwidth/CPU exhaustion beyond this cap is
 * explicitly out of scope (SECURITY §4: "a determined attacker takes the
 * demo down; it is a demo").
 */
function readBodyWithCap(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      total += chunk.length;
      if (total > maxBytes) {
        rejected = true;
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

async function handleRequest(store: LogStore, rateLimiter: RateLimiter, docRateLimiter: RateLimiter, options: RelayOptions, generationId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(req, res, options.allowedOrigin);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://relay.internal");

  // A liveness probe for the host (Render pings this) and a cheap way to read
  // the current generation. No doc id, no origin check, no rate limit: a health
  // check carries no Origin and must not be throttled or count as an append.
  if (url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      generation: generationId,
      docs: store.docCount(),
      uptimeSeconds: Math.round(process.uptime()),
    });
    return;
  }

  const match = DOC_PATH_RE.exec(url.pathname);
  if (!match) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const docId = decodeURIComponent(match[1]!);
  // Stamp this response with the document's generation token: the resident log
  // instance's own token, or the boot token when the doc is absent (never
  // created, or evicted and not yet recreated). It is per document, not per
  // boot, so a client whose cursor points into a log instance that has since
  // been replaced sees the token change and reconciles, whether the instance
  // was lost to a full restart or to an LRU eviction and later recreation. This
  // overrides the boot-token default the wrapper set, so it covers every
  // response below, successes and rejections alike. See DECISIONS #0031.
  res.setHeader(GENERATION_HEADER, store.generationOf(docId) ?? generationId);

  if (req.method === "POST") {
    // SECURITY §2.3: reject a browser append from any origin but the demo's,
    // server-side — CORS headers don't stop a no-preflight simple POST from
    // landing (see isOriginAllowed).
    if (!isOriginAllowed(req, options.allowedOrigin)) {
      sendJson(res, 403, { error: "forbidden origin" });
      return;
    }
    // Two ceilings: per client address, and per document. Either one tripping
    // rejects the append (both record the attempt, which is fine).
    if (!rateLimiter.allow(clientKey(req, options.trustedProxyDepth ?? 0)) || !docRateLimiter.allow(docId)) {
      sendJson(res, 429, { error: "rate limit exceeded" });
      return;
    }
    let body: Buffer;
    try {
      body = await readBodyWithCap(req, MAX_MESSAGE_BYTES);
    } catch {
      sendJson(res, 413, { error: "message too large" });
      return;
    }
    const result = store.append(docId, body);
    if (!result.ok) {
      const status = result.error === "invalid document id" ? 400 : result.error === "message too large" ? 413 : 507;
      sendJson(res, status, { error: result.error });
      return;
    }
    // An append that just created the doc made its token exist; re-stamp so a
    // creating POST carries the same token its reads will, not the boot default
    // the pre-op stamp used while the doc was still absent.
    res.setHeader(GENERATION_HEADER, store.generationOf(docId) ?? generationId);
    sendJson(res, 200, { offset: result.offset });
    return;
  }

  if (req.method === "GET") {
    const fromParam = url.searchParams.get("from") ?? "0";
    if (!/^\d+$/.test(fromParam)) {
      sendJson(res, 400, { error: "invalid offset" });
      return;
    }
    const from = Number(fromParam);
    if (!Number.isSafeInteger(from)) {
      sendJson(res, 400, { error: "invalid offset" });
      return;
    }
    const result = store.read(docId, from);
    if (!result.ok) {
      if (result.error === "invalid document id") {
        sendJson(res, 400, { error: result.error });
        return;
      }
      // Out of range: `from` is past the end of this log. Rather than 416, we
      // return an empty body. The only way a well-behaved client's cursor gets
      // ahead of the log is that the log reset under it: the relay runs in
      // memory with no persistent disk on the free host, so a spin-down and
      // restart brings the process back with an empty log while clients still
      // hold a cursor into the old one. Returning empty lets that read succeed,
      // and the changed generation token on the same response tells the client
      // to reconcile (reset its cursor and re-push). A hard 416 would instead
      // throw on the client and wedge every future sync. See DECISIONS #0031.
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": 0 });
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": result.bytes.length,
    });
    res.end(result.bytes);
    return;
  }

  sendJson(res, 405, { error: "method not allowed" });
}

export function createRelayServer(options: RelayOptions): Server {
  const store = new LogStore({ dataDir: options.dataDir, maxDocs: options.maxDocs, maxLogBytesPerDoc: options.maxLogBytesPerDoc });
  store.replayFromDisk();

  const rateLimiter = new RateLimiter(options.appendRatePerSecond ?? APPEND_RATE_PER_SECOND);
  const docRateLimiter = new RateLimiter(options.appendRatePerSecondPerDoc ?? APPEND_RATE_PER_SECOND_PER_DOC);
  const connectionLimiter = new ConnectionLimiter(options.maxConnectionsPerIp ?? MAX_CONNECTIONS_PER_IP);
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;

  // A fresh token each time the process boots. It is the fallback stamped on
  // every response before handleRequest (so /health and a 500 carry something),
  // and the value used for a doc that has no resident log instance. Per-document
  // requests override it with the doc's own token (see handleRequest), which is
  // what catches an eviction-and-recreation that the boot token alone would miss.
  const generationId = randomUUID();

  const server = createServer((req, res) => {
    res.setHeader(GENERATION_HEADER, generationId);
    handleRequest(store, rateLimiter, docRateLimiter, options, generationId, req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
  });

  server.on("connection", (socket: Socket) => {
    // Connection limiting is necessarily keyed on the socket peer: at
    // TCP-accept time no HTTP headers have been parsed, so X-Forwarded-For
    // is unavailable here (unlike the per-request rate limit, which can use
    // it via `trustedProxyDepth`). Behind a proxy this is a per-proxy cap
    // rather than per-client — a coarser but still-real socket-exhaustion
    // guard, and the proxy itself typically bounds fan-in too.
    const key = socket.remoteAddress ?? "unknown";
    if (!connectionLimiter.tryAcquire(key)) {
      socket.destroy();
      return;
    }
    socket.setTimeout(idleTimeoutMs, () => socket.destroy());
    socket.on("close", () => connectionLimiter.release(key));
  });

  return server;
}
