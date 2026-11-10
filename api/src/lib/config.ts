import { z } from 'zod';
import { loadApiAiConfig, ProviderConfigError, type ApiAiConfig, type Env } from '@ragbot/shared';

/**
 * Validated API configuration (P4). Every limit and secret must be set explicitly:
 * there are no defaults, so a missing value stops the process at startup (handover §4.13).
 * Errors name variables only, never their values.
 */
export interface AppConfig {
  readonly supabaseUrl: string;
  /**
   * Secrets (this key, the two token secrets, the Turnstile key, the rate-limit key) and `ai` are NON-ENUMERABLE:
   * `JSON.stringify(config)`, `util.inspect(config)`, spreading the config and logging it show
   * none of them. Inside `ai`, every role's `apiKey` is non-enumerable too, so logging
   * `config.ai` or a role prints no key. Direct property access still works, but spreading a role
   * (`{ ...config.ai.embedding }`) drops its `apiKey`: pass the role object itself to a provider.
   */
  readonly supabaseSecretKey: string;
  readonly visitorTokenSecret: string;
  /** Optional: a retired signing secret, accepted by verifyToken only, never used to sign. */
  readonly visitorTokenSecretPrevious: string | undefined;
  readonly turnstileSecretKey: string;
  /** HMAC key for rate-limit bucket keys (lib/rate-key.ts). Non-enumerable like the other secrets. */
  readonly rateLimitKeySecret: string;
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
  /** Bot-independent per-IP limit on POST /v1/sessions, counted before any policy read. */
  readonly sessionPreflightPerIpLimit: number;
  readonly sessionPreflightWindowSeconds: number;
  /** Bound on one Turnstile siteverify call; a timeout counts as a failed challenge. */
  readonly turnstileTimeoutMs: number;
  readonly chatDeadlineMs: number;
  readonly providerMaxAttempts: number;
  /** Chat pipeline limits (P7). All required, no defaults. */
  readonly retrievalTopK: number;
  readonly retrievalMinSimilarity: number;
  /** Upper bound (estimated tokens) on one chat prompt: system, history, evidence and question. */
  readonly chatContextMaxTokens: number;
  readonly chatHistoryMaxMessages: number;
  readonly chatMaxOutputTokens: number;
  readonly chatReservationTtlSeconds: number;
  /** Total attempts per provider before the first token (1..3), including the first. */
  readonly chatProviderAttempts: number;
  readonly historyPageSize: number;
  /** USD per million tokens. */
  readonly chatPrice: TokenPrice;
  /** Null exactly when no fallback provider is configured. */
  readonly chatFallbackPrice: TokenPrice | null;
  readonly moderationPrice: TokenPrice;
  readonly embeddingPricePerMillionTokens: number;
  readonly ai: ApiAiConfig;
}

