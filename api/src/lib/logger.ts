import { randomUUID } from 'node:crypto';
import type { FastifyServerOptions } from 'fastify';
import type { LogLevel } from './config.js';

/**
 * Structured logging for Fastify's built-in pino logger (P4).
 *
 * RULE FOR EVERY LATER ROUTE: log only ids, counts and codes (request id, bot id, session id,
 * number of chunks, error code, status). Never a message, question, prompt, answer, chunk text,
 * history, document body, token, key or header value. Nothing sensitive is logged by design:
 * request logs carry method, path (no query string), status and duration only. The redaction
 * list below is a second line of defence for anything a route logs by mistake, not permission to
 * log those fields (handover §4, CLAUDE.md invariants).
 */

const REDACTED_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'apikey',
  'x-visitor-token',
  'x-turnstile-token',
  'idempotency-key',
] as const;

const REDACTED_FIELDS = [
  'message',
  'content',
  'text',
  'question',
  'body',
  'prompt',
  'history',
  'chunks',
  'token',
  'secret',
  'password',
  'email',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'apiKey',
  'accessToken',
  'access_token',
  'refresh_token',
  'visitor_token',
  'turnstile_token',
  'secret_key',
  'idempotency_key',
] as const;

/** "Authorization", "ApiKey", "AccessToken": first letter upper-cased. */
const capitalised = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);
/** "X-Visitor-Token", "Set-Cookie": every hyphen-separated part capitalised. */
const titleCased = (name: string): string => name.split('-').map(capitalised).join('-');

const FIELD_NAMES = [...new Set([...REDACTED_FIELDS, ...REDACTED_FIELDS.map(capitalised)])];
const HEADER_NAMES = [...new Set([...REDACTED_HEADERS, ...REDACTED_HEADERS.map(titleCased)])];

/** Wildcard prefixes up to four levels deep: pino cannot redact "at any depth". */
const PREFIXES = ['', '*.', '*.*.', '*.*.*.', '*.*.*.*.'] as const;

export const REDACT_PATHS: readonly string[] = Object.freeze([
  ...PREFIXES.flatMap((p) => FIELD_NAMES.map((f) => `${p}${f}`)),
  ...PREFIXES.flatMap((p) => HEADER_NAMES.map((h) => `${p}headers["${h}"]`)),
  ...PREFIXES.flatMap((p) => HEADER_NAMES.map((h) => `${p}["${h}"]`)),
]);

/** Fresh server-generated id; a client-supplied request id is never trusted. */
export function generateRequestId(): string {
  return randomUUID();
}

function pathOnly(url: unknown): string {
  if (typeof url !== 'string') return '';
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

type LoggerOptions = Exclude<FastifyServerOptions['logger'], boolean | undefined>;

const serializers = {
  req: (req: { method?: unknown; url?: unknown }) => ({
    method: req.method,
    path: pathOnly(req.url),
  }),
  res: (res: { statusCode?: unknown }) => ({ statusCode: res.statusCode }),
  // Error messages can carry upstream bodies or secrets: log the class and code only.
  err: (err: { name?: unknown; code?: unknown }) => ({
    type: typeof err?.name === 'string' ? err.name : 'Error',
    code: typeof err?.code === 'string' ? err.code : undefined,
  }),
} as unknown as NonNullable<LoggerOptions['serializers']>;

export function buildLoggerOptions(level: LogLevel): LoggerOptions {
  return {
    level,
    base: null,
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    redact: { paths: [...REDACT_PATHS], censor: '[Redacted]' },
    serializers,
  };
}
