import type { Browser } from "playwright";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// Load-bearing: headless Chromium is challenged by Cloudflare without the stealth plugin.
chromium.use(StealthPlugin());

export type BrowserLike = Pick<Browser, "newPage" | "close" | "isConnected">;

/** Owns exactly one Chromium instance; every launch is tracked so none can leak. */
export class BrowserManager {
  private readonly launch: () => Promise<BrowserLike>;
  private browser: BrowserLike | null = null;

  constructor(opts: { launch?: () => Promise<BrowserLike> } = {}) {
    this.launch = opts.launch ?? (() => chromium.launch({ headless: true }));
  }

  async get(): Promise<BrowserLike> {
    if (this.browser === null || !this.browser.isConnected()) {
      await this.close();
      this.browser = await this.launch();
    }
    return this.browser;
  }

  async restart(): Promise<BrowserLike> {
    await this.close();
    this.browser = await this.launch();
    return this.browser;
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => {});
  }
}
