import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadWorkerConfig, type WorkerConfig } from '../../worker/src/lib/config.ts';
import { createDb, DbError, type Db } from '../../worker/src/lib/db.ts';
import { createStorage } from '../../worker/src/lib/storage.ts';
import {
  RetryJobError,
  startRuntime,
  type JobHandlers,
  type Runtime,
} from '../../worker/src/runtime.ts';
import { getLocalPrivilegedKey, getLocalStack, keyHeaders } from './helpers/local-stack.ts';

// P6-QUEUE: the job runtime against the LOCAL stack with real `jobs` rows and a TEST-ONLY handler.
// No mocks of the database. Jobs are of type `warm_answer_cache`, which nothing else claims in P6,
// and carry a per-run marker; they are deleted afterwards. The retry case needs migration 012
// (retry_job_later). The secret key and AI keys are generated or read at run time and never logged.

const RUN = randomUUID().slice(0, 8);
const FAKE_AI_KEY = `fake-${randomBytes(12).toString('hex')}`;

let apiUrl: string;
let key: string;
let rawDb: Db;
const jobIds: string[] = [];
const runtimes: Runtime[] = [];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(50);
  }
  throw new Error('condition not met in time');
}

async function svc(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      ...keyHeaders(key),
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status >= 300)
    throw new Error(`service call ${method} ${path.split('?')[0] ?? ''} -> ${String(res.status)}`);
  const text = await res.text();
  return text.length === 0 ? null : (JSON.parse(text) as unknown);
}

interface JobRow {
  id: string;
  state: string;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_until: string | null;
  available_at: string;
  last_error: string | null;
}

async function insertJob(maxAttempts = 3): Promise<string> {
  const rows = (await svc('POST', '/rest/v1/jobs', {
    type: 'warm_answer_cache',
    dedupe_key: `p6-queue-${RUN}-${randomUUID()}`,
    payload: { run: RUN },
    max_attempts: maxAttempts,
  })) as { id: string }[];
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('job insert returned no id');
  jobIds.push(id);
  return id;
}

async function getJob(id: string): Promise<JobRow> {
  const rows = (await svc(
    'GET',
    `/rest/v1/jobs?id=eq.${id}&select=id,state,attempts,max_attempts,locked_by,locked_until,available_at,last_error`,
  )) as JobRow[];
  const row = rows[0];
  if (row === undefined) throw new Error('job not found');
  return row;
}

function config(overrides: Record<string, string> = {}): WorkerConfig {
  return loadWorkerConfig({
    SUPABASE_URL: apiUrl,
    SUPABASE_SECRET_KEY: key,
    LOG_LEVEL: 'silent',
    DB_TIMEOUT_MS: '2000',
    STORAGE_TIMEOUT_MS: '5000',
    WORKER_CONCURRENCY: '3',
    JOB_LEASE_SECONDS: '6',
    JOB_HEARTBEAT_INTERVAL_SECONDS: '2',
    JOB_POLL_INTERVAL_MS: '100',
    JOB_BACKOFF_BASE_SECONDS: '30',
    JOB_BACKOFF_MAX_SECONDS: '60',
    SHUTDOWN_GRACE_MS: '3000',
    MAINTENANCE_INTERVAL_SECONDS: '300',
    RETENTION_BATCH_SIZE: '10',
    PURGE_BATCH_SIZE: '10',
    CHAT_DEADLINE_MS: '60000',
    STUCK_RUN_THRESHOLD_SECONDS: '300',
    VISITOR_SESSION_GRACE_SECONDS: '3600',
    TERMINAL_JOB_RETENTION_DAYS: '30',
    ABANDONED_UPLOAD_HOURS: '24',
    EXTRACT_MAX_CHARS: '1000',
    WORKER_MAX_DOWNLOAD_BYTES: '1048576',
    MAX_CHUNKS_PER_VERSION: '1000',
    EXTRACT_TIMEOUT_MS: '1000',
    EXTRACT_CHILD_MEMORY_MB: '64',
    EMBEDDING_BATCH_SIZE: '8',
    EMBEDDING_PRICE_PER_MILLION_TOKENS: '0.1',
    ANALYSIS_PRICE_INPUT_PER_MILLION_TOKENS: '0.1',
    ANALYSIS_PRICE_OUTPUT_PER_MILLION_TOKENS: '0.4',
    GEMINI_API_KEY: FAKE_AI_KEY,
    EMBEDDING_PROVIDER: 'gemini',
    EMBEDDING_MODEL: 'gemini-embedding-001',
    EMBEDDING_DIMENSIONS: '1536',
    ANALYSIS_PROVIDER: 'gemini',
    ANALYSIS_MODEL: 'gemini-2.5-flash-lite',
    ...overrides,
  });
}

