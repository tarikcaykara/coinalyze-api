export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

// stderr only: stdout is reserved for the --once JSON output.
const write = (level: string, scope: string, msg: string) => {
  console.error(`${new Date().toISOString()} ${level} [${scope}] ${msg}`);
};

export const createLogger = (scope: string): Logger => ({
  info: (msg) => write("INFO", scope, msg),
  warn: (msg) => write("WARN", scope, msg),
  error: (msg) => write("ERROR", scope, msg),
});

export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
