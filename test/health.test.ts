import { expect, test } from "bun:test";
import { computeHealth } from "../src/health.ts";
import type { SourceName, SourceStatus } from "../src/types.ts";

const status = (name: SourceName, lastSuccessAt: number | null): SourceStatus => ({
  name,
  intervalMs: 1000,
  lastSuccessAt,
  consecutiveFailures: lastSuccessAt === null ? 1 : 0,
  lastError: null,
});

test("never succeeded but within the startup grace period is ok", () => {
  const h = computeHealth([status("api", null), status("chart", null)], 2500, 0);
  expect(h.httpStatus).toBe(200);
  expect(h.body.status).toBe("ok");
  expect(h.body.uptime_s).toBe(2);
});

test("one stale and one fresh source is degraded", () => {
  const h = computeHealth([status("api", 9500), status("chart", 1000)], 10000, 0);
  expect(h.httpStatus).toBe(200);
  expect(h.body.status).toBe("degraded");
  expect(h.body.sources.api?.healthy).toBe(true);
  expect(h.body.sources.chart?.healthy).toBe(false);
});

test("all sources stale (or never succeeded past grace) is down with 503", () => {
  const h = computeHealth([status("api", 1000), status("chart", null)], 10000, 0);
  expect(h.httpStatus).toBe(503);
  expect(h.body.status).toBe("down");
});
