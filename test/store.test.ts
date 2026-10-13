import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore } from "../src/store.ts";
import type { Snapshot } from "../src/types.ts";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "coinalyze-store-"));
  file = join(dir, "funding_rate.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const snap = (source: "api" | "chart", timestamp: number, rate = 0.01): Snapshot => ({
  type: "snapshot",
  source,
  symbol: "ETH",
  coin: "ethereum",
  timestamp,
  aggregated_predicted_funding_rate: rate,
  oi_weighted_predicted_funding_rate: null,
  markets: null,
  unit: "percent_per_8h",
});

test("a corrupt or v1-format file starts empty", async () => {
  await Bun.write(file, "{not json");
  const corrupt = new SnapshotStore({ file, historyLimit: 10 });
  await corrupt.load();
  expect(corrupt.latest()).toEqual([]);

  await Bun.write(file, JSON.stringify({ aggregated_predicted_funding_rate: 0.01, coin: "ethereum" }));
  const v1 = new SnapshotStore({ file, historyLimit: 10 });
  await v1.load();
  expect(v1.latest()).toEqual([]);
});

test("history is capped per (source, symbol) key and merged ascending", async () => {
  const store = new SnapshotStore({ file, historyLimit: 2 });
  await store.add([snap("api", 1), snap("api", 3), snap("chart", 2)]);
  await store.add([snap("api", 5)]);
  expect(store.history().map((s) => `${s.source}@${s.timestamp}`)).toEqual([
    "chart@2",
    "api@3",
    "api@5",
  ]);
});

test("latest() is persisted and re-seeded by load(), skipping invalid entries", async () => {
  const store = new SnapshotStore({ file, historyLimit: 10 });
  const received: Snapshot[] = [];
  store.subscribe((s) => received.push(s));
  await store.add([snap("api", 1, 0.02), snap("chart", 2, 0.03)]);
  expect(received.map((s) => s.timestamp)).toEqual([1, 2]);

  const persisted = JSON.parse(await Bun.file(file).text());
  expect(persisted).toEqual(store.latest());

  await Bun.write(file, JSON.stringify([...persisted, { ...snap("api", 3), symbol: "DOGE" }]));
  const reloaded = new SnapshotStore({ file, historyLimit: 10 });
  await reloaded.load();
  expect(reloaded.latest()).toEqual(store.latest());
  expect(reloaded.history()).toEqual(store.latest());
});
