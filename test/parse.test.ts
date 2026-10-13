import { expect, test } from "bun:test";
import { classifyCloudflare, parseLegendValue } from "../src/sources/chart/parse.ts";

test("parses a Unicode-minus legend value", () => {
  expect(parseLegendValue("Predicted Funding Rate\nAggregated\nAVG close 10 \u22120.0123")).toBe(-0.0123);
});

test("parses an ASCII-minus legend value", () => {
  expect(parseLegendValue("Predicted Funding Rate AVG close 10 -0.5")).toBe(-0.5);
});

test("a bare minus is not a value", () => {
  expect(parseLegendValue("Predicted Funding Rate AVG close 10 -")).toBeNull();
});

test("no legend yields null", () => {
  expect(parseLegendValue("Open Interest 123.4")).toBeNull();
});

test("cloudflare states", () => {
  expect(classifyCloudflare("Just a moment...", "")).toBe("challenge");
  expect(classifyCloudflare("x", "You have been blocked")).toBe("blocked");
  expect(classifyCloudflare("Ethereum Funding Rate | Coinalyze", "Predicted Funding Rate")).toBe("none");
});
