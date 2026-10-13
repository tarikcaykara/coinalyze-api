import { expect, test } from "bun:test";
import type { FutureMarket, ValuePoint } from "../src/coinalyze/client.ts";
import { FundingSource, OI_REFRESH_MS, STALE_AFTER_MS } from "../src/funding/source.ts";

const T0 = 1_800_000_000_000;

const perp = (symbol: string, exchange: string, quote: string, extra: Partial<FutureMarket> = {}): FutureMarket => ({
  symbol,
  exchange,
  symbol_on_exchange: symbol,
  base_asset: "ETH",
  quote_asset: quote,
  is_perpetual: true,
  margined: "STABLE",
  ...extra,
});

const MARKETS: FutureMarket[] = [
  perp("ETHUSDT_PERP.A", "A", "USDT"), // BINANCE USDT
  perp("ETH.H", "H", "USD"), // HYPERLIQUID, hourly rate
  perp("pf_ethusd.K", "K", "USD"), // KRAKEN, hourly rate
  perp("ETH_USDC-PERPETUAL.2", "2", "USDC"), // DERIBIT, no predicted rate
  // Not in the venue list:
  perp("7.O", "O", "USD"), // Polymarket
  perp("ETHU_PERP.A", "A", "U"), // Binance, exotic quote
  perp("ETHUSD_PERP.A", "A", "USD", { margined: "COIN" }), // coin-margined
  perp("ETHUSDT_260327.A", "A", "USDT", { is_perpetual: false }), // dated future
];

const fakeClient = (clock: { now: number }) => {
  const calls = { futureMarkets: 0, openInterest: 0, requested: [] as string[] };
  const client = {
    futureMarkets: async () => {
      calls.futureMarkets++;
      return MARKETS;
    },
    predictedFundingRate: async (symbols: string[]): Promise<ValuePoint[]> => {
      calls.requested = symbols;
      const rates: ValuePoint[] = [
        { symbol: "ETHUSDT_PERP.A", value: 0.02, update: clock.now - 30_000 },
        { symbol: "ETH.H", value: 0.00125, update: clock.now - 30_000 },
        { symbol: "pf_ethusd.K", value: 0.5, update: clock.now - STALE_AFTER_MS - 1 },
        // Deribit is omitted, as the API does for venues without a predicted rate.
      ];
      return rates.filter((r) => symbols.includes(r.symbol));
    },
    openInterestUsd: async (symbols: string[]): Promise<ValuePoint[]> => {
      calls.openInterest++;
      const oi: ValuePoint[] = [
        { symbol: "ETHUSDT_PERP.A", value: 300, update: clock.now },
        { symbol: "ETH.H", value: 100, update: clock.now },
        { symbol: "pf_ethusd.K", value: 1e12, update: clock.now },
      ];
      return oi.filter((r) => symbols.includes(r.symbol));
    },
  };
  return { client, calls };
};

test("aggregates fresh venue rates only, normalized to 8h, with a per-venue breakdown", async () => {
  const clock = { now: T0 };
  const { client, calls } = fakeClient(clock);
  const source = new FundingSource({ client, coins: ["ETH"], intervalMs: 60000, now: () => clock.now });

  const [eth] = await source.poll();

  expect(calls.requested.sort()).toEqual(["ETH.H", "ETHUSDT_PERP.A", "ETH_USDC-PERPETUAL.2", "pf_ethusd.K"]);
  // Binance 0.02 (OI 300) and Hyperliquid 0.00125/h → 0.01/8h (OI 100); stale Kraken excluded.
  expect(eth!.aggregated_predicted_funding_rate).toBeCloseTo(0.015, 12);
  expect(eth!.oi_weighted_predicted_funding_rate).toBeCloseTo(0.0175, 12);
  expect(eth!.markets).toBe(2);

  const byVenue = Object.fromEntries(eth!.components.map((c) => [c.venue, c]));
  expect(byVenue["BINANCE USDT"]!.status).toBe("used");
  expect(byVenue["HYPERLIQUID"]!).toMatchObject({ status: "used", predicted_rate: 0.00125, rate_8h: 0.01 });
  expect(byVenue["KRAKEN"]!.status).toBe("stale");
  expect(byVenue["DERIBIT"]!).toMatchObject({ status: "no_rate", symbol: "ETH_USDC-PERPETUAL.2", rate_8h: null });
  expect(byVenue["BINANCE USDC"]!).toMatchObject({ status: "unlisted", symbol: null });
  expect(eth!.components).toHaveLength(10);
});

test("market list is cached for a day and open interest for OI_REFRESH_MS", async () => {
  const clock = { now: T0 };
  const { client, calls } = fakeClient(clock);
  const source = new FundingSource({ client, coins: ["ETH"], intervalMs: 60000, now: () => clock.now });

  await source.poll();
  clock.now += 60000;
  await source.poll();
  expect(calls).toMatchObject({ futureMarkets: 1, openInterest: 1 });

  clock.now += OI_REFRESH_MS;
  await source.poll();
  expect(calls).toMatchObject({ futureMarkets: 1, openInterest: 2 });
});

test("throws when no coin has a fresh rate", async () => {
  const clock = { now: T0 };
  const { client } = fakeClient(clock);
  const source = new FundingSource({ client, coins: ["ETH"], intervalMs: 60000, now: () => clock.now + STALE_AFTER_MS + 60_000 });
  await expect(source.poll()).rejects.toThrow("no coin produced a value");
});
