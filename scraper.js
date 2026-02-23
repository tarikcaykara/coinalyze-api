import { chromium } from "playwright";

const CONFIG = {
  url: "https://coinalyze.net/ethereum/funding-rate/",
  outputFile: "./funding_rate.json",
  coin: "ethereum",
  timeframe: "1 minute",
  cloudflareTimeout: 120000,
  iframeTimeout: 30000,
};

const isCloudflareBlocked = async (page) => {
  return page.evaluate(() => {
    const title = (document.title || "").toLowerCase();
    const text = (document.body?.innerText || "").toLowerCase();
    return (
      title.includes("attention required") ||
      text.includes("you have been blocked") ||
      text.includes("cf-browser-verification")
    );
  });
};

const waitUntilUnblocked = async (page, timeoutMs = CONFIG.cloudflareTimeout) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isCloudflareBlocked(page))) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
};

const waitForBlobFrame = async (page, timeoutMs = CONFIG.iframeTimeout) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const blobFrame = page
      .frames()
      .find((f) => f.url().startsWith(`blob:${new URL(CONFIG.url).origin}`));
    if (blobFrame) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
};

const readLegendValue = async (frame) => {
  return frame.evaluate(() => {
    const text = document.body?.innerText || "";
    const match = text.match(
      /Predicted Funding Rate[\s\S]*?AVG close 10\s+([\u2212\-\d.]+)/i,
    );
    if (!match) return null;
    const raw = match[1].replace(/\u2212/g, "-");
    return parseFloat(raw);
  });
};

const scrapeAggregatedFundingRate = async () => {
  console.log("scraping started");

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  let hasError = false;

  try {
    await page.goto(CONFIG.url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page
      .waitForLoadState("networkidle", { timeout: 20000 })
      .catch(() => {});

    if (await isCloudflareBlocked(page)) {
      console.log("cloudflare challenge detected, waiting...");
      const passed = await waitUntilUnblocked(page);
      if (!passed) throw new Error("cloudflare challenge timeout");
    }

    const hasBlobFrame = await waitForBlobFrame(page);
    if (!hasBlobFrame) throw new Error("chart iframe not loaded within 30s");
    await page.waitForTimeout(5000);

    const frames = page.frames();
    const origin = new URL(CONFIG.url).origin;
    const relevantFrames = frames.filter((f) => {
      const url = f.url();
      return url.startsWith(`blob:${origin}`) || url.includes(CONFIG.url);
    });
    console.log(
      `frames: ${frames.length} total, ${relevantFrames.length} relevant`,
    );

    let clickCount = 0;

    for (const frame of relevantFrames) {
      try {
        const btn = frame.locator('button[aria-label="1 minute"]').first();
        const count = await btn.count();
        console.log(
          `frame ${frame.url().substring(0, 50)}: 1m button count = ${count}`,
        );
        if (count === 0) {
          const fallback = frame.locator('button:has-text("1m")').first();
          const fbCount = await fallback.count();
          console.log(`  fallback "1m" text count = ${fbCount}`);
          if (fbCount === 0) continue;
          await fallback.waitFor({ state: "visible", timeout: 10000 });
          await fallback.click({ timeout: 3000 });
          clickCount++;
          console.log(
            `clicked 1m (fallback) in frame: ${frame.url().substring(0, 60)}`,
          );
          continue;
        }
        await btn.waitFor({ state: "visible", timeout: 10000 });
        await btn.click({ timeout: 3000 });
        clickCount++;
        console.log(`clicked 1m in frame: ${frame.url().substring(0, 60)}`);
      } catch {
        continue;
      }
    }

    console.log(`clicked ${CONFIG.timeframe} buttons total: ${clickCount}`);

    if (clickCount === 0) {
      throw new Error(`could not click any ${CONFIG.timeframe} timeframe button`);
    }

    await page.waitForTimeout(10000);

    let predictedValue = null;

    for (const frame of relevantFrames) {
      try {
        const value = await readLegendValue(frame);
        if (value !== null) {
          console.log(
            `found value ${value} in frame: ${frame.url().substring(0, 60)}`,
          );
          predictedValue = value;
        }
      } catch {
        continue;
      }
    }

    if (predictedValue === null) {
      console.log("regex failed, trying full text dump...");
      for (const frame of relevantFrames) {
        try {
          const text = await frame.evaluate(
            () => document.body?.innerText || "",
          );
          if (text.toLowerCase().includes("predicted")) {
            console.log(
              `--- frame text (${frame.url().substring(0, 60)}) ---`,
            );
            console.log(text.substring(0, 2000));
            console.log("---");
          }
        } catch {
          continue;
        }
      }
      throw new Error("could not read predicted funding rate from chart");
    }

    console.log(`aggregated predicted funding rate avg close 10: ${predictedValue}`);

    const result = {
      aggregated_predicted_funding_rate: predictedValue,
      coin: CONFIG.coin,
      timestamp: Date.now(),
    };

    await Bun.write(CONFIG.outputFile, JSON.stringify(result, null, 2));
    console.log(`saved to ${CONFIG.outputFile}`);
  } catch (error) {
    console.error(`scraping error: ${error.message}`);
    hasError = true;
  } finally {
    await browser.close();
  }

  if (hasError) process.exit(1);
};

scrapeAggregatedFundingRate();
