import { COIN_REGISTRY, type CoinSymbol } from "../../coins.ts";
import { createLogger, errorMessage } from "../../log.ts";
import type { Snapshot, Source } from "../../types.ts";
import { BrowserManager } from "./browser.ts";
import { ChartPage } from "./page.ts";

const log = createLogger("chart");

/**
 * Recovery tiers per cycle: reload → full load (per coin) → browser restart (all coins failed).
 * The loop retries the next cycle either way.
 */
export class ChartSource implements Source {
  readonly name = "chart";
  readonly intervalMs: number;
  private readonly manager: BrowserManager;
  private readonly pages: ChartPage[];

  constructor(opts: {
    coins: CoinSymbol[];
    intervalMs: number;
    sessionRefreshMs: number;
    manager?: BrowserManager;
  }) {
    this.intervalMs = opts.intervalMs;
    this.manager = opts.manager ?? new BrowserManager();
    this.pages = opts.coins.map((symbol) => new ChartPage(symbol, opts.sessionRefreshMs));
  }

  async poll(): Promise<Snapshot[]> {
    const browser = await this.manager.get();
    const results = await Promise.allSettled(
      this.pages.map(async (p) => {
        try {
          await p.refresh(browser);
          return await p.read();
        } catch (e) {
          log.warn(`${p.symbol}: ${errorMessage(e)}; retrying with a full load`);
          await p.fullLoad(browser);
          return await p.read();
        }
      }),
    );

    const snapshots: Snapshot[] = [];
    for (const [i, result] of results.entries()) {
      const p = this.pages[i]!;
      if (result.status === "rejected") {
        log.error(`${p.symbol}: ${errorMessage(result.reason)}`);
        await p.invalidate();
        continue;
      }
      snapshots.push({
        type: "snapshot",
        source: "chart",
        symbol: p.symbol,
        coin: COIN_REGISTRY[p.symbol].slug,
        timestamp: Date.now(),
        aggregated_predicted_funding_rate: result.value,
        oi_weighted_predicted_funding_rate: null,
        markets: null,
        unit: "percent_per_8h",
      });
    }

    if (snapshots.length === 0) {
      log.warn("all coins failed; restarting the browser");
      await this.manager.restart();
      throw new Error("chart: all coins failed");
    }
    log.info(
      snapshots.map((s) => `${s.symbol}=${s.aggregated_predicted_funding_rate}%`).join(", "),
    );
    return snapshots;
  }

  async close(): Promise<void> {
    await Promise.all(this.pages.map((p) => p.invalidate()));
    await this.manager.close();
  }
}
