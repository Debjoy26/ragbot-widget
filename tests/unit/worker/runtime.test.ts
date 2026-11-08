import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerConfig } from '../../../worker/src/lib/config.ts';
import { DbError, type Db } from '../../../worker/src/lib/db.ts';
import { createLogger, sanitizeFields } from '../../../worker/src/lib/logger.ts';
import type { Storage } from '../../../worker/src/lib/storage.ts';
import {
  ABORT_SETTLE_MS,
  computeBackoffSeconds,
  LeaseLostError,
  RetryJobError,
  ShutdownError,
  startRuntime,
  type JobContext,
  type JobHandler,
  type JobHandlers,
} from '../../../worker/src/runtime.ts';

// P6-QUEUE: runtime with a labelled FAKE database and fake timers. A fake cannot prove the SQL
// lease behaviour; tests/integration/worker-runtime.test.ts does that against the local stack.

const SENTINEL_PAYLOAD = `payload-text-${randomBytes(6).toString('hex')}`;
const SENTINEL_ERROR = `error-text-${randomBytes(6).toString('hex')}`;

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    supabaseUrl: 'http://127.0.0.1:54321',
    logLevel: 'debug',
    workerId: 'w-test',
    dbTimeoutMs: 5000,
    storageTimeoutMs: 5000,
    concurrency: 2,
    leaseSeconds: 90,
    heartbeatIntervalMs: 30_000,
    pollIntervalMs: 1000,
    backoffBaseSeconds: 10,
    backoffMaxSeconds: 100,
    shutdownGraceMs: 5000,
    maintenanceIntervalSeconds: 300,
    retentionBatchSize: 10,
    purgeBatchSize: 10,
    stuckRunThresholdSeconds: 300,
    chatDeadlineMs: 60_000,
    visitorSessionGraceSeconds: 3600,
    terminalJobRetentionDays: 30,
    abandonedUploadHours: 24,
    extraction: { maxExtractedChars: 1000, timeoutMs: 1000, childMemoryMb: 64 },
    embeddingBatchSize: 8,
    embeddingPricePerMillionTokens: 0.1,
    ...overrides,
  } as unknown as WorkerConfig;
}

interface Call {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly options: unknown;
}

