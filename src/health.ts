import type { SourceStatus } from "./types.ts";

export interface SourceHealth {
  healthy: boolean;
  interval_ms: number;
  last_success_at: number | null;
  consecutive_failures: number;
  last_error: string | null;
}

export interface HealthBody {
  status: "ok" | "degraded" | "down";
  uptime_s: number;
  sources: Record<string, SourceHealth>;
}

export interface Health {
  httpStatus: 200 | 503;
  body: HealthBody;
}

/** A source is healthy if it succeeded within 3 intervals, or has not had 3 intervals to try yet. */
export const computeHealth = (statuses: SourceStatus[], now: number, startedAt: number): Health => {
  const sources: Record<string, SourceHealth> = {};
  let healthyCount = 0;
  for (const s of statuses) {
    const window = 3 * s.intervalMs;
    const healthy =
      s.lastSuccessAt !== null ? now - s.lastSuccessAt <= window : now - startedAt <= window;
    if (healthy) healthyCount++;
    sources[s.name] = {
      healthy,
      interval_ms: s.intervalMs,
      last_success_at: s.lastSuccessAt,
      consecutive_failures: s.consecutiveFailures,
      last_error: s.lastError,
    };
  }
  const status =
    healthyCount === statuses.length ? "ok" : healthyCount > 0 ? "degraded" : "down";
  return {
    httpStatus: status === "down" ? 503 : 200,
    body: { status, uptime_s: Math.floor((now - startedAt) / 1000), sources },
  };
};
