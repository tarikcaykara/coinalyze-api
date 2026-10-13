import { expect, test } from "bun:test";
import { BrowserManager, type BrowserLike } from "../src/sources/chart/browser.ts";
import { ChartSource } from "../src/sources/chart/source.ts";

// A browser whose pages can never be opened, as after Chromium was killed.
const deadBrowserManager = () => {
  let launches = 0;
  const manager = new BrowserManager({
    launch: async (): Promise<BrowserLike> => {
      launches++;
      return {
        newPage: async () => {
          throw new Error("Target page, context or browser has been closed");
        },
        close: async () => {},
        isConnected: () => true,
      };
    },
  });
  return { manager, launches: () => launches };
};

test("when every coin fails, the browser is restarted for the next cycle", async () => {
  const { manager, launches } = deadBrowserManager();
  const source = new ChartSource({ coins: ["BTC", "ETH"], intervalMs: 60000, sessionRefreshMs: 3600000, manager });
  await expect(source.poll()).rejects.toThrow("chart: all coins failed");
  expect(launches()).toBe(2);
});

test("after shutdown starts, a failing poll does not relaunch Chromium", async () => {
  const { manager, launches } = deadBrowserManager();
  const controller = new AbortController();
  const source = new ChartSource({
    coins: ["BTC", "ETH"],
    intervalMs: 60000,
    sessionRefreshMs: 3600000,
    manager,
    signal: controller.signal,
  });
  controller.abort();
  await expect(source.poll()).rejects.toThrow("chart: all coins failed");
  expect(launches()).toBe(1);
});
