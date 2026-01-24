# Coinalyze Aggregated Predicted Funding Rate API

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.0+-black?logo=bun)](https://bun.sh)
[![GitHub stars](https://img.shields.io/github/stars/tarikcaykara/coinalyze-aggregated-funding?style=social)](https://github.com/tarikcaykara/coinalyze-aggregated-funding)

Unofficial Bun + JavaScript wrapper for Coinalyze.net API that calculates **aggregated (open interest weighted) predicted funding rate**, including real-time value and historical data.

Coinalyze provides per-exchange predicted funding rates but **does not expose the aggregated (OI-weighted) value directly in the API**. This project replicates the site's "Aggregated Predicted Funding Rate" chart (including "AVG close 10") by fetching raw data and computing the weighted average.

## Features

- Real-time aggregated predicted funding rate (OI-weighted across major exchanges)
- Historical aggregated predicted funding rate data (exact replica of Coinalyze chart)
- Native `Bun.serve` with declarative routes
- Built with **Bun** (ultra-fast runtime) and **plain JavaScript**
- Easy to extend (caching, more intervals, other assets, etc.)

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/tarikcaykara/coinalyze-aggregated-funding.git
   cd coinalyze-aggregated-funding
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

3. Create a `.env` file (get your free API key from [coinalyze.net](https://coinalyze.net)):
   ```env
   COINALYZE_API_KEY=your_api_key_here
   PORT=3000  # optional
   ```

4. Run the server:
   ```bash
   bun dev   # development mode (auto-restart on changes)
   # or
   bun start # production mode
   ```

## API Endpoints

Server runs on `http://localhost:3000` by default.

### GET `/api/aggregated-predicted-funding-rate`

Returns current aggregated predicted funding rate (OI-weighted).

**Example response:**

```json
{
  "aggregated_predicted_funding_rate": 0.0032,
  "timestamp": "2026-01-21T15:02:00.000Z"
}
```

### GET `/api/aggregated-predicted-history`

Returns historical aggregated predicted funding rate data.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `interval` | string | `1h` | Time interval (`1m`, `1hour`, `8hour`, `daily`, etc.) |
| `days` | number | `7` | Number of days to fetch |
| `from` | number | - | Start timestamp (UNIX seconds) |
| `to` | number | - | End timestamp (UNIX seconds) |

**Example response:**

```json
{
  "history": [
    { "t": 1700000000, "c": 0.0028 },
    { "t": 1700003600, "c": 0.0031 },
    { "t": 1700007200, "c": 0.0032 }
  ],
  "avgClose10": 0.0032,
  "latestAggregated": 0.0032,
  "timestamp": "2026-01-21T15:02:00.000Z"
}
```

## Notes & Disclaimer

- This is an unofficial project – use at your own risk
- Respect Coinalyze rate limits (~40 requests/min on free plan)
- Always use your own API key (personal/non-commercial use recommended)
- For production use, consider adding caching to reduce API calls

## Contributing

Contributions are welcome! Some ideas:

- Add support for more assets (BTC, SOL, etc.)
- Implement in-memory or Redis caching
- Add WebSocket for real-time updates
- Build a simple frontend dashboard with charts
- Improve error handling and rate limit management

Fork the repo, create a branch, and open a Pull Request.

## License

MIT License – feel free to use, modify, and distribute.
