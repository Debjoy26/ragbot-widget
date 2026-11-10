import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { loadConfig, type AppConfig } from '../../../api/src/lib/config.ts';
import { buildLoggerOptions } from '../../../api/src/lib/logger.ts';
import type { Db } from '../../../api/src/lib/supabase.ts';
import { buildServer, type ServerDeps } from '../../../api/src/server.ts';
import type { VisitorAuth } from '../../../api/src/services/auth.ts';
import type { Limits } from '../../../api/src/services/limits.ts';
import type { Runs } from '../../../api/src/services/runs.ts';
import type { TurnstileVerifier } from '../../../api/src/services/turnstile.ts';

// FAKE values for tests only, random per run. None of these is a real credential.
function hex32(): string {
  return randomBytes(32).toString('hex');
}

export const FAKE_SUPABASE_KEY = hex32();
export const FAKE_VISITOR_SECRET = hex32();
export const FAKE_TURNSTILE_KEY = hex32();
export const FAKE_AI_KEY = hex32();
export const FAKE_RATE_KEY = hex32();

export function validEnv(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    SUPABASE_URL: 'https://fakeproject.supabase.co',
    SUPABASE_SECRET_KEY: FAKE_SUPABASE_KEY,
    VISITOR_TOKEN_SECRET: FAKE_VISITOR_SECRET,
    TURNSTILE_SECRET_KEY: FAKE_TURNSTILE_KEY,
    RATE_LIMIT_KEY_SECRET: FAKE_RATE_KEY,
    ALLOWED_ORIGINS: 'https://client.example.com,https://other.example.com',
    PORT: '8080',
    LOG_LEVEL: 'info',
    TRUSTED_PROXY_HOPS: '1',
    BODY_LIMIT_BYTES: '1024',
    REQUEST_TIMEOUT_MS: '5000',
    CONNECTION_TIMEOUT_MS: '5000',
    READY_TIMEOUT_MS: '200',
    DB_TIMEOUT_MS: '1000',
    VISITOR_TOKEN_TTL_SECONDS: '900',
    SESSION_PREFLIGHT_PER_IP_LIMIT: '30',
    SESSION_PREFLIGHT_WINDOW_SECONDS: '600',
    TURNSTILE_TIMEOUT_MS: '2000',
    CHAT_DEADLINE_MS: '30000',
    PROVIDER_MAX_ATTEMPTS: '2',
    RETRIEVAL_TOP_K: '5',
    RETRIEVAL_MIN_SIMILARITY: '0.55',
    CHAT_CONTEXT_MAX_TOKENS: '6000',
    CHAT_HISTORY_MAX_MESSAGES: '6',
    CHAT_MAX_OUTPUT_TOKENS: '800',
    CHAT_PRICE_INPUT_PER_MILLION: '0.1',
    CHAT_PRICE_OUTPUT_PER_MILLION: '0.4',
    MODERATION_PRICE_INPUT_PER_MILLION: '0.1',
    MODERATION_PRICE_OUTPUT_PER_MILLION: '0.4',
    EMBEDDING_PRICE_PER_MILLION_TOKENS: '0.15',
    CHAT_RESERVATION_TTL_SECONDS: '120',
    CHAT_PROVIDER_ATTEMPTS: '2',
    HISTORY_PAGE_SIZE: '20',
    GEMINI_API_KEY: FAKE_AI_KEY,
    CHAT_PRIMARY_PROVIDER: 'gemini',
    CHAT_PRIMARY_MODEL: 'fake-chat-model',
    EMBEDDING_PROVIDER: 'gemini',
    EMBEDDING_MODEL: 'fake-embedding-model',
    EMBEDDING_DIMENSIONS: '1536',
    MODERATION_PROVIDER: 'gemini',
    MODERATION_MODEL: 'fake-moderation-model',
    MODERATION_MODE: 'llm_classifier',
    ...overrides,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig(validEnv(overrides));
}

/**
 * FAKE database, labelled as such: it never satisfies a real DB gate. Only `ping` works; any other
 * call fails loudly so a test that reaches the database by accident does not pass quietly.
 */
export function fakeDb(ping: Db['ping'] = async () => true): Db {
  return {
    ping,
    selectOne: async () => {
      throw new Error('fakeDb: selectOne is not available');
    },
    rpc: async () => {
      throw new Error('fakeDb: rpc is not available');
    },
  };
}

function unavailable(name: string): never {
  throw new Error(`fake service: ${name} is not available in this test`);
}

/**
 * FAKE visitor-facing services, labelled as such. Each method fails loudly, so a test that
 * reaches one by accident does not pass quietly. Tests that exercise a service override it:
 * `buildTestServer({ config, db, limits: myLimits })`.
 */
export function fakeServices(): Pick<ServerDeps, 'auth' | 'limits' | 'runs' | 'turnstile'> {
  const auth: VisitorAuth = {
    issueToken: () => unavailable('auth.issueToken'),
    verifyToken: () => unavailable('auth.verifyToken'),
    authenticate: () => unavailable('auth.authenticate'),
  };
  const limits: Limits = {
    consumeSessionPreflight: () => unavailable('limits.consumeSessionPreflight'),
    consumeSessionCreate: () => unavailable('limits.consumeSessionCreate'),
    consumeSessionCreateBot: () => unavailable('limits.consumeSessionCreateBot'),
    loadMessagePolicy: () => unavailable('limits.loadMessagePolicy'),
    consumeMessage: () => unavailable('limits.consumeMessage'),
    reserve: () => unavailable('limits.reserve'),
    settle: () => unavailable('limits.settle'),
    release: () => unavailable('limits.release'),
  };
  const runs: Runs = {
    beginRun: () => unavailable('runs.beginRun'),
    markRunning: () => unavailable('runs.markRunning'),
    finishRun: () => unavailable('runs.finishRun'),
  };
  const turnstile: TurnstileVerifier = { verify: () => unavailable('turnstile.verify') };
  return { auth, limits, runs, turnstile };
}

/** `buildServer` with labelled fake services; any of them can be overridden. */
export function buildTestServer(
  deps: Pick<ServerDeps, 'config'> & Partial<Omit<ServerDeps, 'config'>>,
) {
  return buildServer({ db: fakeDb(), ...fakeServices(), ...deps });
}

export class LogCapture {
  readonly lines: string[] = [];
  readonly stream = new Writable({
    write: (chunk: Buffer, _enc, cb) => {
      this.lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      cb();
    },
  });
  get text(): string {
    return this.lines.join('\n');
  }
  get records(): Record<string, unknown>[] {
    return this.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

export function appWithCapture(
  config: AppConfig,
  db: Db = fakeDb(),
  level: 'info' | 'debug' = 'info',
) {
  const capture = new LogCapture();
  const app = buildTestServer({
    config,
    db,
    logger: { ...buildLoggerOptions(level), stream: capture.stream },
  });
  return { app, capture };
}
