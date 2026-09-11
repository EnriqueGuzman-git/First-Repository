/**
 * Structured JSON logger: one object per line to stdout (info/debug) or stderr
 * (warn/error). Under NODE_ENV=test all output is suppressed unless LOG_LEVEL is
 * set, keeping test output clean.
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
