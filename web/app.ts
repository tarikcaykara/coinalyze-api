import { ColorType, createChart, LineSeries, type ISeriesApi, type Time, type UTCTimestamp } from "lightweight-charts";
import type { CoinSymbol } from "../src/coins.ts";
import { CLOSE, HISTORY_LIMIT, type ClientMessage, type ServerMessage } from "../src/protocol.ts";
import type { ComponentStatus, HistoryPoint, Snapshot } from "../src/types.ts";

type Status = "Connecting" | "Connected" | "Rejected" | "Disconnected";

const TOKEN_KEY = "coinalyze.token";
const RECONNECT_MS = 3000;
const STATUS_LABEL: Record<ComponentStatus, string> = {
  used: "used",
  stale: "stale",
  no_rate: "no predicted rate",
  unlisted: "not listed",
};

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;

const statusEl = $<HTMLSpanElement>("#status");
const tokenInput = $<HTMLInputElement>("#token");
const tokenToggle = $<HTMLButtonElement>("#token-toggle");
const tabsEl = $<HTMLElement>("#tabs");
const venuesEl = $<HTMLTableSectionElement>("#venues");
// Narrow screens render each row as a card and label every cell from its column header.
const venueColumns = [...document.querySelectorAll<HTMLTableCellElement>("table.venues thead th")].map((th) => th.textContent ?? "");

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let coins: CoinSymbol[] = [];
let intervalMs = Infinity;
let selected: CoinSymbol | null = null;
const history = new Map<CoinSymbol, HistoryPoint[]>();
const latest = new Map<CoinSymbol, Snapshot>();

const setStatus = (status: Status) => {
  statusEl.textContent = status;
  statusEl.className = `pill ${status.toLowerCase()}`;
};

const send = (ws: WebSocket, msg: ClientMessage) => ws.send(JSON.stringify(msg));

const record = (point: HistoryPoint) => {
  const list = history.get(point.symbol) ?? [];
  list.push(point);
  if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
  history.set(point.symbol, list);
};

const signed = (v: number, digits: number) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;

// ---- Cards ----------------------------------------------------------------

const formatAge = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
};

const renderCard = (id: string, text: string | null, sign: number | null, timestamp: number | null, note?: string) => {
  const card = $<HTMLElement>(id);
  const valueEl = card.querySelector(".value") as HTMLElement;
  const ageEl = card.querySelector(".age") as HTMLElement;
  const badge = card.querySelector(".badge") as HTMLElement;
  const noted = text === null && timestamp !== null && note !== undefined;
  valueEl.textContent = text ?? "—";
  valueEl.className = sign === null ? "value" : `value ${sign >= 0 ? "positive" : "negative"}`;
  ageEl.textContent = noted ? note : timestamp === null ? "waiting for data…" : formatAge(Date.now() - timestamp);
  badge.hidden = noted || timestamp === null || Date.now() - timestamp <= 3 * intervalMs;
};

const renderCards = () => {
  if (selected === null) return;
  const s = latest.get(selected);
  const ts = s?.timestamp ?? null;
  const avg = s?.aggregated_predicted_funding_rate ?? null;
  const oi = s?.oi_weighted_predicted_funding_rate ?? null;
  renderCard("#card-avg", avg === null ? null : `${signed(avg, 4)}%`, avg, ts);
  renderCard("#card-oi", oi === null ? null : `${signed(oi, 4)}%`, oi, ts, "waiting for open interest…");
  const spread = avg !== null && oi !== null ? oi - avg : null;
  renderCard("#card-spread", spread === null ? null : `${signed(spread, 4)} pp`, spread, ts, "waiting for open interest…");
  renderCard("#card-venues", s ? `${s.markets} / ${s.components.length}` : null, null, ts);
};

// ---- Per-venue table ------------------------------------------------------

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });

