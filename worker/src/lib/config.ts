import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  loadWorkerAiConfig,
  ProviderConfigError,
  type Env,
  type WorkerAiConfig,
} from '@ragbot/shared';
import { assertWorkerEnv } from '../env-guard.js';
import { maxEmbeddingBatchSize, MAX_WRITE_BATCH } from './embeddings.js';
import { LOG_LEVELS, type LogLevel } from './logger.js';

/**
 * Validated worker configuration (P6-QUEUE). Every limit and secret must be set explicitly: there
 * are no defaults for limits, so a missing value stops the process at start-up (handover section
 * 4.13). Errors name variables only, never their values. The one optional variable is WORKER_ID.
 * The worker id is always `<base>-<random>`: the base is WORKER_ID, or the host name and process
 * id, and the random suffix is new on every start, so two processes (or a restart) never share a
 * lease owner name.
 */
export interface WorkerConfig {
  readonly supabaseUrl: string;
  /**
   * NON-ENUMERABLE, like `ai` and every role's `apiKey` inside it: JSON.stringify, util.inspect
   * and spreading the config show none of them. Direct property access still works.
   */
  readonly supabaseSecretKey: string;
  readonly logLevel: LogLevel;
  readonly workerId: string;
  readonly dbTimeoutMs: number;
  readonly storageTimeoutMs: number;
  /** Jobs running at once in this process. Also the most one poll may claim. */
  readonly concurrency: number;
  readonly leaseSeconds: number;
  readonly heartbeatIntervalMs: number;
  readonly pollIntervalMs: number;
  /** retry_job_later delay: min(backoffMax, backoffBase * 2^(attempt-1)) with jitter. */
  readonly backoffBaseSeconds: number;
  readonly backoffMaxSeconds: number;
  /** On SIGTERM/SIGINT: how long running jobs may finish before they are aborted. */
  readonly shutdownGraceMs: number;
  readonly maintenanceIntervalSeconds: number;
  /** Batch for session, run, reservation, conversation, entry, job and upload cleanup (1..10000). */
  readonly retentionBatchSize: number;
  /** Batch for rate-limit bucket, cache and usage purges (1..100000). */
  readonly purgeBatchSize: number;
  readonly stuckRunThresholdSeconds: number;
  readonly chatDeadlineMs: number;
  readonly visitorSessionGraceSeconds: number;
  readonly terminalJobRetentionDays: number;
  /** At least 24: an upload may legitimately take a while to be registered. */
  readonly abandonedUploadHours: number;
  /** Hard cap on one object download, applied on top of the row's byte_size and max_bytes. */
  readonly maxDownloadBytes: number;
  /** Most chunks one document version may produce; more fails the version FILE_UNSUPPORTED. */
  readonly maxChunksPerVersion: number;
  /** Extraction limits (agreed with the extraction module). max_bytes and max_pages come from the database. */
  readonly extraction: {
    readonly maxExtractedChars: number;
    readonly timeoutMs: number;
    readonly childMemoryMb: number;
  };
  /** Chunks embedded per provider call. */
  readonly embeddingBatchSize: number;
  /** US dollars per million input tokens, for budget estimates. */
  readonly embeddingPricePerMillionTokens: number;
  readonly ai: WorkerAiConfig;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  /** Names of the offending environment variables. Never values. */
  readonly variables: readonly string[];
  constructor(variables: readonly string[], message: string) {
    super(message);
    this.variables = Object.freeze([...variables]);
  }
}

/**
 * The reaper must not fail a run that is still legitimately streaming, or one whose settle is
 * still in flight: STUCK_RUN_THRESHOLD_SECONDS >= CHAT_DEADLINE_MS / 1000 + this margin (status
 * section 3a av).
 */
export const STUCK_RUN_MARGIN_SECONDS = 60;

const MAX_INT32 = 2_147_483_647;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const nonEmpty = z.string().trim().min(1);

const integer = (min: number, max: number) =>
  nonEmpty
    .regex(/^\d{1,10}$/)
    .transform((v) => Number(v))
    .pipe(z.number().int().min(min).max(max));

/** A non-negative decimal such as `0.15`. Not exponent notation, not negative, bounded. */
const decimal = (max: number) =>
  nonEmpty
    .regex(/^\d{1,6}(\.\d{1,6})?$/)
    .transform((v) => Number(v))
    .pipe(z.number().finite().min(0).max(max));

/** Rejects `.env.example` placeholders such as `<server-only-secret-key>`. */
const secret = nonEmpty.refine((v) => !/<[^>]*>/.test(v));

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
  const extras = raw.includes('?') || raw.includes('#') || url.search !== '' || url.hash !== '';
  if (!schemeOk || url.username || url.password || extras) {
    ctx.issues.push({ code: 'custom', message: 'invalid', input: raw });
    return z.NEVER;
  }
  return url.toString().replace(/\/$/, '');
});