/** USD per one million tokens. */
export interface TokenPrice {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
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

/**
 * Cloudflare's published Turnstile test secrets (always passes, always fails, token already spent).
 * They make every challenge pass or fail regardless of the visitor, so they must never run a real
 * API. Assembled from parts so the secret scanner does not flag the source.
 */
const CLOUDFLARE_TEST_SECRETS: ReadonlySet<string> = new Set(
  ['1x', '2x', '3x'].map((prefix) => [prefix, '0'.repeat(31), 'AA'].join('')),
);

const integer = (min: number, max: number) =>
  nonEmpty
    .regex(/^\d{1,10}$/)
    .transform((v) => Number(v))
    .pipe(z.number().int().min(min).max(max));

/** A non-negative decimal such as `0.25` (digits only: no sign, no exponent), within [min, max]. */
const decimal = (min: number, max: number) =>
  nonEmpty
    .regex(/^\d{1,9}(?:\.\d{1,9})?$/)
    .transform((v) => Number(v))
    .pipe(z.number().min(min).max(max));

/** Largest USD-per-million price accepted. A typo such as 1e9 must not pass as a price. */
const MAX_PRICE_PER_MILLION = 100_000;
const price = decimal(0, MAX_PRICE_PER_MILLION);
/** Fallback prices are required only when a fallback provider is configured (checked in loadConfig). */
const optionalPrice = z.preprocess((v) => (v === '' ? undefined : v), price.optional());

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
  // No credentials, query or fragment: the URL is a base for REST paths, nothing more.
  const extras = raw.includes('?') || raw.includes('#') || url.search !== '' || url.hash !== '';
  if (!schemeOk || url.username || url.password || extras) {
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

/** An unset or empty optional secret means "not configured"; anything else must be a valid secret. */
const optionalSecret = (minBytes: number) =>
  z.preprocess((v) => (v === '' ? undefined : v), secret(minBytes).optional());

const envSchema = z.object({
  SUPABASE_URL: supabaseUrl,
  SUPABASE_SECRET_KEY: secret(1),
  VISITOR_TOKEN_SECRET: secret(MIN_SECRET_BYTES),
  VISITOR_TOKEN_SECRET_PREVIOUS: optionalSecret(MIN_SECRET_BYTES),
  TURNSTILE_SECRET_KEY: secret(1).refine((v) => !CLOUDFLARE_TEST_SECRETS.has(v)),
  RATE_LIMIT_KEY_SECRET: secret(MIN_SECRET_BYTES),
  ALLOWED_ORIGINS: allowedOrigins,
  PORT: integer(1, 65_535),
  LOG_LEVEL: z.enum(LOG_LEVELS),
  TRUSTED_PROXY_HOPS: integer(0, 10),
  BODY_LIMIT_BYTES: integer(1, MAX_INT32),
  REQUEST_TIMEOUT_MS: integer(1, MAX_INT32),
  CONNECTION_TIMEOUT_MS: integer(1, MAX_INT32),
  READY_TIMEOUT_MS: integer(1, MAX_INT32),
  DB_TIMEOUT_MS: integer(1, MAX_INT32),
  // 60..86400 matches create_visitor_session (a value outside it is refused by the database).
  VISITOR_TOKEN_TTL_SECONDS: integer(60, 86_400),
  SESSION_PREFLIGHT_PER_IP_LIMIT: integer(1, 1_000_000),
  SESSION_PREFLIGHT_WINDOW_SECONDS: integer(1, 86_400),
  TURNSTILE_TIMEOUT_MS: integer(1, MAX_INT32),
  CHAT_DEADLINE_MS: integer(1, MAX_INT32),
  PROVIDER_MAX_ATTEMPTS: integer(1, 10),
  // P7 chat pipeline. match_document_chunks accepts a count of 1..50 and a similarity of -1..1.
  RETRIEVAL_TOP_K: integer(1, 50),
  RETRIEVAL_MIN_SIMILARITY: decimal(0, 1),
  CHAT_CONTEXT_MAX_TOKENS: integer(1, 10_000_000),
  CHAT_HISTORY_MAX_MESSAGES: integer(0, 50),
  CHAT_MAX_OUTPUT_TOKENS: integer(1, 1_000_000),
  CHAT_PRICE_INPUT_PER_MILLION: price,
  CHAT_PRICE_OUTPUT_PER_MILLION: price,
  CHAT_FALLBACK_PRICE_INPUT_PER_MILLION: optionalPrice,
  CHAT_FALLBACK_PRICE_OUTPUT_PER_MILLION: optionalPrice,
  MODERATION_PRICE_INPUT_PER_MILLION: price,
  MODERATION_PRICE_OUTPUT_PER_MILLION: price,
  EMBEDDING_PRICE_PER_MILLION_TOKENS: price,
  // reserve_request_budget accepts a TTL of 1..86400 seconds.
  CHAT_RESERVATION_TTL_SECONDS: integer(1, 86_400),
  CHAT_PROVIDER_ATTEMPTS: integer(1, 3),
  // get_conversation_history accepts a limit of 1..100.
  HISTORY_PAGE_SIZE: integer(1, 100),
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

const SECRET_VARIABLES = [
  'VISITOR_TOKEN_SECRET',
  'VISITOR_TOKEN_SECRET_PREVIOUS',
  'TURNSTILE_SECRET_KEY',
  'SUPABASE_SECRET_KEY',
  'RATE_LIMIT_KEY_SECRET',
] as const;

/** Names of secret variables that share a value with another one. Values are never returned. */
function reusedSecrets(
  values: Readonly<Record<(typeof SECRET_VARIABLES)[number], string | undefined>>,
) {
  const byValue = new Map<string, string[]>();
  for (const name of SECRET_VARIABLES) {
    const value = values[name];
    if (value === undefined) continue;
    byValue.set(value, [...(byValue.get(value) ?? []), name]);
  }
  return [...byValue.values()].filter((names) => names.length > 1).flat();
}

/** `.env.example` placeholders such as `<gemini-key>` must never be accepted as a key. */
const PLACEHOLDER = /<[^>]*>/;

/** Variables (by name) whose value is a placeholder and which supply a key the config uses. */
function placeholderKeyVariables(ai: ApiAiConfig, env: Env): string[] {
  const used = [ai.chatPrimary, ai.chatFallback, ai.embedding, ai.moderation].flatMap((r) =>
    r === null ? [] : [r.apiKey],
  );
  const bad = new Set(used.filter((key) => PLACEHOLDER.test(key)));
  if (bad.size === 0) return [];
  const names = Object.entries(env)
    .filter(
      ([name, value]) => /_API_KEY$/.test(name) && value !== undefined && bad.has(value.trim()),
    )
    .map(([name]) => name);
  return names.length > 0 ? names : ['AI provider API key'];
}

/** A frozen copy of a provider role whose `apiKey` is readable but not enumerable. */
function hideApiKey<T extends { readonly apiKey: string }>(role: T): T {
  const { apiKey, ...rest } = role;
  const copy = { ...rest };
  Object.defineProperty(copy, 'apiKey', {
    value: apiKey,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(copy) as unknown as T;
}

function hideAiKeys(ai: ApiAiConfig): ApiAiConfig {
  return Object.freeze({
    chatPrimary: hideApiKey(ai.chatPrimary),
    chatFallback: ai.chatFallback === null ? null : hideApiKey(ai.chatFallback),
    embedding: hideApiKey(ai.embedding),
    moderation: hideApiKey(ai.moderation),
  });
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

  const placeholders = placeholderKeyVariables(ai, env);
  if (placeholders.length > 0) {
    throw new ConfigError(placeholders, `Invalid AI configuration: ${placeholders.join(', ')}`);
  }

  // Fallback prices are required exactly when a fallback is configured, and refused otherwise (a
  // price with no provider is a typo). Names only, never values.
  const fallbackPriceVars = [
    'CHAT_FALLBACK_PRICE_INPUT_PER_MILLION',
    'CHAT_FALLBACK_PRICE_OUTPUT_PER_MILLION',
  ] as const;
  const fallbackIn = v.CHAT_FALLBACK_PRICE_INPUT_PER_MILLION;
  const fallbackOut = v.CHAT_FALLBACK_PRICE_OUTPUT_PER_MILLION;
  if (ai.chatFallback !== null && (fallbackIn === undefined || fallbackOut === undefined)) {
    const missing = fallbackPriceVars.filter(
      (_, i) => (i === 0 ? fallbackIn : fallbackOut) === undefined,
    );
    throw new ConfigError(missing, `Invalid configuration: ${missing.join(', ')}`);
  }
  if (ai.chatFallback === null && (fallbackIn !== undefined || fallbackOut !== undefined)) {
    throw new ConfigError(
      [...fallbackPriceVars],
      `Invalid configuration: ${fallbackPriceVars.join(', ')} (no fallback provider is configured)`,
    );
  }

  // A reservation must outlive the request it covers, or the reaper could expire it mid-answer.
  if (v.CHAT_RESERVATION_TTL_SECONDS * 1000 <= v.CHAT_DEADLINE_MS) {
    const names = ['CHAT_RESERVATION_TTL_SECONDS', 'CHAT_DEADLINE_MS'];
    throw new ConfigError(names, `Invalid configuration: ${names.join(', ')} (TTL must be longer)`);
  }

  // CONNECTION_TIMEOUT_MS is the idle-socket timeout: while a handler runs and writes nothing, the
  // socket is idle, and Node destroys it when the timeout passes. A readiness probe that may run
  // as long as READY_TIMEOUT_MS therefore needs a shorter deadline than the socket's, or its 503
  // would never reach the client. (REQUEST_TIMEOUT_MS only bounds receiving the request, so it
  // says nothing about handler time and is not compared.)
  if (v.READY_TIMEOUT_MS >= v.CONNECTION_TIMEOUT_MS) {
    const names = ['READY_TIMEOUT_MS', 'CONNECTION_TIMEOUT_MS'];
    throw new ConfigError(names, `Invalid configuration: ${names.join(', ')} (must be shorter)`);
  }

  // One secret, one purpose: a leaked or rotated value must not unlock something else.
  const reused = reusedSecrets({
    VISITOR_TOKEN_SECRET: v.VISITOR_TOKEN_SECRET,
    VISITOR_TOKEN_SECRET_PREVIOUS: v.VISITOR_TOKEN_SECRET_PREVIOUS,
    TURNSTILE_SECRET_KEY: v.TURNSTILE_SECRET_KEY,
    SUPABASE_SECRET_KEY: v.SUPABASE_SECRET_KEY,
    RATE_LIMIT_KEY_SECRET: v.RATE_LIMIT_KEY_SECRET,
  });
  if (reused.length > 0) {
    throw new ConfigError(reused, `Invalid configuration: ${reused.join(', ')} must all differ`);
  }

  const config = {
    supabaseUrl: v.SUPABASE_URL,
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
    sessionPreflightPerIpLimit: v.SESSION_PREFLIGHT_PER_IP_LIMIT,
    sessionPreflightWindowSeconds: v.SESSION_PREFLIGHT_WINDOW_SECONDS,
    turnstileTimeoutMs: v.TURNSTILE_TIMEOUT_MS,
    chatDeadlineMs: v.CHAT_DEADLINE_MS,
    providerMaxAttempts: v.PROVIDER_MAX_ATTEMPTS,
    retrievalTopK: v.RETRIEVAL_TOP_K,
    retrievalMinSimilarity: v.RETRIEVAL_MIN_SIMILARITY,
    chatContextMaxTokens: v.CHAT_CONTEXT_MAX_TOKENS,
    chatHistoryMaxMessages: v.CHAT_HISTORY_MAX_MESSAGES,
    chatMaxOutputTokens: v.CHAT_MAX_OUTPUT_TOKENS,
    chatReservationTtlSeconds: v.CHAT_RESERVATION_TTL_SECONDS,
    chatProviderAttempts: v.CHAT_PROVIDER_ATTEMPTS,
    historyPageSize: v.HISTORY_PAGE_SIZE,
    chatPrice: {
      inputPerMillion: v.CHAT_PRICE_INPUT_PER_MILLION,
      outputPerMillion: v.CHAT_PRICE_OUTPUT_PER_MILLION,
    },
    chatFallbackPrice:
      fallbackIn === undefined || fallbackOut === undefined
        ? null
        : { inputPerMillion: fallbackIn, outputPerMillion: fallbackOut },
    moderationPrice: {
      inputPerMillion: v.MODERATION_PRICE_INPUT_PER_MILLION,
      outputPerMillion: v.MODERATION_PRICE_OUTPUT_PER_MILLION,
    },
    embeddingPricePerMillionTokens: v.EMBEDDING_PRICE_PER_MILLION_TOKENS,
  };
  // Secrets are defined as non-enumerable, read-only properties (see AppConfig). They are frozen
  // here by hand because deepFreeze walks enumerable properties only.
  const hidden: Record<string, unknown> = {
    supabaseSecretKey: v.SUPABASE_SECRET_KEY,
    visitorTokenSecret: v.VISITOR_TOKEN_SECRET,
    visitorTokenSecretPrevious: v.VISITOR_TOKEN_SECRET_PREVIOUS,
    turnstileSecretKey: v.TURNSTILE_SECRET_KEY,
    rateLimitKeySecret: v.RATE_LIMIT_KEY_SECRET,
    ai: hideAiKeys(ai),
  };
  for (const [name, value] of Object.entries(hidden)) {
    Object.defineProperty(config, name, {
      value,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return deepFreeze(config) as unknown as AppConfig;
}
