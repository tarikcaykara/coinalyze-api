---
description: Project context and Bun runtime conventions for coinalyze-api.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# Project: coinalyze-api

## What this project is

A scraper + realtime broadcast service that extracts the **Aggregated Predicted Funding Rate (AVG close 10)** for Ethereum from the Coinalyze TradingView chart and rebroadcasts it over WebSocket. The value is NOT exposed by Coinalyze's public API and cannot be recomputed reliably from per-exchange data, so we read it directly from the rendered chart legend.

Primary consumers are internal services that need a stable, server-side-aggregated funding rate signal.

## Architecture at a glance

Single-file application. All logic lives in `scraper.js` (~390 lines). There is intentionally no framework, router, or build step.

```
Coinalyze.net
  → Playwright (Chromium, headless + stealth plugin)
    → DOM legend text in blob: iframe (TradingView chart)
      → regex extraction
        → funding_rate.json  (disk)
        → Bun.serve() WebSocket "funding-rate" channel  (network)
          → authenticated clients
```

Two runtime modes, selected by CLI flag:

- **`bun run scrape`** — one-shot. Launch browser → load page → read value → write JSON → exit. Used for manual checks and debugging.
- **`bun run start`** — production. Adds `--loop`: persistent browser, periodic reload every `INTERVAL_MS`, full re-navigation every `SESSION_REFRESH_MS`, WebSocket broadcast server, multi-level error recovery.

## Key files

| File | Purpose |
|------|---------|
| `scraper.js` | Entire application: scraping, loop, WebSocket server, error recovery |
| `test.html` | Built-in WebSocket client UI, served at `GET /` |
| `Dockerfile` | Bun base image + Chromium system libs + `bunx playwright install chromium`; `CMD ["bun", "run", "start"]` |
| `.env.example` | All runtime env vars (see Configuration below) |
| `package.json` | Only two scripts: `scrape`, `start` |
| `funding_rate.json` | Last scraped value (overwritten each cycle) |
| `README.md` | User-facing documentation (keep in sync with `scraper.js` when behavior changes) |

## scraper.js map (by line range)

- `6-19` — `CONFIG` block. All env vars and hardcoded constants. Change defaults here.
- `21-40` — Cloudflare detection (`isCloudflareBlocked`, `waitUntilUnblocked`).
- `42-52` — `waitForBlobFrame`: the TradingView chart lives inside a `blob:` iframe; must wait for it explicitly.
- `54-64` — `readLegendValue`: regex `/Predicted Funding Rate[\s\S]*?AVG close 10\s+([\u2212\-\d.]+)/i`. Handles Unicode minus (U+2212).
- `66-85` — `loadPage`: navigate → networkidle → Cloudflare check → blob iframe wait.
- `87-124` — `clickTimeframe`: selects "1 minute". Tries `button[aria-label="1 minute"]` first, falls back to `button:has-text("1m")`. Iterates over all relevant frames.
- `126-137` — `getRelevantFrames`: filters to `blob:` or target-URL frames.
- `139-194` — `readAndSave`: extracts, writes JSON, broadcasts over WebSocket if server present.
- `196-215` — `scrapeOnce`: one-shot mode orchestration.
- `217-298` — `createWebSocketServer`: `Bun.serve()`, auth, pub/sub on `"funding-rate"` channel, ping/pong keepalive. Close codes: `4001` bad token, `4002` pong timeout.
- `300-382` — `runLoop`: persistent browser, `SESSION_REFRESH_MS` full-load logic, three-tier error recovery (reload → full load → browser reopen).
- `384-390` — `--loop` flag dispatch.

## Configuration (env vars)

Bun auto-loads `.env`. Do NOT use `dotenv`.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | WebSocket + HTTP port |
| `AUTH_TOKEN` | `coinalyze-secret-2025` | WS clients must send this in `{type:"auth",token}` handshake |
| `INTERVAL_MS` | `60000` | Scrape cycle delay |
| `SESSION_REFRESH_MS` | `3600000` | Full re-navigation interval (1h). Between refreshes, cycles use `page.reload()`. |
| `PING_INTERVAL_MS` | `30000` | WS keepalive ping frequency |
| `PONG_TIMEOUT_MS` | `65000` | Close client if no pong in this window |

