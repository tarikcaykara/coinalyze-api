import { expect, test } from "bun:test";
import { aggregate } from "../src/funding/aggregate.ts";

test("simple and OI-weighted averages", () => {
  const r = aggregate([
    { rate: 0.01, oiUsd: 100 },
    { rate: -0.03, oiUsd: 300 },
  ]);
  expect(r.count).toBe(2);
  expect(r.avg).toBeCloseTo(-0.01, 12);
  expect(r.oiWeighted).toBeCloseTo(-0.02, 12);
});

test("null and NaN rates are excluded from count, avg and the weighted sum", () => {
  const r = aggregate([
    { rate: 0.02, oiUsd: 100 },
    { rate: null, oiUsd: 1e9 },
    { rate: Number.NaN, oiUsd: 1e9 },
  ]);
  expect(r.count).toBe(1);
  expect(r.avg).toBeCloseTo(0.02, 12);
  expect(r.oiWeighted).toBeCloseTo(0.02, 12);
});

test("missing OI leaves avg intact and oiWeighted null", () => {
  const r = aggregate([
    { rate: 0.01, oiUsd: null },
    { rate: 0.03, oiUsd: 0 },
  ]);
  expect(r.avg).toBeCloseTo(0.02, 12);
  expect(r.oiWeighted).toBeNull();
});

test("empty input", () => {
  expect(aggregate([])).toEqual({ avg: null, oiWeighted: null, count: 0 });
});
