/**
 * Max connections per IP (SECURITY §2.1): "blunt, but stops the laziest
 * exhaustion." Tracks a plain count per key — the caller increments on
 * connection open and must decrement on close, from whatever transport
 * layer it's wired into (a raw socket, here).
 */
export class ConnectionLimiter {
  private readonly countByKey = new Map<string, number>();

  constructor(private readonly maxPerKey: number) {}

  /** True (and reserves a slot) if `key` is under its connection limit. */
  tryAcquire(key: string): boolean {
    const count = this.countByKey.get(key) ?? 0;
    if (count >= this.maxPerKey) return false;
    this.countByKey.set(key, count + 1);
    return true;
  }

  release(key: string): void {
    const count = this.countByKey.get(key) ?? 0;
    if (count <= 1) {
      this.countByKey.delete(key);
    } else {
      this.countByKey.set(key, count - 1);
    }
  }

  countFor(key: string): number {
    return this.countByKey.get(key) ?? 0;
  }
}
