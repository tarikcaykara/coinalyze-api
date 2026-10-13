import { createLogger, errorMessage } from "./log.ts";
import type { SnapshotStore } from "./store.ts";
import type { Source, SourceStatus } from "./types.ts";

const log = createLogger("loop");

export const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal.aborted) {
    resolve();
    return promise;
  }
  const onAbort = () => {
    clearTimeout(timer);
    resolve();
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
};

export interface LoopDeps {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Polls `source` every `intervalMs` (measured start-to-start) until `signal` aborts.
 * The first poll runs immediately, so startup failures are retried like any other failure.
 * Never throws and never exits the process.
 */
export const runSourceLoop = async (
  source: Source,
  store: Pick<SnapshotStore, "add">,
  status: SourceStatus,
  signal: AbortSignal,
  deps: LoopDeps = { now: Date.now, sleep: abortableSleep },
): Promise<void> => {
  while (!signal.aborted) {
    const t0 = deps.now();
    try {
      const snaps = await source.poll();
      await store.add(snaps);
      status.lastSuccessAt = deps.now();
      status.consecutiveFailures = 0;
      status.lastError = null;
    } catch (e) {
      status.consecutiveFailures++;
      status.lastError = errorMessage(e);
      log.error(
        `${source.name} cycle failed (${status.consecutiveFailures} in a row): ${status.lastError}`,
      );
    }
    await deps.sleep(Math.max(0, source.intervalMs - (deps.now() - t0)), signal);
  }
};
