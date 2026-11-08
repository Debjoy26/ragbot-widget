import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerConfig } from '../../../worker/src/lib/config.ts';
import { DbError, type Db } from '../../../worker/src/lib/db.ts';
import { createLogger } from '../../../worker/src/lib/logger.ts';
import type { Storage } from '../../../worker/src/lib/storage.ts';
import {
  MAINTENANCE_TASKS,
  runMaintenance,
  startMaintenance,
} from '../../../worker/src/maintenance.ts';

// P6-QUEUE: maintenance with a labelled FAKE database and storage. The real functions are
// exercised by the pgTAP suites and the integration test, not here.

const BOT = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const VER = '33333333-3333-4333-8333-333333333333';
const PATH_A = `${BOT}/${DOC}/${VER}/a.pdf`;
const PATH_B = `${BOT}/${DOC}/${VER}/b.md`;

const config = {
  workerId: 'w-test',
  pollIntervalMs: 1000,
  maintenanceIntervalSeconds: 60,
  retentionBatchSize: 10,
  purgeBatchSize: 20,
  stuckRunThresholdSeconds: 300,
  visitorSessionGraceSeconds: 3600,
  terminalJobRetentionDays: 30,
  abandonedUploadHours: 24,
} as unknown as WorkerConfig;

const EXPECTED = [
  'expire_stuck_request_runs',
  'expire_visitor_sessions',
  'purge_expired_rate_limit_buckets',
  'purge_expired_caches',
  'expire_stale_budget_reservations',
  'purge_expired_conversations',
  'purge_expired_data_entries',
  'purge_expired_usage_records',
  'fail_orphaned_index_versions',
  'purge_terminal_jobs',
  'prune_superseded_chunks',
  'expire_abandoned_uploads',
];

function setup(impl: Partial<Record<string, (args: Record<string, unknown>) => unknown>> = {}) {
  const calls: { name: string; args: Record<string, unknown>; options: unknown }[] = [];
  const db: Db = {
    rpc: (name, args, _s, options) => {
      calls.push({ name, args: { ...args }, options });
      try {
        const fn = impl[name];
        return Promise.resolve(
          (fn === undefined ? (name === 'expire_abandoned_uploads' ? [] : 0) : fn(args)) as never,
        );
      } catch (err) {
        return Promise.reject(err as Error);
      }
    },
  };
  const removed: string[][] = [];
  let removeError: unknown;
  const storage: Storage = {
    download: () => Promise.reject(new Error('unused')),
    remove: (paths) => {
      if (removeError !== undefined) return Promise.reject(removeError as Error);
      removed.push([...paths]);
      return Promise.resolve(paths.length);
    },
  };
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', sink: (l) => void lines.push(l) });
  return {
    calls,
    removed,
    lines,
    deps: { db, storage, log },
    failRemove: (e: unknown) => {
      removeError = e;
    },
  };
}

const live = new AbortController().signal;

describe('maintenance tasks', () => {
  it('covers exactly the listed functions, in order', () => {
    expect(MAINTENANCE_TASKS.map((t) => t.name)).toEqual(EXPECTED);
  });

  it('fails orphaned index versions before it purges terminal jobs (R-6)', async () => {
    const names = MAINTENANCE_TASKS.map((t) => t.name);
    expect(names.indexOf('fail_orphaned_index_versions')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('fail_orphaned_index_versions')).toBeLessThan(
      names.indexOf('purge_terminal_jobs'),
    );
    // And the order holds at run time, not only in the list.
    const s = setup();
    await runMaintenance(config, s.deps, live);
    const ran = s.calls.map((c) => c.name);
    expect(ran.indexOf('fail_orphaned_index_versions')).toBeLessThan(
      ran.indexOf('purge_terminal_jobs'),
    );
  });

  it('calls each function once with configured arguments and opt-in contention retry', async () => {
    const s = setup();
    const results = await runMaintenance(config, s.deps, live);
    expect(s.calls.map((c) => c.name)).toEqual(EXPECTED);
    expect(results.every((r) => r.ok)).toBe(true);
    const by = Object.fromEntries(s.calls.map((c) => [c.name, c.args]));
    expect(by['expire_stuck_request_runs']).toEqual({ p_older_than_seconds: 300, p_batch: 10 });
    expect(by['expire_visitor_sessions']).toEqual({ p_batch: 10, p_grace_seconds: 3600 });
    expect(by['purge_expired_rate_limit_buckets']).toEqual({ p_batch: 20 });
    expect(by['purge_expired_caches']).toEqual({ p_batch: 20 });
    expect(by['purge_expired_usage_records']).toEqual({ p_batch: 20 });
    expect(by['purge_terminal_jobs']).toEqual({ p_older_than_days: 30, p_batch: 10 });
    expect(by['expire_abandoned_uploads']).toEqual({ p_older_than_hours: 24, p_batch: 10 });
    expect(by['fail_orphaned_index_versions']).toEqual({ p_batch: 10 });
    expect(by['prune_superseded_chunks']).toEqual({ p_batch: 10 });
    expect(
      s.calls.every((c) => (c.options as { retryOnContention?: boolean }).retryOnContention),
    ).toBe(true);
  });

  it('sums jsonb count objects and logs a count, not rows', async () => {
    const s = setup({
      purge_expired_caches: () => ({
        query_embedding_cache: 2,
        moderation_cache: 3,
        answer_cache: 4,
      }),
      expire_stuck_request_runs: () => 7,
    });
    const results = await runMaintenance(config, s.deps, live);
    expect(results.find((r) => r.task === 'purge_expired_caches')?.count).toBe(9);
    expect(results.find((r) => r.task === 'expire_stuck_request_runs')?.count).toBe(7);
    expect(
      s.lines.some((l) => l.includes('"task":"purge_expired_caches"') && l.includes('"count":9')),
    ).toBe(true);
  });

  it('treats an unexpected response shape as a failed task, not a crash', async () => {
    const s = setup({
      purge_terminal_jobs: () => 'many',
      purge_expired_caches: () => ({ a: 'x' }),
    });
    const results = await runMaintenance(config, s.deps, live);
    expect(
      results
        .filter((r) => !r.ok)
        .map((r) => r.task)
        .sort(),
    ).toEqual(['purge_expired_caches', 'purge_terminal_jobs']);
    expect(results).toHaveLength(EXPECTED.length);
  });
});

