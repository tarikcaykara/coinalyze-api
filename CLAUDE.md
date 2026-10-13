---
description: Project context and Bun runtime conventions for coinalyze-api.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# Project: coinalyze-api

## What this project is

A Bun + TypeScript service that publishes the **aggregated predicted funding rate** (BTC, ETH, SOL; % per 8h) over an authenticated WebSocket, with a live dashboard and `/health`. It uses two sources:

- **`api` (primary):** the official Coinalyze REST API. The API has no aggregated endpoint, so we aggregate per-market predicted rates ourselves (simple AVG + OI-weighted, normalized to 8h).
- **`chart` (reference):** headless Chromium reads the "Aggregated Predicted Funding Rate · AVG close 10" legend from Coinalyze's TradingView chart. It exists to measure divergence; the chart is not real-time.

Primary consumers are internal services that need a stable aggregated funding-rate signal.

## Architecture at a glance

```
ApiSource ──(API_INTERVAL_MS)──┐                         ┌→ funding_rate.json (latest per source+coin)
                               ├→ runSourceLoop → SnapshotStore ─┼→ WS channel "funding-rate" → dashboard / clients
ChartSource ─(CHART_INTERVAL_MS)┘        │                └→ in-memory history (720 per source+coin)
                                         └→ SourceStatus → GET /health
```

Runtime modes:

- **`bun run start`**: loop mode. Serves the dashboard (`GET /`), `/health` and `/ws`, and runs one loop per enabled source.
- **`bun run once`**: polls each source once, prints a JSON array to stdout, writes `funding_rate.json`, then exits 0 (or 1 if nothing was produced).

## Module map

| File | Purpose |
|---|---|
| `src/main.ts` | Entry: config → store → sources → loops → server; `--once`; SIGINT/SIGTERM shutdown. **Only owner of `process.exit`**, of the static `web/index.html` import, and of the dynamic chart import (so `SOURCES=api` never loads Playwright). |
| `src/config.ts` | `loadConfig(env, argv)` → `Config`; throws `ConfigError` for any invalid input. |
| `src/coins.ts` | `COIN_REGISTRY` (symbol → Coinalyze slug), `chartUrl`. |
| `src/types.ts` | `Snapshot`, `SourceName`, `Source`, `SourceStatus`. |
| `src/log.ts` | `createLogger(scope)`: writes to **stderr only** (stdout is reserved for `--once` JSON). |
| `src/store.ts` | `SnapshotStore`: latest + bounded history, persistence, subscribers. |
| `src/loop.ts` | `runSourceLoop`: drift-free (start-to-start), first poll immediate, never throws/exits. |
| `src/health.ts` | `computeHealth` (pure): healthy = success within 3 intervals (or startup grace). |
| `src/server.ts` | `createServer`: `Bun.serve` routes + WS protocol. |
| `src/sources/api/rate-limiter.ts` | Token bucket, 40 tokens, 40/min refill. |
| `src/sources/api/client.ts` | `CoinalyzeClient`: `api_key` header, ≤20 symbols per request, 429 `Retry-After` (3 attempts), 401 fails immediately. |
| `src/sources/api/aggregate.ts` | `aggregate()` + **calibration constants** (`API_VALUE_TO_PERCENT`, `FUNDING_NORMALIZATION`, `MARKET_SCOPE`); the single source of methodology truth. |
| `src/sources/api/source.ts` | `ApiSource`: market cache 24h, OI cache 10 min, budget warning. |
| `src/sources/chart/parse.ts` | `parseLegendValue`, `classifyCloudflare` (pure). |
| `src/sources/chart/browser.ts` | `BrowserManager`: one tracked Chromium; stealth plugin registered here. |
| `src/sources/chart/page.ts` | `ChartPage`: full load / reload / 1-minute selection / read, per coin. |
| `src/sources/chart/source.ts` | `ChartSource`: coins run concurrently; recovery tiers reload → full load → browser restart. |
| `web/index.html`, `web/app.ts`, `web/style.css` | Dashboard (Bun HTML import, `lightweight-charts` v5). |
| `test/*.test.ts` | `bun:test`; no network, no browser. |
| `Dockerfile`, `docker-compose.yml` | Pinned `oven/bun:1.4.3-debian`, non-root, healthcheck; compose adds `shm_size`, `init`. |
| `.github/workflows/ci.yml` | `bun install --frozen-lockfile` → `bun run typecheck` → `bun test`. |

## Configuration (env vars)

Bun auto-loads `.env`. Do NOT use `dotenv`. All parsing happens in `src/config.ts`.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP + WS port |
| `AUTH_TOKEN` | none | Required in loop mode. There is no default token. |
| `COINALYZE_API_KEY` | none | Required when `SOURCES` includes `api` |
| `SOURCES` | `api,chart` | `api`, `chart` |
| `COINS` | `BTC,ETH,SOL` | Must be keys of `COIN_REGISTRY` |
| `API_INTERVAL_MS` | `120000` | Sized for the 40 calls/min budget with 3 coins |
| `CHART_INTERVAL_MS` | `60000` | |
| `SESSION_REFRESH_MS` | `3600000` | Full chart re-navigation |
| `PING_INTERVAL_MS` | `30000` | |
| `PONG_TIMEOUT_MS` | `65000` | |
| `AUTH_TIMEOUT_MS` | `10000` | |

`INTERVAL_MS` (v1) is rejected with an explicit error.

## WebSocket contract

