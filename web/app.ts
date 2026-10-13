import { ColorType, createChart, LineSeries, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { CoinSymbol } from "../src/coins.ts";
import type { Snapshot, SourceName } from "../src/types.ts";

type ServerMessage =
  | { type: "auth"; status: "ok"; coins: CoinSymbol[]; sources: SourceName[]; interval_ms: Partial<Record<SourceName, number>> }
  | { type: "auth"; status: "error"; message: string }
  | { type: "history"; snapshots: Snapshot[] }
  | { type: "ping" }
  | { type: "error"; message: string }
  | Snapshot;

type Status = "Connecting" | "Connected" | "Rejected" | "Disconnected";

const TOKEN_KEY = "coinalyze.token";
const RECONNECT_MS = 3000;
const HISTORY_LIMIT = 720;
const COLORS = { apiAvg: "#3b82f6", apiOi: "#a855f7", chart: "#f59e0b" };

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;

const statusEl = $<HTMLSpanElement>("#status");
const tokenInput = $<HTMLInputElement>("#token");
const tabsEl = $<HTMLElement>("#tabs");

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let coins: CoinSymbol[] = [];
let enabledSources: SourceName[] = [];
let intervalMs: Partial<Record<SourceName, number>> = {};
let selected: CoinSymbol | null = null;
const history = new Map<string, Snapshot[]>();

const setStatus = (status: Status) => {
  statusEl.textContent = status;
  statusEl.className = `pill ${status.toLowerCase()}`;
};

const record = (s: Snapshot) => {
  const key = `${s.source}:${s.symbol}`;
  const list = history.get(key) ?? [];
  list.push(s);
  if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
  history.set(key, list);
};

const latest = (source: SourceName, symbol: CoinSymbol): Snapshot | undefined =>
  history.get(`${source}:${symbol}`)?.at(-1);

// ---- Cards ----------------------------------------------------------------

const formatAge = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
};

const renderCard = (
  id: string,
  value: number | null,
  unit: string,
  observed: { source: SourceName; timestamp: number }[],
  waiting: boolean,
) => {
  const card = $<HTMLElement>(id);
  const valueEl = card.querySelector(".value") as HTMLElement;
  const ageEl = card.querySelector(".age") as HTMLElement;
  const badge = card.querySelector(".badge") as HTMLElement;
  if (value === null) {
    valueEl.textContent = "—";
    valueEl.className = "value";
    ageEl.textContent = waiting ? "waiting for data…" : "";
    badge.hidden = true;
    return;
  }
  valueEl.textContent = `${value >= 0 ? "+" : ""}${value.toFixed(4)}${unit}`;
  valueEl.className = `value ${value >= 0 ? "positive" : "negative"}`;
  const now = Date.now();
  const oldest = Math.min(...observed.map((o) => o.timestamp));
  ageEl.textContent = formatAge(now - oldest);
  badge.hidden = !observed.some((o) => now - o.timestamp > 3 * (intervalMs[o.source] ?? Infinity));
};

const renderCards = () => {
  if (selected === null) return;
  const api = enabledSources.includes("api") ? latest("api", selected) : undefined;
  const chart = enabledSources.includes("chart") ? latest("chart", selected) : undefined;
  const apiWaiting = enabledSources.includes("api");
  const chartWaiting = enabledSources.includes("chart");

  renderCard("#card-api-avg", api?.aggregated_predicted_funding_rate ?? null, "%", api ? [api] : [], apiWaiting);
  renderCard("#card-api-oi", api?.oi_weighted_predicted_funding_rate ?? null, "%", api ? [api] : [], apiWaiting);
  renderCard("#card-chart", chart?.aggregated_predicted_funding_rate ?? null, "%", chart ? [chart] : [], chartWaiting);
  renderCard(
    "#card-divergence",
    api && chart ? api.aggregated_predicted_funding_rate - chart.aggregated_predicted_funding_rate : null,
    " pp",
    api && chart ? [api, chart] : [],
    apiWaiting && chartWaiting,
  );
};

// ---- Chart ----------------------------------------------------------------

const chart = createChart($<HTMLDivElement>("#chart"), {
  autoSize: true,
  layout: { background: { type: ColorType.Solid, color: "#131823" }, textColor: "#8a93a6" },
  grid: { vertLines: { color: "#1c2230" }, horzLines: { color: "#1c2230" } },
  rightPriceScale: { borderColor: "#232a38" },
  timeScale: { borderColor: "#232a38", timeVisible: true, secondsVisible: true },
  localization: { priceFormatter: (p: number) => `${p.toFixed(4)}%` },
});

