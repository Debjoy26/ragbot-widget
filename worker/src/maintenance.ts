// Maintenance scheduler (P6-QUEUE): periodic retention and housekeeping calls (status section 3a
// ae and av, the P5 bucket-purge item). Every task is isolated: one failing task is logged with a
// code and the rest still run. Logs carry task name, count and code only, never rows or text.
//
// RB020 (retention policy missing for a bot) is a configuration gap the owner must fix, not a
// crash: it is logged as a warning and the next interval tries again.
import type { WorkerConfig } from './lib/config.js';
import { DbError, type Db } from './lib/db.js';
import { errorCode, silentLogger, type Logger } from './lib/logger.js';
import { isSafeObjectPath, type Storage } from './lib/storage.js';

export interface MaintenanceDeps {
  readonly db: Db;
  readonly storage: Storage;
  readonly log?: Logger;
}

export interface TaskResult {
  readonly task: string;
  readonly ok: boolean;
  /** Rows affected (summed for functions that report several counts). 0 when the task failed. */
  readonly count: number;
  /** SQLSTATE or short reason when the task failed. */
  readonly code?: string;
}

interface Task {
  readonly name: string;
  run(config: WorkerConfig, deps: Required<MaintenanceDeps>, signal: AbortSignal): Promise<number>;
}

const RETRY = { retryOnContention: true } as const;

/** fail_orphaned_index_versions, prune_superseded_chunks and settle_orphaned_index_reservations accept a batch of 1..1000 (migration 012). */
export const INDEX_MAINTENANCE_MAX_BATCH = 1000;

/** expire_abandoned_uploads accepts a batch of 1..1000 (migration 012), tighter than the other tasks. */
export const ABANDONED_UPLOAD_MAX_BATCH = 1000;

/** Accepts an integer or an object of integer counts (jsonb); anything else is an invalid response. */
function totalCount(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    let sum = 0;
    for (const v of Object.values(value)) {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0)
        throw new DbError('invalid_response');
      sum += v;
    }
    return sum;
  }
  throw new DbError('invalid_response');
}

const call =
  (name: string, args: (c: WorkerConfig) => Record<string, unknown>): Task['run'] =>
  async (config, { db }, signal) =>
    totalCount(await db.rpc<unknown>(name, args(config), signal, RETRY));

export const MAINTENANCE_TASKS: readonly Task[] = [
  {
    name: 'expire_stuck_request_runs',
    run: call('expire_stuck_request_runs', (c) => ({
      p_older_than_seconds: c.stuckRunThresholdSeconds,
      p_batch: c.retentionBatchSize,
    })),
  },
  {
    name: 'expire_visitor_sessions',
    run: call('expire_visitor_sessions', (c) => ({
      p_batch: c.retentionBatchSize,
      p_grace_seconds: c.visitorSessionGraceSeconds,
    })),
  },
  {
    name: 'purge_expired_rate_limit_buckets',
    run: call('purge_expired_rate_limit_buckets', (c) => ({ p_batch: c.purgeBatchSize })),
  },
  {
    name: 'purge_expired_caches',
    run: call('purge_expired_caches', (c) => ({ p_batch: c.purgeBatchSize })),
  },
  {
    name: 'expire_stale_budget_reservations',
    run: call('expire_stale_budget_reservations', (c) => ({ p_batch: c.retentionBatchSize })),
  },
  // After the expiry sweep: settles job reservations left `reserved` or `expired` by attempts that
  // can no longer settle them (review P6-R4, F2). Batch 1..1000, like the other index tasks.
  {
    name: 'settle_orphaned_index_reservations',
    run: call('settle_orphaned_index_reservations', (c) => ({
      p_batch: Math.min(c.retentionBatchSize, INDEX_MAINTENANCE_MAX_BATCH),
    })),
  },
  {
    name: 'purge_expired_conversations',
    run: call('purge_expired_conversations', (c) => ({ p_batch: c.retentionBatchSize })),
  },
  {
    name: 'purge_expired_data_entries',
    run: call('purge_expired_data_entries', (c) => ({ p_batch: c.retentionBatchSize })),
  },
  {
    name: 'purge_expired_usage_records',
    run: call('purge_expired_usage_records', (c) => ({ p_batch: c.purgeBatchSize })),
  },
  // Order matters (review P6-R3, R-6): fail_orphaned_index_versions runs BEFORE purge_terminal_jobs,
  // so it sees the index jobs before the purge deletes the finished ones.
  {
    name: 'fail_orphaned_index_versions',
    run: call('fail_orphaned_index_versions', (c) => ({
      p_batch: Math.min(c.retentionBatchSize, INDEX_MAINTENANCE_MAX_BATCH),
    })),
  },
  {
    name: 'purge_terminal_jobs',
    run: call('purge_terminal_jobs', (c) => ({
      p_older_than_days: c.terminalJobRetentionDays,
      p_batch: c.retentionBatchSize,
    })),
  },
  {
    name: 'prune_superseded_chunks',
    run: call('prune_superseded_chunks', (c) => ({
      p_batch: Math.min(c.retentionBatchSize, INDEX_MAINTENANCE_MAX_BATCH),
    })),
  },
  {
    name: 'expire_abandoned_uploads',
    async run(config, { db, storage }, signal) {
      const rows = await db.rpc<unknown>(
        'expire_abandoned_uploads',
        {
          p_older_than_hours: config.abandonedUploadHours,
          p_batch: Math.min(config.retentionBatchSize, ABANDONED_UPLOAD_MAX_BATCH),
        },
        signal,
        RETRY,
      );
      if (!Array.isArray(rows)) throw new DbError('invalid_response');
      const paths: string[] = [];
      for (const row of rows) {
        const path = (row as { storage_path?: unknown } | null)?.storage_path;
        // A row with a path we would not send to Storage is skipped, not fatal.
        if (isSafeObjectPath(path)) paths.push(path);
      }
      // The versions are already failed in the database. A removal failure here leaves objects that
      // nothing references any more; the task reports the failure and the objects stay (known gap).
      if (paths.length > 0) await storage.remove(paths, signal);
      return paths.length;
    },
  },
];

