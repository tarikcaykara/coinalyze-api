/**
 * Sliding window: at most `limit` calls in any `windowMs`, the way Coinalyze counts its 40 calls/min.
 * A recorded call is held for `windowMs + marginMs`: the server counts calls when they arrive, so the
 * margin keeps request latency from putting its window behind ours.
 */
export class RateLimiter {
  private readonly limit: number;
  private readonly holdMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<unknown>;
  /** Recorded calls, oldest first. */
  private calls: { at: number; n: number }[] = [];

  constructor(
    opts: {
      limit?: number;
      windowMs?: number;
      marginMs?: number;
      now?: () => number;
      sleep?: (ms: number) => Promise<unknown>;
    } = {},
  ) {
    this.limit = opts.limit ?? 40;
    this.holdMs = (opts.windowMs ?? 60000) + (opts.marginMs ?? 250);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? Bun.sleep;
  }

  /**
   * Waits until `n` more calls fit in the window, then records them.
   * Returns a refund that removes them again, for a request the server rejected.
   */
  async acquire(n: number): Promise<() => void> {
    if (n > this.limit) {
      throw new Error(`cannot acquire ${n} calls (limit ${this.limit} per window)`);
    }
    for (;;) {
      const t = this.now();
      this.calls = this.calls.filter((c) => t - c.at < this.holdMs);
      const used = this.calls.reduce((sum, c) => sum + c.n, 0);
      if (used + n <= this.limit) {
        const entry = { at: t, n };
        this.calls.push(entry);
        return () => {
          this.calls = this.calls.filter((c) => c !== entry);
        };
      }
      // Sleep until enough of the oldest calls have left the window.
      let freed = 0;
      for (const c of this.calls) {
        freed += c.n;
        if (used - freed + n <= this.limit) {
          await this.sleep(c.at + this.holdMs - t);
          break;
        }
      }
    }
  }
}
