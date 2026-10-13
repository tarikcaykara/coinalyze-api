import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const base = { AUTH_TOKEN: "secret", COINALYZE_API_KEY: "key" };

describe("loadConfig", () => {
  test("requires AUTH_TOKEN in loop mode", () => {
    expect(() => loadConfig({ COINALYZE_API_KEY: "key" }, [])).toThrow(
      "Missing required env var AUTH_TOKEN",
    );
  });

  test("once mode does not need AUTH_TOKEN", () => {
    const config = loadConfig({ COINALYZE_API_KEY: "key" }, ["--once"]);
    expect(config.mode).toBe("once");
    expect(config.authToken).toBeNull();
  });

  test("SOURCES=api requires COINALYZE_API_KEY", () => {
    expect(() => loadConfig({ AUTH_TOKEN: "secret", SOURCES: "api" }, [])).toThrow(
      "Missing required env var COINALYZE_API_KEY",
    );
  });

  test("SOURCES=chart works without COINALYZE_API_KEY", () => {
    const config = loadConfig({ AUTH_TOKEN: "secret", SOURCES: "chart" }, []);
    expect(config.sources).toEqual(["chart"]);
    expect(config.coinalyzeApiKey).toBeNull();
  });

  test("COINS is trimmed, uppercased and order-preserving", () => {
    expect(loadConfig({ ...base, COINS: "eth, btc" }, []).coins).toEqual(["ETH", "BTC"]);
  });

  test("rejects unknown coins", () => {
    expect(() => loadConfig({ ...base, COINS: "DOGE" }, [])).toThrow(
      'Invalid COINS entry "DOGE" (supported: BTC, ETH, SOL)',
    );
  });

  test("rejects unknown and empty sources", () => {
    expect(() => loadConfig({ ...base, SOURCES: "api,rest" }, [])).toThrow(
      'Invalid SOURCES entry "rest"',
    );
    expect(() => loadConfig({ ...base, SOURCES: "" }, [])).toThrow('Invalid SOURCES entry ""');
  });

  test.each(["abc", "0", "1.5", "-5"])("rejects API_INTERVAL_MS=%p", (raw) => {
    expect(() => loadConfig({ ...base, API_INTERVAL_MS: raw }, [])).toThrow(
      `Invalid API_INTERVAL_MS: "${raw}"`,
    );
  });

  test("rejects the removed v1 INTERVAL_MS", () => {
    expect(() => loadConfig({ ...base, INTERVAL_MS: "60000" }, [])).toThrow(
      "INTERVAL_MS was replaced by API_INTERVAL_MS and CHART_INTERVAL_MS",
    );
  });
});
