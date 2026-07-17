import { describe, expect, it } from "vitest";
import { ConnectionLimiter } from "./connection-limit.js";

describe("ConnectionLimiter", () => {
  it("allows connections up to the per-key limit, then blunt-refuses more", () => {
    const limiter = new ConnectionLimiter(2);
    expect(limiter.tryAcquire("ip1")).toBe(true);
    expect(limiter.tryAcquire("ip1")).toBe(true);
    expect(limiter.tryAcquire("ip1")).toBe(false);
    expect(limiter.countFor("ip1")).toBe(2);
  });

  it("tracks each key independently", () => {
    const limiter = new ConnectionLimiter(1);
    expect(limiter.tryAcquire("ip1")).toBe(true);
    expect(limiter.tryAcquire("ip2")).toBe(true); // unaffected by ip1's slot
  });

  it("release frees a slot for a later acquire", () => {
    const limiter = new ConnectionLimiter(1);
    expect(limiter.tryAcquire("ip1")).toBe(true);
    expect(limiter.tryAcquire("ip1")).toBe(false);
    limiter.release("ip1");
    expect(limiter.tryAcquire("ip1")).toBe(true);
  });

  it("release on a key with no connections is a harmless no-op, not a negative count", () => {
    const limiter = new ConnectionLimiter(1);
    limiter.release("never-acquired");
    expect(limiter.countFor("never-acquired")).toBe(0);
    // Still fully usable afterward.
    expect(limiter.tryAcquire("never-acquired")).toBe(true);
  });
});
