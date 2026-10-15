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
