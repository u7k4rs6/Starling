import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpRelayTransport } from "./transport.js";

/**
 * A minimal stand-in for the relay's HTTP contract (ARCH §5), not the real
 * relay package: `packages/provider` depends only on `starling-crdt` per
 * the architecture graph (§1), and pulling in `packages/relay` — even as a
 * dev-only test dependency — isn't needed to prove `HttpRelayTransport`
 * speaks the documented contract correctly. The real relay's own behavior
 * (resource bounds, CORS, rate limiting) is already covered by Step 8's
 * suite; Step 10's integration test is where a real relay and a real
 * provider run together end to end.
 */
function startFakeRelay(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

let activeServer: Server | null = null;

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
    activeServer = null;
  }
});

describe("HttpRelayTransport.append", () => {
  it("POSTs the exact bytes to /doc/:id and returns the offset from the JSON response", async () => {
    let receivedMethod = "";
    let receivedPath = "";
    let receivedBody: Buffer | null = null;
    const { url, server } = await startFakeRelay((req, res) => {
      receivedMethod = req.method ?? "";
      receivedPath = req.url ?? "";
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ offset: 42 }));
      });
    });
    activeServer = server;

    const transport = new HttpRelayTransport(url, "doc-1");
    const offset = await transport.append(new Uint8Array([1, 2, 3]));

    expect(offset).toBe(42);
    expect(receivedMethod).toBe("POST");
    expect(receivedPath).toBe("/doc/doc-1");
    expect(receivedBody).toEqual(Buffer.from([1, 2, 3]));
  });

  it("throws on a non-ok response instead of returning a bogus offset", async () => {
    const { url, server } = await startFakeRelay((_req, res) => {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "message too large" }));
    });
    activeServer = server;

    const transport = new HttpRelayTransport(url, "doc-1");
    await expect(transport.append(new Uint8Array([1]))).rejects.toThrow();
  });
});

describe("HttpRelayTransport.read", () => {
  it("GETs /doc/:id?from=N and returns the raw response bytes", async () => {
    let receivedPath = "";
    const { url, server } = await startFakeRelay((req, res) => {
      receivedPath = req.url ?? "";
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(Buffer.from([9, 8, 7]));
    });
    activeServer = server;

    const transport = new HttpRelayTransport(url, "doc-1");
    const bytes = await transport.read(17);

    expect(receivedPath).toBe("/doc/doc-1?from=17");
    expect(bytes).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("throws on a non-ok response", async () => {
    const { url, server } = await startFakeRelay((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid document id" }));
    });
    activeServer = server;

    const transport = new HttpRelayTransport(url, "not-a-uuid");
    await expect(transport.read(0)).rejects.toThrow();
  });
});
