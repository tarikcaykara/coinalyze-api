import type { SourceStatus } from "./types.ts";

export interface HealthBody {
  status: "ok" | "down";
  uptime_s: number;
  interval_ms: number;
  last_success_at: number | null;
  consecutive_failures: number;
  last_error: string | null;
}

export interface Health {
  httpStatus: 200 | 503;
  body: HealthBody;
}

/** Healthy if a poll succeeded within 3 intervals, or 3 intervals have not passed since startup yet. */
export const computeHealth = (s: SourceStatus, now: number, startedAt: number): Health => {
  const window = 3 * s.intervalMs;
  const healthy = s.lastSuccessAt !== null ? now - s.lastSuccessAt <= window : now - startedAt <= window;
  return {
    httpStatus: healthy ? 200 : 503,
    body: {
      status: healthy ? "ok" : "down",
      uptime_s: Math.floor((now - startedAt) / 1000),
      interval_ms: s.intervalMs,
      last_success_at: s.lastSuccessAt,
      consecutive_failures: s.consecutiveFailures,
      last_error: s.lastError,
    },
  };
};
