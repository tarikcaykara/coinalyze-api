import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const CONFIG = {
  url: "https://coinalyze.net/ethereum/funding-rate/",
  outputFile: "./funding_rate.json",
  coin: "ethereum",
  timeframe: "1 minute",
  cloudflareTimeout: 120000,
  iframeTimeout: 30000,
  intervalMs: parseInt(process.env.INTERVAL_MS || "60000"),
  sessionRefreshMs: parseInt(process.env.SESSION_REFRESH_MS || "3600000"),
  port: parseInt(process.env.PORT || "3000"),
  authToken: process.env.AUTH_TOKEN || "coinalyze-secret-2025",
  pingIntervalMs: parseInt(process.env.PING_INTERVAL_MS || "30000"),
  pongTimeoutMs: parseInt(process.env.PONG_TIMEOUT_MS || "65000"),
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

const loadPage = async (page) => {
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
};

const clickTimeframe = async (relevantFrames) => {
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
};

const getRelevantFrames = (page) => {
  const frames = page.frames();
  const origin = new URL(CONFIG.url).origin;
  const relevantFrames = frames.filter((f) => {
    const url = f.url();
    return url.startsWith(`blob:${origin}`) || url.includes(CONFIG.url);
  });
  console.log(
    `frames: ${frames.length} total, ${relevantFrames.length} relevant`,
  );
  return relevantFrames;
};

const readAndSave = async (relevantFrames, { server, setLastData } = {}) => {
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

  const json = JSON.stringify(result, null, 2);
  await Bun.write(CONFIG.outputFile, json);
  console.log(`saved to ${CONFIG.outputFile}`);

  if (server) {
    server.publish("funding-rate", json);
    if (setLastData) setLastData(json);
    console.log("broadcast to websocket clients");
  }
};

const scrapeOnce = async () => {
  console.log("scraping started");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await loadPage(page);
    const relevantFrames = getRelevantFrames(page);
    await clickTimeframe(relevantFrames);
    await page.waitForTimeout(10000);
    await readAndSave(relevantFrames);
  } catch (error) {
    console.error(`scraping error: ${error.message}`);
    await browser.close();
    process.exit(1);
  }

  await browser.close();
};

const createWebSocketServer = () => {
  const clients = new Map();
  let lastData = null;

  const server = Bun.serve({
    port: CONFIG.port,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req);
        if (!upgraded) return new Response("Upgrade failed", { status: 400 });
        return;
      }
      return new Response(Bun.file("./test.html"), {
        headers: { "Content-Type": "text/html" },
      });
    },
    websocket: {
      open(ws) {
        clients.set(ws, { authenticated: false, lastPong: Date.now() });
        console.log("ws: client connected, awaiting auth");
      },
      message(ws, message) {
        try {
          const data = JSON.parse(message);

          if (data.type === "pong") {
            const client = clients.get(ws);
            if (client) client.lastPong = Date.now();
            return;
          }

          if (data.type === "auth") {
            if (data.token === CONFIG.authToken) {
              const client = clients.get(ws);
              if (client) client.authenticated = true;
              ws.subscribe("funding-rate");
              ws.send(JSON.stringify({ type: "auth", status: "ok" }));
              if (lastData) ws.send(lastData);
              console.log("ws: client authenticated");
            } else {
              ws.send(
                JSON.stringify({
                  type: "auth",
                  status: "error",
                  message: "invalid token",
                }),
              );
              ws.close(4001, "invalid token");
              console.log("ws: client rejected (bad token)");
            }
          }
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "invalid json" }));
        }
      },
      close(ws) {
        clients.delete(ws);
        console.log("ws: client disconnected");
      },
    },
  });

  const pingMsg = JSON.stringify({ type: "ping" });

  setInterval(() => {
    const now = Date.now();
    for (const [ws, client] of clients) {
      if (now - client.lastPong > CONFIG.pongTimeoutMs) {
        console.log("ws: closing stale connection (pong timeout)");
        ws.close(4002, "pong timeout");
        continue;
      }
      if (client.authenticated) {
        ws.send(pingMsg);
      }
    }
  }, CONFIG.pingIntervalMs);

  console.log(`websocket server listening on ws://localhost:${CONFIG.port}/ws`);
  return { server, setLastData: (data) => { lastData = data; } };
};

const runLoop = async () => {
  console.log(`scraper loop started, interval: ${CONFIG.intervalMs / 1000}s`);

  const wsCtx = createWebSocketServer();
  const browser = await chromium.launch({ headless: true });
  let page = await browser.newPage();
  let lastFullLoad = 0;

  const fullLoad = async () => {
    await loadPage(page);
    const frames = getRelevantFrames(page);
    await clickTimeframe(frames);
    await page.waitForTimeout(10000);
    lastFullLoad = Date.now();
    return frames;
  };

  try {
    let relevantFrames = await fullLoad();
    await readAndSave(relevantFrames, wsCtx);

    while (true) {
      console.log(
        `next reload at ${new Date(Date.now() + CONFIG.intervalMs).toLocaleTimeString()}`,
      );
      await new Promise((r) => setTimeout(r, CONFIG.intervalMs));

      try {
        const needsFullLoad =
          Date.now() - lastFullLoad > CONFIG.sessionRefreshMs;

        if (needsFullLoad) {
          console.log("session refresh: full page load");
          relevantFrames = await fullLoad();
        } else {
          await page.reload({
            waitUntil: "domcontentloaded",
            timeout: 60000,
          });

          if (await isCloudflareBlocked(page)) {
            console.log("cloudflare re-challenge after reload, waiting...");
            const passed = await waitUntilUnblocked(page);
            if (!passed) {
              console.log("cloudflare timeout, attempting full reload...");
              relevantFrames = await fullLoad();
              await readAndSave(relevantFrames, wsCtx);
              continue;
            }
          }

          await waitForBlobFrame(page);
          await page.waitForTimeout(3000);
          relevantFrames = getRelevantFrames(page);
        }

        await readAndSave(relevantFrames, wsCtx);
      } catch (error) {
        console.error(`cycle error: ${error.message}, will retry next cycle`);

        try {
          console.log("attempting recovery with full page load...");
          relevantFrames = await fullLoad();
        } catch (recoveryError) {
          console.error(`recovery failed: ${recoveryError.message}`);
          console.log("reopening browser...");
          await browser.close().catch(() => {});
          const newBrowser = await chromium.launch({ headless: true });
          page = await newBrowser.newPage();
          try {
            relevantFrames = await fullLoad();
          } catch (fatalError) {
            console.error(`fatal: ${fatalError.message}, will retry next cycle`);
          }
        }
      }
    }
  } catch (error) {
    console.error(`fatal error: ${error.message}`);
  } finally {
    await browser.close().catch(() => {});
  }
};

const isLoop = process.argv.includes("--loop");

if (isLoop) {
  runLoop();
} else {
  scrapeOnce();
}