/** A short safe reason for a failed task: the SQLSTATE, or the failure kind for transport errors. */
function failureCode(err: unknown): string {
  if (err instanceof DbError) {
    if (err.sqlstate !== undefined) return err.sqlstate;
    return err.status === undefined ? err.reason : `${err.reason}_${String(err.status)}`;
  }
  return errorCode(err);
}

/** Runs every task once, in order, each isolated from the others' failures. */
export async function runMaintenance(
  config: WorkerConfig,
  deps: MaintenanceDeps,
  signal: AbortSignal,
): Promise<TaskResult[]> {
  const full: Required<MaintenanceDeps> = { ...deps, log: deps.log ?? silentLogger };
  const results: TaskResult[] = [];
  for (const task of MAINTENANCE_TASKS) {
    if (signal.aborted) break;
    const started = Date.now();
    try {
      const count = await task.run(config, full, signal);
      results.push({ task: task.name, ok: true, count });
      full.log.info('maintenance_task', {
        task: task.name,
        count,
        duration_ms: Date.now() - started,
      });
    } catch (err) {
      const code = failureCode(err);
      results.push({ task: task.name, ok: false, count: 0, code });
      if (code === 'RB020') {
        full.log.warn('maintenance_retention_policy_missing', { task: task.name, code });
      } else {
        full.log.error('maintenance_task_failed', { task: task.name, code });
      }
    }
  }
  return results;
}

export interface Maintenance {
  /** Stops scheduling, aborts the pass in progress and waits for it to end. */
  stop(): Promise<void>;
}

/**
 * Runs a pass now, then again `maintenanceIntervalSeconds` after each pass ends (passes never
 * overlap). The first pass waits one poll interval so start-up does not stack calls.
 */
export function startMaintenance(config: WorkerConfig, deps: MaintenanceDeps): Maintenance {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pass: Promise<void> = Promise.resolve();
  const log = deps.log ?? silentLogger;

  const schedule = (ms: number): void => {
    timer = setTimeout(() => {
      pass = runMaintenance(config, deps, controller.signal).then(
        () => {
          if (!controller.signal.aborted) schedule(config.maintenanceIntervalSeconds * 1000);
        },
        (err: unknown) => {
          // runMaintenance isolates task failures; reaching here is a bug. Keep the loop alive.
          log.error('maintenance_pass_failed', { code: errorCode(err) });
          if (!controller.signal.aborted) schedule(config.maintenanceIntervalSeconds * 1000);
        },
      );
    }, ms);
  };
  schedule(config.pollIntervalMs);

  return {
    async stop() {
      controller.abort();
      clearTimeout(timer);
      await pass;
    },
  };
}
