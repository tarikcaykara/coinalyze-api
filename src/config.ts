import { COIN_REGISTRY, isCoinSymbol, type CoinSymbol } from "./coins.ts";

export class ConfigError extends Error {
  override name = "ConfigError";
}

interface BaseConfig {
  coinalyzeApiKey: string;
  coins: CoinSymbol[];
  intervalMs: number;
  dataFile: string;
}

export interface OnceConfig extends BaseConfig {
  mode: "once";
}

export interface LoopConfig extends BaseConfig {
  mode: "loop";
  port: number;
  authToken: string;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  authTimeoutMs: number;
}

export type Config = OnceConfig | LoopConfig;

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

const required = (env: Env, name: string, why = ""): string => {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`Missing required env var ${name}${why}`);
  return value;
};

// "".split(",") yields [""], so an empty list fails the membership check below.
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
  const base: BaseConfig = {
    coinalyzeApiKey: required(env, "COINALYZE_API_KEY"),
    coins: parseCoins(env.COINS ?? "BTC,ETH,SOL"),
    intervalMs: positiveInt(env, "INTERVAL_MS", 60000),
    dataFile: env.DATA_FILE?.trim() || "./funding_rate.json",
  };
  if (argv.includes("--once")) return { ...base, mode: "once" };
  return {
    ...base,
    mode: "loop",
    port: positiveInt(env, "PORT", 3000),
    authToken: required(env, "AUTH_TOKEN", " (required in loop mode)"),
    pingIntervalMs: positiveInt(env, "PING_INTERVAL_MS", 30000),
    pongTimeoutMs: positiveInt(env, "PONG_TIMEOUT_MS", 65000),
    authTimeoutMs: positiveInt(env, "AUTH_TIMEOUT_MS", 10000),
  };
};
