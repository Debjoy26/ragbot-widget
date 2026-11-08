// Job runtime (P6-QUEUE): polls claim_jobs, runs handlers with bounded concurrency, keeps each
// job's lease alive with a heartbeat, retries with exponential backoff and jitter, and shuts down
// gracefully. Handlers are injected: with none registered the runtime claims nothing.
//
// Contract with a handler (JobHandler):
//  * It receives the job and a JobContext whose `signal` is aborted when the lease is lost or the
//    process is shutting down. It must stop promptly then.
//  * Resolving means "the job did its work": the runtime calls complete_job. That includes a
//    permanent failure the handler has already recorded (for example a bad file whose version it
//    failed), per the P6 state machine.
//  * Throwing RetryJobError (or any other error) means "transient": the runtime calls
//    retry_job_later with a safe code and a backoff delay. After max_attempts the database
//    dead-letters the job. An unexpected error is reduced to the code `handler_error`; its message
//    is never logged or stored.
//  * A lease lost mid-job (heartbeat refused) aborts the signal and the runtime touches nothing
//    afterwards: another worker owns the job. A shutdown abort likewise leaves the job to lease
//    expiry.
// Nothing here logs payloads, document text or keys: only ids, counts and codes.
import { JOB_TYPES, type JobType } from '@ragbot/shared';
import type { WorkerConfig } from './lib/config.js';
import { createDb, DbError, type Db } from './lib/db.js';
import { errorCode, silentLogger, type Logger } from './lib/logger.js';
import { createStorage, type Storage } from './lib/storage.js';

export interface ClaimedJob {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Already includes this attempt (claim_jobs increments it). */
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface JobContext {
  readonly db: Db;
  readonly storage: Storage;
  readonly config: WorkerConfig;
  /** Aborted when the lease is lost or the worker is shutting down. */
  readonly signal: AbortSignal;
  readonly workerId: string;
  /** Extends the lease now. Rejects with LeaseLostError when the job is no longer ours. */
  heartbeat(): Promise<void>;
  /** Already carries worker_id, job_id and job_type. Ids, counts and codes only. */
  readonly log: Logger;
}

export type JobHandler = (job: ClaimedJob, ctx: JobContext) => Promise<void>;
export type JobHandlers = Readonly<Partial<Record<JobType, JobHandler>>>;

/** Thrown by a handler for a transient failure. `code` must be a short safe token, never free text. */
export class RetryJobError extends Error {
  override readonly name = 'RetryJobError';
  readonly code: string;
  readonly retryAfterSeconds: number | undefined;
  constructor(code: string, options: { retryAfterSeconds?: number } = {}) {
    super(`job should be retried (${code})`);
    this.code = SAFE_CODE.test(code) ? code : 'handler_error';
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** The job's lease is gone. `ctx.heartbeat()` rejects with it and the job's signal aborts with it. */
export class LeaseLostError extends Error {
  override readonly name = 'LeaseLostError';
  constructor() {
    super('job lease lost');
  }
}

/** The signal's reason on shutdown. */
export class ShutdownError extends Error {
  override readonly name = 'ShutdownError';
  constructor() {
    super('worker shutting down');
  }
}

const SAFE_CODE = /^[a-z0-9_]{1,64}$/;
/** After the grace period expires and handlers are aborted, how long we wait for them to settle. */
export const ABORT_SETTLE_MS = 2000;
export const UNKNOWN_JOB_TYPE_CODE = 'unknown_job_type';
export const HANDLER_ERROR_CODE = 'handler_error';

/**
 * Delay before a retry: min(max, base * 2^(attempts-1)), then "equal jitter": a uniform value in
 * [capped/2, capped]. Whole seconds, at least 1, at most 3600 (retry_job_later's bounds).
 */
export function computeBackoffSeconds(
  attempts: number,
  baseSeconds: number,
  maxSeconds: number,
  random: () => number,
): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 30);
  const capped = Math.min(maxSeconds, baseSeconds * 2 ** exponent);
  const jittered = capped / 2 + random() * (capped / 2);
  return Math.min(3600, Math.max(1, Math.ceil(jittered)));
}

export interface RuntimeDeps {
  readonly db: Db;
  readonly storage: Storage;
  readonly log: Logger;
  /** Uniform random in [0, 1). Injected for tests only. */
  readonly random: () => number;
}

export interface ShutdownResult {
  /** True when every running job finished inside the grace period. */
  readonly drained: boolean;
  /** Jobs aborted after the grace period (left to lease expiry). */
  readonly aborted: number;
}

export interface Runtime {
  /** Stops claiming, lets running jobs finish up to shutdownGraceMs, then aborts the rest. */
  shutdown(): Promise<ShutdownResult>;
  /** Jobs running now. */
  runningCount(): number;
}

function parseClaimedJob(row: unknown): ClaimedJob | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  const { id, type, payload, attempts, max_attempts: maxAttempts } = r;
  if (typeof id !== 'string' || id.length === 0 || typeof type !== 'string') return null;
  if (!Number.isInteger(attempts) || !Number.isInteger(maxAttempts)) return null;
  const body =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  return {
    id,
    type,
    payload: Object.freeze(body),
    attempts: attempts as number,
    maxAttempts: maxAttempts as number,
  };
}

