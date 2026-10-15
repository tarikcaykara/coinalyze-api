import { expect, test } from "bun:test";
import { RateLimiter } from "../src/coinalyze/rate-limiter.ts";

const HOLD_MS = 60000 + 250;

const fakeClock = () => {
  const clock = { t: 0, slept: 0 };
  const limiter = new RateLimiter({
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
      clock.slept += ms;
    },
  });
  return { clock, limiter };
};

test("40 calls fit in the window; more wait until the oldest calls leave it, not for a refill", async () => {
  const { clock, limiter } = fakeClock();
  await limiter.acquire(20);
  clock.t = 10000;
  await limiter.acquire(20);
  expect(clock.slept).toBe(0);

  // The first 20 leave the window at HOLD_MS; the next 20 at 10 s + HOLD_MS.
  await limiter.acquire(20);
  expect(clock.t).toBe(HOLD_MS);
  await limiter.acquire(1);
  expect(clock.t).toBe(10000 + HOLD_MS);
});

test("a refunded request frees its calls at once", async () => {
  const { clock, limiter } = fakeClock();
  await limiter.acquire(20);
  const refund = await limiter.acquire(20);
  refund();
  await limiter.acquire(20);
  expect(clock.slept).toBe(0);
});

test("a request larger than the limit can never be served", async () => {
  const { limiter } = fakeClock();
  await expect(limiter.acquire(41)).rejects.toThrow("limit 40");
});
