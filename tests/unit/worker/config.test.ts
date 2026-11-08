import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadWorkerConfig,
  STUCK_RUN_MARGIN_SECONDS,
} from '../../../worker/src/lib/config.ts';

// P6-QUEUE. Fake values generated at run time; nothing reads the real environment.
const fakeKey = (): string => `fake-${randomBytes(12).toString('hex')}`;
const SB_KEY = fakeKey();
const AI_KEY = fakeKey();

function validEnv(): Record<string, string> {
  return {
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SECRET_KEY: SB_KEY,
    LOG_LEVEL: 'info',
    DB_TIMEOUT_MS: '10000',
    STORAGE_TIMEOUT_MS: '60000',
    WORKER_CONCURRENCY: '2',
    JOB_LEASE_SECONDS: '120',
    JOB_HEARTBEAT_INTERVAL_SECONDS: '30',
    JOB_POLL_INTERVAL_MS: '2000',
    JOB_BACKOFF_BASE_SECONDS: '15',
    JOB_BACKOFF_MAX_SECONDS: '900',
    SHUTDOWN_GRACE_MS: '25000',
    MAINTENANCE_INTERVAL_SECONDS: '300',
    RETENTION_BATCH_SIZE: '500',
    PURGE_BATCH_SIZE: '5000',
    CHAT_DEADLINE_MS: '60000',
    STUCK_RUN_THRESHOLD_SECONDS: '300',
    VISITOR_SESSION_GRACE_SECONDS: '3600',
    TERMINAL_JOB_RETENTION_DAYS: '30',
    ABANDONED_UPLOAD_HOURS: '24',
    WORKER_MAX_DOWNLOAD_BYTES: '52428800',
    MAX_CHUNKS_PER_VERSION: '5000',
    EXTRACT_MAX_CHARS: '5000000',
    EXTRACT_TIMEOUT_MS: '120000',
    EXTRACT_CHILD_MEMORY_MB: '512',
    EMBEDDING_BATCH_SIZE: '64',
    EMBEDDING_PRICE_PER_MILLION_TOKENS: '0.15',
    GEMINI_API_KEY: AI_KEY,
    EMBEDDING_PROVIDER: 'gemini',
    EMBEDDING_MODEL: 'gemini-embedding-001',
    EMBEDDING_DIMENSIONS: '1536',
    ANALYSIS_PROVIDER: 'gemini',
    ANALYSIS_MODEL: 'gemini-2.5-flash-lite',
  };
}