function runtime(cfg: WorkerConfig, handlers: JobHandlers): Runtime {
  const rt = startRuntime(cfg, handlers, {
    db: createDb({
      url: cfg.supabaseUrl,
      secretKey: cfg.supabaseSecretKey,
      timeoutMs: cfg.dbTimeoutMs,
    }),
    storage: createStorage({
      url: cfg.supabaseUrl,
      secretKey: cfg.supabaseSecretKey,
      timeoutMs: cfg.storageTimeoutMs,
    }),
  });
  runtimes.push(rt);
  return rt;
}

/** A handler that only touches jobs of this run; a foreign job is retried untouched in effect. */
const mine = (job: { payload: Readonly<Record<string, unknown>> }): boolean =>
  job.payload['run'] === RUN;

beforeAll(() => {
  const stack = getLocalStack();
  apiUrl = stack.apiUrl;
  key = getLocalPrivilegedKey();
  rawDb = createDb({ url: apiUrl, secretKey: key, timeoutMs: 5000 });
});

afterAll(async () => {
  await Promise.all(runtimes.map((r) => r.shutdown()));
  if (jobIds.length > 0) {
    await svc('DELETE', `/rest/v1/jobs?id=in.(${jobIds.join(',')})`);
  }
});

describe('runtime against the local stack', () => {
  it('claims a real job, runs the handler and completes it', async () => {
    const id = await insertJob();
    const seen: string[] = [];
    const rt = runtime(config(), {
      warm_answer_cache: (job) => {
        if (mine(job)) seen.push(job.id);
        return Promise.resolve();
      },
    });
    await waitFor(async () => (await getJob(id)).state === 'succeeded');
    const row = await getJob(id);
    expect(seen.filter((s) => s === id)).toHaveLength(1);
    expect(row).toMatchObject({
      state: 'succeeded',
      attempts: 1,
      locked_by: null,
      locked_until: null,
    });
    await rt.shutdown();
  }, 30_000);

  it('heartbeat extends the lease beyond its first expiry while the handler runs', async () => {
    const id = await insertJob();
    let firstLockedUntil = 0;
    let claimedBy = '';
    const cfg = config(); // lease 6 s, heartbeat every 2 s
    const rt = runtime(cfg, {
      warm_answer_cache: async (job, ctx) => {
        if (!mine(job)) return;
        const row = await getJob(job.id);
        firstLockedUntil = Date.parse(row.locked_until ?? '');
        claimedBy = row.locked_by ?? '';
        // Run for longer than the whole lease: only the heartbeat keeps the job ours.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 8000);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          });
        });
      },
    });
    await waitFor(async () => (await getJob(id)).state === 'running');
    await sleep(7000); // past the original expiry
    const mid = await getJob(id);
    expect(mid.state).toBe('running');
    expect(mid.locked_by).toBe(claimedBy);
    expect(Date.parse(mid.locked_until ?? '')).toBeGreaterThan(firstLockedUntil);
    expect(Date.parse(mid.locked_until ?? '')).toBeGreaterThan(Date.now());
    // Another worker cannot take a heartbeated job.
    const stolen = await rawDb.rpc<unknown[]>('claim_jobs', {
      p_worker: `thief-${RUN}`,
      p_limit: 10,
      p_lease_seconds: 5,
      p_types: ['warm_answer_cache'],
    });
    expect(stolen.some((r) => (r as { id: string }).id === id)).toBe(false);
    await waitFor(async () => (await getJob(id)).state === 'succeeded', 20_000);
    await rt.shutdown();
  }, 45_000);

  it('two runtimes never run one job twice', async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, () => insertJob()));
    const runs = new Map<string, number>();
    const byWorker = new Map<string, number>();
    const handler: JobHandlers = {
      warm_answer_cache: async (job, ctx) => {
        if (!mine(job)) return;
        runs.set(job.id, (runs.get(job.id) ?? 0) + 1);
        byWorker.set(ctx.workerId, (byWorker.get(ctx.workerId) ?? 0) + 1);
        await sleep(300);
      },
    };
    const a = runtime(config({ WORKER_ID: `a-${RUN}`, WORKER_CONCURRENCY: '3' }), handler);
    const b = runtime(config({ WORKER_ID: `b-${RUN}`, WORKER_CONCURRENCY: '3' }), handler);
    await waitFor(async () => {
      const states = await Promise.all(ids.map(async (i) => (await getJob(i)).state));
      return states.every((s) => s === 'succeeded');
    }, 25_000);
    for (const id of ids) expect(runs.get(id)).toBe(1);
    expect(ids.every((id) => (runs.get(id) ?? 0) === 1)).toBe(true);
    // Both runtimes took part (8 jobs, 3 slots each, 300 ms handlers).
    expect(byWorker.size).toBe(2);
    await Promise.all([a.shutdown(), b.shutdown()]);
  }, 40_000);

  it('lets another runtime take a job after its lease expires, and fences out the old worker', async () => {
    const id = await insertJob(5);
    // A "crashed" worker: claims with a 2 s lease and never heartbeats or completes.
    const crashed = `crashed-${RUN}`;
    const first = await rawDb.rpc<{ id: string }[]>('claim_jobs', {
      p_worker: crashed,
      p_limit: 100,
      p_lease_seconds: 2,
      p_types: ['warm_answer_cache'],
    });
    expect(first.some((r) => r.id === id)).toBe(true);
    // Any other job of this type that the crashed claim took is not ours; nothing to do for them.
    const ranOn: { attempts: number; worker: string }[] = [];
    const rt = runtime(config({ WORKER_ID: `rescuer-${RUN}` }), {
      warm_answer_cache: (job, ctx) => {
        if (job.id === id) ranOn.push({ attempts: job.attempts, worker: ctx.workerId });
        return Promise.resolve();
      },
    });
    await waitFor(async () => (await getJob(id)).state === 'succeeded', 20_000);
    // P6-D2 (S-6): the worker id is the configured base plus a random suffix.
    expect(ranOn).toHaveLength(1);
    expect(ranOn[0]?.attempts).toBe(2);
    expect(ranOn[0]?.worker).toMatch(new RegExp(`^rescuer-${RUN}-[0-9a-f]{6}$`));
    // The old worker's lease is gone: its heartbeat and completion are refused (RB013).
    for (const [fn, args] of [
      ['heartbeat_job', { p_job_id: id, p_worker: crashed, p_lease_seconds: 5 }],
      ['complete_job', { p_job_id: id, p_worker: crashed }],
    ] as const) {
      const err = await rawDb.rpc(fn, args).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DbError);
      expect((err as DbError).sqlstate).toBe('RB013');
    }
    await rt.shutdown();
  }, 40_000);

  it('retries a failing handler later with a safe code (needs migration 012: retry_job_later)', async () => {
    const id = await insertJob(3);
    const rt = runtime(config(), {
      warm_answer_cache: (job) => {
        if (!mine(job)) return Promise.resolve();
        return Promise.reject(new RetryJobError('provider_unavailable'));
      },
    });
    await waitFor(async () => {
      const r = await getJob(id);
      return r.state === 'queued' && r.attempts === 1;
    });
    const row = await getJob(id);
    expect(row.last_error).toBe('provider_unavailable');
    expect(row.locked_by).toBeNull();
    // Backoff base 30 s, equal jitter: available 15..30 s from now.
    const waitMs = Date.parse(row.available_at) - Date.now();
    expect(waitMs).toBeGreaterThan(10_000);
    expect(waitMs).toBeLessThanOrEqual(31_000);
    await rt.shutdown();
  }, 30_000);

  it('dead-letters a job whose last attempt fails', async () => {
    const id = await insertJob(1);
    const rt = runtime(config(), {
      warm_answer_cache: (job) => {
        if (!mine(job)) return Promise.resolve();
        return Promise.reject(new Error('boom'));
      },
    });
    await waitFor(async () => (await getJob(id)).state === 'failed');
    const row = await getJob(id);
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('handler_error');
    await rt.shutdown();
  }, 30_000);

  it('shutdown hands a running job back to the queue with its attempt restored (P6-D2), and another runtime takes it', async () => {
    const id = await insertJob(5);
    const a = runtime(config({ WORKER_ID: `drain-${RUN}`, SHUTDOWN_GRACE_MS: '500' }), {
      warm_answer_cache: async (job, ctx) => {
        if (!mine(job) || job.id !== id) return;
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            resolve();
          });
        });
        throw new Error('aborted');
      },
    });
    await waitFor(async () => (await getJob(id)).state === 'running');
    const result = await a.shutdown();
    expect(result).toEqual({ drained: false, aborted: 1 });
    const left = await getJob(id);
    // P6-D2 (C-7): release_job_lease returns the job to the queue and gives the attempt back.
    expect(left.state).toBe('queued');
    expect(left.attempts).toBe(0);
    expect(left.locked_by).toBeNull();
    const b = runtime(config({ WORKER_ID: `after-${RUN}` }), {
      warm_answer_cache: () => Promise.resolve(),
    });
    await waitFor(async () => (await getJob(id)).state === 'succeeded', 20_000);
    expect((await getJob(id)).attempts).toBe(1);
    await b.shutdown();
  }, 40_000);
});
