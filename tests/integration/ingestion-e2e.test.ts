import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, DbError, type Db } from '../../worker/src/lib/db.ts';
import { createLogger } from '../../worker/src/lib/logger.ts';
import { chunkDocument } from '../../worker/src/lib/chunk.ts';
import { extractText } from '../../worker/src/lib/extract.ts';
import { createStorage } from '../../worker/src/lib/storage.ts';
import {
  MAINTENANCE_TASKS,
  runMaintenance,
  type TaskResult,
} from '../../worker/src/maintenance.ts';
import { FakeEmbeddingBackend, fakeVectorFor } from './helpers/fake-embeddings.ts';
import {
  buildPdf,
  IngestionHarness,
  makeExecutableBytes,
  makeScannedPdf,
  makeText,
  makeTextPdf,
  sleep,
  utf8,
  waitFor,
  type TestBot,
  type UploadedVersion,
} from './helpers/ingestion-fixtures.ts';
import { RuntimePool } from './helpers/ingestion-runtime.ts';

// P6 acceptance cases A1-A10 (A9 resumption and A10 partial spend are P6-D1 additions), B1-B12, C3-C5 and the
// debug cycle P6-D2 cases D1-D10 (docs/evidence/P6/test-plan.md, docs/evidence/P6/board.md), end to end against the LOCAL
// stack: real jobs, real Storage objects, real database functions, and the real index/cleanup handlers run
// by the real runtime in this process. The ONLY fake is the embedding provider (FAKE, see
// helpers/fake-embeddings.ts); no provider is ever called. Cases A3, C1 and C2 need a real process and are
// in ingestion-process.test.ts. Every test creates its own bot and removes it, its jobs and its objects.
//
// Run this file alone, not in parallel with other integration files (see helpers/ingestion-fixtures.ts):
// a runtime claims any queued index or cleanup job on the stack. The harness refuses to start when foreign
// index/cleanup jobs exist. The handlers come from the INDEX worker (worker/src/handlers.ts, wave 2).

const TEST_TIMEOUT = 120_000;
/** A test with a name starting with its case id; all share one generous timeout. */
const t = (name: string, fn: () => Promise<void>, timeout = TEST_TIMEOUT): void => {
  it(name, fn, timeout);
};

let h: IngestionHarness;
let backend: FakeEmbeddingBackend;
const pool = new RuntimePool();
const bots: TestBot[] = [];

