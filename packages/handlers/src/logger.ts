/** Structured details of a log line: ids, timings and counts. */
export type SeclaiLogFields = Record<string, unknown>;

/**
 * Where the handlers send their log lines, each called as `(message, fields)`.
 * `console` fits, and so do winston and consola. pino takes `(fields, message)`
 * and would drop the fields, so wrap it, one line per level:
 * `info: (m, f) => log.info(f, m)`.
 */
export interface SeclaiLogger {
  debug(message: string, fields?: SeclaiLogFields): void;
  info(message: string, fields?: SeclaiLogFields): void;
  warn(message: string, fields?: SeclaiLogFields): void;
  error(message: string, fields?: SeclaiLogFields): void;
}

export type SeclaiLogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Method = (typeof LEVELS)[number];

const ORDER: Record<SeclaiLogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

/**
 * A {@link SeclaiLogger} that writes to `console` from `level` up, with each
 * message prefixed `[seclai]`. Passing `console` itself also works, but logs
 * `debug` lines too: every token and keepalive.
 *
 * @param level - The lowest level written. Defaults to `info`.
 * @param target - Where to write. Defaults to `console`.
 */
export function consoleLogger(
  level: SeclaiLogLevel = "info",
  target: SeclaiLogger = console,
): SeclaiLogger {
  const threshold = ORDER[level] ?? ORDER.info;
  const method = (name: Method) => (message: string, fields?: SeclaiLogFields) => {
    if (ORDER[name] < threshold) return;
    const line = `[seclai] ${message}`;
    if (fields === undefined) target[name](line);
    else target[name](line, fields);
  };
  return { debug: method("debug"), info: method("info"), warn: method("warn"), error: method("error") };
}

/** Values shorter than this aren't scrubbed: they'd match ordinary text. */
const MIN_SECRET_LENGTH = 8;

/**
 * Wrap `logger` so a method that throws can't break a run or an upload, and so
 * `secret` never appears in a message or a top-level string field.
 */
export function safeLogger(logger: SeclaiLogger, secret?: string): SeclaiLogger {
  const scrub =
    secret && secret.length >= MIN_SECRET_LENGTH
      ? (value: string) => value.split(secret).join("[redacted]")
      : (value: string) => value;

  const method = (name: Method) => (message: string, fields?: SeclaiLogFields) => {
    try {
      if (fields === undefined) {
        logger[name](scrub(message));
        return;
      }
      const clean: SeclaiLogFields = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        clean[key] = typeof value === "string" ? scrub(value) : value;
      }
      logger[name](scrub(message), clean);
    } catch {
      // A broken logger must not break the request.
    }
  };
  return { debug: method("debug"), info: method("info"), warn: method("warn"), error: method("error") };
}
