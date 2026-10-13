import { COIN_REGISTRY, type CoinSymbol } from "../../coins.ts";
import { createLogger } from "../../log.ts";
import type { Snapshot, Source } from "../../types.ts";
import { aggregate, MARKET_SCOPE, toPercent8h } from "./aggregate.ts";
import type { CoinalyzeClient, FutureMarket } from "./client.ts";

const log = createLogger("api");

const MARKET_REFRESH_MS = 24 * 60 * 60 * 1000;
export const OI_REFRESH_MS = 600000;
const API_CALLS_PER_MIN = 40;

type Client = Pick<CoinalyzeClient, "futureMarkets" | "predictedFundingRate" | "openInterestUsd">;

export class ApiSource implements Source {
  readonly name = "api";
  readonly intervalMs: number;
  private readonly client: Client;
  private readonly coins: CoinSymbol[];
  private marketsByCoin = new Map<CoinSymbol, FutureMarket[]>();
  private marketsAt: number | null = null;
  private oiBySymbol = new Map<string, number>();
  private oiAt: number | null = null;

  constructor(opts: { client: Client; coins: CoinSymbol[]; intervalMs: number }) {
    this.client = opts.client;
    this.coins = opts.coins;
    this.intervalMs = opts.intervalMs;
  }

  async poll(): Promise<Snapshot[]> {
    await this.ensureMarkets();
    const symbols = [...this.marketsByCoin.values()].flat().map((m) => m.symbol);
    await this.ensureOpenInterest(symbols);

    const rates = new Map<string, number>();
    for (const p of await this.client.predictedFundingRate(symbols)) rates.set(p.symbol, p.value);

    const snapshots: Snapshot[] = [];
    for (const [symbol, markets] of this.marketsByCoin) {
      const result = aggregate(
        markets.map((m) => {
          const value = rates.get(m.symbol);
          return {
            rate: value === undefined ? null : toPercent8h(value, m.exchange),
            oiUsd: this.oiBySymbol.get(m.symbol) ?? null,
          };
        }),
      );
      if (result.avg === null) {
        log.warn(`no predicted funding rate for any ${symbol} market`);
        continue;
      }
      snapshots.push({
        type: "snapshot",
        source: "api",
        symbol,
        coin: COIN_REGISTRY[symbol].slug,
        timestamp: Date.now(),
        aggregated_predicted_funding_rate: result.avg,
        oi_weighted_predicted_funding_rate: result.oiWeighted,
        markets: result.count,
        unit: "percent_per_8h",
      });
    }
    if (snapshots.length === 0) throw new Error("api: no coin produced a value");
    log.info(
      snapshots
        .map((s) => `${s.symbol} avg=${s.aggregated_predicted_funding_rate.toFixed(4)}% (${s.markets} mkts)`)
        .join(", "),
    );
    return snapshots;
  }

  async close(): Promise<void> {}

  private async ensureMarkets(): Promise<void> {
    if (this.marketsAt !== null && Date.now() - this.marketsAt <= MARKET_REFRESH_MS) return;
    const all = await this.client.futureMarkets();
    const byCoin = new Map<CoinSymbol, FutureMarket[]>();
    for (const symbol of this.coins) {
      const markets = all.filter(
        (m) =>
          m.is_perpetual === true &&
          m.base_asset === symbol &&
          (MARKET_SCOPE === "all" || m.margined === "STABLE"),
      );
      if (markets.length === 0) {
        log.warn(`no perpetual markets for ${symbol}`);
        continue;
      }
      byCoin.set(symbol, markets);
    }
    this.marketsByCoin = byCoin;
    this.marketsAt = Date.now();

    const n = [...byCoin.values()].flat().length;
    const callsPerMin = (n * 60000) / this.intervalMs + (n * 60000) / OI_REFRESH_MS;
    log.info(`tracking ${n} perpetual markets (scope: ${MARKET_SCOPE})`);
    if (callsPerMin > API_CALLS_PER_MIN) {
      log.warn(
        `estimated ${callsPerMin.toFixed(1)} calls/min exceeds the ${API_CALLS_PER_MIN}/min API limit; cycles will be throttled`,
      );
    }
  }

  private async ensureOpenInterest(symbols: string[]): Promise<void> {
    if (this.oiAt !== null && Date.now() - this.oiAt <= OI_REFRESH_MS) return;
    const oi = new Map<string, number>();
    for (const p of await this.client.openInterestUsd(symbols)) oi.set(p.symbol, p.value);
    this.oiBySymbol = oi;
    this.oiAt = Date.now();
  }
}
