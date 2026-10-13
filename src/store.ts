import { isCoinSymbol } from "./coins.ts";
import { createLogger } from "./log.ts";
import { isSourceName, type Snapshot } from "./types.ts";

const log = createLogger("store");

const isSnapshot = (value: unknown): value is Snapshot => {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    s.type === "snapshot" &&
    isSourceName(s.source) &&
    typeof s.symbol === "string" &&
    isCoinSymbol(s.symbol) &&
    Number.isFinite(s.timestamp) &&
    Number.isFinite(s.aggregated_predicted_funding_rate)
  );
};

export class SnapshotStore {
  private readonly file: string;
  private readonly historyLimit: number;
  private readonly latestByKey = new Map<string, Snapshot>();
  private readonly historyByKey = new Map<string, Snapshot[]>();
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
    return [...this.latestByKey.values()];
  }

  history(): Snapshot[] {
    return [...this.historyByKey.values()].flat().sort((a, b) => a.timestamp - b.timestamp);
  }

  subscribe(fn: (s: Snapshot) => void): void {
    this.subscribers.push(fn);
  }

  private record(s: Snapshot): void {
    const key = `${s.source}:${s.symbol}`;
    this.latestByKey.set(key, s);
    const history = this.historyByKey.get(key) ?? [];
    history.push(s);
    if (history.length > this.historyLimit) history.splice(0, history.length - this.historyLimit);
    this.historyByKey.set(key, history);
  }
}
