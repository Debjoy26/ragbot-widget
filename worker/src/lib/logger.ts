// Structured, redacting logger for the worker (P6-QUEUE). One JSON line per event on stdout/stderr.
//
// RULE FOR EVERY JOB HANDLER: log only ids, counts, durations and codes (job id, document id,
// version id, chunk count, error code). Never payload text, document text, chunk text, prompts,
// keys, tokens or URLs. Two guards back that rule up, neither is permission to log such fields:
//  * a field whose NAME looks sensitive is replaced by "[Redacted]";
//  * only string, number, boolean and null values are accepted; objects, arrays and Error
//    instances are replaced by "[Omitted]" (an Error message can carry an upstream body).
// Long strings are cut, so an accidentally logged body cannot flood the log.

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Readonly<Record<string, LogValue | object>>;

export interface Logger {
  error(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  /** A logger that adds `bindings` (ids, never content) to every line. */
  child(bindings: LogFields): Logger;
}

const RANK: Record<LogLevel, number> = {
  silent: 0,
  fatal: 1,
  error: 2,
  warn: 3,
  info: 4,
  debug: 5,
  trace: 6,
};

/** Field names that are redacted wherever they appear (case-insensitive substring match). */
const SENSITIVE_NAME =
  /(message|content|text|body|prompt|question|answer|history|chunk|payload|token|secret|password|passwd|authorization|cookie|api_?key|apikey|secret_?key|key$|embedding|email|url|path)/i;

/** A NUMBER under a name like chunk_count or token_total is a count, not content: it is kept. */
const COUNT_NAME =
  /(^|_)(count|total|ms|seconds|bytes|attempts?|done|written|deleted|removed|expired|purged)$/i;

const MAX_STRING_CHARS = 200;
const MAX_FIELDS = 40;

export const REDACTED = '[Redacted]';
export const OMITTED = '[Omitted]';

/** A safe error code from anything thrown: its `code` property if it is a short token, else its class name. */
export function errorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) return code;
    const sqlstate = (err as { sqlstate?: unknown }).sqlstate;
    if (typeof sqlstate === 'string' && /^[0-9A-Z]{5}$/.test(sqlstate)) return sqlstate;
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(name)) return name;
  }
  return 'Error';
}

export function sanitizeFields(fields: LogFields | undefined): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  if (fields === undefined) return out;
  let n = 0;
  for (const [name, value] of Object.entries(fields)) {
    if (++n > MAX_FIELDS) break;
    if (SENSITIVE_NAME.test(name) && !(typeof value === 'number' && COUNT_NAME.test(name))) {
      out[name] = REDACTED;
    } else if (value === null || value === undefined || typeof value === 'boolean') {
      out[name] = value;
    } else if (typeof value === 'number') {
      out[name] = Number.isFinite(value) ? value : null;
    } else if (typeof value === 'string') {
      out[name] =
        value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}...` : value;
    } else {
      out[name] = OMITTED;
    }
  }
  return out;
}

export type LogSink = (line: string) => void;

export interface CreateLoggerOptions {
  level: LogLevel;
  /** Injected for tests only. */
  sink?: LogSink;
  /** Injected for tests only. */
  now?: () => Date;
}

function build(
  level: LogLevel,
  sink: LogSink,
  now: () => Date,
  bindings: Record<string, LogValue>,
): Logger {
  const emit = (name: LogLevel, event: string, fields: LogFields | undefined): void => {
    if (RANK[name] > RANK[level]) return;
    const line = {
      time: now().toISOString(),
      level: name,
      event: event.slice(0, MAX_STRING_CHARS),
      ...bindings,
      ...sanitizeFields(fields),
    };
    sink(JSON.stringify(line));
  };
  return {
    error: (event, fields) => {
      emit('error', event, fields);
    },
    warn: (event, fields) => {
      emit('warn', event, fields);
    },
    info: (event, fields) => {
      emit('info', event, fields);
    },
    debug: (event, fields) => {
      emit('debug', event, fields);
    },
    child: (extra) => build(level, sink, now, { ...bindings, ...sanitizeFields(extra) }),
  };
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const sink: LogSink =
    options.sink ??
    ((line) => {
      process.stdout.write(`${line}\n`);
    });
  return build(options.level, sink, options.now ?? (() => new Date()), {});
}

/** A logger that drops everything. For tests and as a safe default in fakes. */
export const silentLogger: Logger = createLogger({ level: 'silent' });