const renderVenues = () => {
  const s = selected === null ? undefined : latest.get(selected);
  if (!s) {
    venuesEl.replaceChildren();
    return;
  }
  const oiTotal = s.components
    .filter((c) => c.status === "used")
    .reduce((sum, c) => sum + (c.oi_usd !== null && c.oi_usd > 0 ? c.oi_usd : 0), 0);
  venuesEl.replaceChildren(
    ...s.components.map((c) => {
      const used = c.status === "used";
      const weight = used && c.oi_usd !== null && c.oi_usd > 0 && oiTotal > 0 ? c.oi_usd / oiTotal : null;
      const cells = [
        c.venue,
        c.symbol ?? "—",
        c.predicted_rate === null ? "—" : `${signed(c.predicted_rate, 5)}%`,
        `${c.rate_period_hours}h`,
        c.rate_8h === null ? "—" : `${signed(c.rate_8h, 4)}%`,
        c.oi_usd === null ? "—" : usd.format(c.oi_usd),
        weight === null ? "—" : `${(weight * 100).toFixed(1)}%`,
        STATUS_LABEL[c.status],
      ];
      const row = document.createElement("tr");
      row.className = used ? "" : "excluded";
      row.replaceChildren(
        ...cells.map((text, i) => {
          const td = document.createElement("td");
          td.textContent = text;
          td.dataset.label = venueColumns[i];
          if (i >= 2 && i <= 6) td.className = "num";
          return td;
        }),
      );
      return row;
    }),
  );
};

// ---- Chart ----------------------------------------------------------------

const localTime = (time: Time, withSeconds: boolean) =>
  new Date((time as UTCTimestamp) * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
  });

const chart = createChart($<HTMLDivElement>("#chart"), {
  autoSize: true,
  layout: { background: { type: ColorType.Solid, color: "#131823" }, textColor: "#8a93a6" },
  grid: { vertLines: { color: "#1c2230" }, horzLines: { color: "#1c2230" } },
  rightPriceScale: { borderColor: "#232a38" },
  timeScale: { borderColor: "#232a38", timeVisible: true, tickMarkFormatter: (t: Time) => localTime(t, false) },
  localization: { priceFormatter: (p: number) => `${p.toFixed(4)}%`, timeFormatter: (t: Time) => localTime(t, true) },
});

interface Line {
  series: ISeriesApi<"Line">;
  pick: (p: HistoryPoint) => number | null;
  lastTime: number;
}

const lines: Line[] = [
  {
    series: chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 2, title: "AVG" }),
    pick: (p) => p.aggregated_predicted_funding_rate,
    lastTime: 0,
  },
  {
    series: chart.addSeries(LineSeries, { color: "#a855f7", lineWidth: 2, title: "OI-w" }),
    pick: (p) => p.oi_weighted_predicted_funding_rate,
    lastTime: 0,
  },
];

/** One point per second (last value wins), ascending, as lightweight-charts requires. */
const toPoints = (points: HistoryPoint[], pick: Line["pick"]) => {
  const bySecond = new Map<number, number>();
  for (const p of [...points].sort((a, b) => a.timestamp - b.timestamp)) {
    const value = pick(p);
    if (value !== null) bySecond.set(Math.floor(p.timestamp / 1000), value);
  }
  return [...bySecond].map(([time, value]) => ({ time: time as UTCTimestamp, value }));
};

const rebuildChart = () => {
  if (selected === null) return;
  for (const line of lines) {
    const points = toPoints(history.get(selected) ?? [], line.pick);
    line.series.setData(points);
    line.lastTime = points.at(-1)?.time ?? 0;
  }
  chart.timeScale().fitContent();
};

const pushPoint = (p: HistoryPoint) => {
  const time = Math.floor(p.timestamp / 1000);
  for (const line of lines) {
    const value = line.pick(p);
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
  renderVenues();
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
        intervalMs = msg.interval_ms;
        renderTabs();
      }
      return;
    case "history":
      history.clear();
      latest.clear();
      for (const p of msg.points) record(p);
      for (const s of msg.latest) latest.set(s.symbol, s);
      if (selected !== null) select(selected);
      return;
    case "ping":
      send(ws, { type: "pong" });
      return;
    case "error":
      console.warn(`server error: ${msg.message}`);
      return;
    case "snapshot": {
      const { components: _, ...point } = msg;
      record(point);
      latest.set(msg.symbol, msg);
      if (msg.symbol === selected) {
        pushPoint(point);
        renderCards();
        renderVenues();
      }
      return;
    }
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
  ws.onopen = () => send(ws, { type: "auth", token });
  ws.onmessage = (event) => handle(ws, JSON.parse(String(event.data)) as ServerMessage);
  ws.onclose = (event) => {
    if (socket !== ws) return; // replaced by a newer connection
    socket = null;
    if (event.code === CLOSE.invalidToken) {
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

tokenToggle.addEventListener("click", () => {
  const reveal = tokenInput.type === "password";
  tokenInput.type = reveal ? "text" : "password";
  tokenToggle.textContent = reveal ? "Hide" : "Show";
});

setInterval(renderCards, 1000);

const stored = localStorage.getItem(TOKEN_KEY);
if (stored !== null) {
  tokenInput.value = stored;
  connect();
}