/** Logged on every line and sent to the database as a lease owner: a short, plain token. */
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/;
/** WORKER_ID is the base of the id; `-` and 6 hex characters are added, and the id stays within 63. */
const WORKER_ID_SUFFIX_LENGTH = 7;
const WORKER_ID_BASE_MAX = 63 - WORKER_ID_SUFFIX_LENGTH;

const optionalWorkerId = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z
    .string()
    .regex(WORKER_ID)
    .refine((v) => v.length <= WORKER_ID_BASE_MAX)
    .optional(),
);

const envSchema = z.object({
  SUPABASE_URL: supabaseUrl,
  SUPABASE_SECRET_KEY: secret,
  LOG_LEVEL: z.enum(LOG_LEVELS),
  WORKER_ID: optionalWorkerId,
  DB_TIMEOUT_MS: integer(1, MAX_INT32),
  STORAGE_TIMEOUT_MS: integer(1, MAX_INT32),
  // claim_jobs accepts a limit of 1..100.
  WORKER_CONCURRENCY: integer(1, 100),
  // claim_jobs and heartbeat_job accept 1..3600.
  JOB_LEASE_SECONDS: integer(5, 3600),
  JOB_HEARTBEAT_INTERVAL_SECONDS: integer(1, 1200),
  JOB_POLL_INTERVAL_MS: integer(100, 3_600_000),
  // retry_job_later accepts a delay of 1..3600 seconds.
  JOB_BACKOFF_BASE_SECONDS: integer(1, 3600),
  JOB_BACKOFF_MAX_SECONDS: integer(1, 3600),
  SHUTDOWN_GRACE_MS: integer(0, 3_600_000),
  MAINTENANCE_INTERVAL_SECONDS: integer(5, 86_400),
  RETENTION_BATCH_SIZE: integer(1, 10_000),
  PURGE_BATCH_SIZE: integer(1, 100_000),
  // expire_stuck_request_runs accepts 60..86400.
  STUCK_RUN_THRESHOLD_SECONDS: integer(60, 86_400),
  CHAT_DEADLINE_MS: integer(1, MAX_INT32),
  // expire_visitor_sessions accepts a grace of 1..86400; purge_terminal_jobs 1..3650 days.
  VISITOR_SESSION_GRACE_SECONDS: integer(1, 86_400),
  TERMINAL_JOB_RETENTION_DAYS: integer(1, 3650),
  ABANDONED_UPLOAD_HOURS: integer(24, 8760),
  WORKER_MAX_DOWNLOAD_BYTES: integer(1, MAX_INT32),
  MAX_CHUNKS_PER_VERSION: integer(1, 1_000_000),
  EXTRACT_MAX_CHARS: integer(1, MAX_INT32),
  EXTRACT_TIMEOUT_MS: integer(1, 3_600_000),
  EXTRACT_CHILD_MEMORY_MB: integer(16, 16_384),
  // write_document_chunks accepts at most 200 chunks per call.
  EMBEDDING_BATCH_SIZE: integer(1, MAX_WRITE_BATCH),
  EMBEDDING_PRICE_PER_MILLION_TOKENS: decimal(10_000),
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

const PLACEHOLDER = /<[^>]*>/;

function placeholderKeyVariables(ai: WorkerAiConfig, env: Env): string[] {
  const used = [ai.embedding, ai.analysis].map((r) => r.apiKey);
  const bad = new Set(used.filter((key) => PLACEHOLDER.test(key)));
  if (bad.size === 0) return [];
  const names = Object.entries(env)
    .filter(
      ([name, value]) => /_API_KEY$/.test(name) && value !== undefined && bad.has(value.trim()),
    )
    .map(([name]) => name);
  return names.length > 0 ? names : ['AI provider API key'];
}

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

/** `host-pid`, reduced to the characters a worker id may carry. */
function defaultWorkerIdBase(): string {
  const host = hostname()
    .replace(/[^A-Za-z0-9.-]/g, '-')
    .slice(0, 30);
  const base = host.length > 0 && /^[A-Za-z0-9]/.test(host) ? host : 'worker';
  return `${base}-${String(process.pid)}`;
}

/** `<base>-<6 random hex>`. Always random, even when the operator names the worker. */
export function generateWorkerId(base: string = defaultWorkerIdBase()): string {
  return `${base}-${randomBytes(3).toString('hex')}`;
}

/** Validates the environment and returns a deeply frozen config. Throws ConfigError (or the env guard's Error). */
export function loadWorkerConfig(env: Env): WorkerConfig {
  // API-only secrets (VISITOR_TOKEN_SECRET and friends) must not reach the worker at all.
  assertWorkerEnv(env);

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? 'unknown')))];
    throw new ConfigError(names, `Invalid configuration: ${names.join(', ')}`);
  }
  const v = parsed.data;

  let ai: WorkerAiConfig;
  try {
    ai = loadWorkerAiConfig(env);
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      throw new ConfigError(variablesIn(err.message), `Invalid AI configuration: ${err.message}`);
    }
    throw new ConfigError([], 'Invalid AI configuration');
  }
  const placeholders = placeholderKeyVariables(ai, env);
  if (placeholders.length > 0) {
    throw new ConfigError(placeholders, `Invalid AI configuration: ${placeholders.join(', ')}`);
  }

  const relations: [string[], boolean][] = [
    // The heartbeat must fire several times per lease so one slow or lost call cannot lose the job.
    [
      ['JOB_HEARTBEAT_INTERVAL_SECONDS', 'JOB_LEASE_SECONDS'],
      v.JOB_HEARTBEAT_INTERVAL_SECONDS * 3 > v.JOB_LEASE_SECONDS,
    ],
    [
      ['JOB_BACKOFF_BASE_SECONDS', 'JOB_BACKOFF_MAX_SECONDS'],
      v.JOB_BACKOFF_BASE_SECONDS > v.JOB_BACKOFF_MAX_SECONDS,
    ],
    // A heartbeat call that hangs for the whole database timeout must still end well inside the lease.
    [['DB_TIMEOUT_MS', 'JOB_LEASE_SECONDS'], v.DB_TIMEOUT_MS * 2 > v.JOB_LEASE_SECONDS * 1000],
    // One batch is one provider request: the configured provider must accept that many inputs.
    [
      ['EMBEDDING_BATCH_SIZE', 'EMBEDDING_PROVIDER'],
      v.EMBEDDING_BATCH_SIZE > maxEmbeddingBatchSize(ai.embedding.provider),
    ],
    [
      ['STUCK_RUN_THRESHOLD_SECONDS', 'CHAT_DEADLINE_MS'],
      v.STUCK_RUN_THRESHOLD_SECONDS * 1000 < v.CHAT_DEADLINE_MS + STUCK_RUN_MARGIN_SECONDS * 1000,
    ],
  ];
  for (const [names, violated] of relations) {
    if (violated) {
      throw new ConfigError(names, `Invalid configuration: ${names.join(', ')} (inconsistent)`);
    }
  }

  const config = {
    supabaseUrl: v.SUPABASE_URL,
    logLevel: v.LOG_LEVEL,
    workerId: v.WORKER_ID === undefined ? generateWorkerId() : generateWorkerId(v.WORKER_ID),
    dbTimeoutMs: v.DB_TIMEOUT_MS,
    storageTimeoutMs: v.STORAGE_TIMEOUT_MS,
    concurrency: v.WORKER_CONCURRENCY,
    leaseSeconds: v.JOB_LEASE_SECONDS,
    heartbeatIntervalMs: v.JOB_HEARTBEAT_INTERVAL_SECONDS * 1000,
    pollIntervalMs: v.JOB_POLL_INTERVAL_MS,
    backoffBaseSeconds: v.JOB_BACKOFF_BASE_SECONDS,
    backoffMaxSeconds: v.JOB_BACKOFF_MAX_SECONDS,
    shutdownGraceMs: v.SHUTDOWN_GRACE_MS,
    maintenanceIntervalSeconds: v.MAINTENANCE_INTERVAL_SECONDS,
    retentionBatchSize: v.RETENTION_BATCH_SIZE,
    purgeBatchSize: v.PURGE_BATCH_SIZE,
    stuckRunThresholdSeconds: v.STUCK_RUN_THRESHOLD_SECONDS,
    chatDeadlineMs: v.CHAT_DEADLINE_MS,
    visitorSessionGraceSeconds: v.VISITOR_SESSION_GRACE_SECONDS,
    terminalJobRetentionDays: v.TERMINAL_JOB_RETENTION_DAYS,
    abandonedUploadHours: v.ABANDONED_UPLOAD_HOURS,
    maxDownloadBytes: v.WORKER_MAX_DOWNLOAD_BYTES,
    maxChunksPerVersion: v.MAX_CHUNKS_PER_VERSION,
    extraction: {
      maxExtractedChars: v.EXTRACT_MAX_CHARS,
      timeoutMs: v.EXTRACT_TIMEOUT_MS,
      childMemoryMb: v.EXTRACT_CHILD_MEMORY_MB,
    },
    embeddingBatchSize: v.EMBEDDING_BATCH_SIZE,
    embeddingPricePerMillionTokens: v.EMBEDDING_PRICE_PER_MILLION_TOKENS,
  };
  const hidden: Record<string, unknown> = {
    supabaseSecretKey: v.SUPABASE_SECRET_KEY,
    ai: Object.freeze({
      embedding: hideApiKey(ai.embedding),
      analysis: hideApiKey(ai.analysis),
    }),
  };
  for (const [name, value] of Object.entries(hidden)) {
    Object.defineProperty(config, name, {
      value,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return deepFreeze(config) as unknown as WorkerConfig;
}
