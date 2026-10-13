import type { CoinalyzeClient, FutureMarket } from "../coinalyze/client.ts";
import { COIN_REGISTRY, type CoinSymbol } from "../coins.ts";
import { createLogger } from "../log.ts";
import type { MarketComponent, Snapshot, Source } from "../types.ts";
import { aggregate } from "./aggregate.ts";
import { VENUES, type Venue } from "./universe.ts";

const log = createLogger("funding");

const MARKET_REFRESH_MS = 24 * 60 * 60 * 1000;
export const OI_REFRESH_MS = 600000;
/** Predicted rates older than this are excluded (live venues update about every minute). */
export const STALE_AFTER_MS = 15 * 60 * 1000;
const API_CALLS_PER_MIN = 40;

type Client = Pick<CoinalyzeClient, "futureMarkets" | "predictedFundingRate" | "openInterestUsd">;

interface ResolvedVenue {
  venue: Venue;
  symbol: string | null;
}

/** Polls Coinalyze for every venue in VENUES and aggregates per coin. */
export class FundingSource implements Source {
  readonly name = "funding";
  readonly intervalMs: number;
  private readonly client: Client;
  private readonly coins: CoinSymbol[];
  private readonly now: () => number;
  private venuesByCoin = new Map<CoinSymbol, ResolvedVenue[]>();
  private marketsAt: number | null = null;
  private oiBySymbol = new Map<string, number>();
  private oiAt: number | null = null;

  constructor(opts: { client: Client; coins: CoinSymbol[]; intervalMs: number; now?: () => number }) {
    this.client = opts.client;
    this.coins = opts.coins;
    this.intervalMs = opts.intervalMs;
    this.now = opts.now ?? Date.now;
  }

  async poll(): Promise<Snapshot[]> {
    await this.resolveVenues();
    const symbols = [...this.venuesByCoin.values()].flat().flatMap((v) => (v.symbol === null ? [] : [v.symbol]));
    await this.refreshOpenInterest(symbols);

    const rates = new Map<string, { value: number; update: number }>();
    for (const p of await this.client.predictedFundingRate(symbols)) rates.set(p.symbol, p);

    const now = this.now();
    const snapshots: Snapshot[] = [];
    for (const [coin, venues] of this.venuesByCoin) {
      const components = venues.map(({ venue, symbol }) => this.component(venue, symbol, rates, now));
      const used = components.filter((c) => c.status === "used");
      const result = aggregate(used.map((c) => ({ rate: c.rate_8h, oiUsd: c.oi_usd })));
      if (result.avg === null) {
        log.warn(`${coin}: no venue has a fresh predicted rate`);
        continue;
      }
      snapshots.push({
        type: "snapshot",
        symbol: coin,
        coin: COIN_REGISTRY[coin].slug,
        timestamp: now,
        aggregated_predicted_funding_rate: result.avg,
        oi_weighted_predicted_funding_rate: result.oiWeighted,
        markets: result.count,
        unit: "percent_per_8h",
        components,
      });
    }
    if (snapshots.length === 0) throw new Error("no coin produced a value");
    log.info(
      snapshots
        .map((s) => `${s.symbol} avg=${s.aggregated_predicted_funding_rate.toFixed(4)}% (${s.markets}/${VENUES.length})`)
        .join(", "),
    );
    return snapshots;
  }

  private component(
    venue: Venue,
    symbol: string | null,
    rates: Map<string, { value: number; update: number }>,
    now: number,
  ): MarketComponent {
    const point = symbol === null ? undefined : rates.get(symbol);
    const value = point !== undefined && Number.isFinite(point.value) ? point.value : null;
    const status =
      symbol === null
        ? "unlisted"
        : value === null || point === undefined
          ? "no_rate"
          : now - point.update > STALE_AFTER_MS
            ? "stale"
            : "used";
    return {
      venue: venue.label,
      symbol,
      predicted_rate: value,
      rate_period_hours: venue.ratePeriodHours,
      rate_8h: value === null ? null : (value * 8) / venue.ratePeriodHours,
      oi_usd: symbol === null ? null : (this.oiBySymbol.get(symbol) ?? null),
      updated_at: point?.update ?? null,
      status,
    };
  }

  private async resolveVenues(): Promise<void> {
    if (this.marketsAt !== null && this.now() - this.marketsAt <= MARKET_REFRESH_MS) return;
    const perpetuals = (await this.client.futureMarkets()).filter(
      (m) => m.is_perpetual === true && m.margined === "STABLE",
    );
    const resolved = new Map<CoinSymbol, ResolvedVenue[]>();
    for (const coin of this.coins) {
      resolved.set(
        coin,
        VENUES.map((venue) => ({ venue, symbol: this.matchVenue(coin, venue, perpetuals) })),
      );
    }
    this.venuesByCoin = resolved;
    this.marketsAt = this.now();

    const n = [...resolved.values()].flat().filter((v) => v.symbol !== null).length;
    const callsPerMin = (n * 60000) / this.intervalMs + (n * 60000) / OI_REFRESH_MS;
    log.info(`resolved ${n} markets across ${this.coins.length} coin(s), ~${callsPerMin.toFixed(1)} API calls/min`);
    if (callsPerMin > API_CALLS_PER_MIN) {
      log.warn(
        `estimated ${callsPerMin.toFixed(1)} calls/min exceeds the ${API_CALLS_PER_MIN}/min API limit; cycles will be throttled`,
      );
    }
  }

  private matchVenue(coin: CoinSymbol, venue: Venue, perpetuals: FutureMarket[]): string | null {
    const matches = perpetuals.filter(
      (m) => m.base_asset === coin && m.exchange === venue.exchange && m.quote_asset === venue.quote,
    );
    if (matches.length === 1) return matches[0]!.symbol;
    if (matches.length > 1) {
      log.warn(`${coin} ${venue.label}: ${matches.length} matching perpetuals (${matches.map((m) => m.symbol).join(", ")}); skipped`);
    }
    return null;
  }

  private async refreshOpenInterest(symbols: string[]): Promise<void> {
    if (this.oiAt !== null && this.now() - this.oiAt <= OI_REFRESH_MS) return;
    const oi = new Map<string, number>();
    for (const p of await this.client.openInterestUsd(symbols)) oi.set(p.symbol, p.value);
    this.oiBySymbol = oi;
    this.oiAt = this.now();
  }
}
