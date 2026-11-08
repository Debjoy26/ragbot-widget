import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createCleanupHandler } from '../../../worker/src/jobs/cleanup.ts';
import type { WorkerConfig } from '../../../worker/src/lib/config.ts';
import { DbError, type Db } from '../../../worker/src/lib/db.ts';
import { createLogger } from '../../../worker/src/lib/logger.ts';
import type { Storage } from '../../../worker/src/lib/storage.ts';
import type { ClaimedJob, JobContext } from '../../../worker/src/runtime.ts';

// P6-INDEX: the cleanup handler against a labelled FAKE database and FAKE storage.

const BOT_ID = randomUUID();
const DOC_ID = randomUUID();
const SENTINEL = `name-${randomBytes(5).toString('hex')}`;

function objectPath(name: string): string {
  return `${randomUUID()}/${DOC_ID}/${randomUUID()}/${name}`;
}

interface Rig {
  calls: { name: string; args: Record<string, unknown> }[];
  removed: string[][];
  logs: string[];
  responders: Record<string, (args: Record<string, unknown>, n: number) => unknown>;
  heartbeat: ReturnType<typeof vi.fn>;
  controller: AbortController;
  ctx: JobContext;
}

function makeRig(retentionBatchSize = 10): Rig {
  const calls: Rig['calls'] = [];
  const removed: string[][] = [];
  const logs: string[] = [];
  const counts: Record<string, number> = {};
  const responders: Rig['responders'] = {
    cleanup_document: () => [{ deleted_chunks: 0, done: true }],
    cleanup_storage_targets: () => [],
  };
  const db: Db = {
    rpc: (name: string, args: Readonly<Record<string, unknown>>) => {
      calls.push({ name, args: { ...args } });
      counts[name] = (counts[name] ?? 0) + 1;
      const responder = responders[name];
      if (responder === undefined) return Promise.reject(new Error(`unexpected rpc ${name}`));
      try {
        return Promise.resolve(responder(args, counts[name] ?? 0) as never);
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };
  const storage: Storage = {
    download: () => Promise.reject(new Error('not used')),
    remove: (paths: readonly string[]) => {
      removed.push([...paths]);
      return Promise.resolve(paths.length);
    },
  };
  const controller = new AbortController();
  const heartbeat = vi.fn(() => Promise.resolve());
  const ctx: JobContext = {
    db,
    storage,
    config: { retentionBatchSize } as unknown as WorkerConfig,
    signal: controller.signal,
    workerId: 'w-test',
    heartbeat,
    log: createLogger({
      level: 'debug',
      sink: (l) => {
        logs.push(l);
      },
    }),
  };
  return { calls, removed, logs, responders, heartbeat, controller, ctx };
}

const job = (payload: Record<string, unknown>): ClaimedJob => ({
  id: randomUUID(),
  type: 'cleanup',
  payload,
  attempts: 1,
  maxAttempts: 3,
});

const documentJob = job({ bot_id: BOT_ID, scope: 'document', resource_id: DOC_ID });
const run = (rig: Rig, j: ClaimedJob = documentJob): Promise<void> =>
  createCleanupHandler()(j, rig.ctx);

describe('cleanup: document scope', () => {
  it('loops cleanup_document until done, then removes the unreferenced storage objects', async () => {
    const rig = makeRig(50);
    rig.responders['cleanup_document'] = (_a, n) =>
      n < 3 ? [{ deleted_chunks: 50, done: false }] : [{ deleted_chunks: 7, done: true }];
    const paths = [objectPath('a.txt'), objectPath('b.pdf')];
    rig.responders['cleanup_storage_targets'] = () =>
      paths.map((storage_path) => ({ storage_path }));
    await run(rig);

    const names = rig.calls.map((c) => c.name);
    expect(names).toEqual([
      'cleanup_document',
      'cleanup_document',
      'cleanup_document',
      'cleanup_storage_targets',
    ]);
    expect(rig.calls[0]?.args).toEqual({ p_document_id: DOC_ID, p_batch: 50 });
    expect(rig.removed).toEqual([paths]);
    expect(rig.heartbeat).toHaveBeenCalledTimes(2);
    const done = rig.logs.map((l) => JSON.parse(l) as Record<string, unknown>).at(-1);
    expect(done).toMatchObject({
      event: 'cleanup_document_done',
      deleted_count: 107,
      removed_count: 2,
    });
  });

  it('caps the batch at the database maximum of 1000', async () => {
    const rig = makeRig(5000);
    await run(rig);
    expect(rig.calls[0]?.args['p_batch']).toBe(1000);
  });

  it('is idempotent: a repeat with nothing left completes and removes nothing', async () => {
    const rig = makeRig();
    await run(rig);
    await run(rig);
    expect(rig.removed).toEqual([]);
    expect(rig.calls.filter((c) => c.name === 'cleanup_document')).toHaveLength(2);
  });

  it('re-removing already-removed objects is harmless (the same targets twice)', async () => {
    const rig = makeRig();
    const path = objectPath('same.txt');
    rig.responders['cleanup_storage_targets'] = () => [{ storage_path: path }];
    await run(rig);
    await run(rig);
    expect(rig.removed).toEqual([[path], [path]]);
  });

  it('skips targets that are not a safe object path and logs the count', async () => {
    const rig = makeRig();
    const good = objectPath('ok.txt');
    rig.responders['cleanup_storage_targets'] = () => [
      { storage_path: good },
      { storage_path: '../../etc/passwd' },
      { storage_path: 'not/a/valid/shape' },
    ];
    await run(rig);
    expect(rig.removed).toEqual([[good]]);
    expect(rig.logs.join('\n')).toContain('"skipped_count":2');
  });

  it.each(['RB010', 'RB030'])(
    'completes quietly on %s (unknown or live document)',
    async (code) => {
      const rig = makeRig();
      rig.responders['cleanup_document'] = () => {
        throw new DbError('http', 400, code);
      };
      await expect(run(rig)).resolves.toBeUndefined();
      expect(rig.removed).toEqual([]);
      expect(rig.calls.map((c) => c.name)).toEqual(['cleanup_document']);
    },
  );

  it('does not remove storage objects when the targets call says the document is live', async () => {
    const rig = makeRig();
    rig.responders['cleanup_storage_targets'] = () => {
      throw new DbError('http', 400, 'RB030');
    };
    await expect(run(rig)).resolves.toBeUndefined();
    expect(rig.removed).toEqual([]);
  });

  it('propagates a database outage so the runtime retries', async () => {
    const rig = makeRig();
    rig.responders['cleanup_document'] = () => {
      throw new DbError('http', 503);
    };
    await expect(run(rig)).rejects.toBeInstanceOf(DbError);
  });

  it('a failure removing objects propagates (retry) and the repeat finishes the job', async () => {
    const rig = makeRig();
    const path = objectPath('x.txt');
    rig.responders['cleanup_storage_targets'] = () => [{ storage_path: path }];
    const remove = vi.spyOn(rig.ctx.storage, 'remove');
    remove.mockRejectedValueOnce(new Error('storage down'));
    await expect(run(rig)).rejects.toThrow();
    await expect(run(rig)).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('refuses to spin when the database reports no progress and not done', async () => {
    const rig = makeRig();
    rig.responders['cleanup_document'] = () => [{ deleted_chunks: 0, done: false }];
    await expect(run(rig)).rejects.toThrow(/no progress/);
    expect(rig.calls).toHaveLength(1);
  });

  it('rejects a malformed cleanup_document result', async () => {
    const rig = makeRig();
    rig.responders['cleanup_document'] = () => [{ nope: 1 }];
    await expect(run(rig)).rejects.toThrow();
  });

  it('stops without touching state when the signal is aborted', async () => {
    const rig = makeRig();
    rig.controller.abort();
    await run(rig);
    expect(rig.calls).toEqual([]);
    expect(rig.removed).toEqual([]);
  });

  it('logs ids and counts only, never object paths or names', async () => {
    const rig = makeRig();
    rig.responders['cleanup_storage_targets'] = () => [
      { storage_path: objectPath(`${SENTINEL}.txt`) },
    ];
    await run(rig);
    const lines = rig.logs.join('\n');
    expect(lines).toContain(DOC_ID);
    expect(lines).not.toContain(SENTINEL);
  });
});

describe('cleanup: other scopes and bad payloads', () => {
  it.each([
    ['conversation', { bot_id: BOT_ID, scope: 'conversation', resource_id: randomUUID() }],
    ['expired', { bot_id: BOT_ID, scope: 'expired' }],
  ])('scope %s completes with no work and is logged', async (scope, payload) => {
    const rig = makeRig();
    await run(rig, job(payload));
    expect(rig.calls).toEqual([]);
    expect(rig.removed).toEqual([]);
    const line = rig.logs.map((l) => JSON.parse(l) as Record<string, unknown>)[0];
    expect(line).toMatchObject({ event: 'cleanup_scope_skipped', scope });
  });

  it.each([
    ['an unknown scope', { bot_id: BOT_ID, scope: 'everything', resource_id: DOC_ID }],
    ['a document scope without a resource', { bot_id: BOT_ID, scope: 'document' }],
    ['a payload that is not a uuid', { bot_id: 'x', scope: 'document', resource_id: 'y' }],
  ])('%s does nothing', async (_n, payload) => {
    const rig = makeRig();
    await run(rig, job(payload));
    expect(rig.calls).toEqual([]);
    expect(rig.removed).toEqual([]);
  });
});
