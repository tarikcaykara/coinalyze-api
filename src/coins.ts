export const COIN_REGISTRY = {
  BTC: { slug: "bitcoin" },
  ETH: { slug: "ethereum" },
  SOL: { slug: "solana" },
} as const;

export type CoinSymbol = keyof typeof COIN_REGISTRY;

export const isCoinSymbol = (value: string): value is CoinSymbol =>
  Object.hasOwn(COIN_REGISTRY, value);

export const chartUrl = (s: CoinSymbol) =>
  `https://coinalyze.net/${COIN_REGISTRY[s].slug}/funding-rate/`;
