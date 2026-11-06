import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { loadConfig, type AppConfig } from '../../../api/src/lib/config.ts';
import { buildLoggerOptions } from '../../../api/src/lib/logger.ts';
import type { DbPing } from '../../../api/src/lib/supabase.ts';
import { buildServer } from '../../../api/src/server.ts';

// FAKE values for tests only, random per run. None of these is a real credential.
function hex32(): string {
  return randomBytes(32).toString('hex');
}

export const FAKE_SUPABASE_KEY = hex32();
export const FAKE_VISITOR_SECRET = hex32();
export const FAKE_TURNSTILE_KEY = hex32();
export const FAKE_AI_KEY = hex32();

export function validEnv(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    SUPABASE_URL: 'https://fakeproject.supabase.co',
    SUPABASE_SECRET_KEY: FAKE_SUPABASE_KEY,
    VISITOR_TOKEN_SECRET: FAKE_VISITOR_SECRET,
    TURNSTILE_SECRET_KEY: FAKE_TURNSTILE_KEY,
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
    CHAT_DEADLINE_MS: '30000',
    PROVIDER_MAX_ATTEMPTS: '2',
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

/** FAKE database probe, labelled as such: it never satisfies a real DB gate. */
export function fakeDb(ping: DbPing['ping'] = async () => true): DbPing {
  return { ping };
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
  db: DbPing = fakeDb(),
  level: 'info' | 'debug' = 'info',
) {
  const capture = new LogCapture();
  const app = buildServer({
    config,
    db,
    logger: { ...buildLoggerOptions(level), stream: capture.stream },
  });
  return { app, capture };
}
