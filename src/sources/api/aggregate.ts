/*
 * Calibration (2026-10-13, ETH, 10 samples 60s apart; page = coinalyze.net/ethereum/funding-rate/):
 * - Units: page% / API value for Binance ETHUSDT_PERP.A, median 0.999 (0.996-1.006) → API values are already percent.
 *   Binance USDC/coin-margined, Bybit (all 3) and WOO X: 0.991-1.010 → per-8h already.
 * - 8h normalization: Hyperliquid (H) 8.000 in 10/10 samples; Kraken (K) median 8.02 (samples where page and
 *   API had refreshed together: 0.0098 vs 0.00977, 0.0112 vs 0.01117) → both report hourly rates.
 *   Exchanges absent from the page (Lighter, Polymarket, dYdX, Aster, Bitfinex, Gate.io, Phemex, Coinbase) are unmeasured.
 * - Scope: mean |AVG − chart "AVG close 10"| = 0.00122 pp for all perps (21 with a value) vs 0.00079 pp for
 *   stablecoin-margined perps (18) → "stable". Mean chart value 0.00713%. Re-run if Coinalyze changes units or listings.
 */

/** Multiplier from the API's predicted-funding-rate unit to percent. */
export const API_VALUE_TO_PERCENT = 1;

/** Exchange code → multiplier to reach an 8h rate. Unlisted exchanges already report per 8h. */
export const FUNDING_NORMALIZATION: Record<string, number> = {
  H: 8, // Hyperliquid, hourly
  K: 8, // Kraken, hourly
};

/** Which perpetual markets enter the aggregate: all, or stablecoin-margined only. */
export const MARKET_SCOPE: "all" | "stable" = "stable";

export const toPercent8h = (value: number, exchange: string): number =>
  value * API_VALUE_TO_PERCENT * (FUNDING_NORMALIZATION[exchange] ?? 1);

export interface AggregateEntry {
  rate: number | null;
  oiUsd: number | null;
}

export interface AggregateResult {
  avg: number | null;
  oiWeighted: number | null;
  count: number;
}

/**
 * avg = mean of finite rates.
 * oiWeighted = Σ(rate·oi) / Σoi over entries with a finite rate and a finite oi > 0.
 */
export const aggregate = (entries: AggregateEntry[]): AggregateResult => {
  let count = 0;
  let sum = 0;
  let weightedSum = 0;
  let oiSum = 0;
  for (const { rate, oiUsd } of entries) {
    if (rate === null || !Number.isFinite(rate)) continue;
    count++;
    sum += rate;
    if (oiUsd !== null && Number.isFinite(oiUsd) && oiUsd > 0) {
      weightedSum += rate * oiUsd;
      oiSum += oiUsd;
    }
  }
  return {
    avg: count > 0 ? sum / count : null,
    oiWeighted: oiSum > 0 ? weightedSum / oiSum : null,
    count,
  };
};
