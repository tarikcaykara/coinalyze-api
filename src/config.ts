import { COIN_REGISTRY, isCoinSymbol, type CoinSymbol } from "./coins.ts";
import { isSourceName, type SourceName } from "./types.ts";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface Config {
  mode: "loop" | "once";
  port: number;
  authToken: string | null;
  coinalyzeApiKey: string | null;
  sources: SourceName[];
  coins: CoinSymbol[];
  apiIntervalMs: number;
  chartIntervalMs: number;
  sessionRefreshMs: number;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  authTimeoutMs: number;
  dataFile: "./funding_rate.json";
}

type Env = Record<string, string | undefined>;

const positiveInt = (env: Env, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value <= 0) {
    throw new ConfigError(`Invalid ${name}: "${raw}"`);
  }
  return value;
};

// "".split(",") yields [""], so an empty list fails the membership check below.
const parseSources = (raw: string): SourceName[] => {
  const sources: SourceName[] = [];
  for (const value of new Set(raw.split(",").map((s) => s.trim().toLowerCase()))) {
    if (!isSourceName(value)) {
      throw new ConfigError(`Invalid SOURCES entry "${value}" (supported: api, chart)`);
    }
    sources.push(value);
  }
  return sources;
};

const parseCoins = (raw: string): CoinSymbol[] => {
  const coins: CoinSymbol[] = [];
  for (const value of new Set(raw.split(",").map((s) => s.trim().toUpperCase()))) {
    if (!isCoinSymbol(value)) {
      const supported = Object.keys(COIN_REGISTRY).join(", ");
      throw new ConfigError(`Invalid COINS entry "${value}" (supported: ${supported})`);
    }
    coins.push(value);
  }
  return coins;
};

export const loadConfig = (env: Env, argv: string[]): Config => {
  if (env.INTERVAL_MS !== undefined) {
    throw new ConfigError("INTERVAL_MS was replaced by API_INTERVAL_MS and CHART_INTERVAL_MS");
  }

  const mode = argv.includes("--once") ? "once" : "loop";
  const sources = parseSources(env.SOURCES ?? "api,chart");
  const coins = parseCoins(env.COINS ?? "BTC,ETH,SOL");

  const authToken = env.AUTH_TOKEN?.trim() || null;
  if (mode === "loop" && authToken === null) {
    throw new ConfigError("Missing required env var AUTH_TOKEN");
  }

  const coinalyzeApiKey = env.COINALYZE_API_KEY?.trim() || null;
  if (sources.includes("api") && coinalyzeApiKey === null) {
    throw new ConfigError(
      "Missing required env var COINALYZE_API_KEY (required when SOURCES includes api)",
    );
  }

  return {
    mode,
    port: positiveInt(env, "PORT", 3000),
    authToken,
    coinalyzeApiKey,
    sources,
    coins,
    apiIntervalMs: positiveInt(env, "API_INTERVAL_MS", 120000),
    chartIntervalMs: positiveInt(env, "CHART_INTERVAL_MS", 60000),
    sessionRefreshMs: positiveInt(env, "SESSION_REFRESH_MS", 3600000),
    pingIntervalMs: positiveInt(env, "PING_INTERVAL_MS", 30000),
    pongTimeoutMs: positiveInt(env, "PONG_TIMEOUT_MS", 65000),
    authTimeoutMs: positiveInt(env, "AUTH_TIMEOUT_MS", 10000),
    dataFile: "./funding_rate.json",
  };
};