async function mkBot(options: Parameters<IngestionHarness['createBot']>[0] = {}): Promise<TestBot> {
  const b = await h.createBot(options);
  bots.push(b);
  return b;
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** Starts a runtime with the real handlers over the current fake backend. */
async function startRuntime(
  overrides: Record<string, string> = {},
  options: Parameters<RuntimePool['start']>[2] = {},
) {
  return pool.start(h.config(overrides), backend, options);
}

/** Registers a text document, runs it to the end and returns the upload. */
async function indexedText(bot: TestBot, marker: string): Promise<UploadedVersion> {
  const up = await bot.register({ bytes: utf8(makeText(marker)), mediaType: 'text/plain' });
  await bot.waitVersion(up.versionId, ['ready', 'failed']);
  return up;
}

async function expectFailed(
  bot: TestBot,
  up: UploadedVersion,
  code: string,
  options: { jobSucceeds?: boolean } = {},
): Promise<void> {
  const v = await bot.waitVersion(up.versionId, ['failed', 'ready']);
  expect(v.status).toBe('failed');
  expect(v.failure_code).toBe(code);
  expect(await bot.chunkIndexes(up.versionId)).toEqual([]);
  const doc = await bot.document(up.documentId);
  expect(doc.active_version_id).toBeNull();
  if (options.jobSucceeds !== false) {
    // A permanent failure is recorded on the version and the job is completed (the job did its work).
    expect((await bot.waitJobDone(up.versionId)).state).toBe('succeeded');
  }
}

beforeAll(async () => {
  h = await IngestionHarness.create();
}, 180_000);

beforeEach(() => {
  backend = new FakeEmbeddingBackend(h.model);
});

afterEach(async () => {
  backend.releaseAll();
  await pool.shutdownAll();
  for (const b of bots.splice(0)) await b.dispose();
}, 60_000);

afterAll(async () => {
  await h.close();
}, 60_000);

// ---------------------------------------------------------------------------------------------------
// A. Queue
// ---------------------------------------------------------------------------------------------------

describe('A. queue', () => {
  t(
    'A1 duplicate delivery: a job whose lease expired is run by one of two runtimes; one activation, chunks written once',
    async () => {
      const bot = await mkBot();
      const up = await bot.register({ bytes: utf8(makeText('a1')), mediaType: 'text/plain' });
      const job = await bot.indexJob(up.versionId);
      const before = await bot.corpusVersion();

      // A first delivery that never finishes: claimed with a 2 s lease and then abandoned.
      const raw = createDb({ url: h.apiUrl, secretKey: h.key, timeoutMs: 5000 });
      const claimed = await raw.rpc<{ id: string }[]>('claim_jobs', {
        p_worker: `abandoned-${h.run}`,
        p_limit: 1,
        p_lease_seconds: 2,
        p_types: ['index_document'],
      });
      expect(claimed.map((r) => r.id)).toEqual([job.id]);

      // Two runtimes race for the expired job.
      await startRuntime({ WORKER_ID: `a1a-${h.run}` });
      await startRuntime({ WORKER_ID: `a1b-${h.run}` });
      const done = await bot.waitJobDone(up.versionId);

      expect(done.state).toBe('succeeded');
      expect(done.attempts).toBe(2);
      const version = await bot.version(up.versionId);
      expect(version.status).toBe('ready');
      const idx = await bot.chunkIndexes(up.versionId);
      expect(idx.length).toBeGreaterThan(2);
      expect(idx).toEqual(range(idx.length));
      expect(await bot.corpusVersion()).toBe(before + 1);
      expect((await bot.document(up.documentId)).active_version_id).toBe(up.versionId);
      // One run embedded every chunk once: no duplicate work from the second runtime.
      expect(backend.completedCalls).toBe(Math.ceil(idx.length / 2));
      const usage = (await bot.usageEvents()).filter((u) => u.operation === 'embedding_index');
      expect(usage).toHaveLength(Math.ceil(idx.length / 2));
    },
  );

  t(
    'A1 duplicate delivery: the same finished job delivered again activates nothing and calls no provider',
    async () => {
      const bot = await mkBot();
      await startRuntime();
      const up = await indexedText(bot, 'a1redo');
      expect((await bot.version(up.versionId)).status).toBe('ready');
      const corpus = await bot.corpusVersion();
      const chunks = await bot.chunkIndexes(up.versionId);
      const calls = backend.calls;

      const rows = (await h.rest().post('jobs', {
        type: 'index_document',
        dedupe_key: `index:version:${up.versionId}`,
        payload: { bot_id: bot.id, document_id: up.documentId, version_id: up.versionId },
        max_attempts: 3,
      })) as { id: string }[];
      const dupId = rows[0]?.id;
      if (dupId === undefined) throw new Error('duplicate job not created');
      const dup = await waitFor(
        'duplicate delivery to settle',
        async () => {
          const j = await bot.job(dupId);
          return ['succeeded', 'failed', 'cancelled'].includes(j.state) ? j : null;
        },
        40_000,
      );

      expect(dup.state).toBe('succeeded');
      expect(await bot.corpusVersion()).toBe(corpus);
      expect(await bot.chunkIndexes(up.versionId)).toEqual(chunks);
      expect(backend.calls).toBe(calls);
      expect((await bot.version(up.versionId)).status).toBe('ready');
    },
  );

  t(
    "A2 lease expiry: another runtime takes the job after locked_until; the first worker's later calls are refused (RB013)",
    async () => {
      const bot = await mkBot();
      const up = await bot.register({ bytes: utf8(makeText('a2')), mediaType: 'text/plain' });
      const job = await bot.indexJob(up.versionId);
      const raw: Db = createDb({ url: h.apiUrl, secretKey: h.key, timeoutMs: 5000 });
      const first = `stopped-${h.run}`;

      // Worker one claims with a 2 s lease, reads the context once, then stops heartbeating.
      const claimed = await raw.rpc<{ id: string }[]>('claim_jobs', {
        p_worker: first,
        p_limit: 1,
        p_lease_seconds: 2,
        p_types: ['index_document'],
      });
      expect(claimed.map((r) => r.id)).toEqual([job.id]);
      const base = { p_job_id: job.id, p_worker: first, p_version_id: up.versionId };
      const ctx = await raw.rpc<{ status: string }[]>('get_index_job_context', base);
      expect(ctx[0]?.status).toBe('uploaded');
      await sleep(2500);

      // A second runtime claims it after the lease; its first embedding call is held so the job is in flight.
      const hold = backend.holdCall(1);
      await startRuntime({ WORKER_ID: `a2-second-${h.run}` });
      await hold.reached;
      // The runtime's lease owner is its WORKER_ID plus a random suffix (P6-D2-W): the base identifies it.
      expect((await bot.indexJob(up.versionId)).locked_by ?? '').toMatch(
        new RegExp(`^a2-second-${h.run}-[0-9a-f]{6}$`),
      );

      const chunk = {
        chunk_index: 0,
        content: 'late write from the stopped worker',
        token_count: 5,
        page_number: null,
        section: null,
        metadata: {},
        embedding: fakeVectorFor('late'),
      };
      const stale: [string, Record<string, unknown>][] = [
        ['get_index_job_context', base],
        ['update_version_progress', { ...base, p_patch: { batches_done: 0 } }],
        ['write_document_chunks', { ...base, p_chunks: [chunk] }],
        ['activate_version_for_job', { ...base, p_expected_chunks: 1 }],
        ['fail_document_version', { ...base, p_failure_code: 'INDEXING_FAILED' }],
        ['complete_job', { p_job_id: job.id, p_worker: first }],
      ];
      const refuse = async (): Promise<void> => {
        for (const [fn, args] of stale) {
          const err = await raw.rpc(fn, args).then(
            () => null,
            (e: unknown) => e,
          );
          expect(err, fn).toBeInstanceOf(DbError);
          expect((err as DbError).sqlstate, fn).toBe('RB013');
        }
      };
      await refuse(); // while the second worker holds the job
      hold.release();
      const done = await bot.waitJobDone(up.versionId);
      expect(done.state).toBe('succeeded');
      expect(done.attempts).toBe(2);
      await refuse(); // and after it finished
      expect((await bot.version(up.versionId)).status).toBe('ready');
      const late = (await h
        .rest()
        .get(
          `document_chunks?document_version_id=eq.${up.versionId}&content=eq.late%20write%20from%20the%20stopped%20worker&select=id`,
        )) as unknown[];
      expect(late).toEqual([]);
    },
  );

  t(
    'A4 retry exhaustion: a provider that always fails transiently dead-letters the job after max_attempts with bounded, growing backoff',
    async () => {
      const bot = await mkBot({ indexMaxAttempts: 3 });
      backend.failAlways('transient');
      await startRuntime({ JOB_BACKOFF_BASE_SECONDS: '4', JOB_BACKOFF_MAX_SECONDS: '16' });
      const up = await bot.register({ bytes: utf8(makeText('a4')), mediaType: 'text/plain' });
      const before = await bot.corpusVersion();

      // The delay left when a retry first becomes visible is a lower bound of the delay that was set.
      const observed = new Map<number, number>();
      const final = await waitFor(
        'job to dead-letter',
        async () => {
          const j = await bot.indexJob(up.versionId);
          if (j.state === 'queued' && j.attempts > 0 && !observed.has(j.attempts)) {
            observed.set(j.attempts, Date.parse(j.available_at) - Date.now());
          }
          return j.state === 'failed' ? j : null;
        },
        80_000,
        50,
      );

      expect(final.attempts).toBe(3);
      expect(final.max_attempts).toBe(3);
      expect(final.last_error ?? '').toMatch(/^[A-Za-z0-9_ ;.-]{1,200}$/);
      expect(backend.calls).toBeGreaterThanOrEqual(3);
      for (const attempt of [1, 2]) {
        const seen = observed.get(attempt);
        expect(seen, `delay observed after attempt ${String(attempt)}`).toBeDefined();
        const capped = Math.min(16, 4 * 2 ** (attempt - 1)) * 1000;
        expect(seen).toBeLessThanOrEqual(capped + 300);
        expect(seen).toBeGreaterThanOrEqual(capped / 2 - 800);
      }
      // Growth: the second delay cannot be below the first delay's ceiling less the jitter range.
      expect(observed.get(2) ?? 0).toBeGreaterThan(3000);
      const v = await bot.version(up.versionId);
      expect(v.status).toBe('failed');
      expect(v.failure_code).toBe('INDEXING_FAILED');
      expect((await bot.document(up.documentId)).status).toBe('failed');
      expect(await bot.corpusVersion()).toBe(before);
    },
  );

  t(
    'A4 retry: a 429 from the provider is retried and the job then succeeds on the second attempt',
    async () => {
      const bot = await mkBot({ indexMaxAttempts: 3 });
      backend.failNext('rate_limited', 1);
      await startRuntime();
      const up = await bot.register({ bytes: utf8(makeText('a4b')), mediaType: 'text/plain' });
      const done = await bot.waitJobDone(up.versionId);
      expect(done.state).toBe('succeeded');
      expect(done.attempts).toBe(2);
      expect((await bot.version(up.versionId)).status).toBe('ready');
    },
  );

  t(
    'A5 incomplete embeddings never activate: a later batch failing leaves the new version unready and the previous version serving',
    async () => {
      const bot = await mkBot({ indexMaxAttempts: 2 });
      await startRuntime();
      const v1 = await indexedText(bot, 'a5old');
      expect((await bot.version(v1.versionId)).status).toBe('ready');
      await pool.shutdownAll();
      const corpus = await bot.corpusVersion();

      // The first batch of the new version embeds, then every later call fails transiently.
      backend = new FakeEmbeddingBackend(h.model);
      backend.failAfter(1, 'transient');
      await startRuntime();
      const v2 = await bot.addVersion(v1.documentId, {
        bytes: utf8(makeText('a5new')),
        mediaType: 'text/plain',
      });
      const done = await bot.waitJobDone(v2.versionId, 80_000);

      expect(done.state).toBe('failed');
      const second = await bot.version(v2.versionId);
      expect(second.status).toBe('failed');
      expect(second.failure_code).toBe('INDEXING_FAILED');
      const doc = await bot.document(v1.documentId);
      expect(doc.active_version_id).toBe(v1.versionId);
      expect(doc.status).toBe('ready');
      expect((await bot.version(v1.versionId)).status).toBe('ready');
      expect(await bot.corpusVersion()).toBe(corpus);
      const hits = await bot.match('anything');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((r) => r.document_version_id === v1.versionId)).toBe(true);
    },
  );

  t(
    'A9 resumption: a transient failure after some batches; the retry embeds only the remaining chunks, records no duplicate usage and activates',
    async () => {
      const bot = await mkBot({ indexMaxAttempts: 3 });
      // Two batches embed and are written, then the third call fails transiently.
      backend.failFrom(3, 'transient');
      await startRuntime({ JOB_BACKOFF_BASE_SECONDS: '4', JOB_BACKOFF_MAX_SECONDS: '8' });
      const up = await bot.register({ bytes: utf8(makeText('a9')), mediaType: 'text/plain' });
      // The provider recovers before the retry (the backoff is at least two seconds).
      await waitFor('the failing third provider call', () => backend.calls >= 3, 60_000, 20);
      backend.stopFailing();
      const callsAtFailure = backend.calls;
      const done = await bot.waitJobDone(up.versionId, 80_000);

      expect(done.state).toBe('succeeded');
      expect(done.attempts).toBe(2);
      expect((await bot.version(up.versionId)).status).toBe('ready');
      const idx = await bot.chunkIndexes(up.versionId);
      const n = idx.length;
      expect(n).toBeGreaterThan(6);
      expect(idx).toEqual(range(n));
      // First attempt: 2 completed calls (4 chunks) and one failed call. Retry: the remaining n - 4
      // chunks only, never the first two batches again.
      expect(callsAtFailure).toBe(3);
      expect(backend.completedCalls).toBe(Math.ceil(n / 2));
      expect(backend.batchSizes.slice(0, 3)).toEqual([2, 2, 2]);
      expect(backend.inputsSeen).toBe(n + 2); // n chunks once, plus the batch that failed once
      // No duplicate usage rows: one per completed provider call, for this job only.
      const usage = (await bot.usageEvents()).filter((u) => u.operation === 'embedding_index');
      expect(usage).toHaveLength(Math.ceil(n / 2));
      expect(usage.every((u) => u.job_id === done.id)).toBe(true);
      expect(usage.reduce((sum, u) => sum + u.input_tokens, 0)).toBe(backend.tokensReported);
      // Each attempt settled its own spend; nothing is left reserved or released.
      const reservations = (await bot.reservations()).filter((r) => r.job_id === done.id);
      expect(reservations.map((r) => r.state)).toEqual(['settled', 'settled']);
      const cost = usage.reduce((sum, u) => sum + Number(u.estimated_cost), 0);
      const settled = reservations.reduce((sum, r) => sum + Number(r.amount), 0);
      expect(Math.abs(settled - cost)).toBeLessThan(0.00001);
      const row = (await bot.status()).find((r) => r.document_id === up.documentId);
      expect(row?.batches_total).toBe(Math.ceil(n / 2));
      expect(row?.batches_done).toBe(Math.ceil(n / 2));
    },
  );

  t(
    'A10 partial spend: a permanent provider failure after some batches settles the reservation at the cost so far, which counts toward the cap',
    async () => {
      const bot = await mkBot();
      backend.failFrom(3, 'permanent'); // two batches embed, the third call fails for good
      await startRuntime();
      const up = await bot.register({ bytes: utf8(makeText('a10')), mediaType: 'text/plain' });
      const failed = await bot.waitVersion(up.versionId, ['failed', 'ready']);
      expect(failed.status).toBe('failed');
      expect(failed.failure_code).toBe('INDEXING_FAILED');
      // A permanent failure completes the job. The two written batches stay (never active, never
      // retrievable) until cleanup; the document has no active version.
      const job = await bot.waitJobDone(up.versionId);
      expect(job.state).toBe('succeeded');
      expect((await bot.document(up.documentId)).active_version_id).toBeNull();
      expect(await bot.match('a10')).toEqual([]);
      expect(await bot.chunkIndexes(up.versionId)).toEqual(range(4));
      expect(backend.completedCalls).toBe(2);
      const usage = (await bot.usageEvents()).filter((u) => u.operation === 'embedding_index');
      expect(usage).toHaveLength(2);
      const cost = usage.reduce((sum, u) => sum + Number(u.estimated_cost), 0);
      expect(cost).toBeGreaterThan(0);

      const reservations = (await bot.reservations()).filter((r) => r.job_id === job.id);
      // 'settled' rows count toward the daily cap; 'released' and 'reserved' would not be spend.
      expect(reservations.map((r) => r.state)).toEqual(['settled']);
      const amount = Number(reservations[0]?.amount);
      expect(Math.abs(amount - cost)).toBeLessThan(0.00001);
    },
  );

  t(
    'A6 atomic replacement: a new version activates in one step, the old one is superseded, retrieval sees only the new chunks',
    async () => {
      const bot = await mkBot();
      await startRuntime();
      const v1 = await indexedText(bot, 'a6old');
      expect((await bot.version(v1.versionId)).status).toBe('ready');
      const corpus = await bot.corpusVersion();

      const v2 = await bot.addVersion(v1.documentId, {
        bytes: utf8(makeText('a6new')),
        mediaType: 'text/plain',
      });
      await bot.waitVersion(v2.versionId, ['ready', 'failed']);

      const doc = await bot.document(v1.documentId);
      expect(doc.active_version_id).toBe(v2.versionId);
      expect(doc.status).toBe('ready');
      expect((await bot.version(v2.versionId)).status).toBe('ready');
      expect((await bot.version(v1.versionId)).status).toBe('superseded');
      expect(await bot.corpusVersion()).toBe(corpus + 1);
      const hits = await bot.match('a6new-section-0');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((r) => r.document_version_id === v2.versionId)).toBe(true);
      expect(hits.some((r) => r.document_version_id === v1.versionId)).toBe(false);
    },
  );

  t(
    'A7 delete after indexing: the document leaves retrieval at once; cleanup then removes its chunks and its object',
    async () => {
      const bot = await mkBot();
      // Indexing only, so the delete is observed before any cleanup has run.
      await startRuntime({}, { only: ['index_document'] });
      const up = await indexedText(bot, 'a7');
      expect((await bot.version(up.versionId)).status).toBe('ready');
      expect((await bot.match('a7')).length).toBeGreaterThan(0);

      await bot.deleteDocument(up.documentId);
      expect(await bot.match('a7')).toEqual([]); // immediately excluded
      expect((await bot.document(up.documentId)).deleted_at).not.toBeNull();
      expect(await bot.chunkCountForDocument(up.documentId)).toBeGreaterThan(0); // not cleaned yet
      expect(await h.objectExists(up.path)).toBe(true);

      await startRuntime({}, { only: ['cleanup'] });
      const cleanup = await bot.waitCleanupDone(up.documentId);
      expect(cleanup.state).toBe('succeeded');
      expect(await bot.chunkCountForDocument(up.documentId)).toBe(0);
      await waitFor('object removal', async () => !(await h.objectExists(up.path)), 15_000);
    },
  );

  t(
    "A7 delete during indexing: the in-flight job's later writes are refused and nothing of the document stays",
    async () => {
      const bot = await mkBot({ indexMaxAttempts: 3 });
      const hold = backend.holdCall(2); // batch one is written, batch two is in flight
      await startRuntime();
      const up = await bot.register({ bytes: utf8(makeText('a7b')), mediaType: 'text/plain' });
      await hold.reached;

      await bot.deleteDocument(up.documentId);
      expect(await bot.match('a7b')).toEqual([]);
      const cleanup = await bot.waitCleanupDone(up.documentId);
      expect(cleanup.state).toBe('succeeded');

      hold.release(); // the in-flight job continues against a deleted document
      await bot.waitJobDone(up.versionId, 60_000);
      await sleep(500);
      expect(await bot.chunkCountForDocument(up.documentId)).toBe(0);
      const doc = await bot.document(up.documentId);
      expect(doc.active_version_id).toBeNull();
      expect(doc.deleted_at).not.toBeNull();
      expect((await bot.version(up.versionId)).status).not.toBe('ready');
      await waitFor('object removal', async () => !(await h.objectExists(up.path)), 15_000);
    },
  );

  const spoofs: [string, () => Uint8Array, string][] = [
    ['a PDF registered and uploaded as text/plain', () => makeTextPdf('a8'), 'text/plain'],
    [
      'text registered and uploaded as application/pdf',
      () => utf8(makeText('a8')),
      'application/pdf',
    ],
    ['an executable renamed .pdf', makeExecutableBytes, 'application/pdf'],
  ];
  for (const [label, bytes, mediaType] of spoofs) {
    t(`A8 spoofed file type (${label}) fails FILE_UNSUPPORTED with no provider call`, async () => {
      const bot = await mkBot();
      await startRuntime();
      const up = await bot.register({ bytes: bytes(), mediaType });
      await expectFailed(bot, up, 'FILE_UNSUPPORTED');
      expect(backend.calls).toBe(0);
      expect((await bot.document(up.documentId)).status).toBe('failed');
    });
  }
});