function isLeaseRefusal(err: unknown): boolean {
  return err instanceof DbError && err.sqlstate === 'RB013';
}

/** Starts the runtime. `deps` is for tests; by default the clients are built from `config`. */
export function startRuntime(
  config: WorkerConfig,
  handlers: JobHandlers,
  deps: Partial<RuntimeDeps> = {},
): Runtime {
  for (const type of Object.keys(handlers)) {
    if (!(JOB_TYPES as readonly string[]).includes(type)) {
      throw new TypeError('a handler is registered for an unknown job type');
    }
  }
  const types = Object.keys(handlers) as JobType[];
  const db =
    deps.db ??
    createDb({
      url: config.supabaseUrl,
      secretKey: config.supabaseSecretKey,
      timeoutMs: config.dbTimeoutMs,
    });
  const storage =
    deps.storage ??
    createStorage({
      url: config.supabaseUrl,
      secretKey: config.supabaseSecretKey,
      timeoutMs: config.storageTimeoutMs,
    });
  const rootLog = (deps.log ?? silentLogger).child({ worker_id: config.workerId });
  const random = deps.random ?? Math.random;

  const running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let stopping = false;
  let wake: (() => void) | null = null;

  function sleepInterruptible(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  }

  function wakeUp(): void {
    wake?.();
  }

  // ---- one job ---------------------------------------------------------------------------

  async function runJob(
    job: ClaimedJob,
    leaseStartMs: number,
    controller: AbortController,
  ): Promise<void> {
    const log = rootLog.child({ job_id: job.id, job_type: job.type });
    let leaseLost = false;
    let leaseDeadlineMs = leaseStartMs + config.leaseSeconds * 1000;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeating: Promise<void> = Promise.resolve();
    let finished = false;

    const loseLease = (): void => {
      if (leaseLost) return;
      leaseLost = true;
      log.warn('job_lease_lost');
      controller.abort(new LeaseLostError());
    };

    // One heartbeat. A refusal (RB013 or any 4xx) or an expired local deadline means the lease is
    // gone. A transient failure (network, timeout, 5xx) is tolerated until the lease that the last
    // successful heartbeat granted would have run out.
    const beat = async (): Promise<void> => {
      if (leaseLost) throw new LeaseLostError();
      const startedMs = Date.now();
      try {
        await db.rpc<unknown>(
          'heartbeat_job',
          { p_job_id: job.id, p_worker: config.workerId, p_lease_seconds: config.leaseSeconds },
          controller.signal,
          { retryOnContention: true },
        );
        leaseDeadlineMs = startedMs + config.leaseSeconds * 1000;
      } catch (err) {
        if (leaseLost) throw new LeaseLostError();
        const definitive =
          isLeaseRefusal(err) ||
          (err instanceof DbError && err.status !== undefined && err.status < 500);
        if (definitive || Date.now() >= leaseDeadlineMs) {
          log.warn('job_heartbeat_failed', { code: errorCode(err) });
          loseLease();
          throw new LeaseLostError();
        }
        log.warn('job_heartbeat_retrying', { code: errorCode(err) });
      }
    };

    const scheduleBeat = (): void => {
      heartbeatTimer = setTimeout(() => {
        heartbeating = beat().then(
          () => {
            if (!finished && !leaseLost) scheduleBeat();
          },
          () => {
            // beat() already aborted the signal.
          },
        );
      }, config.heartbeatIntervalMs);
    };

    const ctx: JobContext = {
      db,
      storage,
      config,
      signal: controller.signal,
      workerId: config.workerId,
      heartbeat: beat,
      log,
    };

    log.info('job_started', { attempts: job.attempts });
    scheduleBeat();

    let outcome: 'ok' | { error: unknown };
    const handler = (handlers as Record<string, JobHandler | undefined>)[job.type];
    if (handler === undefined) {
      outcome = { error: new RetryJobError(UNKNOWN_JOB_TYPE_CODE) };
    } else {
      try {
        await handler(job, ctx);
        outcome = 'ok';
      } catch (err) {
        outcome = { error: err };
      }
    }

    finished = true;
    clearTimeout(heartbeatTimer);
    await heartbeating;

    try {
      if (leaseLost) {
        log.warn('job_abandoned', { reason: 'lease_lost' });
        return;
      }
      if (outcome === 'ok') {
        await db.rpc<unknown>(
          'complete_job',
          { p_job_id: job.id, p_worker: config.workerId },
          undefined,
          { retryOnContention: true },
        );
        log.info('job_completed');
        return;
      }
      const reason: unknown = controller.signal.reason;
      if (controller.signal.aborted && reason instanceof ShutdownError) {
        log.warn('job_abandoned', { reason: 'shutdown' });
        return;
      }
      const err = outcome.error;
      const retry = err instanceof RetryJobError ? err : undefined;
      const code =
        retry !== undefined
          ? retry.code
          : handler === undefined
            ? UNKNOWN_JOB_TYPE_CODE
            : HANDLER_ERROR_CODE;
      let delay = computeBackoffSeconds(
        job.attempts,
        config.backoffBaseSeconds,
        config.backoffMaxSeconds,
        random,
      );
      if (code === UNKNOWN_JOB_TYPE_CODE) {
        delay = config.backoffMaxSeconds;
      } else if (
        retry?.retryAfterSeconds !== undefined &&
        Number.isFinite(retry.retryAfterSeconds)
      ) {
        delay = Math.min(
          config.backoffMaxSeconds,
          Math.max(delay, Math.ceil(retry.retryAfterSeconds)),
        );
      }
      delay = Math.min(3600, Math.max(1, Math.floor(delay)));
      const state = await db.rpc<unknown>(
        'retry_job_later',
        {
          p_job_id: job.id,
          p_worker: config.workerId,
          p_error_code: code,
          p_delay_seconds: delay,
        },
        undefined,
        { retryOnContention: true },
      );
      log.warn('job_retry_scheduled', {
        code,
        delay_seconds: delay,
        attempts: job.attempts,
        state: typeof state === 'string' ? state : null,
      });
    } catch (err) {
      // The bookkeeping call failed (lease already gone, database down). The lease will expire and
      // the job will be claimed again; handlers are idempotent.
      log.error('job_bookkeeping_failed', { code: errorCode(err) });
    }
  }

  // ---- polling ---------------------------------------------------------------------------

  async function pollOnce(): Promise<void> {
    const free = config.concurrency - running.size;
    if (free <= 0) return;
    const claimStartMs = Date.now();
    const rows = await db.rpc<unknown>('claim_jobs', {
      p_worker: config.workerId,
      p_limit: free,
      p_lease_seconds: config.leaseSeconds,
      p_types: types,
    });
    if (!Array.isArray(rows)) throw new DbError('invalid_response');
    for (const row of rows) {
      const job = parseClaimedJob(row);
      if (job === null) {
        rootLog.error('claim_row_invalid');
        continue;
      }
      if (running.has(job.id) || running.size >= config.concurrency) continue;
      const controller = new AbortController();
      const done = runJobTracked(job, claimStartMs, controller);
      running.set(job.id, { controller, done });
    }
  }

  async function runJobTracked(
    job: ClaimedJob,
    leaseStartMs: number,
    controller: AbortController,
  ): Promise<void> {
    try {
      await runJob(job, leaseStartMs, controller);
    } finally {
      running.delete(job.id);
      wakeUp();
    }
  }

  let loopDone: Promise<void> = Promise.resolve();
  if (types.length > 0) {
    loopDone = (async () => {
      let failures = 0;
      while (!stopping) {
        let delay = config.pollIntervalMs;
        try {
          await pollOnce();
          failures = 0;
        } catch (err) {
          failures += 1;
          rootLog.error('claim_failed', { code: errorCode(err), failures });
          delay = Math.min(
            config.pollIntervalMs * 2 ** Math.min(failures, 10),
            config.backoffMaxSeconds * 1000,
          );
        }
        if (stopping) break;
        await sleepInterruptible(delay);
      }
    })();
  } else {
    rootLog.info('runtime_idle', { reason: 'no_handlers' });
  }

  return {
    runningCount: () => running.size,

    async shutdown(): Promise<ShutdownResult> {
      if (!stopping) {
        stopping = true;
        rootLog.info('shutdown_started', { running: running.size });
      }
      wakeUp();
      await loopDone;
      const settled = (): Promise<void> =>
        Promise.all([...running.values()].map((e) => e.done)).then(() => undefined);

      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const drained = await Promise.race([
        settled().then(() => true),
        new Promise<boolean>((resolve) => {
          graceTimer = setTimeout(() => {
            resolve(false);
          }, config.shutdownGraceMs);
        }),
      ]);
      clearTimeout(graceTimer);
      if (drained) return { drained: true, aborted: 0 };

      const aborted = running.size;
      for (const entry of running.values()) entry.controller.abort(new ShutdownError());
      rootLog.warn('shutdown_aborting', { aborted });
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        settled(),
        new Promise<void>((resolve) => {
          settleTimer = setTimeout(resolve, ABORT_SETTLE_MS);
        }),
      ]);
      clearTimeout(settleTimer);
      return { drained: false, aborted };
    },
  };
}
