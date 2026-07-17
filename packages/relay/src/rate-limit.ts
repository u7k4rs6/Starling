/**
 * Append rate limit per IP (SECURITY §2.1): "well above a human typist,
 * well below a script." A sliding one-second window, tracked per key
 * (the caller decides what a key is — an IP address in production).
 */
export class RateLimiter {
  private readonly timestampsByKey = new Map<string, number[]>();

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number = 1000,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** True if `key` is still under its limit — and records this attempt. */
  allow(key: string): boolean {
    const now = this.now();
    const windowStart = now - this.windowMs;
    const recent = (this.timestampsByKey.get(key) ?? []).filter((t) => t > windowStart);
    if (recent.length >= this.maxPerWindow) {
      this.timestampsByKey.set(key, recent);
      return false;
    }
    recent.push(now);
    this.timestampsByKey.set(key, recent);
    return true;
  }
}