let jobSeq = 0;
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  jobSeq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(jobSeq).padStart(12, '0')}`,
    type: 'index_document',
    payload: { note: SENTINEL_PAYLOAD },
    state: 'running',
    attempts: 1,
    max_attempts: 5,
    ...overrides,
  };
}

function harness(
  options: {
    queue?: Record<string, unknown>[];
    impl?: Partial<Record<string, (args: Record<string, unknown>) => unknown>>;
    config?: Partial<WorkerConfig>;
    random?: () => number;
  } = {},
) {
  const queue = [...(options.queue ?? [])];
  const calls: Call[] = [];
  const lines: string[] = [];
  const db: Db = {
    rpc: (name, args, _signal, opts) => {
      calls.push({ name, args: { ...args }, options: opts });
      const custom = options.impl?.[name];
      if (custom !== undefined) {
        try {
          return Promise.resolve(custom(args) as never);
        } catch (err) {
          return Promise.reject(err as Error);
        }
      }
      if (name === 'claim_jobs') {
        const limit = args['p_limit'] as number;
        return Promise.resolve(queue.splice(0, limit) as never);
      }
      if (name === 'retry_job_later') return Promise.resolve('queued' as never);
      return Promise.resolve(null as never);
    },
  };
  const storage = {} as Storage;
  const config = makeConfig(options.config);
  const log = createLogger({ level: 'debug', sink: (l) => void lines.push(l) });
  const start = (handlers: JobHandlers) =>
    startRuntime(config, handlers, { db, storage, log, random: options.random ?? (() => 0.5) });
  const named = (name: string): Call[] => calls.filter((c) => c.name === name);
  return { queue, calls, lines, config, start, named };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('computeBackoffSeconds', () => {
  it('doubles per attempt up to the max, with equal jitter in [capped/2, capped]', () => {
    for (const [attempts, capped] of [
      [1, 10],
      [2, 20],
      [3, 40],
      [4, 80],
      [5, 100],
      [50, 100],
    ] as const) {
      const lo = computeBackoffSeconds(attempts, 10, 100, () => 0);
      const hi = computeBackoffSeconds(attempts, 10, 100, () => 0.999999);
      expect(lo).toBe(Math.max(1, Math.ceil(capped / 2)));
      expect(hi).toBe(capped);
    }
  });

  it('stays within 1..3600 and uses whole seconds', () => {
    expect(computeBackoffSeconds(1, 1, 1, () => 0)).toBe(1);
    expect(computeBackoffSeconds(40, 3600, 3600, () => 0.9999)).toBe(3600);
    for (let i = 0; i < 200; i++) {
      const d = computeBackoffSeconds(3, 7, 500, Math.random);
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(Math.ceil(14));
      expect(d).toBeLessThanOrEqual(28);
    }
  });

  it('treats attempts below 1 as the first attempt', () => {
    expect(computeBackoffSeconds(0, 10, 100, () => 0.999999)).toBe(10);
  });
});

describe('runtime: claiming', () => {
  it('claims nothing at all when no handler is registered', async () => {
    const h = harness({ queue: [row()] });
    const rt = h.start({});
    await tick(10_000);
    expect(h.calls).toHaveLength(0);
    expect((await rt.shutdown()).drained).toBe(true);
  });

  it('claims for the handler types, with the free slot count, worker id and lease', async () => {
    const h = harness();
    const rt = h.start({
      index_document: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    });
    await tick(0);
    const claim = h.named('claim_jobs')[0];
    expect(claim?.args).toEqual({
      p_worker: 'w-test',
      p_limit: 2,
      p_lease_seconds: 90,
      p_types: ['index_document', 'cleanup'],
    });
    await rt.shutdown();
  });

  it('refuses a handler registered for an unknown job type', () => {
    const h = harness();
    expect(() => h.start({ not_a_job: () => Promise.resolve() } as unknown as JobHandlers)).toThrow(
      TypeError,
    );
    expect(h.calls).toHaveLength(0);
  });

  it('polls again after the poll interval, not before', async () => {
    const h = harness();
    const rt = h.start({ index_document: () => Promise.resolve() });
    await tick(0);
    expect(h.named('claim_jobs')).toHaveLength(1);
    await tick(999);
    expect(h.named('claim_jobs')).toHaveLength(1);
    await tick(1);
    expect(h.named('claim_jobs')).toHaveLength(2);
    await rt.shutdown();
  });

  it('keeps polling, with a longer delay, after a claim failure', async () => {
    let n = 0;
    const h = harness({
      impl: {
        claim_jobs: () => {
          n += 1;
          if (n <= 2) throw new DbError('network');
          return [];
        },
      },
    });
    const rt = h.start({ index_document: () => Promise.resolve() });
    await tick(0);
    expect(n).toBe(1);
    await tick(1999); // first failure: 1000 * 2^1
    expect(n).toBe(1);
    await tick(1);
    expect(n).toBe(2);
    await tick(4000);
    expect(n).toBe(3);
    expect(h.lines.some((l) => l.includes('claim_failed'))).toBe(true);
    await rt.shutdown();
  });

  it('skips a malformed claim row and runs the valid one', async () => {
    const ran: string[] = [];
    const good = row();
    const h = harness({ queue: [{ id: 5, type: 'index_document' }, good] });
    const rt = h.start({
      index_document: (job) => {
        ran.push(job.id);
        return Promise.resolve();
      },
    });
    await tick(0);
    expect(ran).toEqual([good['id']]);
    await rt.shutdown();
  });
});

describe('runtime: concurrency', () => {
  it('never runs more than `concurrency` jobs and refills a slot as one ends', async () => {
    const jobs = Array.from({ length: 5 }, () => row());
    const h = harness({ queue: jobs, config: { concurrency: 2 } });
    const gates = new Map<string, ReturnType<typeof deferred>>();
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const rt = h.start({
      index_document: async (job) => {
        active += 1;
        peak = Math.max(peak, active);
        order.push(job.id);
        const gate = deferred();
        gates.set(job.id, gate);
        await gate.promise;
        active -= 1;
      },
    });
    await tick(0);
    expect(active).toBe(2);
    expect(rt.runningCount()).toBe(2);
    // The second claim, if any, asks for zero free slots: it must not happen.
    expect(h.named('claim_jobs').every((c) => (c.args['p_limit'] as number) >= 1)).toBe(true);

    gates.get(order[0] as string)?.resolve();
    await tick(0);
    expect(active).toBe(2);
    expect(order).toHaveLength(3);
    expect(h.named('claim_jobs').at(-1)?.args['p_limit']).toBe(1);

    for (const id of order.slice()) gates.get(id)?.resolve();
    await tick(0);
    for (let i = 0; i < 6; i++) {
      for (const g of gates.values()) g.resolve();
      await tick(0);
    }
    expect(peak).toBe(2);
    expect(order).toHaveLength(5);
    expect(h.named('complete_job')).toHaveLength(5);
    await rt.shutdown();
  });
});

describe('runtime: outcomes', () => {
  it('completes a job whose handler resolves', async () => {
    const j = row();
    const h = harness({ queue: [j] });
    const rt = h.start({ index_document: () => Promise.resolve() });
    await tick(0);
    expect(h.named('complete_job')[0]?.args).toEqual({ p_job_id: j['id'], p_worker: 'w-test' });
    expect(h.named('retry_job_later')).toHaveLength(0);
    await rt.shutdown();
  });

  it('turns an unexpected throw into retry_job_later with a safe code, never its message', async () => {
    const j = row({ attempts: 2 });
    const h = harness({ queue: [j], random: () => 0 });
    const rt = h.start({
      index_document: () => Promise.reject(new Error(`boom ${SENTINEL_ERROR}`)),
    });
    await tick(0);
    const retry = h.named('retry_job_later');
    expect(retry).toHaveLength(1);
    expect(retry[0]?.args).toEqual({
      p_job_id: j['id'],
      p_worker: 'w-test',
      p_error_code: 'handler_error',
      p_delay_seconds: 10, // attempt 2 -> 20, random 0 -> 20 / 2
    });
    expect(h.named('complete_job')).toHaveLength(0);
    expect(JSON.stringify(h.calls)).not.toContain(SENTINEL_ERROR);
    expect(h.lines.join('\n')).not.toContain(SENTINEL_ERROR);
    await rt.shutdown();
  });

  it('retry delay is within the jitter bounds for every random value', async () => {
    for (const r of [0, 0.5, 0.999999]) {
      const h = harness({ queue: [row({ attempts: 3 })], random: () => r });
      const rt = h.start({ index_document: () => Promise.reject(new Error('x')) });
      await tick(0);
      const delay = h.named('retry_job_later')[0]?.args['p_delay_seconds'] as number;
      expect(delay).toBeGreaterThanOrEqual(20); // attempt 3 -> 40 capped at 40, lower half
      expect(delay).toBeLessThanOrEqual(40);
      await rt.shutdown();
    }
  });

  it('uses the handler-supplied code and honours retryAfterSeconds up to the max', async () => {
    const h = harness({ queue: [row(), row()], random: () => 0, config: { concurrency: 2 } });
    let i = 0;
    const rt = h.start({
      index_document: () =>
        Promise.reject(
          i++ === 0
            ? new RetryJobError('provider_rate_limited', { retryAfterSeconds: 60 })
            : new RetryJobError('provider_rate_limited', { retryAfterSeconds: 100_000 }),
        ),
    });
    await tick(0);
    const delays = h.named('retry_job_later').map((c) => c.args['p_delay_seconds']);
    expect(
      h.named('retry_job_later').every((c) => c.args['p_error_code'] === 'provider_rate_limited'),
    ).toBe(true);
    expect(delays.sort((a, b) => Number(a) - Number(b))).toEqual([60, 100]);
    await rt.shutdown();
  });

  it('replaces an unsafe retry code with handler_error', async () => {
    const h = harness({ queue: [row()] });
    const rt = h.start({
      index_document: () => Promise.reject(new RetryJobError(`Bad Code ${SENTINEL_ERROR}`)),
    });
    await tick(0);
    expect(h.named('retry_job_later')[0]?.args['p_error_code']).toBe('handler_error');
    await rt.shutdown();
  });

  it('handles an unknown job type safely: no handler call, long retry, nothing lost', async () => {
    const handler = vi.fn(() => Promise.resolve());
    const h = harness({ queue: [row({ type: 'warm_answer_cache' })] });
    const rt = h.start({ index_document: handler as unknown as JobHandler });
    await tick(0);
    expect(handler).not.toHaveBeenCalled();
    const retry = h.named('retry_job_later');
    expect(retry).toHaveLength(1);
    expect(retry[0]?.args['p_error_code']).toBe('unknown_job_type');
    expect(retry[0]?.args['p_delay_seconds']).toBe(100);
    expect(h.named('complete_job')).toHaveLength(0);
    await rt.shutdown();
  });

  it('survives a failing complete_job: logs a code and keeps polling', async () => {
    const h = harness({
      queue: [row()],
      impl: {
        complete_job: () => {
          throw new DbError('http', 400, 'RB013');
        },
      },
    });
    const rt = h.start({ index_document: () => Promise.resolve() });
    await tick(0);
    expect(h.lines.some((l) => l.includes('job_bookkeeping_failed') && l.includes('RB013'))).toBe(
      true,
    );
    await tick(1000);
    expect(h.named('claim_jobs').length).toBeGreaterThan(1);
    expect(rt.runningCount()).toBe(0);
    await rt.shutdown();
  });

  it('passes opt-in contention retry on its bookkeeping calls', async () => {
    const h = harness({ queue: [row()] });
    const rt = h.start({ index_document: () => Promise.resolve() });
    await tick(0);
    expect(h.named('complete_job')[0]?.options).toEqual({ retryOnContention: true });
    await rt.shutdown();
  });
});

describe('runtime: heartbeat', () => {
  it('heartbeats at the configured cadence while a job runs, and stops when it ends', async () => {
    const gate = deferred();
    const j = row();
    const h = harness({ queue: [j] });
    const rt = h.start({ index_document: () => gate.promise });
    await tick(0);
    expect(h.named('heartbeat_job')).toHaveLength(0);
    await tick(29_999);
    expect(h.named('heartbeat_job')).toHaveLength(0);
    await tick(1);
    expect(h.named('heartbeat_job')).toHaveLength(1);
    await tick(30_000);
    expect(h.named('heartbeat_job')).toHaveLength(2);
    await tick(30_000);
    expect(h.named('heartbeat_job')).toHaveLength(3);
    expect(h.named('heartbeat_job')[0]?.args).toEqual({
      p_job_id: j['id'],
      p_worker: 'w-test',
      p_lease_seconds: 90,
    });
    gate.resolve();
    await tick(0);
    await tick(120_000);
    expect(h.named('heartbeat_job')).toHaveLength(3);
    expect(h.named('complete_job')).toHaveLength(1);
    await rt.shutdown();
  });

  it('aborts the job signal and touches nothing afterwards when the lease is refused', async () => {
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const h = harness({
      queue: [row()],
      impl: {
        heartbeat_job: () => {
          throw new DbError('http', 400, 'RB013');
        },
      },
    });
    const rt = h.start({
      index_document: async (_job, ctx) => {
        signal = ctx.signal;
        await gate.promise;
      },
    });
    await tick(0);
    expect(signal?.aborted).toBe(false);
    await tick(30_000);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(LeaseLostError);
    gate.resolve();
    await tick(0);
    expect(h.named('complete_job')).toHaveLength(0);
    expect(h.named('retry_job_later')).toHaveLength(0);
    expect(h.named('heartbeat_job')).toHaveLength(1); // no further beats once lost
    await tick(60_000);
    expect(h.named('heartbeat_job')).toHaveLength(1);
    await rt.shutdown();
  });

  it('does not complete a job whose handler resolves after the lease was lost', async () => {
    const gate = deferred();
    const h = harness({
      queue: [row()],
      impl: {
        heartbeat_job: () => {
          throw new DbError('http', 400, 'RB013');
        },
      },
    });
    const rt = h.start({
      index_document: async (_job, ctx) => {
        await gate.promise;
        expect(ctx.signal.aborted).toBe(true);
      },
    });
    await tick(30_000);
    gate.resolve();
    await tick(0);
    expect(h.named('complete_job')).toHaveLength(0);
    expect(h.named('retry_job_later')).toHaveLength(0);
    await rt.shutdown();
  });

  it('does not call the DB for a job that throws after its lease was lost', async () => {
    const gate = deferred();
    const h = harness({
      queue: [row()],
      impl: {
        heartbeat_job: () => {
          throw new DbError('http', 400, 'RB013');
        },
      },
    });
    const rt = h.start({
      index_document: async () => {
        await gate.promise;
        throw new Error('aborted');
      },
    });
    await tick(30_000);
    gate.resolve();
    await tick(0);
    expect(h.named('retry_job_later')).toHaveLength(0);
    expect(h.named('complete_job')).toHaveLength(0);
    await rt.shutdown();
  });

  it('tolerates a transient heartbeat failure while the lease still holds, then recovers', async () => {
    const gate = deferred();
    let signal: AbortSignal | undefined;
    let n = 0;
    const h = harness({
      queue: [row()],
      impl: {
        heartbeat_job: () => {
          n += 1;
          if (n === 1) throw new DbError('network');
          return null;
        },
      },
    });
    const rt = h.start({
      index_document: async (_j, ctx) => {
        signal = ctx.signal;
        await gate.promise;
      },
    });
    await tick(0);
    await tick(30_000); // beat 1 fails (lease runs to t=90s)
    expect(signal?.aborted).toBe(false);
    await tick(30_000); // beat 2 succeeds
    expect(n).toBe(2);
    expect(signal?.aborted).toBe(false);
    gate.resolve();
    await tick(0);
    expect(h.named('complete_job')).toHaveLength(1);
    await rt.shutdown();
  });

  it('aborts when transient heartbeat failures outlast the lease', async () => {
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const h = harness({
      queue: [row()],
      impl: {
        heartbeat_job: () => {
          throw new DbError('timeout');
        },
      },
      config: { leaseSeconds: 90, heartbeatIntervalMs: 30_000 },
    });
    const rt = h.start({
      index_document: async (_j, ctx) => {
        signal = ctx.signal;
        await gate.promise;
      },
    });
    await tick(0);
    await tick(60_000);
    expect(signal?.aborted).toBe(false);
    await tick(30_000); // t=90s: the lease granted at claim time has run out
    expect(signal?.aborted).toBe(true);
    gate.resolve();
    await tick(0);
    expect(h.named('complete_job')).toHaveLength(0);
    expect(h.named('retry_job_later')).toHaveLength(0);
    await rt.shutdown();
  });

  it('ctx.heartbeat() extends the lease on demand and rejects when it is lost', async () => {
    let n = 0;
    const results: string[] = [];
    const h = harness({
      queue: [row()],
      impl: {
        heartbeat_job: () => {
          n += 1;
          if (n === 2) throw new DbError('http', 400, 'RB013');
          return null;
        },
      },
    });
    const rt = h.start({
      index_document: async (_j, ctx: JobContext) => {
        await ctx.heartbeat();
        results.push('first ok');
        await ctx.heartbeat().catch((e: unknown) => {
          results.push(e instanceof LeaseLostError ? 'lost' : 'other');
        });
        await ctx.heartbeat().catch((e: unknown) => {
          results.push(e instanceof LeaseLostError ? 'still lost' : 'other');
        });
      },
    });
    await tick(0);
    expect(results).toEqual(['first ok', 'lost', 'still lost']);
    expect(h.named('heartbeat_job')).toHaveLength(2);
    await rt.shutdown();
  });
});

describe('runtime: graceful shutdown', () => {
  it('stops claiming, lets a running job finish inside the grace period, then completes it', async () => {
    const gate = deferred();
    const h = harness({ queue: [row()] });
    const rt = h.start({ index_document: () => gate.promise });
    await tick(0);
    expect(rt.runningCount()).toBe(1);
    const claimsBefore = h.named('claim_jobs').length;

    let result: { drained: boolean; aborted: number } | undefined;
    void rt.shutdown().then((r) => (result = r));
    await tick(2000);
    expect(result).toBeUndefined();
    gate.resolve();
    await tick(0);
    expect(result).toEqual({ drained: true, aborted: 0 });
    expect(h.named('complete_job')).toHaveLength(1);
    await tick(10_000);
    expect(h.named('claim_jobs')).toHaveLength(claimsBefore);
  });

  it('aborts jobs still running after the grace period and leaves them to lease expiry', async () => {
    let signal: AbortSignal | undefined;
    const h = harness({ queue: [row()], config: { shutdownGraceMs: 5000 } });
    const rt = h.start({
      index_document: (_j, ctx) =>
        new Promise<void>((_res, rej) => {
          signal = ctx.signal;
          ctx.signal.addEventListener('abort', () => {
            rej(new Error('aborted'));
          });
        }),
    });
    await tick(0);
    let result: { drained: boolean; aborted: number } | undefined;
    void rt.shutdown().then((r) => (result = r));
    await tick(4999);
    expect(signal?.aborted).toBe(false);
    expect(result).toBeUndefined();
    await tick(1);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(ShutdownError);
    await tick(0);
    expect(result).toEqual({ drained: false, aborted: 1 });
    // The job is left to lease expiry: no completion, no retry, no failure.
    expect(h.named('complete_job')).toHaveLength(0);
    expect(h.named('retry_job_later')).toHaveLength(0);
    expect(h.named('fail_job')).toHaveLength(0);
  });

  it('does not complete a job whose handler RESOLVES after the shutdown abort (it returned early)', async () => {
    const h = harness({ queue: [row()], config: { shutdownGraceMs: 5000 } });
    const rt = h.start({
      index_document: (_j, ctx) =>
        new Promise<void>((resolve) => {
          // A well-behaved handler stops promptly and returns normally when the signal aborts.
          ctx.signal.addEventListener('abort', () => {
            resolve();
          });
        }),
    });
    await tick(0);
    let result: { drained: boolean; aborted: number } | undefined;
    void rt.shutdown().then((r) => (result = r));
    await tick(5000);
    await tick(0);
    expect(result).toEqual({ drained: false, aborted: 1 });
    expect(h.named('complete_job')).toHaveLength(0);
    expect(h.named('retry_job_later')).toHaveLength(0);
    expect(h.named('fail_job')).toHaveLength(0);
  });

  it('still completes a job that resolves normally inside the grace period', async () => {
    const gate = deferred();
    const h = harness({ queue: [row()], config: { shutdownGraceMs: 5000 } });
    const rt = h.start({ index_document: () => gate.promise });
    await tick(0);
    void rt.shutdown();
    await tick(1000);
    gate.resolve();
    await tick(0);
    expect(h.named('complete_job')).toHaveLength(1);
  });

  it('is bounded even when a handler ignores the abort', async () => {
    const never = new Promise<void>(() => undefined);
    const h = harness({ queue: [row()], config: { shutdownGraceMs: 1000 } });
    const rt = h.start({ index_document: () => never });
    await tick(0);
    let result: { drained: boolean; aborted: number } | undefined;
    void rt.shutdown().then((r) => (result = r));
    await tick(1000);
    expect(result).toBeUndefined();
    await tick(ABORT_SETTLE_MS);
    expect(result).toEqual({ drained: false, aborted: 1 });
  });

  it('does not start new jobs after shutdown begins, even if a claim was in flight', async () => {
    const claimGate = deferred();
    const ran = vi.fn();
    const j = row();
    const h = harness({
      impl: {
        claim_jobs: async () => {
          await claimGate.promise;
          return [j];
        },
      },
    });
    const rt = h.start({
      index_document: () => {
        ran();
        return Promise.resolve();
      },
    });
    await tick(0);
    const done = rt.shutdown();
    claimGate.resolve();
    await tick(0);
    await tick(10_000);
    await done;
    // A claimed job still runs and completes (it is ours); nothing new is claimed afterwards.
    expect(h.named('claim_jobs')).toHaveLength(1);
    expect(ran).toHaveBeenCalledTimes(1);
    expect(h.named('complete_job')).toHaveLength(1);
  });

  it('can be called twice', async () => {
    const h = harness();
    const rt = h.start({ index_document: () => Promise.resolve() });
    await tick(0);
    await rt.shutdown();
    expect((await rt.shutdown()).drained).toBe(true);
  });
});

describe('runtime: nothing sensitive is logged', () => {
  it('logs ids, counts and codes only', async () => {
    const h = harness({
      queue: [row(), row({ type: 'warm_answer_cache' })],
      random: () => 0,
    });
    const rt = h.start({
      index_document: () => Promise.reject(new Error(`fail ${SENTINEL_ERROR}`)),
    });
    await tick(0);
    await rt.shutdown();
    const out = h.lines.join('\n');
    expect(out).not.toContain(SENTINEL_PAYLOAD);
    expect(out).not.toContain(SENTINEL_ERROR);
    expect(out).toContain('job_retry_scheduled');
    for (const l of h.lines) expect(() => JSON.parse(l)).not.toThrow();
  });
});

describe('logger field sanitising', () => {
  it('redacts sensitive names, omits objects, keeps counts and ids', () => {
    const out = sanitizeFields({
      job_id: 'abc',
      chunk_count: 7,
      duration_ms: 12,
      text: 'document body',
      payload: 'x',
      api_key: 'k',
      nested: { a: 1 },
      list: [1],
      err: new Error('x'),
      ok: true,
      nothing: null,
      inf: Number.POSITIVE_INFINITY,
      long: 'z'.repeat(500),
    });
    expect(out['job_id']).toBe('abc');
    expect(out['chunk_count']).toBe(7);
    expect(out['duration_ms']).toBe(12);
    expect(out['text']).toBe('[Redacted]');
    expect(out['payload']).toBe('[Redacted]');
    expect(out['api_key']).toBe('[Redacted]');
    expect(out['nested']).toBe('[Omitted]');
    expect(out['list']).toBe('[Omitted]');
    expect(out['err']).toBe('[Omitted]');
    expect(out['ok']).toBe(true);
    expect(out['nothing']).toBeNull();
    expect(out['inf']).toBeNull();
    expect((out['long'] as string).length).toBeLessThan(250);
  });

  it('redacts a string under a count-looking name', () => {
    expect(sanitizeFields({ chunk_count: 'secret body text' })['chunk_count']).toBe('[Redacted]');
  });

  it('respects the level and adds child bindings', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', sink: (l) => void lines.push(l) }).child({
      job_id: 'j1',
    });
    log.info('quiet');
    log.warn('loud', { code: 'X1' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      level: 'warn',
      event: 'loud',
      job_id: 'j1',
      code: 'X1',
    });
  });
});
