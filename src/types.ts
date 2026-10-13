import type { CoinSymbol } from "./coins.ts";

export type SourceName = "api" | "chart";

export const isSourceName = (value: unknown): value is SourceName =>
  value === "api" || value === "chart";

export interface Snapshot {
  type: "snapshot";
  source: SourceName;
  symbol: CoinSymbol;
  /** Coinalyze slug ("ethereum"); kept from the v1 payload. */
  coin: string;
  timestamp: number;
  aggregated_predicted_funding_rate: number;
  oi_weighted_predicted_funding_rate: number | null;
  markets: number | null;
  unit: "percent_per_8h";
}

export interface Source {
  readonly name: SourceName;
  readonly intervalMs: number;
  /** Returns snapshots of the coins that succeeded; throws only when zero coins succeeded. */
  poll(): Promise<Snapshot[]>;
  close(): Promise<void>;
}

export interface SourceStatus {
  name: SourceName;
  intervalMs: number;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
}