// ---------------------------------------------------------------------------------------------------
// B. P6 plan cases
// ---------------------------------------------------------------------------------------------------

describe('B. plan cases', () => {
  t('B1 a failed replacement keeps the old version active and the document ready', async () => {
    const bot = await mkBot();
    await startRuntime();
    const v1 = await indexedText(bot, 'b1');
    expect((await bot.version(v1.versionId)).status).toBe('ready');
    const corpus = await bot.corpusVersion();

    const v2 = await bot.addVersion(v1.documentId, {
      bytes: makeScannedPdf(),
      mediaType: 'application/pdf',
    });
    const second = await bot.waitVersion(v2.versionId, ['failed', 'ready']);

    expect(second.status).toBe('failed');
    expect(second.failure_code).toBe('OCR_REQUIRED');
    const doc = await bot.document(v1.documentId);
    expect(doc.active_version_id).toBe(v1.versionId);
    expect(doc.status).toBe('ready');
    expect((await bot.version(v1.versionId)).status).toBe('ready');
    expect(await bot.corpusVersion()).toBe(corpus);
    expect((await bot.match('b1')).every((r) => r.document_version_id === v1.versionId)).toBe(true);
  });

  t(
    'B2 progress and failure codes are readable per document through admin_document_status, never last_error',
    async () => {
      const bot = await mkBot();
      const hold = backend.holdCall(2);
      await startRuntime();
      const up = await bot.register({ bytes: utf8(makeText('b2')), mediaType: 'text/plain' });
      await hold.reached;

      const during = await waitFor(
        'progress to show a finished batch',
        async () => {
          const row = (await bot.status()).find((r) => r.document_id === up.documentId);
          return row !== undefined && (row.batches_done ?? 0) >= 1 ? row : null;
        },
        20_000,
      );
      expect(during.latest_version_status).toBe('embedding');
      expect(during.batches_total ?? 0).toBeGreaterThanOrEqual(2);
      expect(during.batches_done ?? 0).toBeLessThan(during.batches_total ?? 0);
      expect(during.failure_code).toBeNull();
      expect(Object.keys(during).sort()).toEqual(
        [
          'active_version_id',
          'batches_done',
          'batches_total',
          'document_id',
          'failure_code',
          'latest_version_id',
          'latest_version_number',
          'latest_version_status',
          'status',
          'title',
        ].sort(),
      );

      hold.release();
      await bot.waitVersion(up.versionId, ['ready', 'failed']);
      const n = (await bot.chunkIndexes(up.versionId)).length;
      const after = (await bot.status()).find((r) => r.document_id === up.documentId);
      expect(after?.latest_version_status).toBe('ready');
      expect(after?.batches_total).toBe(Math.ceil(n / 2));
      expect(after?.batches_done).toBe(Math.ceil(n / 2));

      const bad = await bot.register({ bytes: makeScannedPdf(), mediaType: 'application/pdf' });
      await bot.waitVersion(bad.versionId, ['failed', 'ready']);
      const failedRow = (await bot.status()).find((r) => r.document_id === bad.documentId);
      expect(failedRow?.latest_version_status).toBe('failed');
      expect(failedRow?.failure_code).toBe('OCR_REQUIRED');
      expect(Object.keys(failedRow ?? {})).not.toContain('last_error');
    },
  );

  t(
    'B3 a job over the daily cap fails safely: BUDGET_EXCEEDED, no provider call, no reservation left reserved',
    async () => {
      const bot = await mkBot({ dailyCapUsd: 0 });
      await startRuntime();
      const up = await bot.register({ bytes: utf8(makeText('b3')), mediaType: 'text/plain' });
      await expectFailed(bot, up, 'BUDGET_EXCEEDED');
      expect(backend.calls).toBe(0);
      expect((await bot.reservations()).filter((r) => r.state === 'reserved')).toEqual([]);
      expect((await bot.usageEvents()).filter((u) => u.operation === 'embedding_index')).toEqual(
        [],
      );
    },
  );

  t(
    'B4 an older version finishing late is failed SUPERSEDED and the newer active version is untouched',
    async () => {
      const bot = await mkBot();
      const hold = backend.holdWhen((texts) => texts.some((s) => s.includes('b4old')));
      await startRuntime();
      const v1 = await bot.register({ bytes: utf8(makeText('b4old')), mediaType: 'text/plain' });
      await hold.reached; // the first version is stuck in the provider call
      const v2 = await bot.addVersion(v1.documentId, {
        bytes: utf8(makeText('b4new')),
        mediaType: 'text/plain',
      });
      expect((await bot.waitVersion(v2.versionId, ['ready', 'failed'])).status).toBe('ready');
      const corpus = await bot.corpusVersion();

      hold.release();
      const old = await bot.waitVersion(v1.versionId, ['failed', 'ready'], 60_000);
      expect(old.status).toBe('failed');
      expect(old.failure_code).toBe('SUPERSEDED');
      const doc = await bot.document(v1.documentId);
      expect(doc.active_version_id).toBe(v2.versionId);
      expect((await bot.version(v2.versionId)).status).toBe('ready');
      expect(await bot.corpusVersion()).toBe(corpus);
      expect((await bot.match('b4new')).every((r) => r.document_version_id === v2.versionId)).toBe(
        true,
      );
    },
  );

  t('B5 a scanned PDF (no text layer) fails OCR_REQUIRED and never becomes ready', async () => {
    const bot = await mkBot();
    await startRuntime();
    const up = await bot.register({ bytes: makeScannedPdf(3), mediaType: 'application/pdf' });
    await expectFailed(bot, up, 'OCR_REQUIRED');
    expect(backend.calls).toBe(0);
    expect((await bot.document(up.documentId)).status).toBe('failed');
  });

  const unsupported: {
    label: string;
    bytes: () => Uint8Array;
    mediaType: string;
    prepare?: (bot: TestBot, up: UploadedVersion) => Promise<void>;
  }[] = [
    {
      label: 'an encrypted PDF',
      bytes: () => buildPdf({ pages: [['encrypted fixture']], encrypt: true }),
      mediaType: 'application/pdf',
    },
    {
      label: 'a corrupt PDF',
      bytes: () => utf8(`%PDF-1.4\n${'not a real pdf body '.repeat(30)}`),
      mediaType: 'application/pdf',
    },
    {
      label: 'a PDF with more pages than the upload policy allows',
      bytes: () => makeTextPdf('b6pages', 3),
      mediaType: 'application/pdf',
      prepare: (bot) => bot.setUploadPolicy({ max_pages: 2 }),
    },
    {
      label: 'a file larger than the upload policy allows when indexed',
      bytes: () => utf8(makeText('b6big')),
      mediaType: 'text/plain',
      // The registered upload was within the policy; the policy shrank before indexing.
      prepare: (bot) => bot.setUploadPolicy({ max_bytes: 100 }),
    },
  ];
  for (const c of unsupported) {
    t(`B6 ${c.label} fails FILE_UNSUPPORTED with no provider call`, async () => {
      const bot = await mkBot();
      // Register, upload and confirm first, then change the policy, then start the runtime.
      const up = await bot.register({ bytes: c.bytes(), mediaType: c.mediaType });
      if (c.prepare !== undefined) await c.prepare(bot, up);
      await startRuntime();
      await expectFailed(bot, up, 'FILE_UNSUPPORTED');
      expect(backend.calls).toBe(0);
    });
  }

  const etagCases: [string, (bot: TestBot, up: UploadedVersion, text: string) => Promise<void>][] =
    [
      [
        'the recorded eTag is missing',
        (bot, up) => bot.patchVersion(up.versionId, { upload_etag: null }),
      ],
      [
        'the recorded eTag differs from the object',
        (bot, up) =>
          bot.patchVersion(up.versionId, { upload_etag: '"00000000000000000000000000000000"' }),
      ],
      [
        'the object was replaced after the upload was confirmed',
        async (bot, up, text) => {
          // Same length, different content: only the eTag can notice.
          const other = text.slice(0, -1) + (text.endsWith('x') ? 'y' : 'x');
          await bot.putObject(up.path, utf8(other), 'text/plain', true);
        },
      ],
    ];
  for (const [label, tamper] of etagCases) {
    t(
      `B7 eTag check: ${label}; fails closed with FILE_UNSUPPORTED and no provider call`,
      async () => {
        const bot = await mkBot();
        const text = makeText('b7');
        const up = await bot.register({ bytes: utf8(text), mediaType: 'text/plain' });
        await tamper(bot, up, text);
        await startRuntime();
        await expectFailed(bot, up, 'FILE_UNSUPPORTED');
        expect(backend.calls).toBe(0);
      },
    );
  }

  t(
    'B8 size check: an object whose size differs from the registered size fails closed with no provider call',
    async () => {
      const bot = await mkBot();
      const bytes = utf8(makeText('b8'));
      const up = await bot.register({ bytes, mediaType: 'text/plain' });
      await bot.patchVersion(up.versionId, { byte_size: bytes.length + 1 });
      await startRuntime();
      await expectFailed(bot, up, 'FILE_UNSUPPORTED');
      expect(backend.calls).toBe(0);
    },
  );

  for (const [label, bytes, mediaType] of [
    ['text/plain', utf8(makeText('b8ok')), 'text/plain'],
    ['application/pdf', makeTextPdf('b8ok', 2), 'application/pdf'],
  ] as const) {
    t(`B8 checksum is stored when indexing succeeds (${label})`, async () => {
      const bot = await mkBot();
      await startRuntime();
      const up = await bot.register({ bytes, mediaType });
      const v = await bot.waitVersion(up.versionId, ['ready', 'failed']);
      expect(v.status).toBe('ready');
      expect(v.checksum ?? '').toMatch(/^[0-9a-f]{64}$/);
      expect(v.embedding_model).toBe(h.model);
      expect(v.extraction_method).toBe(mediaType === 'application/pdf' ? 'pdf_text' : 'plain_text');
      expect(v.extraction_version).toBeTruthy();
      expect(v.chunking_version).toBeTruthy();
    });
  }

  t('B9 a reindex shares the original storage path and indexes to ready', async () => {
    const bot = await mkBot();
    await startRuntime();
    const v1 = await indexedText(bot, 'b9re');
    expect((await bot.version(v1.versionId)).status).toBe('ready');
    const corpus = await bot.corpusVersion();
    const re = await bot.reindex(v1.documentId);
    const second = await bot.waitVersion(re.versionId, ['ready', 'failed']);
    expect(second.status, `failure_code ${String(second.failure_code)}`).toBe('ready');
    expect(second.storage_path).toBe(v1.path); // the reindex reuses the original object
    expect((await bot.version(v1.versionId)).status).toBe('superseded');
    expect((await bot.document(v1.documentId)).active_version_id).toBe(re.versionId);
    expect(await bot.corpusVersion()).toBe(corpus + 1);
  });

  t(
    'B9 a storage path shared by another live version is not deleted by cleanup; the last reference removes it',
    async () => {
      const bot = await mkBot();
      await startRuntime();
      const v1 = await indexedText(bot, 'b9');
      expect((await bot.version(v1.versionId)).status).toBe('ready');

      // A second, live document whose version references the same object (as a reindex would, across
      // versions; made directly here so this case does not depend on the reindex path).
      const docs = (await h.rest().post('documents', {
        bot_id: bot.id,
        title: 'P6 shared path holder',
        status: 'draft',
      })) as { id: string }[];
      const other = docs[0]?.id;
      if (other === undefined) throw new Error('document not created');
      await h.rest().post('document_versions', {
        document_id: other,
        version_number: 1,
        storage_path: v1.path,
        media_type: 'text/plain',
        byte_size: utf8(makeText('b9')).length,
        status: 'uploaded',
      });

      await bot.deleteDocument(v1.documentId);
      expect((await bot.waitCleanupDone(v1.documentId)).state).toBe('succeeded');
      expect(await bot.chunkCountForDocument(v1.documentId)).toBe(0);
      expect(await h.objectExists(v1.path)).toBe(true); // still referenced by a live version

      await bot.deleteDocument(other);
      expect((await bot.waitCleanupDone(other)).state).toBe('succeeded');
      await waitFor('shared object removal', async () => !(await h.objectExists(v1.path)), 15_000);
    },
  );

  t(
    'B10 an abandoned pending_upload past the limit is failed and its object removed by maintenance',
    async () => {
      const bot = await mkBot();
      const old = await bot.registerPending(
        { bytes: utf8('b10 abandoned'), mediaType: 'text/plain' },
        true,
      );
      const fresh = await bot.registerPending(
        { bytes: utf8('b10 fresh'), mediaType: 'text/plain' },
        true,
      );
      await bot.patchVersion(old.versionId, {
        created_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
      });

      const cfg = h.config({ ABANDONED_UPLOAD_HOURS: '24' });
      const results = await runMaintenance(
        cfg,
        {
          db: createDb({ url: h.apiUrl, secretKey: h.key, timeoutMs: 5000 }),
          storage: createStorage({ url: h.apiUrl, secretKey: h.key, timeoutMs: 10_000 }),
        },
        new AbortController().signal,
      );

      const task = results.find((r) => r.task === 'expire_abandoned_uploads');
      expect(task?.ok).toBe(true);
      expect(task?.count ?? 0).toBeGreaterThanOrEqual(1);
      const v = await bot.version(old.versionId);
      expect(v.status).toBe('failed');
      expect(v.failure_code).toBe('INDEXING_FAILED');
      expect(await h.objectExists(old.path)).toBe(false);
      expect((await bot.version(fresh.versionId)).status).toBe('pending_upload');
      expect(await h.objectExists(fresh.path)).toBe(true);
    },
  );

  t(
    'B11 usage: one embedding_index record per provider batch and the reservation settles to the recorded cost',
    async () => {
      const bot = await mkBot();
      await startRuntime();
      const up = await bot.register({ bytes: utf8(makeText('b11')), mediaType: 'text/plain' });
      const v = await bot.waitVersion(up.versionId, ['ready', 'failed']);
      expect(v.status).toBe('ready');
      const job = await bot.waitJobDone(up.versionId);
      const n = (await bot.chunkIndexes(up.versionId)).length;
      const batches = Math.ceil(n / 2);

      const usage = (await bot.usageEvents()).filter((u) => u.operation === 'embedding_index');
      expect(usage).toHaveLength(batches);
      expect(usage).toHaveLength(backend.completedCalls);
      expect(usage.every((u) => u.job_id === job.id)).toBe(true);
      expect(usage.every((u) => u.model === h.model && u.provider !== null)).toBe(true);
      expect(usage.reduce((s, u) => s + u.input_tokens, 0)).toBe(backend.tokensReported);
      const cost = usage.reduce((s, u) => s + Number(u.estimated_cost), 0);
      expect(cost).toBeGreaterThan(0);

      const reservations = (await bot.reservations()).filter((r) => r.job_id === job.id);
      expect(reservations.map((r) => r.state)).toEqual(['settled']);
      expect(Math.abs(Number(reservations[0]?.amount) - cost)).toBeLessThan(0.00001);
    },
  );

  t(
    "B12 model mismatch: the bot's embedding model changed after the version started; activation is refused and the version fails",
    async () => {
      const bot = await mkBot();
      const hold = backend.holdCall(1);
      await startRuntime();
      const up = await bot.register({ bytes: utf8(makeText('b12')), mediaType: 'text/plain' });
      await hold.reached; // the version has started; no chunk is written yet, so the change is allowed
      await bot.setEmbeddingModel(`${h.model}-changed`);
      const corpus = await bot.corpusVersion();

      hold.release();
      const v = await bot.waitVersion(up.versionId, ['failed', 'ready'], 80_000);
      expect(v.status).toBe('failed');
      expect(v.failure_code).toBe('INDEXING_FAILED');
      const doc = await bot.document(up.documentId);
      expect(doc.active_version_id).toBeNull();
      expect(await bot.corpusVersion()).toBe(corpus);
      expect(await bot.match('b12')).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------------------------------
// C. Maintenance, logs, extraction limits (C1 and C2 are in ingestion-process.test.ts)
// ---------------------------------------------------------------------------------------------------

describe('C. maintenance, logs, extraction limits', () => {
  t(
    'C3 maintenance: one task raising an error does not stop the others; counts are logged',
    async () => {
      const real = createDb({ url: h.apiUrl, secretKey: h.key, timeoutMs: 5000 });
      // Injected failure (test-only): one task's database call is refused. Everything else is real.
      const sabotaged = 'purge_expired_caches';
      const db: Db = {
        rpc: (name, args, signal, options) =>
          name === sabotaged
            ? Promise.reject(new DbError('http', 500, 'XX000'))
            : real.rpc(name, args, signal, options),
      };
      const lines: string[] = [];
      const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
      const results = await runMaintenance(
        h.config(),
        { db, storage: createStorage({ url: h.apiUrl, secretKey: h.key, timeoutMs: 10_000 }), log },
        new AbortController().signal,
      );

      expect(results.map((r) => r.task)).toEqual(MAINTENANCE_TASKS.map((x) => x.name));
      const failed = results.find((r) => r.task === sabotaged);
      expect(failed).toMatchObject({ ok: false, code: 'XX000' });
      const index = results.findIndex((r) => r.task === sabotaged);
      // Tasks before and after the failing one still ran and succeeded.
      expect(results[0]?.ok).toBe(true);
      expect(results[index + 1]?.ok).toBe(true);
      expect(results.find((r) => r.task === 'purge_terminal_jobs')?.ok).toBe(true);
      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const okLines = parsed.filter((p) => p['event'] === 'maintenance_task');
      expect(okLines.length).toBe(results.filter((r) => r.ok).length);
      expect(okLines.every((p) => typeof p['count'] === 'number')).toBe(true);
      const failLines = parsed.filter((p) => p['event'] === 'maintenance_task_failed');
      expect(failLines).toHaveLength(results.filter((r) => !r.ok).length);
      expect(failLines.some((p) => p['task'] === sabotaged && p['code'] === 'XX000')).toBe(true);
    },
  );

  t(
    'C4 no document text, titles, keys or tokens in any log line while documents succeed, fail and retry',
    async () => {
      const bot = await mkBot();
      const sentinel = `sentinel${randomBytes(6).toString('hex')}`;
      const title = `title${randomBytes(6).toString('hex')}`;
      const lines: string[] = [];
      const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
      backend.failNext('transient', 1); // a retry path as well
      await startRuntime({ LOG_LEVEL: 'debug' }, { log });

      const ok = await bot.register({
        bytes: utf8(makeText(sentinel)),
        mediaType: 'text/plain',
        title,
      });
      const scanned = await bot.register({
        bytes: makeScannedPdf(),
        mediaType: 'application/pdf',
        title: `${title}b`,
      });
      const spoof = await bot.register({
        bytes: makeExecutableBytes(),
        mediaType: 'application/pdf',
      });
      await bot.waitVersion(ok.versionId, ['ready', 'failed']);
      await bot.waitVersion(scanned.versionId, ['failed', 'ready']);
      await bot.waitVersion(spoof.versionId, ['failed', 'ready']);
      await bot.waitJobDone(ok.versionId);
      await pool.shutdownAll();

      expect(lines.length).toBeGreaterThan(0);
      const all = lines.join('\n');
      const secrets = [sentinel, title, h.embeddingApiKey, h.key, makeText(sentinel).slice(0, 40)];
      for (const s of secrets) expect(all.includes(s)).toBe(false);
      // Chunk-looking text from the other fixtures, too.
      expect(all).not.toMatch(/\balpha\d{1,2}\b/);
    },
  );

  t(
    'C5 extraction child over the time limit is killed: FILE_UNSUPPORTED, and the runtime goes on to index the next job',
    async () => {
      const bot = await mkBot();
      await startRuntime({ EXTRACT_TIMEOUT_MS: '1' });
      const slow = await bot.register({
        bytes: makeTextPdf('c5time', 2),
        mediaType: 'application/pdf',
      });
      const slow2 = await bot.register({
        bytes: makeTextPdf('c5time2', 2),
        mediaType: 'application/pdf',
      });
      await expectFailed(bot, slow, 'FILE_UNSUPPORTED');
      await expectFailed(bot, slow2, 'FILE_UNSUPPORTED');
      expect(backend.calls).toBe(0);
      // The parent is unaffected: text is decoded in-process and still indexes under the same runtime.
      const text = await bot.register({ bytes: utf8(makeText('c5ok')), mediaType: 'text/plain' });
      expect((await bot.waitVersion(text.versionId, ['ready', 'failed'])).status).toBe('ready');
    },
  );

  t(
    'C5 extraction child over the memory limit is killed mid-parse: FILE_UNSUPPORTED (reason memory), a smaller PDF under the same limit still indexes, and the runtime goes on',
    async () => {
      // 24 MB lets pdf.js start and parse a 250-page PDF (measured with the extraction module, three runs
      // each: the 250-page file passes, the 1000-page file below dies of memory at 24 and at 32 MB). So the
      // heavy file proves a kill in the middle of a parse, not a child that never started.
      // The 250-page control is priced at about $13 by the test's price per million tokens: a high daily cap.
      const bot = await mkBot({ maxPages: 5000, dailyCapUsd: 1000 });
      const lines: string[] = [];
      const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
      await startRuntime(
        { EXTRACT_CHILD_MEMORY_MB: '24', LOG_LEVEL: 'debug', EMBEDDING_BATCH_SIZE: '16' },
        { log },
      );
      const pdfPages = (n: number, perPage: number): string[][] =>
        Array.from({ length: n }, (_, p) =>
          Array.from(
            { length: perPage },
            (_, i) => `p${String(p)} l${String(i)} synthetic memory probe words`,
          ),
        );
      const control = await bot.register({
        bytes: buildPdf({ pages: pdfPages(250, 40) }),
        mediaType: 'application/pdf',
      });
      expect((await bot.waitVersion(control.versionId, ['ready', 'failed'], 60_000)).status).toBe(
        'ready',
      );
      expect(backend.calls).toBeGreaterThan(0); // the control really was embedded
      const callsAfterControl = backend.calls;

      const heavy = await bot.register({
        bytes: buildPdf({ pages: pdfPages(1000, 60) }),
        mediaType: 'application/pdf',
      });
      await expectFailed(bot, heavy, 'FILE_UNSUPPORTED');
      expect(backend.calls).toBe(callsAfterControl); // no provider call for the killed file
      const failLine = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((p) => p['event'] === 'index_version_failed');
      expect(failLine?.['reason']).toBe('memory'); // the memory limit, not a timeout or a failed start

      const text = await bot.register({ bytes: utf8(makeText('c5mem')), mediaType: 'text/plain' });
      expect((await bot.waitVersion(text.versionId, ['ready', 'failed'])).status).toBe('ready');
    },
  );
});

// ---------------------------------------------------------------------------------------------------
// D. Debug cycle P6-D2: one end-to-end case per fix
// ---------------------------------------------------------------------------------------------------

/** A long lease and a long heartbeat interval: a test that edits the job row is not raced by the heartbeat. */
const LONG_LEASE = { JOB_LEASE_SECONDS: '30', JOB_HEARTBEAT_INTERVAL_SECONDS: '10' } as const;

/** One maintenance pass over the local database (the real tasks, the real Storage). */
async function maintain(overrides: Record<string, string> = {}): Promise<TaskResult[]> {
  return runMaintenance(
    h.config(overrides),
    {
      db: createDb({ url: h.apiUrl, secretKey: h.key, timeoutMs: 5000 }),
      storage: createStorage({ url: h.apiUrl, secretKey: h.key, timeoutMs: 10_000 }),
    },
    new AbortController().signal,
  );
}

function taskResult(results: TaskResult[], name: string): TaskResult {
  const r = results.find((x) => x.task === name);
  if (r === undefined) throw new Error(`maintenance has no task ${name}`);
  return r;
}

/** How many chunks the worker's chunker makes of `makeText(marker)` (the expected activation count). */
async function expectedChunks(marker: string): Promise<number> {
  const bytes = utf8(makeText(marker));
  // maxChars is a limit of the merged extraction module (P6-D2-W); a variable avoids an excess-property error
  // against the base commit's narrower type.
  const limits = { timeoutMs: 5000, maxMemoryMb: 64, maxPages: 10, maxChars: 5_000_000 };
  const text = await extractText(bytes, 'text/plain', limits);
  return chunkDocument(text.pages, 'text/plain').chunks.length;
}

/** Claims the version's index job by hand with a 1 s lease, lets it expire and dead-letters it. */
async function deadLetter(bot: TestBot, up: UploadedVersion): Promise<void> {
  const raw = createDb({ url: h.apiUrl, secretKey: h.key, timeoutMs: 5000 });
  const job = await bot.indexJob(up.versionId);
  const claimed = await raw.rpc<{ id: string }[]>('claim_jobs', {
    p_worker: `dead-${h.run}`,
    p_limit: 1,
    p_lease_seconds: 1,
    p_types: ['index_document'],
  });
  expect(claimed.map((r) => r.id)).toEqual([job.id]);
  await sleep(1600);
  // Any later claim dead-letters an expired lease with no attempts left.
  expect(
    await raw.rpc<unknown[]>('claim_jobs', {
      p_worker: `dead-${h.run}`,
      p_limit: 1,
      p_lease_seconds: 1,
      p_types: ['index_document'],
    }),
  ).toEqual([]);
  const after = await bot.indexJob(up.versionId);
  expect(after.state).toBe('failed');
  expect(after.attempts).toBe(after.max_attempts);
}

describe('D. debug cycle P6-D2', () => {
  // ---- D1 -----------------------------------------------------------------------------------------
  for (const status of ['uploaded', 'extracting', 'embedding'] as const) {
    t(
      `D1 a dead-lettered job (expired lease, no attempts left) leaves a ${status} version; maintenance fails it INDEXING_FAILED and the document becomes failed`,
      async () => {
        const bot = await mkBot({ indexMaxAttempts: 1 });
        const up = await bot.register({ bytes: utf8(makeText('d1')), mediaType: 'text/plain' });
        if (status !== 'uploaded') await bot.patchVersion(up.versionId, { status });
        await deadLetter(bot, up);
        // The state the bug left behind: the job is dead, the version is still "in progress".
        expect((await bot.version(up.versionId)).status).toBe(status);
        const corpus = await bot.corpusVersion();

        const results = await maintain();
        expect(taskResult(results, 'fail_orphaned_index_versions')).toMatchObject({ ok: true });
        expect(taskResult(results, 'fail_orphaned_index_versions').count).toBeGreaterThanOrEqual(1);

        const v = await bot.version(up.versionId);
        expect(v.status).toBe('failed');
        expect(v.failure_code).toBe('INDEXING_FAILED');
        const doc = await bot.document(up.documentId);
        expect(doc.status).toBe('failed');
        expect(doc.active_version_id).toBeNull();
        expect(await bot.corpusVersion()).toBe(corpus);
        expect(backend.calls).toBe(0);
      },
    );
  }

  t(
    'D1 a dead-lettered replacement fails INDEXING_FAILED and the document keeps its active version and stays ready',
    async () => {
      const bot = await mkBot({ indexMaxAttempts: 1 });
      await startRuntime();
      const v1 = await indexedText(bot, 'd1old');
      expect((await bot.version(v1.versionId)).status).toBe('ready');
      await pool.shutdownAll();
      const corpus = await bot.corpusVersion();

      const v2 = await bot.addVersion(v1.documentId, {
        bytes: utf8(makeText('d1new')),
        mediaType: 'text/plain',
      });
      await deadLetter(bot, v2);
      expect((await bot.version(v2.versionId)).status).toBe('uploaded');

      const results = await maintain();
      expect(taskResult(results, 'fail_orphaned_index_versions')).toMatchObject({ ok: true });
      const second = await bot.version(v2.versionId);
      expect(second.status).toBe('failed');
      expect(second.failure_code).toBe('INDEXING_FAILED');
      const doc = await bot.document(v1.documentId);
      expect(doc.active_version_id).toBe(v1.versionId);
      expect(doc.status).toBe('ready');
      expect((await bot.version(v1.versionId)).status).toBe('ready');
      expect(await bot.corpusVersion()).toBe(corpus);
    },
  );

  t(
    'D1 negative: maintenance leaves alone a version whose index job is still queued, and one whose job is still running',
    async () => {
      const bot = await mkBot();
      const queued = await bot.register({ bytes: utf8(makeText('d1q')), mediaType: 'text/plain' });
      const running = await bot.register({ bytes: utf8(makeText('d1r')), mediaType: 'text/plain' });
      // Claim only the second one by hand, with a long lease. Both jobs are due, so claim both and put
      // the first back to queued.
      const raw = createDb({ url: h.apiUrl, secretKey: h.key, timeoutMs: 5000 });
      const claimed = await raw.rpc<{ id: string }[]>('claim_jobs', {
        p_worker: `live-${h.run}`,
        p_limit: 2,
        p_lease_seconds: 600,
        p_types: ['index_document'],
      });
      expect(claimed).toHaveLength(2);
      const qJob = await bot.indexJob(queued.versionId);
      await bot.patchJob(qJob.id, {
        state: 'queued',
        attempts: 0,
        locked_by: null,
        locked_until: null,
        available_at: new Date(Date.now() + 3600_000).toISOString(),
      });

      const results = await maintain();
      expect(taskResult(results, 'fail_orphaned_index_versions')).toMatchObject({ ok: true });
      expect((await bot.version(queued.versionId)).status).toBe('uploaded');
      expect((await bot.version(running.versionId)).status).toBe('uploaded');
      expect((await bot.indexJob(running.versionId)).state).toBe('running');
      expect((await bot.document(queued.documentId)).status).not.toBe('failed');
    },
  );

  // ---- D2 -----------------------------------------------------------------------------------------
  const staleStored: [string, Record<string, string>][] = [
    ['chunking_version', { chunking_version: 'c0-stale' }],
    ['extraction_version', { extraction_version: 'x0-stale' }],
    ['embedding_model', { embedding_model: 'fake-embed-stale' }],
  ];
  for (const [field, patch] of staleStored) {
    t(
      `D2 resume after the stored ${field} differs: the chunks are reset, the version indexes from chunk 0 and activates with the right count`,
      async () => {
        const marker = `d2${field.slice(0, 3)}`;
        const expected = await expectedChunks(marker);
        expect(expected).toBeGreaterThan(6);
        const bot = await mkBot({ indexMaxAttempts: 3 });
        // Two batches embed and are written, then the third call fails transiently (as in A9).
        backend.failFrom(3, 'transient');
        await startRuntime({ JOB_BACKOFF_BASE_SECONDS: '4', JOB_BACKOFF_MAX_SECONDS: '8' });
        const up = await bot.register({ bytes: utf8(makeText(marker)), mediaType: 'text/plain' });
        await waitFor('the failing third provider call', () => backend.calls >= 3, 60_000, 20);
        // The failed attempt has handed the job back; the retry waits at least two seconds.
        await waitFor(
          'the job to be queued for a retry',
          async () => {
            const j = await bot.indexJob(up.versionId);
            return j.state === 'queued' && j.attempts === 1;
          },
          20_000,
          20,
        );
        expect(await bot.chunkIndexes(up.versionId)).toEqual(range(4));
        const before = await bot.version(up.versionId);
        const current = before[field as keyof typeof before];
        expect(current).toBeTruthy();
        // The stored value of an earlier run differs from what this worker would write now.
        await bot.patchVersion(up.versionId, patch);
        backend.stopFailing();
        const callsBefore = backend.completedCalls;
        expect(callsBefore).toBe(2);

        const done = await bot.waitJobDone(up.versionId, 80_000);
        expect(done.state).toBe('succeeded');
        expect(done.attempts).toBe(2);
        const v = await bot.version(up.versionId);
        expect(v.status).toBe('ready');
        expect(await bot.chunkIndexes(up.versionId)).toEqual(range(expected));
        // Started over: every chunk embedded again, the two stale batches included.
        expect(backend.completedCalls).toBe(callsBefore + Math.ceil(expected / 2));
        // The new run wrote its own values back over the stale ones.
        expect(v[field as keyof typeof v]).toBe(current);
        expect(v.batches_done).toBe(Math.ceil(expected / 2));
        expect(v.batches_total).toBe(Math.ceil(expected / 2));
        expect((await bot.document(up.documentId)).active_version_id).toBe(up.versionId);
        const hits = await bot.match(`${marker}-section-0`);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.every((r) => r.document_version_id === up.versionId)).toBe(true);
      },
    );
  }

  // ---- D3 -----------------------------------------------------------------------------------------
  /**
   * First attempt: the provider call is held, the reservation exists, then the lease is taken away and the
   * provider answers (a paid batch whose chunks are refused). Returns the job and the first reservation.
   */
  async function lostLeaseAfterPaidBatch(bot: TestBot, up: UploadedVersion, factor: number) {
    const hold = backend.holdCall(1);
    await startRuntime(LONG_LEASE);
    await hold.reached;
    const job = await bot.indexJob(up.versionId);
    const first = (await bot.reservations()).filter((r) => r.job_id === job.id);
    expect(first).toHaveLength(1);
    const reserved = Number(first[0]?.amount);
    expect(reserved).toBeGreaterThan(0);
    await bot.setDailyCap(reserved * factor);
    // The lease is lost; it can be claimed again after three seconds.
    await bot.stealLease(job.id, 3000);
    hold.release(); // the provider answers: the batch is paid for, its chunks are refused (RB013)
    await waitFor(
      'the first attempt to record its usage',
      async () =>
        (await bot.usageEvents()).filter((u) => u.operation === 'embedding_index').length >= 1,
      15_000,
      50,
    );
    expect(await bot.chunkIndexes(up.versionId)).toEqual([]);
    return { job, reserved };
  }

  t(
    'D3 lease lost after a paid batch, then the next attempt: the first attempt counts toward the day, so a cap that fits one attempt but not two refuses the second with BUDGET_EXCEEDED',
    async () => {
      const bot = await mkBot({ indexMaxAttempts: 3 });
      const up = await bot.register({ bytes: utf8(makeText('d3')), mediaType: 'text/plain' });
      // The cap is 1.5 times one attempt's reservation.
      const { job } = await lostLeaseAfterPaidBatch(bot, up, 1.5);

      const v = await bot.waitVersion(up.versionId, ['failed', 'ready'], 40_000);
      expect(v.status).toBe('failed');
      expect(v.failure_code).toBe('BUDGET_EXCEEDED');
      const done = await bot.waitJobDone(up.versionId);
      expect(done.state).toBe('succeeded');
      expect(done.attempts).toBe(2);
      expect(backend.calls).toBe(1); // the second attempt made no provider call
      const reservations = (await bot.reservations()).filter((r) => r.job_id === job.id);
      // The first attempt's reservation was neither released nor reused: it still counts.
      expect(reservations).toHaveLength(1);
      expect(['reserved', 'expired']).toContain(reservations[0]?.state);
      expect(await bot.chunkIndexes(up.versionId)).toEqual([]);
      expect((await bot.document(up.documentId)).active_version_id).toBeNull();
    },
  );

  t(
    'D3 control: with a cap that fits both attempts the second attempt indexes; the first reservation is expired (still counting) and the second is settled',
    async () => {
      const bot = await mkBot({ indexMaxAttempts: 3 });
      const up = await bot.register({ bytes: utf8(makeText('d3c')), mediaType: 'text/plain' });
      const { job } = await lostLeaseAfterPaidBatch(bot, up, 3);

      const v = await bot.waitVersion(up.versionId, ['failed', 'ready'], 40_000);
      expect(v.status).toBe('ready');
      const done = await bot.waitJobDone(up.versionId);
      expect(done.state).toBe('succeeded');
      expect(done.attempts).toBe(2);
      const reservations = (await bot.reservations()).filter((r) => r.job_id === job.id);
      expect(reservations.map((r) => r.state)).toEqual(['expired', 'settled']);
      // Both attempts paid the provider for the first batch: two usage rows for it, none lost.
      const usage = (await bot.usageEvents()).filter((u) => u.operation === 'embedding_index');
      const n = (await bot.chunkIndexes(up.versionId)).length;
      expect(usage).toHaveLength(1 + Math.ceil(n / 2));
      expect(backend.completedCalls).toBe(1 + Math.ceil(n / 2));
    },
  );

  // ---- D4 -----------------------------------------------------------------------------------------
  t(
    'D4 a crash right after the provider answered and before the chunk write: a usage row exists for that batch',
    async () => {
      const bot = await mkBot({ indexMaxAttempts: 3 });
      const hold = backend.holdCall(1);
      await startRuntime(LONG_LEASE);
      const up = await bot.register({ bytes: utf8(makeText('d4')), mediaType: 'text/plain' });
      await hold.reached;
      const job = await bot.indexJob(up.versionId);
      // The worker loses the job for good (an hour), so nothing else runs and the write is refused.
      await bot.stealLease(job.id, 3600_000);
      hold.release();

      const usage = await waitFor(
        'a usage row for the paid batch',
        async () => {
          const rows = (await bot.usageEvents()).filter((u) => u.operation === 'embedding_index');
          return rows.length > 0 ? rows : null;
        },
        15_000,
        50,
      );
      await sleep(500); // the refused chunk write has had time to happen
      expect(usage).toHaveLength(1);
      expect(usage[0]?.job_id).toBe(job.id);
      expect(usage[0]?.model).toBe(h.model);
      expect(usage[0]?.input_tokens).toBe(backend.tokensReported);
      expect(Number(usage[0]?.estimated_cost)).toBeGreaterThan(0);
      expect(backend.completedCalls).toBe(1);
      expect(await bot.chunkIndexes(up.versionId)).toEqual([]); // the write did not happen
      expect((await bot.version(up.versionId)).status).not.toBe('ready');
    },
  );

  // ---- D5 -----------------------------------------------------------------------------------------
  t(
    'D5 overspend: the provider reports far more tokens than estimated; the job stops, settles what it spent and the version is BUDGET_EXCEEDED',
    async () => {
      const bot = await mkBot();
      backend.tokenFactor = 50; // each batch is reported at 50 times its real size
      const hold = backend.holdCall(1);
      await startRuntime();
      const up = await bot.register({ bytes: utf8(makeText('d5')), mediaType: 'text/plain' });
      await hold.reached;
      const job = await bot.indexJob(up.versionId);
      const estimate = Number((await bot.reservations()).find((r) => r.job_id === job.id)?.amount);
      expect(estimate).toBeGreaterThan(0);
      hold.release();

      const v = await bot.waitVersion(up.versionId, ['failed', 'ready'], 40_000);
      expect(v.status).toBe('failed');
      expect(v.failure_code).toBe('BUDGET_EXCEEDED');
      expect((await bot.waitJobDone(up.versionId)).state).toBe('succeeded');
      // It stopped at once: not every batch was bought.
      const total = Math.ceil((await expectedChunks('d5')) / 2);
      expect(backend.completedCalls).toBeGreaterThanOrEqual(1);
      expect(backend.completedCalls).toBeLessThanOrEqual(2);
      expect(backend.completedCalls).toBeLessThan(total);
      expect(backend.calls).toBe(backend.completedCalls);
      const usage = (await bot.usageEvents()).filter((u) => u.operation === 'embedding_index');
      expect(usage).toHaveLength(backend.completedCalls);
      const spent = usage.reduce((sum, u) => sum + Number(u.estimated_cost), 0);
      expect(spent).toBeGreaterThan(estimate); // it really overspent
      // What was spent is settled, and counts toward the cap; nothing is left reserved or released.
      const reservations = (await bot.reservations()).filter((r) => r.job_id === job.id);
      expect(reservations.map((r) => r.state)).toEqual(['settled']);
      expect(Math.abs(Number(reservations[0]?.amount) - spent)).toBeLessThan(0.00001);
      const doc = await bot.document(up.documentId);
      expect(doc.active_version_id).toBeNull();
      expect(doc.status).toBe('failed');
      expect(await bot.match('d5')).toEqual([]);
    },
  );

  // ---- D7 -----------------------------------------------------------------------------------------
  t(
    "D7 superseded version: after a newer version activates, maintenance removes the old version's chunks; the active version's chunks stay",
    async () => {
      const bot = await mkBot();
      await startRuntime();
      const v1 = await indexedText(bot, 'd7old');
      expect((await bot.version(v1.versionId)).status).toBe('ready');
      const v2 = await bot.addVersion(v1.documentId, {
        bytes: utf8(makeText('d7new')),
        mediaType: 'text/plain',
      });
      expect((await bot.waitVersion(v2.versionId, ['ready', 'failed'])).status).toBe('ready');
      expect((await bot.version(v1.versionId)).status).toBe('superseded');
      const oldChunks = await bot.chunkIndexes(v1.versionId);
      const newChunks = await bot.chunkIndexes(v2.versionId);
      expect(oldChunks.length).toBeGreaterThan(2); // the old chunks are still there
      expect(newChunks.length).toBeGreaterThan(2);
      const corpus = await bot.corpusVersion();

      const results = await maintain();
      expect(taskResult(results, 'prune_superseded_chunks')).toMatchObject({ ok: true });
      expect(taskResult(results, 'prune_superseded_chunks').count).toBeGreaterThanOrEqual(
        oldChunks.length,
      );

      expect(await bot.chunkIndexes(v1.versionId)).toEqual([]);
      expect(await bot.chunkIndexes(v2.versionId)).toEqual(newChunks);
      expect((await bot.version(v1.versionId)).status).toBe('superseded');
      expect((await bot.version(v2.versionId)).status).toBe('ready');
      expect((await bot.document(v1.documentId)).active_version_id).toBe(v2.versionId);
      expect(await bot.corpusVersion()).toBe(corpus);
      const hits = await bot.match('d7new-section-0');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((r) => r.document_version_id === v2.versionId)).toBe(true);
    },
  );

  t(
    'D7 negative: maintenance does not remove the chunks of a failed version or of a ready one',
    async () => {
      const bot = await mkBot();
      backend.failFrom(3, 'permanent'); // two batches embed and are written, then the version fails
      await startRuntime();
      const bad = await bot.register({ bytes: utf8(makeText('d7bad')), mediaType: 'text/plain' });
      expect((await bot.waitVersion(bad.versionId, ['failed', 'ready'])).status).toBe('failed');
      await bot.waitJobDone(bad.versionId);
      backend.stopFailing();
      const good = await bot.register({ bytes: utf8(makeText('d7ok')), mediaType: 'text/plain' });
      expect((await bot.waitVersion(good.versionId, ['ready', 'failed'])).status).toBe('ready');
      const badChunks = await bot.chunkIndexes(bad.versionId);
      const goodChunks = await bot.chunkIndexes(good.versionId);
      expect(badChunks).toEqual(range(4));
      expect(goodChunks.length).toBeGreaterThan(2);

      await maintain();

      expect(await bot.chunkIndexes(bad.versionId)).toEqual(badChunks);
      expect(await bot.chunkIndexes(good.versionId)).toEqual(goodChunks);
    },
  );

  // ---- D8 -----------------------------------------------------------------------------------------
  t(
    'D8 an older version reaching the worker after a newer one is active is failed SUPERSEDED before any provider call',
    async () => {
      const bot = await mkBot();
      // The older version's job is parked until the newer version is active.
      const v1 = await bot.register({ bytes: utf8(makeText('d8old')), mediaType: 'text/plain' });
      const oldJob = await bot.indexJob(v1.versionId);
      await bot.patchJob(oldJob.id, {
        available_at: new Date(Date.now() + 3600_000).toISOString(),
      });
      const v2 = await bot.addVersion(v1.documentId, {
        bytes: utf8(makeText('d8new')),
        mediaType: 'text/plain',
      });
      await startRuntime();
      expect((await bot.waitVersion(v2.versionId, ['ready', 'failed'])).status).toBe('ready');
      expect((await bot.version(v1.versionId)).status).toBe('uploaded');
      const corpus = await bot.corpusVersion();
      const calls = backend.calls;
      const usageBefore = (await bot.usageEvents()).length;

      await bot.patchJob(oldJob.id, { available_at: new Date().toISOString() });
      const old = await bot.waitVersion(v1.versionId, ['failed', 'ready'], 40_000);

      expect(old.status).toBe('failed');
      expect(old.failure_code).toBe('SUPERSEDED');
      expect(backend.calls).toBe(calls); // not one provider call for the old version
      expect((await bot.usageEvents()).length).toBe(usageBefore);
      expect(await bot.chunkIndexes(v1.versionId)).toEqual([]);
      expect((await bot.waitJobDone(v1.versionId)).state).toBe('succeeded');
      const doc = await bot.document(v1.documentId);
      expect(doc.active_version_id).toBe(v2.versionId);
      expect(doc.status).toBe('ready');
      expect((await bot.version(v2.versionId)).status).toBe('ready');
      expect(await bot.corpusVersion()).toBe(corpus);
      expect((await bot.match('d8new')).every((r) => r.document_version_id === v2.versionId)).toBe(
        true,
      );
    },
  );

  // ---- D9 -----------------------------------------------------------------------------------------
  for (const stale of [true, false]) {
    t(
      stale
        ? 'D9 admin_retry_version on a failed version with leftover chunks from another chunker: it re-indexes correctly with no mixed chunks'
        : 'D9 admin_retry_version on a failed version with leftover chunks: it re-indexes to a complete, contiguous set',
      async () => {
        const marker = stale ? 'd9stale' : 'd9same';
        const expected = await expectedChunks(marker);
        const bot = await mkBot();
        backend.failFrom(3, 'permanent'); // two batches embed and are written, then the version fails
        await startRuntime();
        const up = await bot.register({ bytes: utf8(makeText(marker)), mediaType: 'text/plain' });
        const failed = await bot.waitVersion(up.versionId, ['failed', 'ready']);
        expect(failed.status).toBe('failed');
        expect(await bot.chunkIndexes(up.versionId)).toEqual(range(4)); // the leftovers
        expect((await bot.waitJobDone(up.versionId)).state).toBe('succeeded');
        backend.stopFailing();
        const leftover = `leftover-${randomBytes(6).toString('hex')}`;
        if (stale) {
          // The leftovers come from an older chunker: different text, a different stored version.
          await bot.setChunkContents(up.versionId, leftover);
          await bot.patchVersion(up.versionId, { chunking_version: 'c0-stale' });
        }

        await h.adminRpcOk('admin_retry_version', { p_version_id: up.versionId });
        const v = await bot.waitVersion(up.versionId, ['ready', 'failed'], 60_000);

        expect(v.status, `failure_code ${String(v.failure_code)}`).toBe('ready');
        expect(v.failure_code).toBeNull();
        expect(await bot.chunkIndexes(up.versionId)).toEqual(range(expected));
        const contents = await bot.chunkContents(up.versionId);
        expect(contents.some((c) => c.includes(leftover))).toBe(false); // no leftover mixed in
        expect(contents.every((c) => c.length > 0)).toBe(true);
        expect(v.chunking_version).not.toBe('c0-stale');
        expect(v.batches_done).toBe(Math.ceil(expected / 2));
        const doc = await bot.document(up.documentId);
        expect(doc.active_version_id).toBe(up.versionId);
        expect(doc.status).toBe('ready');
        const hits = await bot.match(`${marker}-section-0`);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.every((r) => r.document_version_id === up.versionId)).toBe(true);
        if (stale) {
          // Started over: the two leftover batches were embedded again.
          expect(backend.completedCalls).toBe(2 + Math.ceil(expected / 2));
        }
      },
    );
  }

  // ---- D10 ----------------------------------------------------------------------------------------
  t(
    'D10 extracted text over EXTRACT_MAX_CHARS (plain text and a PDF text layer) fails FILE_UNSUPPORTED with no provider call; text under the limit indexes',
    async () => {
      const bot = await mkBot();
      await startRuntime({ EXTRACT_MAX_CHARS: '1000' });
      const over = await bot.register({ bytes: utf8(makeText('d10')), mediaType: 'text/plain' });
      const overPdf = await bot.register({
        bytes: buildPdf({
          pages: [
            Array.from({ length: 40 }, (_, i) => `d10 pdf line ${String(i)} of synthetic words`),
          ],
        }),
        mediaType: 'application/pdf',
      });
      await expectFailed(bot, over, 'FILE_UNSUPPORTED');
      await expectFailed(bot, overPdf, 'FILE_UNSUPPORTED');
      expect(backend.calls).toBe(0);
      expect((await bot.document(over.documentId)).status).toBe('failed');

      // The same runtime still indexes text that fits.
      const under = await bot.register({
        bytes: utf8(makeText('d10ok', 1)),
        mediaType: 'text/plain',
      });
      expect((await bot.waitVersion(under.versionId, ['ready', 'failed'])).status).toBe('ready');
    },
  );
});
