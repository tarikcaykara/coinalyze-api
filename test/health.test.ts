import { expect, test } from "bun:test";
import { computeHealth } from "../src/health.ts";
import type { SourceStatus } from "../src/types.ts";

const status = (lastSuccessAt: number | null): SourceStatus => ({
  intervalMs: 1000,
  lastSuccessAt,
  consecutiveFailures: lastSuccessAt === null ? 1 : 0,
  lastError: null,
});

test("never succeeded but within the startup grace period is ok", () => {
  const h = computeHealth(status(null), 2500, 0);
  expect(h.httpStatus).toBe(200);
  expect(h.body).toMatchObject({ status: "ok", uptime_s: 2 });
});

test("a success within 3 intervals is ok", () => {
  expect(computeHealth(status(7500), 10000, 0).httpStatus).toBe(200);
});

test("stale, or never succeeded past the grace period, is down with 503", () => {
  expect(computeHealth(status(6999), 10000, 0)).toMatchObject({ httpStatus: 503, body: { status: "down" } });
  expect(computeHealth(status(null), 3001, 0).httpStatus).toBe(503);
});
