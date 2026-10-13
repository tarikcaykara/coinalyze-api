/** Token bucket: starts full, refills continuously at `refillPerMs` up to `capacity`. */
export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<unknown>;
  private tokens: number;
  private refilledAt: number;

  constructor(
    opts: {
      capacity?: number;
      refillPerMs?: number;
      now?: () => number;
      sleep?: (ms: number) => Promise<unknown>;
    } = {},
  ) {
    this.capacity = opts.capacity ?? 40;
    this.refillPerMs = opts.refillPerMs ?? 40 / 60000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? Bun.sleep;
    this.tokens = this.capacity;
    this.refilledAt = this.now();
  }

  async acquire(n: number): Promise<void> {
    if (n > this.capacity) {
      throw new Error(`cannot acquire ${n} tokens (capacity ${this.capacity})`);
    }
    this.refill();
    while (this.tokens < n) {
      await this.sleep(Math.ceil((n - this.tokens) / this.refillPerMs));
      this.refill();
    }
    this.tokens -= n;
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.refilledAt) * this.refillPerMs);
    this.refilledAt = t;
  }
}
