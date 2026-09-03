/**
 * @file logger.ts
 * @description Structured JSON logger.
 *
 * Writes JSON lines to stdout (info/debug) and stderr (warn/error).
 * In test environments (NODE_ENV=test) all output is suppressed unless
 * LOG_LEVEL=debug is explicitly set, keeping test output clean.
 *
 * Each log line is a single JSON object:
 *   { level, service, timestamp, traceId?, msg, ...fields }
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function resolveMinLevel(): number {
  const env = process.env['LOG_LEVEL']?.toLowerCase() as LogLevel | undefined;
  if (env && env in LEVELS) return LEVELS[env]!;
  if (process.env['NODE_ENV'] === 'test') return 4; // silence everything in tests
  return LEVELS['info']!;
}

const MIN_LEVEL = resolveMinLevel();
const SERVICE   = process.env['SERVICE_NAME'] ?? 'tictactoe-server';

function write(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < MIN_LEVEL) return;

  const line = JSON.stringify({
    level,
    service: SERVICE,
    timestamp: new Date().toISOString(),
    msg,
    ...fields,
  });

  if (level === 'warn' || level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info:  (msg: string, fields?: Record<string, unknown>) => write('info',  msg, fields),
  warn:  (msg: string, fields?: Record<string, unknown>) => write('warn',  msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
};

/** Attach a traceId to every call in a request scope. */
export function withTrace(traceId: string): typeof logger {
  return {
    debug: (msg, f) => logger.debug(msg, { traceId, ...f }),
    info:  (msg, f) => logger.info(msg,  { traceId, ...f }),
    warn:  (msg, f) => logger.warn(msg,  { traceId, ...f }),
    error: (msg, f) => logger.error(msg, { traceId, ...f }),
  };
}