- Endpoint `ws://<host>:<PORT>/ws`. All messages are JSON.
- The client sends `{"type":"auth","token"}` within `AUTH_TIMEOUT_MS`. The server replies `{"type":"auth","status":"ok",coins,sources,interval_ms}` and then `{"type":"history",snapshots}`.
- After that, each `Snapshot` is published on the `"funding-rate"` channel. Several sources and coins share the channel, so consumers filter by `source` and `symbol`.
- Keepalive: server `{"type":"ping"}` → client `{"type":"pong"}`.
- Close codes: `4001` invalid token, `4002` pong timeout, `4003` auth timeout.
- `Snapshot` keeps the v1 fields `aggregated_predicted_funding_rate`, `coin` (slug) and `timestamp`. Changing those names breaks v1 consumers.

## Non-obvious gotchas (read before changing source logic)

1. **Stealth plugin is load-bearing.** Headless Chromium is challenged by Cloudflare unless `puppeteer-extra-plugin-stealth` is active (`browser.ts`). Don't remove it. Don't "simplify" the `playwright-extra` wrapper.
2. **Blob iframe is unavoidable.** TradingView renders into a `blob:https://coinalyze.net…` iframe. Enumerate `page.frames()` and filter by that prefix.
3. **Interval is a dropdown.** The TradingView toolbar no longer shows favourite interval buttons. `#header-toolbar-intervals button` is a single dropdown labelled with the current interval; pick `[data-value="1"]` ("1 minute"). The legend value depends on the interval (1h ≠ 1m), so re-select after every reload.
4. **Unicode minus.** Negative legend values use U+2212. `parseLegendValue` normalizes it, and the regex requires a digit (a bare `-` is not a value).
5. **`SESSION_REFRESH_MS` exists for a reason.** Long-lived TradingView sessions drift and show stale data. Keep the periodic full re-navigation.
6. **Loops never exit.** `runSourceLoop` catches everything and retries next cycle. Never add `process.exit` outside `main.ts` startup/shutdown.
7. **Calibration constants are measured, not assumed.** They were set from 10 ETH samples on 2026-10-13: values are already %, Hyperliquid (`H`) and Kraken (`K`) are hourly (×8), and `MARKET_SCOPE = "stable"`. Re-run the calibration (README "Calibration results") if Coinalyze changes units or listings.
8. **API budget: 40 calls/min per key, 1 call per symbol.**
   - 3 coins track about 57 stable markets, so the first cycle (OI + predicted rates) takes about 2–3 min.
   - Steady state is about 34 calls/min at `API_INTERVAL_MS=120000`.
   - `ApiSource` warns when the configured interval would exceed the budget.
9. **API keys activate 2 minutes after generation**, and generating a new key deactivates the old one immediately. A fresh key returning 401 is expected for those 2 minutes.
10. **Playwright must not own signals.**
    - `BrowserManager` launches with `handleSIGINT/SIGTERM/SIGHUP: false`. Playwright's defaults close the browser on the signal and `exit(130)` on SIGINT, racing `main.ts` shutdown.
    - With the defaults, an in-flight chart poll also failed and relaunched Chromium mid-shutdown. `ChartSource` takes the shutdown `signal` and skips recovery once it is aborted.

## Project evolution (for orientation, not documentation)

v1 (single `scraper.js`), oldest-first:

1. `942fd72`: Initial Playwright scraper, headed mode, one-shot only.
2. `f47200c`: Consolidated into `scraper.js`, removed a separate `server.js`.
3. `52a56c0`: 1-minute button selection without the dropdown (the favourites toolbar existed then).
4. `858c5f3`: Headless + stealth plugin.
5. `c6da13b`: `--loop` with persistent browser and periodic reload.
6. `19f02fe`: WebSocket broadcast server + Docker deployment.

v2 (`feat/v2-hybrid-rewrite`):

1. `f23e4cd`: TypeScript core (config, store, loop, health).
2. `c919929`: Coinalyze REST source with AVG and OI-weighted aggregation.
3. `a8248d5`: Chart reference source with tiered recovery and leak-free browser lifecycle.
4. `caa3000`: WebSocket/health server and entrypoint; v1 removed.
5. `11c887c`: 1-minute selection through the interval dropdown.
6. `82e7656`: Calibration of units, 8h normalization and market scope.
7. `2162e4a`: Live dashboard.
8. `8e4e6fe`: Shutdown owned by `main.ts` (Playwright signal handlers off; no recovery after abort).
9. `4c7b4e1`: Pinned non-root Docker image, compose, healthcheck, CI.
10. README, CLAUDE.md and LICENSE rewrite for v2.

Headed mode, a separate server file, `INTERVAL_MS` and the single-coin payload are historical.

## Working conventions for this repo

- **Modular TypeScript under `src/`.** One responsibility per module (see the module map). Keep pure logic (`aggregate`, `parse`, `health`, `config`) free of I/O so it stays unit-testable.
- **Explicit `.ts` import extensions** (`allowImportingTsExtensions`, `verbatimModuleSyntax`). Use `import type` for type-only imports.
- **Checks:** `bun test` and `bun run typecheck` must pass; CI runs both. Tests must not touch the network or launch a browser; inject fakes (`fetch`, `sleep`, `now`, `launch`).
- **When behavior changes, update `README.md` in the same commit.** The v1 README drifted badly.
- **Prefer `Bun.*` APIs** over `node:*` equivalents. See the Bun section below.
- **Style:** 2-space indent, double quotes, semicolons, arrow functions for top-level helpers. No linter/formatter enforced.
- **Commits and branches follow Conventional Commits** (`feat:`, `fix:`, `refactor:`, `docs:`, `build:`; branches like `feat/<topic>`).

---

# Bun runtime conventions

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
