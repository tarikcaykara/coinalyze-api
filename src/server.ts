import type { HTMLBundle, ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";
import type { CoinSymbol } from "./coins.ts";
import type { Health } from "./health.ts";
import { createLogger } from "./log.ts";
import type { SnapshotStore } from "./store.ts";
import type { SourceName } from "./types.ts";

const log = createLogger("server");

const CHANNEL = "funding-rate";

interface ClientData {
  authenticated: boolean;
  lastPong: number;
  authTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface ServerOptions {
  port: number;
  authToken: string;
  authTimeoutMs: number;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  store: Pick<SnapshotStore, "history" | "subscribe">;
  getHealth: () => Health;
  meta: {
    coins: CoinSymbol[];
    sources: SourceName[];
    intervalMs: Partial<Record<SourceName, number>>;
  };
  dashboard: HTMLBundle | Response;
}

export interface AppServer {
  port: number;
  stop(): void;
}

const tokenMatches = (candidate: unknown, expected: string): boolean => {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Close codes: 4001 invalid token, 4002 pong timeout, 4003 no auth within authTimeoutMs.
 */
export const createServer = (opts: ServerOptions): AppServer => {
  const clients = new Set<ServerWebSocket<ClientData>>();
  const send = (ws: ServerWebSocket<ClientData>, msg: object) => ws.send(JSON.stringify(msg));

  const server = Bun.serve({
    port: opts.port,
    development: process.env.NODE_ENV !== "production",
    routes: {
      "/": opts.dashboard,
      "/health": () => {
        const h = opts.getHealth();
        return Response.json(h.body, { status: h.httpStatus });
      },
    },
    fetch(req, server) {
      if (new URL(req.url).pathname !== "/ws") return new Response("Not found", { status: 404 });
      const upgraded = server.upgrade(req, {
        data: { authenticated: false, lastPong: Date.now(), authTimer: undefined },
      });
      return upgraded ? undefined : new Response("Upgrade failed", { status: 400 });
    },
    websocket: {
      data: {} as ClientData,
      open(ws) {
        ws.data.authTimer = setTimeout(() => ws.close(4003, "auth timeout"), opts.authTimeoutMs);
        clients.add(ws);
      },
      message(ws, raw) {
        let msg: { type?: unknown; token?: unknown };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          send(ws, { type: "error", message: "invalid json" });
          return;
        }
        if (msg?.type === "auth") {
          if (!tokenMatches(msg.token, opts.authToken)) {
            log.warn("ws: client rejected (invalid token)");
            send(ws, { type: "auth", status: "error", message: "invalid token" });
            ws.close(4001, "invalid token");
            return;
          }
          clearTimeout(ws.data.authTimer);
          ws.data.authTimer = undefined;
          ws.data.authenticated = true;
          ws.data.lastPong = Date.now();
          ws.subscribe(CHANNEL);
          send(ws, {
            type: "auth",
            status: "ok",
            coins: opts.meta.coins,
            sources: opts.meta.sources,
            interval_ms: opts.meta.intervalMs,
          });
          send(ws, { type: "history", snapshots: opts.store.history() });
          log.info(`ws: client authenticated (${clients.size} connected)`);
          return;
        }
        if (msg?.type === "pong") {
          if (ws.data.authenticated) ws.data.lastPong = Date.now();
          return;
        }
        send(ws, { type: "error", message: "unknown message type" });
      },
      close(ws) {
        clearTimeout(ws.data.authTimer);
        clients.delete(ws);
      },
    },
  });

  const pingTimer = setInterval(() => {
    const now = Date.now();
    for (const ws of clients) {
      if (!ws.data.authenticated) continue;
      if (now - ws.data.lastPong > opts.pongTimeoutMs) {
        ws.close(4002, "pong timeout");
        continue;
      }
      send(ws, { type: "ping" });
    }
  }, opts.pingIntervalMs);

  let stopped = false;
  opts.store.subscribe((s) => {
    if (!stopped) server.publish(CHANNEL, JSON.stringify(s));
  });

  return {
    port: server.port ?? opts.port,
    stop() {
      stopped = true;
      clearInterval(pingTimer);
      server.stop(true);
    },
  };
};
