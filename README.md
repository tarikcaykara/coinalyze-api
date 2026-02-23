# Coinalyze Aggregated Predicted Funding Rate Scraper

[![Bun](https://img.shields.io/badge/Bun-1.0+-black?logo=bun)](https://bun.sh)
[![Playwright](https://img.shields.io/badge/Playwright-1.58+-green?logo=playwright)](https://playwright.dev)

Scrapes the **Aggregated Predicted Funding Rate AVG close 10** value directly from the [Coinalyze](https://coinalyze.net/ethereum/funding-rate/) TradingView chart and saves it to a JSON file.

Coinalyze does not expose this aggregated value via their public API, and manual calculation from per-exchange data produces inconsistent results due to proprietary server-side aggregation. This scraper bypasses both issues by reading the exact rendered value from the chart.

## How it works

1. Launches Chromium via Playwright (headed mode)
2. Navigates to `coinalyze.net/ethereum/funding-rate/`
3. Handles Cloudflare challenge if present (auto-waits up to 2 minutes)
4. Waits for the TradingView `blob:` iframe to load
5. Clicks the **1D** timeframe button inside the chart
6. Reads the "Aggregated Predicted Funding Rate AVG close 10" value from the chart legend
7. Saves the result to `funding_rate.json`

## Installation

```bash
git clone https://github.com/tarikcaykara/coinalyze-api.git
cd coinalyze-api
bun install
```

## Usage

```bash
bun run scrape
```

## Output

The scraper writes `funding_rate.json`:

```json
{
  "aggregated_predicted_funding_rate": -0.0004,
  "coin": "ethereum",
  "timeframe": "1D",
  "timestamp": 1771841006455
}
```

| Field                               | Description                                |
| ----------------------------------- | ------------------------------------------ |
| `aggregated_predicted_funding_rate` | The extracted value (positive or negative) |
| `coin`                              | Target cryptocurrency                      |
| `timeframe`                         | Chart timeframe used for scraping          |
| `timestamp`                         | UNIX timestamp in milliseconds             |

## Requirements

- [Bun](https://bun.sh) 1.0+
- [Playwright](https://playwright.dev) (installed via `bun install`)
- Chromium (Playwright downloads it automatically)

## Notes

- Runs in **headed mode** (`headless: false`) to bypass Cloudflare browser verification
- Handles both standard hyphen-minus and Unicode minus sign (U+2212) for negative values
- Scrapes the chart legend text, not the canvas — the TradingView chart renders on `<canvas>` but exposes indicator values in DOM text

## License

MIT