function refusal(env: Record<string, string | undefined>): ConfigError {
  try {
    loadWorkerConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected loadWorkerConfig to throw');
}

describe('loadWorkerConfig: accept', () => {
  it('accepts a complete environment and maps every field', () => {
    const c = loadWorkerConfig({ ...validEnv(), WORKER_ID: 'w-1' });
    expect(c.workerId).toMatch(/^w-1-[0-9a-f]{6}$/);
    expect(c).toMatchObject({
      supabaseUrl: 'http://127.0.0.1:54321',
      abandonedUploadHours: 24,
      maxDownloadBytes: 52_428_800,
      maxChunksPerVersion: 5000,
      concurrency: 2,
      leaseSeconds: 120,
      heartbeatIntervalMs: 30_000,
      pollIntervalMs: 2000,
      backoffBaseSeconds: 15,
      backoffMaxSeconds: 900,
      shutdownGraceMs: 25_000,
      maintenanceIntervalSeconds: 300,
      retentionBatchSize: 500,
      purgeBatchSize: 5000,
      stuckRunThresholdSeconds: 300,
      chatDeadlineMs: 60_000,
      extraction: { maxExtractedChars: 5_000_000, timeoutMs: 120_000, childMemoryMb: 512 },
      embeddingBatchSize: 64,
      embeddingPricePerMillionTokens: 0.15,
    });
    expect(c.ai.embedding.model).toBe('gemini-embedding-001');
    expect(c.ai.analysis.provider).toBe('gemini');
  });

  it('always adds a random suffix to the worker id, even when WORKER_ID is set', () => {
    const a = loadWorkerConfig({ ...validEnv(), WORKER_ID: 'fixed-name' }).workerId;
    const b = loadWorkerConfig({ ...validEnv(), WORKER_ID: 'fixed-name' }).workerId;
    expect(a).toMatch(/^fixed-name-[0-9a-f]{6}$/);
    expect(b).toMatch(/^fixed-name-[0-9a-f]{6}$/);
    expect(a).not.toBe(b);
    // The longest accepted base still gives an id within the 63 characters a lease owner may have.
    const longest = loadWorkerConfig({ ...validEnv(), WORKER_ID: 'a'.repeat(56) }).workerId;
    expect(longest).toHaveLength(63);
    expect(refusal({ ...validEnv(), WORKER_ID: 'a'.repeat(57) }).variables).toContain('WORKER_ID');
  });

  it('generates a worker id with the process id when WORKER_ID is absent or empty', () => {
    for (const WORKER_ID of [undefined, '']) {
      const c = loadWorkerConfig({
        ...validEnv(),
        ...(WORKER_ID === undefined ? {} : { WORKER_ID }),
      });
      expect(c.workerId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/);
      expect(c.workerId).toContain(String(process.pid));
    }
    const a = loadWorkerConfig(validEnv()).workerId;
    const b = loadWorkerConfig(validEnv()).workerId;
    expect(a).not.toBe(b);
  });

  it('returns a frozen config and keeps secrets out of JSON, inspect and spread', () => {
    const c = loadWorkerConfig(validEnv());
    expect(Object.isFrozen(c)).toBe(true);
    expect(c.supabaseSecretKey).toBe(SB_KEY);
    expect(c.ai.embedding.apiKey).toBe(AI_KEY);
    for (const dump of [
      JSON.stringify(c),
      inspect(c, { depth: 6 }),
      JSON.stringify({ ...c }),
      inspect(c.ai, { depth: 6 }),
    ]) {
      expect(dump).not.toContain(SB_KEY);
      expect(dump).not.toContain(AI_KEY);
    }
  });

  it('accepts a price of 0 and a decimal price', () => {
    expect(
      loadWorkerConfig({ ...validEnv(), EMBEDDING_PRICE_PER_MILLION_TOKENS: '0' })
        .embeddingPricePerMillionTokens,
    ).toBe(0);
  });
});

describe('loadWorkerConfig: refuse (fail closed, names only)', () => {
  const required = Object.keys(validEnv()).filter((k) => !k.startsWith('GEMINI_'));

  it.each(required)('refuses when %s is missing, naming it', (name) => {
    const env: Record<string, string | undefined> = validEnv();
    delete env[name];
    const err = refusal(env);
    expect(err.variables.length + err.message.length).toBeGreaterThan(0);
    expect(`${err.variables.join(',')} ${err.message}`).toContain(name);
  });

  it.each([
    ['SUPABASE_URL', 'http://example.com'],
    ['SUPABASE_URL', 'https://user:pw@example.com'],
    ['SUPABASE_URL', 'https://example.com/?x=1'],
    ['SUPABASE_URL', 'not a url'],
    ['SUPABASE_SECRET_KEY', '<server-only-secret-key>'],
    ['SUPABASE_SECRET_KEY', '   '],
    ['LOG_LEVEL', 'verbose'],
    ['WORKER_ID', 'has space'],
    ['WORKER_ID', '-leading-dash'],
    ['WORKER_CONCURRENCY', '0'],
    ['WORKER_CONCURRENCY', '101'],
    ['WORKER_CONCURRENCY', '2.5'],
    ['WORKER_CONCURRENCY', '-1'],
    ['JOB_LEASE_SECONDS', '4'],
    ['JOB_LEASE_SECONDS', '3601'],
    ['JOB_POLL_INTERVAL_MS', '10'],
    ['JOB_BACKOFF_MAX_SECONDS', '3601'],
    ['RETENTION_BATCH_SIZE', '10001'],
    ['PURGE_BATCH_SIZE', '100001'],
    ['STUCK_RUN_THRESHOLD_SECONDS', '59'],
    ['EMBEDDING_BATCH_SIZE', '201'],
    ['EMBEDDING_BATCH_SIZE', '0'],
    ['EMBEDDING_PRICE_PER_MILLION_TOKENS', '-1'],
    ['EMBEDDING_PRICE_PER_MILLION_TOKENS', '1e3'],
    ['EMBEDDING_PRICE_PER_MILLION_TOKENS', 'free'],
    ['EXTRACT_CHILD_MEMORY_MB', '4'],
    ['TERMINAL_JOB_RETENTION_DAYS', '0'],
    ['ABANDONED_UPLOAD_HOURS', '23'],
    ['ABANDONED_UPLOAD_HOURS', '0'],
    ['WORKER_MAX_DOWNLOAD_BYTES', '0'],
    ['WORKER_MAX_DOWNLOAD_BYTES', '2147483648'],
    ['MAX_CHUNKS_PER_VERSION', '0'],
    ['MAX_CHUNKS_PER_VERSION', '1000001'],
  ])('refuses %s=%s', (name, value) => {
    const err = refusal({ ...validEnv(), [name]: value });
    expect(err.variables).toContain(name);
    expect(err.message).not.toContain(value.trim() === '' ? '\u0000' : value);
  });

  it('never echoes a value in the error', () => {
    const err = refusal({ ...validEnv(), SUPABASE_URL: 'https://user:topsecretpw@example.com' });
    expect(err.message).not.toContain('topsecretpw');
    expect(JSON.stringify(err.variables)).not.toContain('topsecretpw');
  });

  it('refuses a placeholder AI key naming the variable', () => {
    const err = refusal({ ...validEnv(), GEMINI_API_KEY: '<gemini-key>' });
    expect(err.variables).toContain('GEMINI_API_KEY');
    expect(err.message).not.toContain('<gemini-key>');
  });

  it('refuses a wrong embedding dimension and a missing AI provider', () => {
    expect(refusal({ ...validEnv(), EMBEDDING_DIMENSIONS: '768' }).variables).toContain(
      'EMBEDDING_DIMENSIONS',
    );
    const env: Record<string, string | undefined> = validEnv();
    delete env['ANALYSIS_PROVIDER'];
    expect(refusal(env).variables).toContain('ANALYSIS_PROVIDER');
  });
});

describe('loadWorkerConfig: relations between values', () => {
  it('requires the heartbeat interval to be at most a third of the lease', () => {
    expect(() =>
      loadWorkerConfig({
        ...validEnv(),
        JOB_LEASE_SECONDS: '90',
        JOB_HEARTBEAT_INTERVAL_SECONDS: '30',
      }),
    ).not.toThrow();
    const err = refusal({
      ...validEnv(),
      JOB_LEASE_SECONDS: '90',
      JOB_HEARTBEAT_INTERVAL_SECONDS: '31',
    });
    expect(err.variables).toEqual(['JOB_HEARTBEAT_INTERVAL_SECONDS', 'JOB_LEASE_SECONDS']);
  });

  it('requires the backoff base to be at most the backoff max', () => {
    expect(refusal({ ...validEnv(), JOB_BACKOFF_BASE_SECONDS: '901' }).variables).toContain(
      'JOB_BACKOFF_BASE_SECONDS',
    );
  });

  it('requires the database timeout to end well inside the lease', () => {
    expect(refusal({ ...validEnv(), DB_TIMEOUT_MS: '60001' }).variables).toContain('DB_TIMEOUT_MS');
    expect(() => loadWorkerConfig({ ...validEnv(), DB_TIMEOUT_MS: '60000' })).not.toThrow();
  });

  it('requires STUCK_RUN_THRESHOLD_SECONDS >= CHAT_DEADLINE_MS/1000 + the named margin', () => {
    expect(STUCK_RUN_MARGIN_SECONDS).toBeGreaterThan(0);
    const deadlineS = 240;
    const boundary = deadlineS + STUCK_RUN_MARGIN_SECONDS;
    const base = { ...validEnv(), CHAT_DEADLINE_MS: String(deadlineS * 1000) };
    expect(() =>
      loadWorkerConfig({ ...base, STUCK_RUN_THRESHOLD_SECONDS: String(boundary) }),
    ).not.toThrow();
    const err = refusal({ ...base, STUCK_RUN_THRESHOLD_SECONDS: String(boundary - 1) });
    expect(err.variables).toEqual(['STUCK_RUN_THRESHOLD_SECONDS', 'CHAT_DEADLINE_MS']);
  });

  it('refuses a threshold equal to the deadline (no margin)', () => {
    expect(
      refusal({
        ...validEnv(),
        CHAT_DEADLINE_MS: '120000',
        STUCK_RUN_THRESHOLD_SECONDS: '120',
      }).variables,
    ).toContain('STUCK_RUN_THRESHOLD_SECONDS');
  });
});

describe('loadWorkerConfig: API-only secrets', () => {
  it.each([
    'VISITOR_TOKEN_SECRET',
    'VISITOR_TOKEN_SECRET_PREVIOUS',
    'TURNSTILE_SECRET_KEY',
    'RATE_LIMIT_KEY_SECRET',
    'RATE_LIMIT_KEY_SECRET_2',
  ])('refuses %s through the environment guard, without echoing it', (name) => {
    const value = fakeKey();
    let message = '';
    try {
      loadWorkerConfig({ ...validEnv(), [name]: value });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(name);
    expect(message).not.toContain(value);
  });
});