describe('maintenance isolation of failures', () => {
  it('a failing task does not stop the others; each failure logs a code only', async () => {
    const leak = 'row-content-should-never-appear';
    const s = setup({
      expire_stuck_request_runs: () => {
        throw new DbError('http', 500, '40001');
      },
      purge_expired_caches: () => {
        throw new DbError('network');
      },
      purge_expired_conversations: () => {
        throw new Error(leak);
      },
    });
    const results = await runMaintenance(config, s.deps, live);
    expect(results).toHaveLength(EXPECTED.length);
    expect(results.filter((r) => r.ok)).toHaveLength(EXPECTED.length - 3);
    expect(results.find((r) => r.task === 'expire_stuck_request_runs')).toMatchObject({
      ok: false,
      code: '40001',
    });
    expect(results.find((r) => r.task === 'purge_expired_caches')?.code).toBe('network');
    expect(s.calls.map((c) => c.name)).toEqual(EXPECTED);
    expect(s.lines.join('\n')).not.toContain(leak);
    expect(s.lines.filter((l) => l.includes('maintenance_task_failed'))).toHaveLength(3);
  });

  it('logs RB020 as a warning, not an error, and continues', async () => {
    const s = setup({
      purge_expired_data_entries: () => {
        throw new DbError('http', 400, 'RB020');
      },
      purge_expired_usage_records: () => {
        throw new DbError('http', 400, 'RB020');
      },
    });
    const results = await runMaintenance(config, s.deps, live);
    expect(results.filter((r) => r.code === 'RB020')).toHaveLength(2);
    const warns = s.lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l['event'] === 'maintenance_retention_policy_missing');
    expect(warns).toHaveLength(2);
    expect(warns.every((w) => w['level'] === 'warn' && w['code'] === 'RB020')).toBe(true);
    expect(s.lines.some((l) => l.includes('maintenance_task_failed'))).toBe(false);
    expect(s.calls).toHaveLength(EXPECTED.length);
  });

  it('a missing function (older schema) fails only that task', async () => {
    const s = setup({
      expire_abandoned_uploads: () => {
        throw new DbError('http', 404, undefined);
      },
    });
    const results = await runMaintenance(config, s.deps, live);
    expect(results.find((r) => r.task === 'expire_abandoned_uploads')).toMatchObject({
      ok: false,
      code: 'http_404',
    });
    expect(results.filter((r) => r.ok)).toHaveLength(EXPECTED.length - 1);
  });

  it('stops between tasks once aborted', async () => {
    const c = new AbortController();
    const s = setup({
      purge_expired_caches: () => {
        c.abort();
        return 0;
      },
    });
    const results = await runMaintenance(config, s.deps, c.signal);
    expect(results.map((r) => r.task)).toEqual(EXPECTED.slice(0, 4));
  });
});