Hardcoded in `CONFIG` (line 7-11): target URL, output file, coin name, timeframe, Cloudflare timeout (120s), iframe timeout (30s).

## WebSocket protocol

- Endpoint: `ws://<host>:<PORT>/ws`
- Test UI: `http://<host>:<PORT>/` (serves `test.html`)
- Handshake: client sends `{"type":"auth","token":"..."}` → server responds `{"type":"auth","status":"ok"}` and immediately pushes last cached value, OR closes with `4001`.
- Channel: `"funding-rate"` (Bun `ws.subscribe` / `server.publish`). Payload is the same JSON as `funding_rate.json`.
- Keepalive: server sends `{"type":"ping"}` every `PING_INTERVAL_MS`; client must reply `{"type":"pong"}` or get closed with `4002`.

## Non-obvious gotchas (read before changing scraping logic)

1. **Stealth plugin is load-bearing.** Headless Chromium is detected by Cloudflare unless `puppeteer-extra-plugin-stealth` is active. Don't remove it. Don't "simplify" the `playwright-extra` wrapper.
2. **Blob iframe is unavoidable.** TradingView renders into a `blob:` URL iframe. You cannot navigate to or directly fetch it; you MUST enumerate `page.frames()` and filter by URL prefix.
3. **Chart is `<canvas>`, values are in DOM.** The number isn't pixel-read — TradingView exposes legend values as DOM text. If Coinalyze ever changes this, the scraper breaks entirely; there is no pixel fallback.
4. **Unicode minus.** Negative values come in as U+2212 (`−`), not ASCII hyphen. The regex and `parseFloat` normalization at line 61 handle both — keep them aligned.
5. **`SESSION_REFRESH_MS` exists for a reason.** Long-lived TradingView sessions drift and eventually show stale data. The 1-hour full re-navigation is a workaround — don't remove it without a replacement.
6. **Loop mode never exits on error.** Three-tier recovery (reload → full load → browser reopen → retry next cycle). Introducing a `process.exit()` anywhere in `runLoop` would break production uptime.
7. **No persistence layer.** `funding_rate.json` on disk + `lastData` variable in memory are the entire state. New WS clients get `lastData` immediately on auth (line 255) so they don't wait a full `INTERVAL_MS` for the first value.
8. **Single coin, single timeframe.** Ethereum + 1-minute are hardcoded in `CONFIG` and in the `clickTimeframe` selectors. Multi-coin support would require non-trivial refactoring.

## Project evolution (for orientation, not documentation)

Commits on `master`, oldest-first among the relevant ones:

1. `942fd72` — Initial Playwright scraper, headed mode, one-shot only.
2. `f47200c` — Consolidated into `scraper.js`, removed a separate `server.js`.
3. `52a56c0` — Robust 1-minute button selection (no dropdown click).
4. `858c5f3` — Switched to headless + stealth plugin.
5. `c6da13b` — Added `--loop` with persistent browser and periodic reload.
6. `19f02fe` — Added WebSocket broadcast server + Docker deployment.

If you see old patterns (headed mode, dropdown clicking, separate server file) in issues, comments, or external docs — they are historical and do not reflect current code.

## Working conventions for this repo

- **Keep `scraper.js` as a single file.** Splitting it into modules has been considered and rejected — the linear top-to-bottom flow is easier to reason about than an artificial module boundary at this size.
- **When behavior changes, update `README.md` in the same commit.** README drifted badly in the past (see commit history: it still described headed + dropdown mode long after both were removed).
- **Prefer `Bun.*` APIs** over `node:*` equivalents — see the Bun section below.
- **No test suite currently.** If adding tests, use `bun test`. Do not introduce Jest/Vitest.
- **No linter/formatter enforced.** Match existing style (2-space indent, double quotes, semicolons, arrow functions for top-level helpers).

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
