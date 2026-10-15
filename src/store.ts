import { isCoinSymbol } from "./coins.ts";
import { createLogger } from "./log.ts";
import type { HistoryPoint, Snapshot } from "./types.ts";

const log = createLogger("store");

const isSnapshot = (value: unknown): value is Snapshot => {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    s.type === "snapshot" &&
    typeof s.symbol === "string" &&
    isCoinSymbol(s.symbol) &&
    Number.isFinite(s.timestamp) &&
    Number.isFinite(s.aggregated_predicted_funding_rate) &&
    Array.isArray(s.components)
  );
};

/** Latest snapshot per coin (persisted to `file`) plus a bounded in-memory history of aggregate points. */
export class SnapshotStore {
  private readonly file: string;
  private readonly historyLimit: number;
  private readonly latestByCoin = new Map<string, Snapshot>();
  private readonly historyByCoin = new Map<string, HistoryPoint[]>();
  private readonly subscribers: ((s: Snapshot) => void)[] = [];

  constructor(opts: { file: string; historyLimit: number }) {
    this.file = opts.file;
    this.historyLimit = opts.historyLimit;
  }

  async load(): Promise<void> {
    const file = Bun.file(this.file);
    if (!(await file.exists())) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      parsed = undefined;
    }
    if (!Array.isArray(parsed)) {
      log.warn(`ignoring unreadable ${this.file}`);
      return;
    }
    for (const entry of parsed) {
      if (isSnapshot(entry)) this.record(entry);
    }
  }

  async add(snaps: Snapshot[]): Promise<void> {
    for (const s of snaps) this.record(s);
    await Bun.write(this.file, JSON.stringify(this.latest(), null, 2));
    for (const s of snaps) {
      for (const fn of this.subscribers) fn(s);
    }
  }

  latest(): Snapshot[] {
    return [...this.latestByCoin.values()];
  }

  /** All coins, ascending by timestamp. */
  history(): HistoryPoint[] {
    return [...this.historyByCoin.values()].flat().sort((a, b) => a.timestamp - b.timestamp);
  }

  subscribe(fn: (s: Snapshot) => void): void {
    this.subscribers.push(fn);
  }

  private record(s: Snapshot): void {
    this.latestByCoin.set(s.symbol, s);
    const { components: _, ...point } = s;
    const history = this.historyByCoin.get(s.symbol) ?? [];
    history.push(point);
    if (history.length > this.historyLimit) history.splice(0, history.length - this.historyLimit);
    this.historyByCoin.set(s.symbol, history);
  }
}
