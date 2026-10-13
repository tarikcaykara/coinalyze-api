import dashboard from "../web/index.html";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { computeHealth } from "./health.ts";
import { createLogger, errorMessage } from "./log.ts";
import { runSourceLoop } from "./loop.ts";
import { createServer } from "./server.ts";
import { CoinalyzeClient } from "./sources/api/client.ts";
import { RateLimiter } from "./sources/api/rate-limiter.ts";
import { ApiSource } from "./sources/api/source.ts";
import { SnapshotStore } from "./store.ts";
import type { Snapshot, Source, SourceStatus } from "./types.ts";

const log = createLogger("main");

let config: Config;
try {
  config = loadConfig(process.env, process.argv);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(e.message);
  process.exit(1);
}

const store = new SnapshotStore({ file: config.dataFile, historyLimit: 720 });

const sources: Source[] = [];
if (config.sources.includes("api")) {
  sources.push(
    new ApiSource({
      // loadConfig guarantees the key whenever the api source is enabled.
      client: new CoinalyzeClient({ apiKey: config.coinalyzeApiKey!, limiter: new RateLimiter() }),
      coins: config.coins,
      intervalMs: config.apiIntervalMs,
    }),
  );
}
if (config.sources.includes("chart")) {
  // Dynamic on purpose: SOURCES=api must run without Playwright/Chromium installed.
  const { ChartSource } = await import("./sources/chart/source.ts");
  sources.push(
    new ChartSource({
      coins: config.coins,
      intervalMs: config.chartIntervalMs,
      sessionRefreshMs: config.sessionRefreshMs,
    }),
  );
}

if (config.mode === "once") {
  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        return await source.poll();
      } catch (e) {
        log.error(`${source.name}: ${errorMessage(e)}`);
        return [];
      } finally {
        await source.close();
      }
    }),
  );
  const collected: Snapshot[] = results.flat();
  if (collected.length > 0) await store.add(collected);
  console.log(JSON.stringify(collected, null, 2));
  process.exit(collected.length > 0 ? 0 : 1);
}

await store.load();
const statuses: SourceStatus[] = sources.map((s) => ({
  name: s.name,
  intervalMs: s.intervalMs,
  lastSuccessAt: null,
  consecutiveFailures: 0,
  lastError: null,
}));
const startedAt = Date.now();
const server = createServer({
  port: config.port,
  // loadConfig guarantees the token in loop mode.
  authToken: config.authToken!,
  authTimeoutMs: config.authTimeoutMs,
  pingIntervalMs: config.pingIntervalMs,
  pongTimeoutMs: config.pongTimeoutMs,
  store,
  getHealth: () => computeHealth(statuses, Date.now(), startedAt),
  meta: {
    coins: config.coins,
    sources: config.sources,
    intervalMs: Object.fromEntries(sources.map((s) => [s.name, s.intervalMs])),
  },
  dashboard,
});
log.info(
  `listening on http://localhost:${server.port} (sources: ${config.sources.join(",")}; coins: ${config.coins.join(",")})`,
);

const controller = new AbortController();
const loops = sources.map((s, i) => runSourceLoop(s, store, statuses[i]!, controller.signal));

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down");
  controller.abort();
  await Promise.race([Promise.all(loops), Bun.sleep(5000)]);
  await Promise.allSettled(sources.map((s) => s.close()));
  server.stop();
  log.info("shutdown complete");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
