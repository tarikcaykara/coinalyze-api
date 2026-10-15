// Offline calibration: samples the Coinalyze chart, the page's per-venue table and the API at the same moments,
// then reports listing drift, per-venue rate periods and how closely the API aggregate tracks the chart.
// Usage: COINALYZE_API_KEY=… bun run calibrate [--coins BTC,ETH,SOL] [--samples 60] [--gap-s 60] [--max-lag 10] [--out calibration.json]
import { parseArgs } from "node:util";
import { CoinalyzeClient } from "../../src/coinalyze/client.ts";
import { RateLimiter } from "../../src/coinalyze/rate-limiter.ts";
import { isCoinSymbol, type CoinSymbol } from "../../src/coins.ts";
import { FundingSource } from "../../src/funding/source.ts";
import { createLogger, errorMessage } from "../../src/log.ts";
import { abortableSleep } from "../../src/loop.ts";
import type { Snapshot } from "../../src/types.ts";
import { analyzeCoin, formatReport, minuteAverage, type CoinSample, type Sample, type VenueHistory } from "./analyze.ts";
import { BrowserManager } from "./browser.ts";
import { ChartPage } from "./chart-page.ts";

const log = createLogger("calibrate");
const SESSION_REFRESH_MS = 3600000;
/** How far back the history lag search looks, in minutes. */
const HISTORY_LAG_MINUTES = 180;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const int = (name: string, raw: string, min: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : fail(`--${name} must be an integer >= ${min}`);
};

const { values } = parseArgs({
  options: {
    coins: { type: "string", default: "BTC,ETH,SOL" },
    samples: { type: "string", default: "60" },
    "gap-s": { type: "string", default: "60" },
    "max-lag": { type: "string", default: "10" },
    out: { type: "string", default: "calibration.json" },
  },
});
const requested = values.coins.split(",").map((c) => c.trim().toUpperCase());
const invalidCoin = requested.find((c) => !isCoinSymbol(c));
if (invalidCoin !== undefined) fail(`Invalid coin "${invalidCoin}"`);
const coins = requested.filter(isCoinSymbol);
const sampleCount = int("samples", values.samples, 1);
const gapMs = int("gap-s", values["gap-s"], 1) * 1000;
const maxLag = int("max-lag", values["max-lag"], 0);
const apiKey = process.env.COINALYZE_API_KEY?.trim() || fail("Missing required env var COINALYZE_API_KEY");

const client = new CoinalyzeClient({ apiKey, limiter: new RateLimiter() });
const source = new FundingSource({ client, coins, intervalMs: gapMs });
const manager = new BrowserManager();
const pages = coins.map((coin) => new ChartPage(coin, SESSION_REFRESH_MS));
const samples: Sample[] = [];

const controller = new AbortController();
process.on("SIGINT", () => {
  if (controller.signal.aborted) process.exit(130);
  log.warn("stopping after the current sample; Ctrl-C again to abort without a report");
  controller.abort();
});

const readPage = async (p: ChartPage, ready: boolean): Promise<Omit<CoinSample, "api">> =>
  ready ? { chart: await p.read().catch(() => null), page: await p.readVenueTable().catch(() => []) } : { chart: null, page: [] };

for (let i = 0; i < sampleCount && !controller.signal.aborted; i++) {
  const t0 = Date.now();
  const browser = await manager.get();
  // Reload first (~15s), then read chart, page table and API together so they describe the same moment.
  const ready = await Promise.allSettled(pages.map((p) => p.refresh(browser)));
  for (const [idx, p] of pages.entries()) {
    const r = ready[idx];
    if (r?.status === "rejected") {
      log.warn(`${p.symbol}: ${errorMessage(r.reason)}`);
      await p.invalidate();
    }
  }
  if (ready.every((r) => r.status === "rejected")) await manager.restart();

  const [api, reads] = await Promise.all([
    source.poll().catch((e): Snapshot[] => {
      log.warn(`api: ${errorMessage(e)}`);
      return [];
    }),
    Promise.all(pages.map(async (p, idx) => [p.symbol, await readPage(p, ready[idx]?.status === "fulfilled")] as const)),
  ]);
  const sample: Sample = {
    at: Date.now(),
    coins: Object.fromEntries(
      reads.map(([coin, read]) => [coin, { ...read, api: api.find((s) => s.symbol === coin) ?? null }]),
    ),
  };
  samples.push(sample);
  await Bun.write(values.out, JSON.stringify(samples, null, 1));
  log.info(
    `sample ${i + 1}/${sampleCount}: ` +
      coins
        .map((c) => {
          const s = sample.coins[c];
          return `${c} chart=${s?.chart ?? "—"} api=${s?.api?.aggregated_predicted_funding_rate.toFixed(5) ?? "—"}`;
        })
        .join(", "),
  );
  if (i < sampleCount - 1) await abortableSleep(Math.max(0, gapMs - (Date.now() - t0)), controller.signal);
}

await Promise.all(pages.map((p) => p.invalidate()));
await manager.close();

/** Per-coin venue average per minute from the API's 1-minute history, covering the samples plus the lag window. */
const loadHistory = async (): Promise<Map<CoinSymbol, Map<number, number>>> => {
  const first = samples[0]?.at;
  const last = samples.at(-1)?.at;
  if (first === undefined || last === undefined) return new Map();
  const fromMinute = Math.floor(first / 60000) - HISTORY_LAG_MINUTES - 30;
  const toMinute = Math.floor(last / 60000);
  const periodBySymbol = new Map<string, { coin: CoinSymbol; ratePeriodHours: number }>();
  for (const s of samples) {
    for (const coin of coins) {
      for (const c of s.coins[coin]?.api?.components ?? []) {
        if (c.symbol !== null) periodBySymbol.set(c.symbol, { coin, ratePeriodHours: c.rate_period_hours });
      }
    }
  }
  let series;
  try {
    series = await client.predictedFundingRateHistory([...periodBySymbol.keys()], fromMinute * 60, toMinute * 60);
  } catch (e) {
    log.warn(`history: ${errorMessage(e)}`);
    return new Map();
  }
  const venuesByCoin = new Map<CoinSymbol, VenueHistory[]>();
  for (const { symbol, history } of series) {
    const meta = periodBySymbol.get(symbol);
    if (meta === undefined) continue;
    venuesByCoin.set(meta.coin, [...(venuesByCoin.get(meta.coin) ?? []), { ratePeriodHours: meta.ratePeriodHours, candles: history }]);
  }
  return new Map([...venuesByCoin].map(([coin, venues]) => [coin, minuteAverage(venues, fromMinute, toMinute)]));
};

const history = await loadHistory();
const reports = coins.map((c) => {
  const avgByMinute = history.get(c);
  return analyzeCoin(samples, c, maxLag, avgByMinute ? { avgByMinute, maxLagMinutes: HISTORY_LAG_MINUTES } : null);
});
console.log(formatReport(reports, samples, gapMs));
log.info(`raw samples: ${values.out}`);
