import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const base = { AUTH_TOKEN: "secret", COINALYZE_API_KEY: "key" };

describe("loadConfig", () => {
  test("requires COINALYZE_API_KEY in both modes", () => {
    expect(() => loadConfig({ AUTH_TOKEN: "secret" }, [])).toThrow("Missing required env var COINALYZE_API_KEY");
    expect(() => loadConfig({}, ["--once"])).toThrow("Missing required env var COINALYZE_API_KEY");
  });

  test("requires AUTH_TOKEN in loop mode only", () => {
    expect(() => loadConfig({ COINALYZE_API_KEY: "key", AUTH_TOKEN: "  " }, [])).toThrow(
      "Missing required env var AUTH_TOKEN",
    );
    expect(loadConfig({ COINALYZE_API_KEY: "key" }, ["--once"]).mode).toBe("once");
  });

  test("COINS is trimmed, uppercased, deduplicated and order-preserving", () => {
    expect(loadConfig({ ...base, COINS: "eth, btc,ETH" }, []).coins).toEqual(["ETH", "BTC"]);
  });

  test("rejects unknown and empty coin lists", () => {
    expect(() => loadConfig({ ...base, COINS: "DOGE" }, [])).toThrow(
      'Invalid COINS entry "DOGE" (supported: BTC, ETH, SOL)',
    );
    expect(() => loadConfig({ ...base, COINS: "" }, [])).toThrow('Invalid COINS entry ""');
  });

  test.each(["abc", "0", "1.5", "-5"])("rejects INTERVAL_MS=%p", (raw) => {
    expect(() => loadConfig({ ...base, INTERVAL_MS: raw }, [])).toThrow(`Invalid INTERVAL_MS: "${raw}"`);
  });
});
