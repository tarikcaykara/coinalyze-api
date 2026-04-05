# Coinalyze Aggregated Predicted Funding Rate Scraper

[![Bun](https://img.shields.io/badge/Bun-1.0+-black?logo=bun)](https://bun.sh)
[![Playwright](https://img.shields.io/badge/Playwright-1.58+-green?logo=playwright)](https://playwright.dev)
[![Docker](https://img.shields.io/badge/Docker-ready-blue?logo=docker)](https://www.docker.com)

Scrapes the **Aggregated Predicted Funding Rate AVG close 10** value directly from the [Coinalyze](https://coinalyze.net/ethereum/funding-rate/) TradingView chart, writes it to a JSON file, and broadcasts updates in real time over a WebSocket channel.

Coinalyze does not expose this aggregated value via their public API, and manual calculation from per-exchange data produces inconsistent results due to proprietary server-side aggregation. This scraper bypasses both issues by reading the exact rendered value from the chart.

## Features

- Headless Chromium scraping with [`puppeteer-extra-plugin-stealth`](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth) to bypass Cloudflare
- Two modes: one-shot (`scrape`) and persistent loop (`start`)
- Built-in WebSocket broadcast server (native `Bun.serve()`) with token auth and ping/pong keepalive
- Persistent browser session with periodic full reloads and automatic error recovery
- Docker image ready for production deployment

## How it works

1. Launches Chromium via Playwright in **headless** mode with the Stealth plugin
2. Navigates to `coinalyze.net/ethereum/funding-rate/`
3. Detects and waits out any Cloudflare challenge (up to 2 minutes)
4. Waits for the TradingView `blob:` iframe to load
5. Clicks the **1 minute** resolution button (`aria-label="1 minute"`, falls back to text match)
6. Reads the "Aggregated Predicted Funding Rate AVG close 10" value from the chart legend DOM
7. Writes the result to `funding_rate.json`
8. In loop mode, publishes the same payload to all authenticated WebSocket clients

## Installation

```bash
git clone https://github.com/tarikcaykara/coinalyze-api.git
cd coinalyze-api
bun install
bunx playwright install chromium
```

## Usage

### One-shot mode

Runs a single scrape, writes `funding_rate.json`, and exits.

```bash
bun run scrape
```

### Loop mode + WebSocket server (production)

Keeps a persistent browser open, re-scrapes every `INTERVAL_MS`, and broadcasts each new value to connected WebSocket clients.

```bash
bun run start
```

Then open `http://localhost:3000/` for the built-in test UI, or connect a client to `ws://localhost:3000/ws`.

## Docker

```bash
docker build -t coinalyze-api .
docker run -d \
  --name coinalyze-api \
  -p 3000:3000 \
  -e AUTH_TOKEN=your-secret-token \
  coinalyze-api
```

The image installs all Chromium system libraries and runs `bun run start` by default.

## Configuration

All configuration is via environment variables (Bun loads `.env` automatically). See `.env.example`.

| Variable             | Default                 | Description                                            |
| -------------------- | ----------------------- | ------------------------------------------------------ |
| `PORT`               | `3000`                  | WebSocket/HTTP server port                             |
| `AUTH_TOKEN`         | `coinalyze-secret-2025` | Token required by WebSocket clients to authenticate   |
| `INTERVAL_MS`        | `60000`                 | Delay between scrape cycles in loop mode (ms)          |
| `SESSION_REFRESH_MS` | `3600000`               | Interval between full page reloads to avoid stale sessions (ms) |
| `PING_INTERVAL_MS`   | `30000`                 | WebSocket keepalive ping interval (ms)                 |
| `PONG_TIMEOUT_MS`    | `65000`                 | Max time to wait for a client pong before closing (ms) |

## WebSocket API

- **Endpoint:** `ws://<host>:<PORT>/ws`
- **Test UI:** `http://<host>:<PORT>/` (served from `test.html`)

### Authentication

Immediately after connecting, the client must send:

```json
{ "type": "auth", "token": "your-secret-token" }
```

- On success, the server replies `{ "type": "auth", "status": "ok" }`, subscribes the client to the `funding-rate` channel, and pushes the last cached value right away.
- On failure, the server sends `{ "type": "auth", "status": "error", "message": "invalid token" }` and closes the socket with code `4001`.

### Broadcast payload

Each scrape publishes the same JSON that is written to `funding_rate.json`:

```json
{
  "aggregated_predicted_funding_rate": -0.0004,
  "coin": "ethereum",
  "timestamp": 1771841006455
}
```

### Keepalive

The server sends `{ "type": "ping" }` every `PING_INTERVAL_MS`. Clients must reply with `{ "type": "pong" }`. If no pong is received within `PONG_TIMEOUT_MS`, the connection is closed with code `4002`.

## Output

The scraper writes `funding_rate.json`:

```json
{
  "aggregated_predicted_funding_rate": -0.0004,
  "coin": "ethereum",
  "timestamp": 1771841006455
}
```

| Field                               | Description                                |
| ----------------------------------- | ------------------------------------------ |
| `aggregated_predicted_funding_rate` | The extracted value (positive or negative) |
| `coin`                              | Target cryptocurrency                      |
| `timestamp`                         | UNIX timestamp in milliseconds             |

## Loop mode details

- A single Chromium instance is reused across scrape cycles.
- Every `SESSION_REFRESH_MS` (default: 1 hour) the page is fully re-navigated and the 1-minute resolution is re-selected. Between refreshes, cycles use a lightweight `page.reload()`.
- On cycle errors, the scraper first retries with a full load; if that still fails, the browser is closed and reopened before the next cycle. The loop never exits on transient errors.

## Requirements

- [Bun](https://bun.sh) 1.0+
- [Playwright](https://playwright.dev) (installed via `bun install`)
- Chromium (install via `bunx playwright install chromium`; Docker image handles system libraries automatically)

## Notes

- Runs in **headless** mode. Cloudflare bypass is handled by `puppeteer-extra-plugin-stealth`, which hides automation markers from the browser fingerprint.
- Handles both standard hyphen-minus and Unicode minus sign (U+2212) for negative values.
- The TradingView chart is rendered on a `<canvas>` inside a `blob:` iframe, but indicator values are exposed in the DOM legend text — that's what this scraper reads.

## License

MIT
