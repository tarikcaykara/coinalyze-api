/** Multiplier from the API's predicted-funding-rate unit to percent. */
export const API_VALUE_TO_PERCENT = 1;

/** Exchange code → multiplier to reach an 8h rate. Unlisted exchanges already report per 8h. */
export const FUNDING_NORMALIZATION: Record<string, number> = {};

/** Which perpetual markets enter the aggregate: all, or stablecoin-margined only. */
export const MARKET_SCOPE: "all" | "stable" = "all";

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
