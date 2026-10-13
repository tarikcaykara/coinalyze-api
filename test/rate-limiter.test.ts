import { expect, test } from "bun:test";
import { RateLimiter } from "../src/sources/api/rate-limiter.ts";

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

test("a full bucket serves 40 calls immediately, the 41st waits ~1.5s", async () => {
  const { clock, limiter } = fakeClock();
  for (let i = 0; i < 40; i++) await limiter.acquire(1);
  expect(clock.slept).toBe(0);
  await limiter.acquire(1);
  expect(clock.slept).toBeGreaterThanOrEqual(1500);
  expect(clock.slept).toBeLessThan(1510);
});

test("a request larger than the bucket can never be served", async () => {
  const { limiter } = fakeClock();
  await expect(limiter.acquire(41)).rejects.toThrow("capacity 40");
});
