import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit.js";

describe("RateLimiter", () => {
  it("allows requests up to the limit within a window", () => {
    const now = 0;
    const limiter = new RateLimiter(3, 1000, () => now);
    expect(limiter.allow("ip1")).toBe(true);
    expect(limiter.allow("ip1")).toBe(true);
    expect(limiter.allow("ip1")).toBe(true);
    expect(limiter.allow("ip1")).toBe(false); // 4th within the same instant
  });

  it("tracks each key independently", () => {
    const now = 0;
    const limiter = new RateLimiter(1, 1000, () => now);
    expect(limiter.allow("ip1")).toBe(true);
    expect(limiter.allow("ip1")).toBe(false);
    expect(limiter.allow("ip2")).toBe(true); // a different key, unaffected
  });

  it("a request outside the window is allowed again — sliding window, not a hard reset", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1000, () => now);
    expect(limiter.allow("ip1")).toBe(true);
    expect(limiter.allow("ip1")).toBe(true);
    expect(limiter.allow("ip1")).toBe(false);

    now = 1001; // past the 1000ms window
    expect(limiter.allow("ip1")).toBe(true);
  });

  it("old timestamps fall out of the window one at a time as time advances", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1000, () => now);
    expect(limiter.allow("ip1")).toBe(true);
    now = 500;
    expect(limiter.allow("ip1")).toBe(false); // still within the window of the first request
    now = 1001;
    expect(limiter.allow("ip1")).toBe(true); // first request has aged out
  });
});
