// Minimal leveled logger. The runner has no server/pino dependency; keep this tiny and dependency-free.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** All log lines go to stderr so stdout stays free for any future machine-readable output. */
export function createLogger(minLevel: LogLevel = 'info'): Logger {
  const min = LEVELS[minLevel];
  const write = (level: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (LEVELS[level] < min) return;
    const line = { ts: new Date().toISOString(), level, msg, ...meta };
    process.stderr.write(`${JSON.stringify(line)}\n`);
  };
  return {
    debug: (msg, meta) => write('debug', msg, meta),
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
  };
}
