import { z } from 'zod';
import { loadApiAiConfig, ProviderConfigError, type ApiAiConfig, type Env } from '@ragbot/shared';

/**
 * Validated API configuration (P4). Every limit and secret must be set explicitly:
 * there are no defaults, so a missing value stops the process at startup (handover §4.13).
 * Errors name variables only, never their values.
 */
export interface AppConfig {
  readonly supabaseUrl: string;
  readonly supabaseSecretKey: string;
  readonly visitorTokenSecret: string;
  readonly turnstileSecretKey: string;
  readonly allowedOrigins: readonly string[];
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly trustedProxyHops: number;
  readonly bodyLimitBytes: number;
  readonly requestTimeoutMs: number;
  readonly connectionTimeoutMs: number;
  readonly readyTimeoutMs: number;
  readonly dbTimeoutMs: number;
  readonly visitorTokenTtlSeconds: number;
  readonly chatDeadlineMs: number;
  readonly providerMaxAttempts: number;
  readonly ai: ApiAiConfig;
}

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  /** Names of the offending environment variables. Never values. */
  readonly variables: readonly string[];
  constructor(variables: readonly string[], message: string) {
    super(message);
    this.variables = Object.freeze([...variables]);
  }
}

const MAX_INT32 = 2_147_483_647;
const MIN_SECRET_BYTES = 32;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const nonEmpty = z.string().trim().min(1);

const integer = (min: number, max: number) =>
  nonEmpty
    .regex(/^\d{1,10}$/)
    .transform((v) => Number(v))
    .pipe(z.number().int().min(min).max(max));

/** Rejects `.env.example` placeholders such as `<server-only-secret-key>`. */
const secret = (minBytes: number) =>
  nonEmpty.refine((v) => !/^<.*>$/.test(v)).refine((v) => Buffer.byteLength(v, 'utf8') >= minBytes);

const supabaseUrl = nonEmpty.transform((raw, ctx) => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    ctx.issues.push({ code: 'custom', message: 'invalid', input: raw });
    return z.NEVER;
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  const schemeOk = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
  if (!schemeOk || url.username || url.password) {
    ctx.issues.push({ code: 'custom', message: 'invalid', input: raw });
    return z.NEVER;
  }
  return url.toString().replace(/\/$/, '');
});

const allowedOrigins = nonEmpty.transform((raw, ctx) => {
  const origins: string[] = [];
  for (const entry of raw.split(',').map((s) => s.trim())) {
    let url: URL | undefined;
    try {
      url = new URL(entry);
    } catch {
      url = undefined;
    }
    const valid =
      url !== undefined &&
      !entry.includes('*') &&
      url.origin === entry &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)));
    if (!valid) {
      ctx.issues.push({ code: 'custom', message: 'invalid', input: raw });
      return z.NEVER;
    }
    if (!origins.includes(entry)) origins.push(entry);
  }
  return origins;
});

const envSchema = z.object({
  SUPABASE_URL: supabaseUrl,
  SUPABASE_SECRET_KEY: secret(1),
  VISITOR_TOKEN_SECRET: secret(MIN_SECRET_BYTES),
  TURNSTILE_SECRET_KEY: secret(1),
  ALLOWED_ORIGINS: allowedOrigins,
  PORT: integer(1, 65_535),
  LOG_LEVEL: z.enum(LOG_LEVELS),
  TRUSTED_PROXY_HOPS: integer(0, 10),
  BODY_LIMIT_BYTES: integer(1, MAX_INT32),
  REQUEST_TIMEOUT_MS: integer(1, MAX_INT32),
  CONNECTION_TIMEOUT_MS: integer(1, MAX_INT32),
  READY_TIMEOUT_MS: integer(1, MAX_INT32),
  DB_TIMEOUT_MS: integer(1, MAX_INT32),
  VISITOR_TOKEN_TTL_SECONDS: integer(1, MAX_INT32),
  CHAT_DEADLINE_MS: integer(1, MAX_INT32),
  PROVIDER_MAX_ATTEMPTS: integer(1, 10),
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Variable names found in a ProviderConfigError message (messages never include values). */
function variablesIn(message: string): string[] {
  return [...new Set(message.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])];
}

/** Validates the environment and returns a deeply frozen config. Throws ConfigError. */
export function loadConfig(env: Env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? 'unknown')))];
    throw new ConfigError(names, `Invalid configuration: ${names.join(', ')}`);
  }

  let ai: ApiAiConfig;
  try {
    ai = loadApiAiConfig(env);
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      throw new ConfigError(variablesIn(err.message), `Invalid AI configuration: ${err.message}`);
    }
    throw new ConfigError([], 'Invalid AI configuration');
  }

  const v = parsed.data;
  return deepFreeze({
    supabaseUrl: v.SUPABASE_URL,
    supabaseSecretKey: v.SUPABASE_SECRET_KEY,
    visitorTokenSecret: v.VISITOR_TOKEN_SECRET,
    turnstileSecretKey: v.TURNSTILE_SECRET_KEY,
    allowedOrigins: v.ALLOWED_ORIGINS,
    port: v.PORT,
    logLevel: v.LOG_LEVEL,
    trustedProxyHops: v.TRUSTED_PROXY_HOPS,
    bodyLimitBytes: v.BODY_LIMIT_BYTES,
    requestTimeoutMs: v.REQUEST_TIMEOUT_MS,
    connectionTimeoutMs: v.CONNECTION_TIMEOUT_MS,
    readyTimeoutMs: v.READY_TIMEOUT_MS,
    dbTimeoutMs: v.DB_TIMEOUT_MS,
    visitorTokenTtlSeconds: v.VISITOR_TOKEN_TTL_SECONDS,
    chatDeadlineMs: v.CHAT_DEADLINE_MS,
    providerMaxAttempts: v.PROVIDER_MAX_ATTEMPTS,
    ai,
  });
}