interface Line {
  series: ISeriesApi<"Line">;
  source: SourceName;
  pick: (s: Snapshot) => number | null;
  lastTime: number;
}

const lines: Line[] = [
  {
    series: chart.addSeries(LineSeries, { color: COLORS.apiAvg, lineWidth: 2, title: "API AVG" }),
    source: "api",
    pick: (s) => s.aggregated_predicted_funding_rate,
    lastTime: 0,
  },
  {
    series: chart.addSeries(LineSeries, { color: COLORS.apiOi, lineWidth: 2, title: "API OI-w" }),
    source: "api",
    pick: (s) => s.oi_weighted_predicted_funding_rate,
    lastTime: 0,
  },
  {
    series: chart.addSeries(LineSeries, { color: COLORS.chart, lineWidth: 2, title: "Chart" }),
    source: "chart",
    pick: (s) => s.aggregated_predicted_funding_rate,
    lastTime: 0,
  },
];

/** One point per second (last value wins), ascending, as lightweight-charts requires. */
const toPoints = (snaps: Snapshot[], pick: Line["pick"]) => {
  const bySecond = new Map<number, number>();
  for (const s of [...snaps].sort((a, b) => a.timestamp - b.timestamp)) {
    const value = pick(s);
    if (value !== null) bySecond.set(Math.floor(s.timestamp / 1000), value);
  }
  return [...bySecond].map(([time, value]) => ({ time: time as UTCTimestamp, value }));
};

const rebuildChart = () => {
  if (selected === null) return;
  for (const line of lines) {
    const points = toPoints(history.get(`${line.source}:${selected}`) ?? [], line.pick);
    line.series.setData(points);
    line.lastTime = points.at(-1)?.time ?? 0;
  }
  chart.timeScale().fitContent();
};

const pushPoint = (s: Snapshot) => {
  for (const line of lines) {
    if (line.source !== s.source) continue;
    const value = line.pick(s);
    const time = Math.floor(s.timestamp / 1000);
    // update() rejects points older than the last one.
    if (value === null || time < line.lastTime) continue;
    line.series.update({ time: time as UTCTimestamp, value });
    line.lastTime = time;
  }
};

// ---- Tabs -----------------------------------------------------------------

const select = (coin: CoinSymbol) => {
  selected = coin;
  for (const button of tabsEl.querySelectorAll("button")) {
    button.setAttribute("aria-selected", String(button.dataset.coin === coin));
  }
  renderCards();
  rebuildChart();
};

const renderTabs = () => {
  tabsEl.replaceChildren(
    ...coins.map((coin) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = coin;
      button.dataset.coin = coin;
      button.addEventListener("click", () => select(coin));
      return button;
    }),
  );
  const initial = selected !== null && coins.includes(selected) ? selected : coins.includes("ETH") ? "ETH" : coins[0];
  if (initial !== undefined) select(initial);
};

// ---- Connection -----------------------------------------------------------

const handle = (ws: WebSocket, msg: ServerMessage) => {
  switch (msg.type) {
    case "auth":
      if (msg.status === "ok") {
        setStatus("Connected");
        coins = msg.coins;
        enabledSources = msg.sources;
        intervalMs = msg.interval_ms;
        renderTabs();
      }
      return;
    case "history":
      history.clear();
      for (const s of msg.snapshots) record(s);
      renderCards();
      rebuildChart();
      return;
    case "ping":
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    case "error":
      console.warn(`server error: ${msg.message}`);
      return;
    case "snapshot":
      record(msg);
      if (msg.symbol === selected) {
        pushPoint(msg);
        renderCards();
      }
      return;
  }
};

const connect = () => {
  clearTimeout(reconnectTimer);
  const token = tokenInput.value.trim();
  if (token === "") return;
  localStorage.setItem(TOKEN_KEY, token);

  if (socket !== null) {
    const old = socket;
    socket = null;
    old.close();
  }
  setStatus("Connecting");
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
  ws.onmessage = (event) => handle(ws, JSON.parse(String(event.data)) as ServerMessage);
  ws.onclose = (event) => {
    if (socket !== ws) return; // replaced by a newer connection
    socket = null;
    if (event.code === 4001) {
      setStatus("Rejected");
      return;
    }
    setStatus("Disconnected");
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  };
};

$<HTMLFormElement>("#connect").addEventListener("submit", (event) => {
  event.preventDefault();
  connect();
});

setInterval(renderCards, 1000);

const stored = localStorage.getItem(TOKEN_KEY);
if (stored !== null) {
  tokenInput.value = stored;
  connect();
}
