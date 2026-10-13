import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Health } from "../src/health.ts";
import { createServer } from "../src/server.ts";
import { SnapshotStore } from "../src/store.ts";
import type { Snapshot } from "../src/types.ts";

const dir = await mkdtemp(join(tmpdir(), "coinalyze-server-"));
const store = new SnapshotStore({ file: join(dir, "funding_rate.json"), historyLimit: 10 });

const snap = (timestamp: number): Snapshot => ({
  type: "snapshot",
  source: "api",
  symbol: "ETH",
  coin: "ethereum",
  timestamp,
  aggregated_predicted_funding_rate: 0.01,
  oi_weighted_predicted_funding_rate: 0.012,
  markets: 12,
  unit: "percent_per_8h",
});

const seeded = snap(1);
await store.add([seeded]);

let health: Health = { httpStatus: 503, body: { status: "down", uptime_s: 0, sources: {} } };

const server = createServer({
  port: 0,
  authToken: "secret-token",
  // Real timer on purpose: the server enforces the auth deadline with its own setTimeout.
  authTimeoutMs: 200,
  pingIntervalMs: 60000,
  pongTimeoutMs: 120000,
  store,
  getHealth: () => health,
  meta: { coins: ["ETH"], sources: ["api"], intervalMs: { api: 120000 } },
  dashboard: new Response("dashboard"),
});

afterAll(async () => {
  server.stop();
  await rm(dir, { recursive: true, force: true });
});

const connect = () => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const queue: unknown[] = [];
  let waiting: ((msg: unknown) => void) | null = null;
  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<CloseEvent>();
  ws.onopen = () => opened.resolve();
  ws.onclose = (e) => closed.resolve(e);
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(msg);
    } else {
      queue.push(msg);
    }
  };
  const next = (): Promise<any> => {
    if (queue.length > 0) return Promise.resolve(queue.shift());
    const { promise, resolve } = Promise.withResolvers<unknown>();
    waiting = resolve;
    return promise;
  };
  return { ws, opened: opened.promise, closed: closed.promise, next };
};

test("valid auth receives metadata, history, then live snapshots", async () => {
  const client = connect();
  await client.opened;
  client.ws.send(JSON.stringify({ type: "auth", token: "secret-token" }));

  expect(await client.next()).toEqual({
    type: "auth",
    status: "ok",
    coins: ["ETH"],
    sources: ["api"],
    interval_ms: { api: 120000 },
  });
  expect(await client.next()).toEqual({ type: "history", snapshots: [seeded] });

  const live = snap(2);
  await store.add([live]);
  expect(await client.next()).toEqual(live);

  client.ws.send("not json");
  expect(await client.next()).toEqual({ type: "error", message: "invalid json" });
  client.ws.close();
  await client.closed;
});

test("a wrong token is closed with 4001", async () => {
  const client = connect();
  await client.opened;
  client.ws.send(JSON.stringify({ type: "auth", token: "secret-tokeN" }));
  expect(await client.next()).toEqual({ type: "auth", status: "error", message: "invalid token" });
  expect((await client.closed).code).toBe(4001);
});

test("a client that never authenticates is closed with 4003", async () => {
  const client = connect();
  await client.opened;
  expect((await client.closed).code).toBe(4003);
});

test("/health returns the computed status code and body", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/health`);
  expect(res.status).toBe(503);
  expect((await res.json()).status).toBe("down");

  health = { httpStatus: 200, body: { status: "ok", uptime_s: 5, sources: {} } };
  expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
});
