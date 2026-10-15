import type { Frame, Page } from "playwright";
import { chartUrl, type CoinSymbol } from "../../src/coins.ts";
import { createLogger } from "../../src/log.ts";
import type { BrowserLike } from "./browser.ts";
import { classifyCloudflare, parseLegendValue, parsePercent, type CloudflareState } from "./parse.ts";

const log = createLogger("chart");

// TradingView renders the chart into a blob: iframe that can only be reached via page.frames().
const BLOB_PREFIX = "blob:https://coinalyze.net";
const CLOUDFLARE_TIMEOUT_MS = 120000;
const IFRAME_TIMEOUT_MS = 30000;
const POLL_MS = 2000;

const isChartFrame = (f: Frame) => f.url().startsWith(BLOB_PREFIX);

/** One stablecoin-margined box of the page's "Current / Predicted" table, % per 8h. */
export interface PageVenue {
  label: string;
  current: number | null;
  predicted: number | null;
}

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
    // A reload can reset the chart to its default timeframe (1 hour).
    await this.selectOneMinute(page);
    await page.waitForTimeout(10000);
  }

  async read(): Promise<number> {
    const page = this.page;
    if (page !== null) {
      const frames = [...page.frames().filter(isChartFrame), page.mainFrame()];
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

  /** The stablecoin-margined "Current / Predicted" boxes on the page (coin-margined boxes carry `.coin-m`). */
  async readVenueTable(): Promise<PageVenue[]> {
    if (this.page === null) throw new Error("page not loaded");
    const boxes = await this.page.evaluate(() =>
      [...document.querySelectorAll("table.funding-rates div.box:not(.coin-m):not(.fr-type)")].map((box) => ({
        label: (box.querySelector(".box-title") as HTMLElement | null)?.innerText ?? "",
        rows: [...box.querySelectorAll(".box-row")].map((row) => (row as HTMLElement).innerText),
      })),
    );
    return boxes.map((b) => ({
      label: b.label.replace(/\s+/g, " ").trim().toUpperCase(),
      current: parsePercent(b.rows[0] ?? ""),
      predicted: parsePercent(b.rows[1] ?? ""),
    }));
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
    while (!page.frames().some(isChartFrame)) {
      if (Date.now() >= deadline) {
        throw new Error(`chart iframe not loaded within ${IFRAME_TIMEOUT_MS / 1000}s`);
      }
      await page.waitForTimeout(POLL_MS);
    }
  }

  /**
   * The interval toolbar is a single dropdown whose trigger is labelled with the current interval.
   * Open it and pick the "1 minute" item (data-value="1"; never "1M" = month or "15").
   */
  private async selectOneMinute(page: Page): Promise<void> {
    const frames = page
      .frames()
      .filter((f) => isChartFrame(f) || f.url().includes(this.url));
    let selected = 0;
    for (const frame of frames) {
      try {
        const trigger = frame.locator("#header-toolbar-intervals button").filter({ visible: true }).first();
        if ((await trigger.count()) === 0) continue;
        if ((await trigger.getAttribute("aria-label")) !== "1 minute") {
          await trigger.click({ timeout: 3000 });
          const item = frame
            .locator('[data-value="1"]')
            .filter({ visible: true, hasText: /^\s*1 minute\s*$/ })
            .first();
          await item.waitFor({ state: "visible", timeout: 10000 });
          await item.click({ timeout: 3000 });
          await frame.waitForFunction(
            () =>
              [...document.querySelectorAll("#header-toolbar-intervals button")].some(
                (b) => (b as HTMLElement).offsetParent !== null && b.getAttribute("aria-label") === "1 minute",
              ),
            undefined,
            { timeout: 10000 },
          );
        }
        selected++;
      } catch {
        // Frame detached or dropdown not interactable; try the next frame.
      }
    }
    if (selected === 0) throw new Error("could not select 1 minute timeframe");
    log.info(`${this.symbol}: 1 minute timeframe selected in ${selected} frame(s)`);
  }
}