describe('expire_abandoned_uploads: object removal', () => {
  it('removes the returned objects through storage', async () => {
    const s = setup({
      expire_abandoned_uploads: () => [
        { version_id: VER, storage_path: PATH_A },
        { version_id: DOC, storage_path: PATH_B },
      ],
    });
    const results = await runMaintenance(config, s.deps, live);
    expect(s.removed).toEqual([[PATH_A, PATH_B]]);
    expect(results.find((r) => r.task === 'expire_abandoned_uploads')).toMatchObject({
      ok: true,
      count: 2,
    });
  });

  it('caps the batch at the function limit of 1000', async () => {
    const s = setup();
    await runMaintenance({ ...config, retentionBatchSize: 5000 } as WorkerConfig, s.deps, live);
    const call = s.calls.find((c) => c.name === 'expire_abandoned_uploads');
    expect(call?.args['p_batch']).toBe(1000);
    const other = s.calls.find((c) => c.name === 'purge_expired_conversations');
    expect(other?.args['p_batch']).toBe(5000);
  });

  it('caps the index maintenance batches at the function limit of 1000', async () => {
    const s = setup();
    await runMaintenance({ ...config, retentionBatchSize: 5000 } as WorkerConfig, s.deps, live);
    for (const name of ['fail_orphaned_index_versions', 'prune_superseded_chunks']) {
      expect(s.calls.find((c) => c.name === name)?.args['p_batch']).toBe(1000);
    }
  });

  it('isolates the index tasks: one failing does not stop the other or the rest', async () => {
    const s = setup({
      fail_orphaned_index_versions: () => {
        throw new DbError('http', 400, 'XX000');
      },
    });
    const results = await runMaintenance(config, s.deps, live);
    expect(results.find((r) => r.task === 'fail_orphaned_index_versions')).toMatchObject({
      ok: false,
      code: 'XX000',
    });
    expect(results.find((r) => r.task === 'prune_superseded_chunks')?.ok).toBe(true);
    expect(results.find((r) => r.task === 'expire_abandoned_uploads')?.ok).toBe(true);
    expect(results).toHaveLength(EXPECTED.length);
  });

  it('does not call storage when nothing expired', async () => {
    const s = setup({ expire_abandoned_uploads: () => [] });
    await runMaintenance(config, s.deps, live);
    expect(s.removed).toHaveLength(0);
  });

  it('skips a path that does not have the storage_path shape instead of sending it', async () => {
    const s = setup({
      expire_abandoned_uploads: () => [
        { version_id: VER, storage_path: '../../etc/passwd' },
        { version_id: VER, storage_path: null },
        { version_id: VER, storage_path: PATH_A },
      ],
    });
    await runMaintenance(config, s.deps, live);
    expect(s.removed).toEqual([[PATH_A]]);
  });

  it('reports a storage failure as that task failing; the rest still ran', async () => {
    const s = setup({
      expire_abandoned_uploads: () => [{ version_id: VER, storage_path: PATH_A }],
    });
    s.failRemove(Object.assign(new Error('x'), { name: 'StorageError' }));
    const results = await runMaintenance(config, s.deps, live);
    expect(results.find((r) => r.task === 'expire_abandoned_uploads')).toMatchObject({
      ok: false,
      code: 'StorageError',
    });
    expect(results.filter((r) => r.ok)).toHaveLength(EXPECTED.length - 1);
  });

  it('rejects a non-array response', async () => {
    const s = setup({ expire_abandoned_uploads: () => ({ rows: [] }) });
    const results = await runMaintenance(config, s.deps, live);
    expect(results.find((r) => r.task === 'expire_abandoned_uploads')?.ok).toBe(false);
  });
});

describe('startMaintenance (scheduler)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a first pass after one poll interval, then every interval after a pass ends', async () => {
    const s = setup();
    const m = startMaintenance(config, s.deps);
    await vi.advanceTimersByTimeAsync(999);
    expect(s.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls).toHaveLength(EXPECTED.length);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(s.calls).toHaveLength(EXPECTED.length);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls).toHaveLength(EXPECTED.length * 2);
    await m.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(s.calls).toHaveLength(EXPECTED.length * 2);
  });

  it('keeps scheduling after a pass with failing tasks', async () => {
    const s = setup({
      purge_terminal_jobs: () => {
        throw new DbError('network');
      },
    });
    const m = startMaintenance(config, s.deps);
    await vi.advanceTimersByTimeAsync(1000 + 60_000);
    expect(s.calls.filter((c) => c.name === 'purge_terminal_jobs')).toHaveLength(2);
    await m.stop();
  });

  it('stop() waits for the pass in progress and nothing runs afterwards', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = setup();
    const slow: Db = {
      rpc: async (name, args, signal, options) => {
        if (name === 'purge_expired_caches') await gate;
        return s.deps.db.rpc(name, args, signal, options);
      },
    };
    const m = startMaintenance(config, { ...s.deps, db: slow });
    await vi.advanceTimersByTimeAsync(1000);
    let stopped = false;
    void m.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(true);
    const n = s.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(s.calls).toHaveLength(n);
    expect(n).toBeLessThan(EXPECTED.length * 2);
  });
});
