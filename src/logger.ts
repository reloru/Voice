/**
 * Fastify bundles pino, so we reuse its logger type rather than adding a
 * second logging dependency. `Logger` is the small surface the rest of the app
 * relies on, which also keeps it trivial to stub in tests.
 */
export interface Logger {
  fatal(obj: object, msg?: string): void;
  fatal(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  debug(obj: object, msg?: string): void;
  debug(msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** No-op logger for tests and CLI paths that should stay quiet. */
export const silentLogger: Logger = {
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => silentLogger,
};

/** Minimal console logger for the CLI, where pino's JSON output is noise. */
export function createConsoleLogger(level: "info" | "debug" = "info"): Logger {
  const write = (stream: "log" | "warn" | "error", obj: object | string, msg?: string) => {
    if (typeof obj === "string") console[stream](obj);
    else console[stream](msg ?? "", obj);
  };
  const logger: Logger = {
    fatal: (obj: object | string, msg?: string) => write("error", obj, msg),
    error: (obj: object | string, msg?: string) => write("error", obj, msg),
    warn: (obj: object | string, msg?: string) => write("warn", obj, msg),
    info: (obj: object | string, msg?: string) => write("log", obj, msg),
    debug: (obj: object | string, msg?: string) => {
      if (level === "debug") write("log", obj, msg);
    },
    child: () => logger,
  };
  return logger;
}
