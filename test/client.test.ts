import { afterAll, beforeEach, expect, test } from "bun:test";
import { CoinalyzeClient } from "../src/coinalyze/client.ts";

interface Seen {
  path: string;
  symbols: string[];
  apiKey: string | null;
}

let seen: Seen[] = [];
let responses: (() => Response)[] = [];

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    const symbols = url.searchParams.get("symbols")?.split(",") ?? [];
    seen.push({ path: url.pathname, symbols, apiKey: req.headers.get("api_key") });
    const next = responses.shift();
    if (next) return next();
    return Response.json(symbols.map((symbol) => ({ symbol, value: 0.01, update: 1 })));
  },
});

afterAll(() => server.stop(true));

beforeEach(() => {
  seen = [];
  responses = [];
});

const makeClient = () => {
  const sleeps: number[] = [];
  const acquired: number[] = [];
  const refunded: number[] = [];
  const client = new CoinalyzeClient({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    limiter: {
      acquire: async (n) => {
        acquired.push(n);
        return () => void refunded.push(n);
      },
    },
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { client, sleeps, acquired, refunded };
};

test("25 symbols are split into chunks of 20 and 5, each costing its size", async () => {
  const { client, acquired } = makeClient();
  const symbols = Array.from({ length: 25 }, (_, i) => `S${i}`);
  const points = await client.predictedFundingRate(symbols);

  expect(seen.map((s) => s.symbols.length)).toEqual([20, 5]);
  expect(seen.every((s) => s.apiKey === "test-key" && s.path === "/v1/predicted-funding-rate")).toBe(true);
  expect(acquired).toEqual([20, 5]);
  expect(points.map((p) => p.symbol)).toEqual(symbols);
});

test("429 refunds the rejected call, honours Retry-After, then succeeds", async () => {
  const { client, sleeps, acquired, refunded } = makeClient();
  responses = [() => new Response("slow down", { status: 429, headers: { "Retry-After": "1" } })];
  const points = await client.openInterestUsd(["ETHUSDT_PERP.A"]);
  expect(sleeps).toEqual([1000]);
  expect(acquired).toEqual([1, 1]);
  expect(refunded).toEqual([1]);
  expect(points).toEqual([{ symbol: "ETHUSDT_PERP.A", value: 0.01, update: 1 }]);
});

test("three 429s give up", async () => {
  const { client, sleeps } = makeClient();
  responses = Array.from({ length: 3 }, () => () => new Response("", { status: 429 }));
  await expect(client.predictedFundingRate(["X"])).rejects.toThrow(
    "rate limited (429) after 3 attempts",
  );
  expect(sleeps).toEqual([60000, 60000]);
  expect(seen.length).toBe(3);
});

test("401 fails immediately without retrying", async () => {
  const { client, sleeps } = makeClient();
  responses = [() => new Response("", { status: 401 })];
  await expect(client.futureMarkets()).rejects.toThrow("invalid COINALYZE_API_KEY (401)");
  expect(seen.length).toBe(1);
  expect(sleeps).toEqual([]);
});
