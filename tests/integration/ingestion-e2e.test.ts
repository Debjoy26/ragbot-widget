import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, DbError, type Db } from '../../worker/src/lib/db.ts';
import { createLogger } from '../../worker/src/lib/logger.ts';
import { createStorage } from '../../worker/src/lib/storage.ts';
import { MAINTENANCE_TASKS, runMaintenance } from '../../worker/src/maintenance.ts';
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

// P6 acceptance cases A1-A8, B1-B12 and C3-C5 (docs/evidence/P6/test-plan.md), end to end against the LOCAL
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
      expect((await bot.indexJob(up.versionId)).locked_by).toBe(`a2-second-${h.run}`);

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
    'C5 extraction child over the memory limit is killed: FILE_UNSUPPORTED, and the runtime goes on to index the next job',
    async () => {
      const bot = await mkBot();
      await startRuntime({ EXTRACT_CHILD_MEMORY_MB: '16' });
      // 250 pages of text is more than a 16 MB heap can parse (measured with the extraction module).
      const pages = Array.from({ length: 250 }, (_, p) =>
        Array.from(
          { length: 40 },
          (_, i) => `p${String(p)} l${String(i)} synthetic memory probe words`,
        ),
      );
      const heavy = await bot.register({
        bytes: buildPdf({ pages }),
        mediaType: 'application/pdf',
      });
      await expectFailed(bot, heavy, 'FILE_UNSUPPORTED');
      expect(backend.calls).toBe(0);
      const text = await bot.register({ bytes: utf8(makeText('c5mem')), mediaType: 'text/plain' });
      expect((await bot.waitVersion(text.versionId, ['ready', 'failed'])).status).toBe('ready');
    },
  );
});
