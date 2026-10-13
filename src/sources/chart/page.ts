import type { Frame, Page } from "playwright";
import { chartUrl, type CoinSymbol } from "../../coins.ts";
import { createLogger } from "../../log.ts";
import type { BrowserLike } from "./browser.ts";
import { classifyCloudflare, parseLegendValue, type CloudflareState } from "./parse.ts";

const log = createLogger("chart");

// TradingView renders the chart into a blob: iframe that can only be reached via page.frames().
const BLOB_PREFIX = "blob:https://coinalyze.net";
const CLOUDFLARE_TIMEOUT_MS = 120000;
const IFRAME_TIMEOUT_MS = 30000;
const POLL_MS = 2000;

/** One Coinalyze funding-rate page for one coin, kept on the 1-minute timeframe. */
export class ChartPage {
  readonly symbol: CoinSymbol;
  private readonly url: string;
  private readonly sessionRefreshMs: number;
  private page: Page | null = null;
  private lastFullLoadAt = 0;

  constructor(symbol: CoinSymbol, sessionRefreshMs: number) {
    this.symbol = symbol;
    this.url = chartUrl(symbol);
    this.sessionRefreshMs = sessionRefreshMs;
  }

  async fullLoad(browser: BrowserLike): Promise<void> {
    await this.invalidate();
    const page = await browser.newPage();
    this.page = page;
    await page.goto(this.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await this.passCloudflare(page);
    await this.waitForBlobFrame(page);
    await page.waitForTimeout(5000);
    await this.selectOneMinute(page);
    await page.waitForTimeout(10000);
    this.lastFullLoadAt = Date.now();
  }

  /** Reloads in place, or does a full load when there is no page or the session is older than SESSION_REFRESH_MS. */
  async refresh(browser: BrowserLike): Promise<void> {
    const page = this.page;
    if (page === null || page.isClosed() || Date.now() - this.lastFullLoadAt > this.sessionRefreshMs) {
      await this.fullLoad(browser);
      return;
    }
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await this.passCloudflare(page);
    await this.waitForBlobFrame(page);
    await page.waitForTimeout(3000);
    // A reload resets the chart to its default timeframe.
    await this.selectOneMinute(page);
    await page.waitForTimeout(10000);
  }

  async read(): Promise<number> {
    const page = this.page;
    if (page !== null) {
      const frames = [...page.frames().filter((f) => f.url().startsWith(BLOB_PREFIX)), page.mainFrame()];
      for (const frame of frames) {
        try {
          const value = parseLegendValue(await frame.evaluate(() => document.body?.innerText ?? ""));
          if (value !== null) return value;
        } catch {
          // Frame detached mid-read; try the next one.
        }
      }
    }
    throw new Error("legend value not found");
  }

  async invalidate(): Promise<void> {
    const page = this.page;
    this.page = null;
    await page?.close().catch(() => {});
  }

  private async passCloudflare(page: Page): Promise<void> {
    const deadline = Date.now() + CLOUDFLARE_TIMEOUT_MS;
    let warned = false;
    for (;;) {
      let state: CloudflareState;
      try {
        const [title, text] = await page.evaluate(() => [document.title, document.body?.innerText ?? ""]);
        state = classifyCloudflare(title ?? "", text ?? "");
      } catch {
        // The challenge navigates the page when it resolves, destroying the execution context.
        state = "challenge";
      }
      if (state === "none") return;
      if (state === "blocked") throw new Error("cloudflare blocked");
      if (!warned) {
        log.warn(`${this.symbol}: cloudflare challenge detected, waiting up to ${CLOUDFLARE_TIMEOUT_MS / 1000}s`);
        warned = true;
      }
      if (Date.now() >= deadline) throw new Error("cloudflare challenge timeout");
      await page.waitForTimeout(POLL_MS);
    }
  }

  private async waitForBlobFrame(page: Page): Promise<void> {
    const deadline = Date.now() + IFRAME_TIMEOUT_MS;
    while (!page.frames().some((f) => f.url().startsWith(BLOB_PREFIX))) {
      if (Date.now() >= deadline) {
        throw new Error(`chart iframe not loaded within ${IFRAME_TIMEOUT_MS / 1000}s`);
      }
      await page.waitForTimeout(POLL_MS);
    }
  }

  private async selectOneMinute(page: Page): Promise<void> {
    const frames = page
      .frames()
      .filter((f: Frame) => f.url().startsWith(BLOB_PREFIX) || f.url().includes(this.url));
    let clicked = 0;
    for (const frame of frames) {
      try {
        let button = frame.locator('button[aria-label="1 minute"]').first();
        if ((await button.count()) === 0) {
          // Exact, case-sensitive: must not match "1M" (month) or "15m".
          button = frame.locator("button", { hasText: /^\s*1m\s*$/ }).first();
          if ((await button.count()) === 0) continue;
        }
        await button.waitFor({ state: "visible", timeout: 10000 });
        await button.click({ timeout: 3000 });
        clicked++;
      } catch {
        // Frame detached or button not interactable; try the next frame.
      }
    }
    if (clicked === 0) throw new Error("could not select 1 minute timeframe");
    log.info(`${this.symbol}: selected 1 minute timeframe in ${clicked} frame(s)`);
  }
}
