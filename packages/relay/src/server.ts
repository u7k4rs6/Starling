import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Socket } from "node:net";
import { ConnectionLimiter } from "./connection-limit.js";
import { RateLimiter } from "./rate-limit.js";
import { LogStore, MAX_MESSAGE_BYTES } from "./store.js";

/** SECURITY §2.1: blunt limits, hard errors, no soft warnings. */
const MAX_CONNECTIONS_PER_IP = 20;
const APPEND_RATE_PER_SECOND = 100;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export type RelayOptions = {
  /** SECURITY §2.3: exactly the demo origin, never "*". */
  allowedOrigin: string;
  dataDir?: string;
  maxConnectionsPerIp?: number;
  appendRatePerSecond?: number;
  idleTimeoutMs?: number;
};

const DOC_PATH_RE = /^\/doc\/([^/?]+)\/?$/;

function clientKey(req: IncomingMessage): string {
  // Real deployments sit behind a proxy that sets X-Forwarded-For; using
  // the raw socket address here is the honest v1 behavior (ARCH §5 names
  // no reverse-proxy trust model), not a placeholder.
  return req.socket.remoteAddress ?? "unknown";
}

function setCors(req: IncomingMessage, res: ServerResponse, allowedOrigin: string): void {
  if (req.headers.origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

async function handleRequest(store: LogStore, rateLimiter: RateLimiter, options: RelayOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(req, res, options.allowedOrigin);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://relay.internal");
  const match = DOC_PATH_RE.exec(url.pathname);
  if (!match) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const docId = decodeURIComponent(match[1]!);

  if (req.method === "POST") {
    // SECURITY §2.3: reject a browser append from any origin but the demo's,
    // server-side — CORS headers don't stop a no-preflight simple POST from
    // landing (see isOriginAllowed).
    if (!isOriginAllowed(req, options.allowedOrigin)) {
      sendJson(res, 403, { error: "forbidden origin" });
      return;
    }
    if (!rateLimiter.allow(clientKey(req))) {
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
      const status = result.error === "invalid document id" ? 400 : 416;
      sendJson(res, status, { error: result.error });
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
  const store = new LogStore({ dataDir: options.dataDir });
  store.replayFromDisk();

  const rateLimiter = new RateLimiter(options.appendRatePerSecond ?? APPEND_RATE_PER_SECOND);
  const connectionLimiter = new ConnectionLimiter(options.maxConnectionsPerIp ?? MAX_CONNECTIONS_PER_IP);
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;

  const server = createServer((req, res) => {
    handleRequest(store, rateLimiter, options, req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
  });

  server.on("connection", (socket: Socket) => {
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
