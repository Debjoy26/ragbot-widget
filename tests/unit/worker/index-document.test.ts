import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  FAILURE_CODES,
  ProviderError,
  VECTOR_DIMENSIONS,
  type EmbeddingProvider,
} from '@ragbot/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUDGET_OVERRUN_FACTOR,
  createIndexDocumentHandler,
  ESTIMATE_BYTES_PER_TOKEN,
  estimateBudgetTokens,
  RESERVATION_TTL_SECONDS,
} from '../../../worker/src/jobs/index-document.ts';
import * as chunkModule from '../../../worker/src/lib/chunk.ts';
import { CHUNKING_VERSION } from '../../../worker/src/lib/chunk.ts';
import * as extractModule from '../../../worker/src/lib/extract.ts';
import { EXTRACTION_VERSION, ExtractSpawnError } from '../../../worker/src/lib/extract.ts';
import type { WorkerConfig } from '../../../worker/src/lib/config.ts';
import { DbError, type Db } from '../../../worker/src/lib/db.ts';
import { createLogger } from '../../../worker/src/lib/logger.ts';
import { StorageError, type Storage } from '../../../worker/src/lib/storage.ts';
import {
  LeaseLostError,
  RetryJobError,
  type ClaimedJob,
  type JobContext,
} from '../../../worker/src/runtime.ts';
import { buildPdf, utf8 } from './fixtures/pdf.ts';

// P6-INDEX: the index_document handler against a labelled FAKE database, FAKE storage and a
// FAKE embedding provider. A fake cannot prove the SQL; tests/integration covers the real stack.

vi.mock('../../../worker/src/lib/chunk.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../worker/src/lib/chunk.ts')>();
  return { ...actual, chunkDocumentAsync: vi.fn(actual.chunkDocumentAsync) };
});

vi.mock('../../../worker/src/lib/extract.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../worker/src/lib/extract.ts')>();
  return { ...actual, extractText: vi.fn(actual.extractText) };
});

const SENTINEL = `doc-text-${randomBytes(6).toString('hex')}`;
const FAKE_KEY = `fake-key-${randomBytes(8).toString('hex')}`;
const JOB_ID = randomUUID();
const BOT_ID = randomUUID();
const DOC_ID = randomUUID();
const VERSION_ID = randomUUID();
const RESERVATION_ID = randomUUID();
const MODEL = 'fake-embed-model';
const ETAG = '"etag-abc"';
const PATH = `${randomUUID()}/${DOC_ID}/${VERSION_ID}/notes.txt`;

function makeConfig(over: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    workerId: 'w-test',
    extraction: { maxExtractedChars: 1_000_000, timeoutMs: 20_000, childMemoryMb: 256 },
    embeddingBatchSize: 4,
    embeddingPricePerMillionTokens: 0.2,
    retentionBatchSize: 10,
    maxDownloadBytes: 10_000_000,
    maxChunksPerVersion: 5000,
    ...over,
  } as unknown as WorkerConfig;
}

interface Call {
  readonly name: string;
  readonly args: Record<string, unknown>;
  /** The abort signal the handler passed to the database client, if any. */
  readonly signal: AbortSignal | undefined;
}

type Responder = (args: Record<string, unknown>) => unknown;

interface Rig {
  calls: Call[];
  events: string[];
  logs: string[];
  responders: Record<string, Responder>;
  embedCalls: string[][];
  downloads: string[];
  embed: ReturnType<typeof vi.fn>;
  heartbeat: ReturnType<typeof vi.fn>;
  controller: AbortController;
  provider: EmbeddingProvider;
  ctx: JobContext;
  names(): string[];
  of(name: string): Call[];
}

function contextRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bot_id: BOT_ID,
    document_id: DOC_ID,
    version_id: VERSION_ID,
    version_number: 1,
    status: 'uploaded',
    storage_path: PATH,
    media_type: 'text/plain',
    byte_size: 0,
    upload_etag: ETAG,
    embedding_model: MODEL,
    max_bytes: 1_000_000,
    max_pages: 50,
    active_version_id: null,
    active_version_number: null,
    batches_done: 0,
    written_chunks: 0,
    stored_chunking_version: null,
    stored_extraction_version: null,
    stored_embedding_model: null,
    ...over,
  };
}

/** A context row for a retried attempt: n chunks written by a run with the CURRENT versions. */
function resumeRow(written: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'embedding',
    written_chunks: written,
    stored_chunking_version: CHUNKING_VERSION,
    stored_extraction_version: EXTRACTION_VERSION,
    stored_embedding_model: MODEL,
    ...over,
  };
}

function vector(): number[] {
  return Array.from({ length: VECTOR_DIMENSIONS }, (_, i) => (i % 7) / 10);
}

function makeRig(
  bytes: Uint8Array,
  row: Record<string, unknown> = {},
  download: Partial<{ etag: string | null; error: unknown }> = {},
): Rig {
  const calls: Call[] = [];
  const events: string[] = [];
  const logs: string[] = [];
  const embedCalls: string[][] = [];
  const downloads: string[] = [];
  const controller = new AbortController();
  const responders: Record<string, Responder> = {
    get_index_job_context: () => [contextRow({ byte_size: bytes.length, ...row })],
    update_version_progress: () => null,
    reserve_index_budget: () => RESERVATION_ID,
    reset_version_chunks: () => 0,
    write_document_chunks: (a) => (a['p_chunks'] as unknown[]).length,
    record_usage_event: () => randomUUID(),
    settle_index_budget: () => null,
    release_index_budget: () => null,
    activate_version_for_job: () => 7,
    fail_document_version: () => null,
  };
  const db: Db = {
    rpc: (name: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal) => {
      calls.push({ name, args: { ...args }, signal });
      events.push(`rpc:${name}`);
      // Like the real client: a call made with an already aborted signal never reaches the database.
      if (signal?.aborted === true) {
        const aborted = new Error('aborted');
        aborted.name = 'AbortError';
        return Promise.reject(aborted);
      }
      const responder = responders[name];
      if (responder === undefined) return Promise.reject(new Error(`unexpected rpc ${name}`));
      try {
        return Promise.resolve(responder(args) as never);
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };
  const storage: Storage = {
    download: (path: string) => {
      downloads.push(path);
      events.push('storage:download');
      if (download.error !== undefined) return Promise.reject(download.error);
      return Promise.resolve({
        bytes,
        etag: download.etag === undefined ? ETAG : download.etag,
        contentType: 'text/plain',
      });
    },
    remove: () => Promise.resolve(0),
  };
  const embed = vi.fn((texts: readonly string[]) => {
    embedCalls.push([...texts]);
    events.push('embed');
    return Promise.resolve({ vectors: texts.map(vector), inputTokens: texts.length * 10 });
  });
  const provider: EmbeddingProvider = {
    provider: 'openai_compatible',
    model: MODEL,
    dimensions: VECTOR_DIMENSIONS,
    embed: embed as unknown as EmbeddingProvider['embed'],
  };
  const heartbeat = vi.fn(() => {
    events.push('heartbeat');
    return Promise.resolve();
  });
  const log = createLogger({
    level: 'debug',
    sink: (line) => {
      logs.push(line);
    },
  }).child({ job_id: JOB_ID });
  const ctx: JobContext = {
    db,
    storage,
    config: makeConfig(),
    signal: controller.signal,
    workerId: 'w-test',
    heartbeat,
    log,
  };
  return {
    calls,
    events,
    logs,
    responders,
    embedCalls,
    downloads,
    embed,
    heartbeat,
    controller,
    provider,
    ctx,
    names: () => calls.map((c) => c.name),
    of: (name) => calls.filter((c) => c.name === name),
  };
}

const job: ClaimedJob = {
  id: JOB_ID,
  type: 'index_document',
  payload: { bot_id: BOT_ID, document_id: DOC_ID, version_id: VERSION_ID },
  attempts: 1,
  maxAttempts: 5,
};

function run(rig: Rig, j: ClaimedJob = job): Promise<void> {
  return createIndexDocumentHandler({ embeddings: rig.provider })(j, rig.ctx);
}

function failedWith(rig: Rig): string | undefined {
  const c = rig.of('fail_document_version')[0];
  return c === undefined ? undefined : (c.args['p_failure_code'] as string);
}

/** A batch was embedded before the failure: the reservation is settled with that cost, not released. */
function expectPartialSpendSettled(rig: Rig, expectedCost?: number): void {
  expect(rig.of('release_index_budget')).toHaveLength(0);
  const settles = rig.of('settle_index_budget');
  expect(settles).toHaveLength(1);
  expect(settles[0]?.args).toEqual({
    p_job_id: JOB_ID,
    p_worker: 'w-test',
    p_reservation_id: RESERVATION_ID,
    p_actual: expect.any(Number) as number,
  });
  const amount = settles[0]?.args['p_actual'] as number;
  expect(amount).toBeGreaterThan(0);
  if (expectedCost !== undefined) expect(amount).toBeCloseTo(expectedCost, 10);
}

/** Budget-token estimate of chunks [from, to) of a plain-text document, as the handler computes it. */
function estimateOfChunks(bytes: Uint8Array, from: number, to: number): number {
  const { chunks } = chunkModule.chunkDocument(
    [{ number: 1, text: new TextDecoder().decode(bytes) }],
    'text/plain',
  );
  return chunks.slice(from, to).reduce((sum, c) => sum + estimateBudgetTokens(c.content), 0);
}

function noEmbedNoWrite(rig: Rig): void {
  expect(rig.embed).not.toHaveBeenCalled();
  expect(rig.of('write_document_chunks')).toHaveLength(0);
  expect(rig.of('reserve_index_budget')).toHaveLength(0);
  expect(rig.of('activate_version_for_job')).toHaveLength(0);
}

const SHORT = utf8(`${SENTINEL} is a short note about opening hours.`);

function longText(): Uint8Array {
  const paragraph = (n: number): string =>
    Array.from({ length: 140 }, (_, i) => `word${String(n)}x${String(i)}`).join(' ');
  return utf8(Array.from({ length: 10 }, (_, n) => `${SENTINEL} ${paragraph(n)}`).join('\n\n'));
}

beforeEach(() => {
  vi.mocked(chunkModule.chunkDocumentAsync).mockClear();
  vi.mocked(extractModule.extractText).mockClear();
});

describe('index_document: success path', () => {
  it('runs the steps in order, reserving before any provider call and settling the actual cost', async () => {
    const rig = makeRig(SHORT);
    await run(rig);

    expect(rig.names()).toEqual([
      'get_index_job_context',
      'update_version_progress',
      'reserve_index_budget',
      'update_version_progress',
      'record_usage_event',
      'write_document_chunks',
      'update_version_progress',
      'settle_index_budget',
      'activate_version_for_job',
    ]);
    expect(rig.events.indexOf('rpc:reserve_index_budget')).toBeLessThan(
      rig.events.indexOf('embed'),
    );
    expect(rig.events.indexOf('storage:download')).toBeLessThan(
      rig.events.indexOf('rpc:reserve_index_budget'),
    );
    expect(rig.names()).not.toContain('release_index_budget');
    expect(rig.names()).not.toContain('fail_document_version');

    const progress = rig.of('update_version_progress').map((c) => c.args['p_patch']);
    const checksum = createHash('sha256').update(SHORT).digest('hex');
    expect(progress[0]).toEqual({ status: 'extracting', checksum });
    expect(progress[1]).toMatchObject({
      status: 'embedding',
      batches_total: 1,
      batches_done: 0,
      extraction_method: 'plain_text',
      embedding_model: MODEL,
    });
    expect((progress[1] as Record<string, unknown>)['extraction_version']).toEqual(
      expect.any(String),
    );
    expect((progress[1] as Record<string, unknown>)['chunking_version']).toEqual(
      expect.any(String),
    );
    expect(progress[2]).toEqual({ batches_done: 1 });

    const write = rig.of('write_document_chunks')[0]?.args;
    const chunks = write?.['p_chunks'] as Record<string, unknown>[];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ chunk_index: 0, metadata: {}, page_number: null });
    expect((chunks[0]?.['embedding'] as number[]).length).toBe(VECTOR_DIMENSIONS);

    const usage = rig.of('record_usage_event')[0]?.args;
    expect(usage).toMatchObject({
      p_bot_id: BOT_ID,
      p_job_id: JOB_ID,
      p_provider: 'openai_compatible',
      p_model: MODEL,
      p_operation: 'embedding_index',
      p_input_tokens: 10,
    });
    const reserve = rig.of('reserve_index_budget')[0]?.args;
    expect(reserve?.['p_amount']).toBeGreaterThan(0);
    expect(reserve).toEqual({
      p_job_id: JOB_ID,
      p_worker: 'w-test',
      p_version_id: VERSION_ID,
      p_amount: expect.any(Number) as number,
      p_ttl_seconds: RESERVATION_TTL_SECONDS,
    });
    const settle = rig.of('settle_index_budget')[0]?.args;
    expect(settle).toEqual({
      p_job_id: JOB_ID,
      p_worker: 'w-test',
      p_reservation_id: RESERVATION_ID,
      p_actual: expect.any(Number) as number,
    });
    expect(settle?.['p_actual']).toBe(usage?.['p_estimated_cost']);
    expect(rig.of('activate_version_for_job')[0]?.args['p_expected_chunks']).toBe(1);
    // Every fenced call carries the job, the worker and the version.
    for (const name of ['get_index_job_context', 'write_document_chunks']) {
      expect(rig.of(name)[0]?.args).toMatchObject({
        p_job_id: JOB_ID,
        p_worker: 'w-test',
        p_version_id: VERSION_ID,
      });
    }
  });

  it('embeds in batches of EMBEDDING_BATCH_SIZE and records one usage row per batch', async () => {
    const rig = makeRig(longText());
    rig.ctx = { ...rig.ctx, config: makeConfig({ embeddingBatchSize: 2 }) };
    await run(rig);

    const written = rig.of('write_document_chunks').flatMap((c) => c.args['p_chunks'] as unknown[]);
    const batches = Math.ceil(written.length / 2);
    expect(written.length).toBeGreaterThan(4);
    expect(rig.embedCalls).toHaveLength(batches);
    expect(rig.embedCalls.every((t) => t.length <= 2)).toBe(true);
    expect(rig.of('record_usage_event')).toHaveLength(batches);
    const progress = rig.of('update_version_progress').map((c) => c.args['p_patch']);
    expect(progress[1]).toMatchObject({ batches_total: batches });
    expect(progress.slice(2)).toEqual(
      Array.from({ length: batches }, (_, i) => ({ batches_done: i + 1 })),
    );
    const indexes = rig
      .of('write_document_chunks')
      .flatMap((c) => (c.args['p_chunks'] as { chunk_index: number }[]).map((x) => x.chunk_index));
    expect(indexes).toEqual(Array.from({ length: written.length }, (_, i) => i));
    expect(rig.of('activate_version_for_job')[0]?.args['p_expected_chunks']).toBe(written.length);
    // Settled with the sum of the recorded batch costs.
    const total = rig
      .of('record_usage_event')
      .reduce((s, c) => s + (c.args['p_estimated_cost'] as number), 0);
    expect(rig.of('settle_index_budget')[0]?.args['p_actual']).toBeCloseTo(total, 10);
    // The lease is extended between batches.
    expect(rig.heartbeat.mock.calls.length).toBeGreaterThanOrEqual(batches);
  });

  it('estimates tokens when the provider reports none', async () => {
    const rig = makeRig(SHORT);
    rig.embed.mockImplementationOnce((texts: readonly string[]) =>
      Promise.resolve({ vectors: texts.map(vector), inputTokens: null }),
    );
    await run(rig);
    expect(rig.of('record_usage_event')[0]?.args['p_input_tokens']).toBeGreaterThan(0);
    expect(rig.names()).toContain('activate_version_for_job');
  });

  it('processes a PDF with a text layer', async () => {
    const pdf = buildPdf({ pages: [[`${SENTINEL} first page of the handbook goes here`]] });
    const rig = makeRig(pdf, { media_type: 'application/pdf' });
    await run(rig);
    expect(rig.of('write_document_chunks')[0]?.args['p_chunks']).toMatchObject([
      { page_number: 1 },
    ]);
    expect(rig.of('update_version_progress')[1]?.args['p_patch']).toMatchObject({
      extraction_method: 'pdf_text',
    });
    expect(rig.names()).toContain('activate_version_for_job');
  });

  it('accepts a weak or unquoted eTag that matches after normalising', async () => {
    const rig = makeRig(SHORT, { upload_etag: 'W/"etag-abc"' }, { etag: '"etag-abc"' });
    await run(rig);
    expect(rig.names()).toContain('activate_version_for_job');
  });
});

describe('index_document: retried attempts', () => {
  it('does not send status=extracting or status=embedding when the version is already at embedding', async () => {
    const rig = makeRig(SHORT, { status: 'embedding' });
    await run(rig);
    for (const c of rig.of('update_version_progress')) {
      expect(c.args['p_patch']).not.toHaveProperty('status');
    }
    expect(rig.names()).toContain('activate_version_for_job');
  });

  it('does not send status=extracting when the version is already at extracting, but moves to embedding', async () => {
    const rig = makeRig(SHORT, { status: 'extracting' });
    await run(rig);
    const patches = rig.of('update_version_progress').map((c) => c.args['p_patch']);
    expect(patches[0]).not.toHaveProperty('status');
    expect(patches[1]).toMatchObject({ status: 'embedding' });
  });

  it('rewrites the same chunk indexes after a partial first attempt (idempotent upserts, no extras)', async () => {
    const bytes = longText();
    const first = makeRig(bytes);
    first.ctx = { ...first.ctx, config: makeConfig({ embeddingBatchSize: 2 }) };
    let writes = 0;
    first.responders['write_document_chunks'] = (a) => {
      writes += 1;
      if (writes === 2) throw new DbError('http', 503);
      return (a['p_chunks'] as unknown[]).length;
    };
    await expect(run(first)).rejects.toBeInstanceOf(RetryJobError);
    const firstIndexes = first
      .of('write_document_chunks')
      .flatMap((c) => (c.args['p_chunks'] as { chunk_index: number }[]).map((x) => x.chunk_index));

    const second = makeRig(bytes, { status: 'embedding' });
    second.ctx = { ...second.ctx, config: makeConfig({ embeddingBatchSize: 2 }) };
    await run(second);
    const secondIndexes = second
      .of('write_document_chunks')
      .flatMap((c) => (c.args['p_chunks'] as { chunk_index: number }[]).map((x) => x.chunk_index));
    expect(secondIndexes).toEqual(Array.from({ length: secondIndexes.length }, (_, i) => i));
    expect(secondIndexes.slice(0, firstIndexes.length)).toEqual(firstIndexes);
    expect(second.of('activate_version_for_job')[0]?.args['p_expected_chunks']).toBe(
      secondIndexes.length,
    );
  });
});

describe('index_document: resumption from written_chunks', () => {
  const resumeConfig = makeConfig({ embeddingBatchSize: 2 });

  async function fresh(bytes: Uint8Array): Promise<Rig> {
    const rig = makeRig(bytes);
    rig.ctx = { ...rig.ctx, config: resumeConfig };
    await run(rig);
    return rig;
  }

  it('skips chunk indexes below written_chunks: no embedding, write or usage row for them', async () => {
    const bytes = longText();
    const full = await fresh(bytes);
    const total = full
      .of('write_document_chunks')
      .flatMap((c) => c.args['p_chunks'] as unknown[]).length;
    expect(total).toBeGreaterThan(5);

    const rig = makeRig(bytes, resumeRow(4, { batches_done: 2 }));
    rig.ctx = { ...rig.ctx, config: resumeConfig };
    await run(rig);

    const indexes = rig
      .of('write_document_chunks')
      .flatMap((c) => (c.args['p_chunks'] as { chunk_index: number }[]).map((x) => x.chunk_index));
    expect(indexes).toEqual(Array.from({ length: total - 4 }, (_, i) => i + 4));
    expect(rig.embedCalls.flat()).toHaveLength(total - 4);
    const batches = Math.ceil((total - 4) / 2);
    expect(rig.embedCalls).toHaveLength(batches);
    expect(rig.of('record_usage_event')).toHaveLength(batches);
    // The estimate covers the remaining chunks only.
    expect(rig.of('reserve_index_budget')[0]?.args['p_amount']).toBeLessThan(
      full.of('reserve_index_budget')[0]?.args['p_amount'] as number,
    );
    // batches_done stays consistent: two batches were done before, the rest continue from there.
    const patches = rig.of('update_version_progress').map((c) => c.args['p_patch']);
    expect(patches[1]).toMatchObject({ batches_total: 2 + batches, batches_done: 2 });
    expect(patches.slice(2)).toEqual(
      Array.from({ length: batches }, (_, i) => ({ batches_done: 3 + i })),
    );
    expect(rig.of('activate_version_for_job')[0]?.args['p_expected_chunks']).toBe(total);
  });

  it('with every chunk already written it embeds nothing and activates', async () => {
    const bytes = longText();
    const full = await fresh(bytes);
    const total = full
      .of('write_document_chunks')
      .flatMap((c) => c.args['p_chunks'] as unknown[]).length;
    const rig = makeRig(bytes, resumeRow(total));
    rig.ctx = { ...rig.ctx, config: resumeConfig };
    await run(rig);
    expect(rig.embed).not.toHaveBeenCalled();
    expect(rig.of('write_document_chunks')).toHaveLength(0);
    expect(rig.of('record_usage_event')).toHaveLength(0);
    expect(rig.of('activate_version_for_job')[0]?.args['p_expected_chunks']).toBe(total);
    // Nothing left to embed, so nothing to reserve, settle or release.
    expect(rig.of('reserve_index_budget')).toHaveLength(0);
    expect(rig.of('settle_index_budget')).toHaveLength(0);
    expect(rig.of('release_index_budget')).toHaveLength(0);
    expect(rig.of('reset_version_chunks')).toHaveLength(0);
  });

  it('starts from chunk 0 when written_chunks exceeds what the chunking produced', async () => {
    const bytes = longText();
    const full = await fresh(bytes);
    const total = full
      .of('write_document_chunks')
      .flatMap((c) => c.args['p_chunks'] as unknown[]).length;
    const rig = makeRig(bytes, resumeRow(total + 1));
    rig.ctx = { ...rig.ctx, config: resumeConfig };
    await run(rig);
    const indexes = rig
      .of('write_document_chunks')
      .flatMap((c) => (c.args['p_chunks'] as { chunk_index: number }[]).map((x) => x.chunk_index));
    expect(indexes).toEqual(Array.from({ length: total }, (_, i) => i));
    expect(rig.of('update_version_progress')[1]?.args['p_patch']).toMatchObject({
      batches_done: 0,
    });
    expect(rig.of('activate_version_for_job')[0]?.args['p_expected_chunks']).toBe(total);
  });

  it.each([
    ['missing', undefined],
    ['negative', -1],
    ['not a number', 'many'],
  ])('fails closed when written_chunks is %s: nothing embedded, nothing failed', async (_n, v) => {
    const rig = makeRig(SHORT);
    rig.responders['get_index_job_context'] = () => {
      const r = contextRow({ byte_size: SHORT.length });
      if (v === undefined) delete r['written_chunks'];
      else r['written_chunks'] = v;
      return [r];
    };
    await expect(run(rig)).rejects.toThrow();
    expect(rig.embed).not.toHaveBeenCalled();
    expect(rig.of('write_document_chunks')).toHaveLength(0);
    expect(rig.of('fail_document_version')).toHaveLength(0);
  });
});

describe('index_document: partial spend', () => {
  it('a permanent provider failure after a batch settles the cost so far and fails the version', async () => {
    const rig = makeRig(longText());
    rig.ctx = { ...rig.ctx, config: makeConfig({ embeddingBatchSize: 2 }) };
    rig.embed
      .mockImplementationOnce((texts: readonly string[]) =>
        Promise.resolve({ vectors: texts.map(vector), inputTokens: 500 }),
      )
      .mockRejectedValueOnce(new ProviderError('auth', 'embedding provider returned HTTP 401'));
    await run(rig);
    expect(failedWith(rig)).toBe('INDEXING_FAILED');
    expectPartialSpendSettled(rig, 0.0001); // 500 tokens at 0.2 USD per million
    expect(rig.names()).not.toContain('activate_version_for_job');
  });

  it('settles with the sum of every batch embedded before the failure', async () => {
    const rig = makeRig(longText());
    rig.ctx = { ...rig.ctx, config: makeConfig({ embeddingBatchSize: 2 }) };
    rig.embed
      .mockImplementationOnce((texts: readonly string[]) =>
        Promise.resolve({ vectors: texts.map(vector), inputTokens: 100 }),
      )
      .mockImplementationOnce((texts: readonly string[]) =>
        Promise.resolve({ vectors: texts.map(vector), inputTokens: 300 }),
      )
      .mockRejectedValueOnce(new ProviderError('auth', 'embedding provider returned HTTP 401'));
    await run(rig);
    expectPartialSpendSettled(rig, 0.00008);
  });

  it('releases (and does not settle) when the provider failed on the first batch', async () => {
    const rig = makeRig(SHORT);
    rig.embed.mockRejectedValueOnce(
      new ProviderError('auth', 'embedding provider returned HTTP 401'),
    );
    await run(rig);
    expect(rig.of('release_index_budget')).toHaveLength(1);
    expect(rig.of('settle_index_budget')).toHaveLength(0);
  });

  // P6-D3 R-3: a request that was sent and then failed may still have been billed.
  describe('a request that failed after it was sent counts its estimated cost as spent', () => {
    const sentFailures: [string, ProviderError][] = [
      ['a timeout', new ProviderError('transient', 'embedding request timed out')],
      ['a network error', new ProviderError('transient', 'embedding request failed (network)')],
      ['an HTTP 5xx', new ProviderError('transient', 'embedding provider returned HTTP 503')],
    ];

    it.each(sentFailures)(
      '%s on the only batch settles the batch estimate and does not release',
      async (_n, failure) => {
        const rig = makeRig(SHORT);
        rig.embed.mockRejectedValueOnce(failure);
        await expect(run(rig)).rejects.toBeInstanceOf(RetryJobError);
        expect(rig.of('release_index_budget')).toHaveLength(0);
        // The only batch is the whole reservation, so the estimate settled equals the amount reserved.
        const reserved = rig.of('reserve_index_budget')[0]?.args['p_amount'] as number;
        expectPartialSpendSettled(rig, reserved);
        // P6-D4: usage includes failed attempts, so the failed call has a row carrying the estimate,
        // equal to the settled amount (no signal: R-4).
        const usage = rig.of('record_usage_event');
        expect(usage).toHaveLength(1);
        const row = usage[0]?.args ?? {};
        expect(row['p_operation']).toBe('embedding_index');
        expect(row['p_input_tokens']).toBe(estimateOfChunks(SHORT, 0, 1000));
        expect(row['p_estimated_cost'] as number).toBeCloseTo(
          rig.of('settle_index_budget')[0]?.args['p_actual'] as number,
          10,
        );
        expect(row['p_bot_id']).toBe(BOT_ID);
        expect(row['p_job_id']).toBe(JOB_ID);
        expect(usage[0]?.signal).toBeUndefined();
      },
    );

    it('the usage rows (completed calls plus the failed one) sum to the settled amount', async () => {
      const rig = makeRig(longText());
      rig.ctx = { ...rig.ctx, config: makeConfig({ embeddingBatchSize: 2 }) };
      rig.embed
        .mockImplementationOnce((texts: readonly string[]) =>
          Promise.resolve({ vectors: texts.map(vector), inputTokens: 100 }),
        )
        .mockRejectedValueOnce(new ProviderError('transient', 'embedding request timed out'));
      await expect(run(rig)).rejects.toBeInstanceOf(RetryJobError);
      const usage = rig.of('record_usage_event');
      expect(usage).toHaveLength(2);
      expect(usage[1]?.args['p_input_tokens']).toBe(estimateOfChunks(longText(), 2, 4));
      const sum = usage.reduce((acc, u) => acc + (u.args['p_estimated_cost'] as number), 0);
      expect(sum).toBeCloseTo(rig.of('settle_index_budget')[0]?.args['p_actual'] as number, 10);
    });

    it('a request refused before it was sent (a local error) records no usage and counts nothing', async () => {
      const rig = makeRig(SHORT);
      rig.embed.mockRejectedValueOnce(new TypeError('embedding batch shape refused locally'));
      await run(rig).catch(() => undefined);
      expect(rig.of('record_usage_event')).toHaveLength(0);
      expect(rig.of('settle_index_budget')).toHaveLength(0);
      expect(rig.of('release_index_budget')).toHaveLength(1);
    });

    it('adds the estimate of the failed batch to the batches already paid for', async () => {
      const rig = makeRig(longText());
      rig.ctx = { ...rig.ctx, config: makeConfig({ embeddingBatchSize: 2 }) };
      rig.embed
        .mockImplementationOnce((texts: readonly string[]) =>
          Promise.resolve({ vectors: texts.map(vector), inputTokens: 100 }),
        )
        .mockRejectedValueOnce(new ProviderError('transient', 'embedding request timed out'));
      await expect(run(rig)).rejects.toBeInstanceOf(RetryJobError);
      const failedBatch = estimateOfChunks(longText(), 2, 4);
      expectPartialSpendSettled(rig, ((100 + failedBatch) * 0.2) / 1_000_000);
    });

    it.each([
      ['rate limited', new ProviderError('rate_limited', 'embedding provider returned HTTP 429')],
      ['unauthorised', new ProviderError('auth', 'embedding provider returned HTTP 401')],
      ['a billing refusal', new ProviderError('billing', 'embedding provider returned HTTP 402')],
      ['a permanent 4xx', new ProviderError('permanent', 'embedding provider returned HTTP 400')],
    ])('%s was not billed: the reservation is released, not settled', async (_n, failure) => {
      const rig = makeRig(SHORT);
      rig.embed.mockRejectedValueOnce(failure);
      await run(rig).catch(() => undefined);
      expect(rig.of('release_index_budget')).toHaveLength(1);
      expect(rig.of('settle_index_budget')).toHaveLength(0);
      expect(rig.of('record_usage_event')).toHaveLength(0);
    });

    it('an abort is not a sent-request failure: nothing is settled or released', async () => {
      const rig = makeRig(SHORT);
      rig.embed.mockImplementationOnce(() => {
        rig.controller.abort(new LeaseLostError());
        const err = new Error('aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      });
      await run(rig);
      expect(rig.of('settle_index_budget')).toHaveLength(0);
      expect(rig.of('release_index_budget')).toHaveLength(0);
    });
  });

  it('a failing settle never masks the original failure', async () => {
    const rig = makeRig(SHORT);
    rig.responders['write_document_chunks'] = () => {
      throw new DbError('http', 503);
    };
    rig.responders['settle_index_budget'] = () => {
      throw new DbError('network');
    };
    await expect(run(rig)).rejects.toBeInstanceOf(RetryJobError);
  });
});

describe('index_document: budget (reserve, settle, release through the *_index_budget functions)', () => {
  const OLD_NAMES = /reserve_job_budget|settle_budget_reservation|release_budget_reservation/;

  it('never calls the retired budget functions, on success or on any failure path', async () => {
    const ok = makeRig(SHORT);
    await run(ok);
    const failed = makeRig(SHORT);
    failed.embed.mockRejectedValueOnce(
      new ProviderError('auth', 'embedding provider returned HTTP 401'),
    );
    await run(failed);
    const partial = makeRig(longText());
    partial.ctx = { ...partial.ctx, config: makeConfig({ embeddingBatchSize: 2 }) };
    partial.embed
      .mockImplementationOnce((t: readonly string[]) =>
        Promise.resolve({ vectors: t.map(vector), inputTokens: 9 }),
      )
      .mockRejectedValueOnce(new ProviderError('auth', 'embedding provider returned HTTP 401'));
    await run(partial);
    for (const rig of [ok, failed, partial]) {
      expect(rig.names().filter((n) => OLD_NAMES.test(n))).toEqual([]);
    }
    expect(ok.names()).toContain('reserve_index_budget');
    expect(failed.names()).toContain('release_index_budget');
    expect(partial.names()).toContain('settle_index_budget');
  });

  it('reserves again on every attempt, for the chunks still to embed (re-estimated)', async () => {
    const bytes = longText();
    const attempt1 = makeRig(bytes);
    attempt1.ctx = { ...attempt1.ctx, config: makeConfig({ embeddingBatchSize: 2 }) };
    let writes = 0;
    attempt1.responders['write_document_chunks'] = (a) => {
      writes += 1;
      if (writes === 3) throw new DbError('http', 503);
      return (a['p_chunks'] as unknown[]).length;
    };
    await expect(run(attempt1)).rejects.toBeInstanceOf(RetryJobError);
    // Two batches (4 chunks) were written before the failure.
    const attempt2 = makeRig(bytes, resumeRow(4, { batches_done: 2 }));
    attempt2.ctx = { ...attempt2.ctx, config: makeConfig({ embeddingBatchSize: 2 }) };
    await run(attempt2);
    const first = attempt1.of('reserve_index_budget');
    const second = attempt2.of('reserve_index_budget');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]?.args['p_amount'] as number).toBeLessThan(
      first[0]?.args['p_amount'] as number,
    );
    // The second reservation covers exactly the chunks embedded by the second attempt.
    const embeddedTexts = attempt2.embedCalls.flat();
    const tokens = embeddedTexts.reduce((sum, t) => sum + estimateBudgetTokens(t), 0);
    expect(second[0]?.args['p_amount'] as number).toBeCloseTo((tokens * 0.2) / 1_000_000, 8);
  });
});

describe('index_document: usage is recorded right after the provider answers', () => {
  it('records the usage before the chunks are written, batch by batch', async () => {
    const rig = makeRig(longText());
    rig.ctx = { ...rig.ctx, config: makeConfig({ embeddingBatchSize: 2 }) };
    await run(rig);
    const events = rig.events.filter((e) =>
      /^(embed|rpc:record_usage_event|rpc:write_document_chunks)$/.test(e),
    );
    expect(events.length).toBeGreaterThanOrEqual(6);
    for (let i = 0; i < events.length; i += 3) {
      expect(events.slice(i, i + 3)).toEqual([
        'embed',
        'rpc:record_usage_event',
        'rpc:write_document_chunks',
      ]);
    }
  });

  it('writes the usage row without the job abort signal (a timeout only)', async () => {
    const rig = makeRig(longText());
    rig.ctx = { ...rig.ctx, config: makeConfig({ embeddingBatchSize: 2 }) };
    await run(rig);
    const usage = rig.of('record_usage_event');
    expect(usage.length).toBeGreaterThan(1);
    for (const call of usage) expect(call.signal).toBeUndefined();
    // The other calls of the job do carry it, so the test would notice a rig that drops signals.
    expect(rig.of('write_document_chunks')[0]?.signal).toBe(rig.controller.signal);
  });

  it('an abort between the provider answer and the usage write does not drop the row', async () => {
    const rig = makeRig(SHORT);
    let stored = 0;
    rig.responders['record_usage_event'] = () => {
      stored += 1;
      return randomUUID();
    };
    rig.embed.mockImplementationOnce((texts: readonly string[]) => {
      // The provider answered (and was paid), then the lease was lost before the usage write.
      queueMicrotask(() => {
        rig.controller.abort(new LeaseLostError());
      });
      return Promise.resolve({ vectors: texts.map(vector), inputTokens: 40 });
    });
    await run(rig);
    const usage = rig.of('record_usage_event');
    expect(usage).toHaveLength(1);
    expect(usage[0]?.args['p_input_tokens']).toBe(40);
    // The row reached the database (the rig refuses calls made with an aborted signal).
    expect(stored).toBe(1);
  });

  it('when the write fails the usage is already recorded and the spend is settled', async () => {
    const rig = makeRig(SHORT);
    rig.responders['write_document_chunks'] = () => {
      throw new DbError('http', 503);
    };
    await expect(run(rig)).rejects.toBeInstanceOf(RetryJobError);
    expect(rig.of('record_usage_event')).toHaveLength(1);
    expect(rig.names().indexOf('record_usage_event')).toBeLessThan(
      rig.names().indexOf('write_document_chunks'),
    );
    expectPartialSpendSettled(rig);
  });

  it('when recording the usage fails nothing is written and the spend is still settled', async () => {
    const rig = makeRig(SHORT);
    rig.responders['record_usage_event'] = () => {
      throw new DbError('http', 503);
    };
    await expect(run(rig)).rejects.toBeInstanceOf(RetryJobError);
    expect(rig.of('write_document_chunks')).toHaveLength(0);
    expectPartialSpendSettled(rig);
  });
});

describe('index_document: conservative estimate and the 1.5x stop', () => {
  it('counts UTF-8 bytes, not characters, and rounds up', () => {
    expect(ESTIMATE_BYTES_PER_TOKEN).toBe(3);
    expect(estimateBudgetTokens('')).toBe(0);
    expect(estimateBudgetTokens('a')).toBe(1);
    expect(estimateBudgetTokens('abc')).toBe(1);
    expect(estimateBudgetTokens('abcd')).toBe(2);
    expect(estimateBudgetTokens('é'.repeat(3))).toBe(2); // 6 bytes
    expect(estimateBudgetTokens('日'.repeat(3))).toBe(3); // 9 bytes
    expect(estimateBudgetTokens('\u{1F600}')).toBe(2); // 4 bytes
  });

  it('reserves from the byte estimate of the chunks (accented text is not undercounted)', async () => {
    const text = 'é'.repeat(600); // 1200 bytes: 400 estimated tokens, only about 300 by character weight
    const rig = makeRig(utf8(text));
    await run(rig);
    const chunks = rig
      .of('write_document_chunks')
      .flatMap((c) => c.args['p_chunks'] as { token_count: number }[]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.token_count).toBeLessThan(400);
    expect(rig.of('reserve_index_budget')[0]?.args['p_amount']).toBeCloseTo(
      (400 * 0.2) / 1_000_000,
      10,
    );
  });

  it('uses the byte estimate for a batch when the provider reports no token count', async () => {
    const rig = makeRig(SHORT);
    rig.embed.mockImplementationOnce((texts: readonly string[]) =>
      Promise.resolve({ vectors: texts.map(vector), inputTokens: null }),
    );
    await run(rig);
    const written = rig.of('write_document_chunks')[0]?.args['p_chunks'] as { content: string }[];
    const expected = written.reduce((sum, c) => sum + estimateBudgetTokens(c.content), 0);
    expect(rig.of('record_usage_event')[0]?.args['p_input_tokens']).toBe(expected);
  });

  it('uses the provider token count when given', async () => {
    const rig = makeRig(SHORT);
    await run(rig);
    expect(rig.of('record_usage_event')[0]?.args['p_input_tokens']).toBe(10);
  });

  it('stops when the actual cost passes 1.5 times the reservation: settles the spend, fails BUDGET_EXCEEDED, writes nothing more', async () => {
    const rig = makeRig(longText());
    rig.ctx = { ...rig.ctx, config: makeConfig({ embeddingBatchSize: 2 }) };
    rig.embed.mockImplementationOnce((texts: readonly string[]) =>
      Promise.resolve({ vectors: texts.map(vector), inputTokens: 5_000_000 }),
    );
    await run(rig);
    expect(failedWith(rig)).toBe('BUDGET_EXCEEDED');
    expect(rig.embed).toHaveBeenCalledTimes(1);
    expect(rig.of('write_document_chunks')).toHaveLength(0);
    expect(rig.of('record_usage_event')).toHaveLength(1);
    expectPartialSpendSettled(rig, 1); // 5,000,000 tokens at 0.2 USD per million
    expect(rig.of('release_index_budget')).toHaveLength(0);
    expect(rig.names()).not.toContain('activate_version_for_job');
  });

  it('keeps going while the actual cost stays at or under 1.5 times the reservation, and settles the actual', async () => {
    const rig = makeRig(longText());
    rig.ctx = { ...rig.ctx, config: makeConfig({ embeddingBatchSize: 2 }) };
    rig.embed.mockImplementation((texts: readonly string[]) => {
      rig.embedCalls.push([...texts]);
      const estimate = texts.reduce((sum, t) => sum + estimateBudgetTokens(t), 0);
      return Promise.resolve({
        vectors: texts.map(vector),
        inputTokens: Math.ceil(estimate * 1.4),
      });
    });
    await run(rig);
    expect(failedWith(rig)).toBeUndefined();
    expect(rig.names()).toContain('activate_version_for_job');
    const reserved = rig.of('reserve_index_budget')[0]?.args['p_amount'] as number;
    const settled = rig.of('settle_index_budget')[0]?.args['p_actual'] as number;
    expect(settled).toBeGreaterThan(reserved);
    expect(settled).toBeLessThanOrEqual(reserved * BUDGET_OVERRUN_FACTOR);
  });
});

describe('index_document: resume resets stale chunks', () => {
  const config2 = makeConfig({ embeddingBatchSize: 2 });

  async function totalChunks(bytes: Uint8Array): Promise<number> {
    const rig = makeRig(bytes);
    rig.ctx = { ...rig.ctx, config: config2 };
    await run(rig);
    return rig.of('write_document_chunks').flatMap((c) => c.args['p_chunks'] as unknown[]).length;
  }

  function writtenIndexes(rig: Rig): number[] {
    return rig
      .of('write_document_chunks')
      .flatMap((c) => (c.args['p_chunks'] as { chunk_index: number }[]).map((x) => x.chunk_index));
  }

  it.each([
    ['chunking version', { stored_chunking_version: 'c0-old' }],
    ['extraction version', { stored_extraction_version: 'x0-old' }],
    ['embedding model', { stored_embedding_model: 'older-model' }],
    ['chunking version missing', { stored_chunking_version: null }],
    ['extraction version missing', { stored_extraction_version: null }],
    ['embedding model missing', { stored_embedding_model: null }],
  ])(
    'resets the version chunks and starts at 0 when the stored %s differs',
    async (_name, stale) => {
      const bytes = longText();
      const total = await totalChunks(bytes);
      const rig = makeRig(bytes, resumeRow(4, { batches_done: 2, ...stale }));
      rig.ctx = { ...rig.ctx, config: config2 };
      await run(rig);

      const resets = rig.of('reset_version_chunks');
      expect(resets).toHaveLength(1);
      expect(resets[0]?.args).toEqual({
        p_job_id: JOB_ID,
        p_worker: 'w-test',
        p_version_id: VERSION_ID,
      });
      // Reset happens before the reservation and before any provider call.
      expect(rig.names().indexOf('reset_version_chunks')).toBeLessThan(
        rig.names().indexOf('reserve_index_budget'),
      );
      expect(rig.events.indexOf('rpc:reset_version_chunks')).toBeLessThan(
        rig.events.indexOf('embed'),
      );
      expect(writtenIndexes(rig)).toEqual(Array.from({ length: total }, (_, i) => i));
      expect(rig.of('update_version_progress')[1]?.args['p_patch']).toMatchObject({
        batches_done: 0,
      });
      expect(rig.of('activate_version_for_job')[0]?.args['p_expected_chunks']).toBe(total);
      // The reservation covers all the chunks again.
      const fresh = makeRig(bytes);
      fresh.ctx = { ...fresh.ctx, config: config2 };
      await run(fresh);
      expect(rig.of('reserve_index_budget')[0]?.args['p_amount']).toBe(
        fresh.of('reserve_index_budget')[0]?.args['p_amount'],
      );
    },
  );

  it('resets when the chunking now yields fewer chunks than written_chunks', async () => {
    const bytes = longText();
    const total = await totalChunks(bytes);
    const rig = makeRig(bytes, resumeRow(total + 1));
    rig.ctx = { ...rig.ctx, config: config2 };
    await run(rig);
    expect(rig.of('reset_version_chunks')).toHaveLength(1);
    expect(writtenIndexes(rig)).toEqual(Array.from({ length: total }, (_, i) => i));
  });

  it('does not reset when everything matches, or when nothing was written yet', async () => {
    const bytes = longText();
    const resumed = makeRig(bytes, resumeRow(4, { batches_done: 2 }));
    resumed.ctx = { ...resumed.ctx, config: config2 };
    await run(resumed);
    expect(resumed.of('reset_version_chunks')).toHaveLength(0);
    expect(Math.min(...writtenIndexes(resumed))).toBe(4);

    const fresh = makeRig(bytes, { status: 'embedding', stored_chunking_version: 'c0-old' });
    fresh.ctx = { ...fresh.ctx, config: config2 };
    await run(fresh);
    expect(fresh.of('reset_version_chunks')).toHaveLength(0);
  });

  it('a lost lease on the reset stops at once: no reservation, no provider call', async () => {
    const bytes = longText();
    const rig = makeRig(bytes, resumeRow(4, { stored_chunking_version: 'c0-old' }));
    rig.responders['reset_version_chunks'] = () => {
      throw new DbError('http', 400, 'RB013');
    };
    await run(rig);
    expect(rig.names()).not.toContain('reserve_index_budget');
    expect(rig.embed).not.toHaveBeenCalled();
    expect(failedWith(rig)).toBeUndefined();
  });
});

describe('index_document: extraction and chunking limits', () => {
  it('passes EXTRACT_MAX_CHARS to extraction and fails an over-long text FILE_UNSUPPORTED', async () => {
    const rig = makeRig(SHORT);
    rig.ctx = {
      ...rig.ctx,
      config: makeConfig({
        extraction: { maxExtractedChars: 10, timeoutMs: 20_000, childMemoryMb: 256 },
      }),
    };
    await run(rig);
    expect(vi.mocked(extractModule.extractText).mock.calls[0]?.[2]).toMatchObject({ maxChars: 10 });
    expect(failedWith(rig)).toBe('FILE_UNSUPPORTED');
    noEmbedNoWrite(rig);
  });

  it('fails FILE_UNSUPPORTED when the document would exceed MAX_CHUNKS_PER_VERSION, before reserving', async () => {
    const rig = makeRig(longText());
    rig.ctx = { ...rig.ctx, config: makeConfig({ maxChunksPerVersion: 2 }) };
    await run(rig);
    expect(failedWith(rig)).toBe('FILE_UNSUPPORTED');
    noEmbedNoWrite(rig);
    expect(vi.mocked(chunkModule.chunkDocumentAsync).mock.calls[0]?.[2]).toMatchObject({
      maxChunks: 2,
    });
  });

  it('chunks through the async chunker with the lease signal', async () => {
    const rig = makeRig(SHORT);
    await run(rig);
    expect(vi.mocked(chunkModule.chunkDocumentAsync).mock.calls[0]?.[2]).toMatchObject({
      maxChunks: 5000,
      signal: rig.ctx.signal,
    });
  });

  it('a child that cannot start is transient: RetryJobError, the version is not failed', async () => {
    vi.mocked(extractModule.extractText).mockRejectedValueOnce(new ExtractSpawnError('ENOENT'));
    const rig = makeRig(buildPdf({ pages: [['some words that are fine here']] }), {
      media_type: 'application/pdf',
    });
    const err = await run(rig).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryJobError);
    expect((err as RetryJobError).code).toBe('extractor_unavailable');
    expect(failedWith(rig)).toBeUndefined();
    noEmbedNoWrite(rig);
  });

  it('a vector component beyond the bound fails INDEXING_FAILED, nothing is written, the spend is settled', async () => {
    const rig = makeRig(SHORT);
    rig.embed.mockImplementationOnce((texts: readonly string[]) =>
      Promise.resolve({
        vectors: texts.map(() => vector().map((v, i) => (i === 3 ? 1e20 : v))),
        inputTokens: 5,
      }),
    );
    await run(rig);
    expect(failedWith(rig)).toBe('INDEXING_FAILED');
    expect(rig.of('write_document_chunks')).toHaveLength(0);
    expect(rig.of('record_usage_event')).toHaveLength(1);
    expectPartialSpendSettled(rig);
  });

  it('every failure code the handler records is one of the shared FAILURE_CODES', async () => {
    const rigs = [
      makeRig(SHORT, { embedding_model: 'other' }),
      makeRig(SHORT, { upload_etag: null }),
      makeRig(SHORT, { version_number: 1, active_version_number: 2 }),
    ];
    for (const rig of rigs) {
      await run(rig);
      expect(FAILURE_CODES as readonly string[]).toContain(failedWith(rig));
    }
  });
});

describe('index_document: nothing to do', () => {
  it.each(['ready', 'superseded', 'failed'])(
    'completes without work when the version is %s',
    async (status) => {
      const rig = makeRig(SHORT, { status });
      await run(rig);
      expect(rig.names()).toEqual(['get_index_job_context']);
      expect(rig.downloads).toHaveLength(0);
    },
  );

  it('completes when the version is not yet indexable (pending_upload)', async () => {
    const rig = makeRig(SHORT, { status: 'pending_upload' });
    await run(rig);
    expect(rig.names()).toEqual(['get_index_job_context']);
  });

  it('completes without failing anything when the document is deleted (RB010)', async () => {
    const rig = makeRig(SHORT);
    rig.responders['get_index_job_context'] = () => {
      throw new DbError('http', 400, 'RB010');
    };
    await run(rig);
    expect(rig.names()).toEqual(['get_index_job_context']);
    expect(rig.downloads).toHaveLength(0);
  });

  it('completes without work on an invalid payload', async () => {
    const rig = makeRig(SHORT);
    await run(rig, { ...job, payload: { version_id: 'not-a-uuid' } });
    expect(rig.calls).toHaveLength(0);
  });

  it('stops quietly when the document is deleted during the job (RB010 on write) and settles the partial spend', async () => {
    const rig = makeRig(SHORT);
    rig.responders['write_document_chunks'] = () => {
      throw new DbError('http', 400, 'RB010');
    };
    await run(rig);
    expect(failedWith(rig)).toBeUndefined();
    expectPartialSpendSettled(rig);
    expect(rig.names()).not.toContain('activate_version_for_job');
  });

  it('stops quietly when the version is no longer in embedding (RB030 on write)', async () => {
    const rig = makeRig(SHORT);
    rig.responders['write_document_chunks'] = () => {
      throw new DbError('http', 400, 'RB030');
    };
    await run(rig);
    expect(failedWith(rig)).toBeUndefined();
    expectPartialSpendSettled(rig);
  });
});

describe('index_document: permanent failures fail the version and return', () => {
  it('older than the active version fails SUPERSEDED with no download', async () => {
    const rig = makeRig(SHORT, {
      version_number: 2,
      active_version_id: randomUUID(),
      active_version_number: 3,
    });
    await run(rig);
    expect(failedWith(rig)).toBe('SUPERSEDED');
    expect(rig.downloads).toHaveLength(0);
    noEmbedNoWrite(rig);
  });

  it('a newer version than the active one proceeds', async () => {
    const rig = makeRig(SHORT, { version_number: 4, active_version_number: 3 });
    await run(rig);
    expect(failedWith(rig)).toBeUndefined();
    expect(rig.names()).toContain('activate_version_for_job');
  });

  it("fails INDEXING_FAILED before any download when the bot's embedding model differs from the provider's", async () => {
    const rig = makeRig(SHORT, { embedding_model: 'some-other-model' });
    await run(rig);
    expect(failedWith(rig)).toBe('INDEXING_FAILED');
    expect(rig.downloads).toHaveLength(0);
    noEmbedNoWrite(rig);
  });

  it('fails INDEXING_FAILED when the bot has no embedding model', async () => {
    const rig = makeRig(SHORT, { embedding_model: null });
    await run(rig);
    expect(failedWith(rig)).toBe('INDEXING_FAILED');
    noEmbedNoWrite(rig);
  });

  it.each([
    ['a missing eTag', { etag: null }, {}],
    ['a changed eTag', { etag: '"someone-else"' }, {}],
    ['no registered upload eTag', {}, { upload_etag: null }],
  ])('%s fails FILE_UNSUPPORTED with no provider call', async (_name, download, row) => {
    const rig = makeRig(SHORT, row, download);
    await run(rig);
    expect(failedWith(rig)).toBe('FILE_UNSUPPORTED');
    noEmbedNoWrite(rig);
  });

  it('a size different from the registered byte_size fails FILE_UNSUPPORTED', async () => {
    const rig = makeRig(SHORT, { byte_size: SHORT.length + 1 });
    await run(rig);
    expect(failedWith(rig)).toBe('FILE_UNSUPPORTED');
    noEmbedNoWrite(rig);
  });

  it.each([
    ['text declared as PDF', utf8('plain words here'), 'application/pdf'],
    ['a PDF declared as text', buildPdf({ pages: [['hello there friend']] }), 'text/plain'],
    ['a PDF declared as markdown', buildPdf({ pages: [['hello there friend']] }), 'text/markdown'],
    [
      'an executable declared as PDF',
      Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]),
      'application/pdf',
    ],
    ['binary declared as text', Uint8Array.from([0, 1, 2, 3, 255, 254, 0, 0, 9, 9]), 'text/plain'],
    ['a type outside the allow-list', utf8('plain words here'), 'application/zip'],
  ])('%s fails FILE_UNSUPPORTED with no provider call', async (_name, bytes, mediaType) => {
    const rig = makeRig(bytes, { media_type: mediaType });
    await run(rig);
    expect(failedWith(rig)).toBe('FILE_UNSUPPORTED');
    noEmbedNoWrite(rig);
  });

  it('an object over max_bytes (storage too_large) fails FILE_UNSUPPORTED', async () => {
    const rig = makeRig(SHORT, {}, { error: new StorageError('too_large') });
    await run(rig);
    expect(failedWith(rig)).toBe('FILE_UNSUPPORTED');
    noEmbedNoWrite(rig);
  });

  it('caps the download at the smallest of byte_size, max_bytes and WORKER_MAX_DOWNLOAD_BYTES', async () => {
    const cases: [Record<string, unknown>, Partial<WorkerConfig>, number][] = [
      [{ max_bytes: 4321, byte_size: 9999 }, { maxDownloadBytes: 50_000 }, 4321],
      [{ max_bytes: 9_000_000, byte_size: 5000 }, { maxDownloadBytes: 50_000 }, 5000],
      [{ max_bytes: 9_000_000, byte_size: 90_000 }, { maxDownloadBytes: 777 }, 777],
    ];
    for (const [row, over, expected] of cases) {
      const rig = makeRig(SHORT, row);
      rig.ctx = { ...rig.ctx, config: makeConfig(over) };
      const download = vi.spyOn(rig.ctx.storage, 'download');
      await run(rig);
      expect(download).toHaveBeenCalledTimes(1);
      expect(download.mock.calls[0]?.[1]).toBe(expected);
    }
  });

  it('asks storage to verify the registered eTag before the body is read', async () => {
    const rig = makeRig(SHORT);
    const download = vi.spyOn(rig.ctx.storage, 'download');
    await run(rig);
    expect(download.mock.calls[0]?.[3]).toEqual({ expectedEtag: ETAG });
  });

  it('an eTag mismatch reported by storage fails FILE_UNSUPPORTED with no provider call', async () => {
    const rig = makeRig(SHORT, {}, { error: new StorageError('etag_mismatch') });
    await run(rig);
    expect(failedWith(rig)).toBe('FILE_UNSUPPORTED');
    noEmbedNoWrite(rig);
  });

  it('a missing registered eTag never reaches storage', async () => {
    const rig = makeRig(SHORT, { upload_etag: null });
    await run(rig);
    expect(rig.downloads).toHaveLength(0);
    expect(failedWith(rig)).toBe('FILE_UNSUPPORTED');
  });

  it('a missing or invalid worker download limit fails closed: nothing downloaded, nothing failed', async () => {
    for (const bad of [undefined, 0, Number.NaN, -5]) {
      const rig = makeRig(SHORT);
      rig.ctx = {
        ...rig.ctx,
        config: makeConfig({ maxDownloadBytes: bad as unknown as number }),
      };
      await expect(run(rig)).rejects.toThrow();
      expect(rig.downloads).toHaveLength(0);
      expect(failedWith(rig)).toBeUndefined();
    }
  });

  it('a missing object (404) fails FILE_UNSUPPORTED', async () => {
    const rig = makeRig(SHORT, {}, { error: new StorageError('http', 404) });
    await run(rig);
    expect(failedWith(rig)).toBe('FILE_UNSUPPORTED');
    noEmbedNoWrite(rig);
  });

  it('a scanned PDF (no text layer) fails OCR_REQUIRED and is never activated', async () => {
    const rig = makeRig(buildPdf({ pages: [[], []] }), { media_type: 'application/pdf' });
    await run(rig);
    expect(failedWith(rig)).toBe('OCR_REQUIRED');
    noEmbedNoWrite(rig);
  });

  it('an encrypted PDF fails FILE_UNSUPPORTED', async () => {
    const rig = makeRig(buildPdf({ pages: [['secret handbook words go here']], encrypt: true }), {
      media_type: 'application/pdf',
    });
    await run(rig);
    expect(failedWith(rig)).toBe('FILE_UNSUPPORTED');
    noEmbedNoWrite(rig);
  });

  it('a corrupt PDF fails FILE_UNSUPPORTED', async () => {
    const rig = makeRig(utf8('%PDF-1.4\nthis is not a real pdf body at all\n%%EOF\n'), {
      media_type: 'application/pdf',
    });
    await run(rig);
    expect(failedWith(rig)).toBe('FILE_UNSUPPORTED');
    noEmbedNoWrite(rig);
  });

  it('a PDF over max_pages fails FILE_UNSUPPORTED', async () => {
    const pdf = buildPdf({ pages: [['page one words here'], ['page two words'], ['page three']] });
    const rig = makeRig(pdf, { media_type: 'application/pdf', max_pages: 2 });
    await run(rig);
    expect(failedWith(rig)).toBe('FILE_UNSUPPORTED');
    noEmbedNoWrite(rig);
  });

  it('zero chunks fail OCR_REQUIRED for a PDF and FILE_UNSUPPORTED for other types', async () => {
    vi.mocked(chunkModule.chunkDocumentAsync).mockResolvedValue({ chunks: [], version: 'c-test' });
    const pdfRig = makeRig(buildPdf({ pages: [['some words that are fine here']] }), {
      media_type: 'application/pdf',
    });
    await run(pdfRig);
    expect(failedWith(pdfRig)).toBe('OCR_REQUIRED');
    noEmbedNoWrite(pdfRig);

    vi.mocked(chunkModule.chunkDocumentAsync).mockResolvedValue({ chunks: [], version: 'c-test' });
    const textRig = makeRig(SHORT);
    await run(textRig);
    expect(failedWith(textRig)).toBe('FILE_UNSUPPORTED');
    noEmbedNoWrite(textRig);
    vi.mocked(chunkModule.chunkDocumentAsync).mockRestore();
  });

  it('the daily cap (RB001) fails BUDGET_EXCEEDED with no provider call, no write, nothing to release', async () => {
    const rig = makeRig(SHORT);
    rig.responders['reserve_index_budget'] = () => {
      throw new DbError('http', 400, 'RB001');
    };
    await run(rig);
    expect(failedWith(rig)).toBe('BUDGET_EXCEEDED');
    expect(rig.embed).not.toHaveBeenCalled();
    expect(rig.of('write_document_chunks')).toHaveLength(0);
    expect(rig.names()).not.toContain('release_index_budget');
    expect(rig.names()).not.toContain('settle_index_budget');
    expect(rig.names()).not.toContain('activate_version_for_job');
  });

  it('other reserve failures are not file failures: they propagate for a retry', async () => {
    const rig = makeRig(SHORT);
    rig.responders['reserve_index_budget'] = () => {
      throw new DbError('http', 400, 'RB002');
    };
    await expect(run(rig)).rejects.toBeInstanceOf(DbError);
    expect(rig.embed).not.toHaveBeenCalled();
    expect(failedWith(rig)).toBeUndefined();
  });

  it('a non-retryable provider error (auth) fails INDEXING_FAILED and releases the reservation', async () => {
    const rig = makeRig(SHORT);
    rig.embed.mockRejectedValueOnce(
      new ProviderError('auth', 'embedding provider returned HTTP 401'),
    );
    await run(rig);
    expect(failedWith(rig)).toBe('INDEXING_FAILED');
    expect(rig.names()).toContain('release_index_budget');
    expect(rig.names()).not.toContain('settle_index_budget');
    expect(rig.names()).not.toContain('activate_version_for_job');
  });

  it('a wrong-length vector from the provider fails INDEXING_FAILED and nothing is written', async () => {
    const rig = makeRig(SHORT);
    rig.embed.mockResolvedValueOnce({ vectors: [[0.1, 0.2, 0.3]], inputTokens: 5 });
    await run(rig);
    expect(failedWith(rig)).toBe('INDEXING_FAILED');
    expect(rig.of('write_document_chunks')).toHaveLength(0);
    // The provider answered and was paid: the usage is recorded and the spend settled, not released.
    expect(rig.of('record_usage_event')).toHaveLength(1);
    expectPartialSpendSettled(rig);
  });

  it('a wrong vector count from the provider fails INDEXING_FAILED', async () => {
    const rig = makeRig(SHORT);
    rig.embed.mockResolvedValueOnce({ vectors: [], inputTokens: 5 });
    await run(rig);
    expect(failedWith(rig)).toBe('INDEXING_FAILED');
    expect(rig.of('write_document_chunks')).toHaveLength(0);
  });

  it('an already-terminal version (RB030 from fail_document_version) is not an error', async () => {
    const rig = makeRig(SHORT, { byte_size: 1 });
    rig.responders['fail_document_version'] = () => {
      throw new DbError('http', 400, 'RB030');
    };
    await expect(run(rig)).resolves.toBeUndefined();
  });
});

describe('index_document: activation refused (RB011)', () => {
  function refuse(rig: Rig, after: Record<string, unknown>): void {
    let contexts = 0;
    rig.responders['get_index_job_context'] = () => {
      contexts += 1;
      return [
        contextRow({
          byte_size: SHORT.length,
          ...(contexts > 1 ? after : {}),
        }),
      ];
    };
    rig.responders['activate_version_for_job'] = () => {
      throw new DbError('http', 400, 'RB011');
    };
  }

  it('fails SUPERSEDED when a newer version became active meanwhile', async () => {
    const rig = makeRig(SHORT);
    refuse(rig, { status: 'embedding', version_number: 1, active_version_number: 2 });
    await run(rig);
    expect(failedWith(rig)).toBe('SUPERSEDED');
    expect(rig.names()).toContain('settle_index_budget');
    expect(rig.names()).not.toContain('release_index_budget');
  });

  it('fails INDEXING_FAILED on an embedding model mismatch', async () => {
    const rig = makeRig(SHORT);
    refuse(rig, { status: 'embedding', embedding_model: 'changed-model' });
    await run(rig);
    expect(failedWith(rig)).toBe('INDEXING_FAILED');
  });

  it('completes without failing when the version is already ready (duplicate delivery)', async () => {
    const rig = makeRig(SHORT);
    refuse(rig, { status: 'ready' });
    await run(rig);
    expect(failedWith(rig)).toBeUndefined();
  });

  it('keeps the settled reservation settled (no release after settle)', async () => {
    const rig = makeRig(SHORT);
    refuse(rig, { status: 'embedding' });
    await run(rig);
    expect(rig.of('settle_index_budget')).toHaveLength(1);
    expect(rig.of('release_index_budget')).toHaveLength(0);
  });
});

describe('index_document: transient failures retry', () => {
  it('a rate-limited provider throws RetryJobError with the retry-after hint and releases the reservation', async () => {
    const rig = makeRig(SHORT);
    rig.embed.mockRejectedValueOnce(
      new ProviderError('rate_limited', 'embedding provider returned HTTP 429', {
        retryAfterSeconds: 42,
      }),
    );
    const err = await run(rig).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryJobError);
    expect((err as RetryJobError).code).toBe('provider_rate_limited');
    expect((err as RetryJobError).retryAfterSeconds).toBe(42);
    expect(rig.of('release_index_budget')).toHaveLength(1);
    expect(rig.of('release_index_budget')[0]?.args).toEqual({
      p_job_id: JOB_ID,
      p_worker: 'w-test',
      p_reservation_id: RESERVATION_ID,
    });
    expect(failedWith(rig)).toBeUndefined();
    expect(rig.names()).not.toContain('activate_version_for_job');
  });

  it('a transient provider error throws RetryJobError(provider_transient)', async () => {
    const rig = makeRig(SHORT);
    rig.embed.mockRejectedValueOnce(new ProviderError('transient', 'embedding request failed'));
    const err = await run(rig).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryJobError);
    expect((err as RetryJobError).code).toBe('provider_transient');
    expect(failedWith(rig)).toBeUndefined();
  });

  it('a failure after some batches leaves written chunks, never activates, and settles the cost so far', async () => {
    const rig = makeRig(longText());
    rig.ctx = { ...rig.ctx, config: makeConfig({ embeddingBatchSize: 2 }) };
    rig.embed
      .mockImplementationOnce((texts: readonly string[]) =>
        Promise.resolve({ vectors: texts.map(vector), inputTokens: 5 }),
      )
      .mockRejectedValueOnce(new ProviderError('transient', 'embedding request failed'));
    await expect(run(rig)).rejects.toBeInstanceOf(RetryJobError);
    expect(rig.of('write_document_chunks')).toHaveLength(1);
    expect(rig.names()).not.toContain('activate_version_for_job');
    // One batch (2 chunks, 5 tokens reported) was paid for, and the second request failed after it
    // was sent (transient), so its estimate counts too. 0.2 USD per million tokens.
    const second = estimateOfChunks(longText(), 2, 4);
    expectPartialSpendSettled(rig, ((5 + second) * 0.2) / 1_000_000);
  });

  it.each([
    ['network', new DbError('network')],
    ['timeout', new DbError('timeout')],
    ['http 503', new DbError('http', 503)],
  ])(
    'a database %s error (after a batch was embedded) becomes RetryJobError(db_unavailable) and settles the partial spend',
    async (_n, dbErr) => {
      const rig = makeRig(SHORT);
      rig.responders['write_document_chunks'] = () => {
        throw dbErr;
      };
      const err = await run(rig).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RetryJobError);
      expect((err as RetryJobError).code).toBe('db_unavailable');
      expectPartialSpendSettled(rig);
    },
  );

  it('a storage network error becomes RetryJobError(storage_unavailable)', async () => {
    const rig = makeRig(SHORT, {}, { error: new StorageError('network') });
    const err = await run(rig).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryJobError);
    expect((err as RetryJobError).code).toBe('storage_unavailable');
    expect(failedWith(rig)).toBeUndefined();
  });

  it('an unexpected error is rethrown (the runtime retries it) after the partial spend is settled', async () => {
    const rig = makeRig(SHORT);
    rig.responders['record_usage_event'] = () => {
      throw new TypeError('boom');
    };
    await expect(run(rig)).rejects.toBeInstanceOf(TypeError);
    expectPartialSpendSettled(rig);
    expect(failedWith(rig)).toBeUndefined();
  });

  it('a failing release never masks the original failure', async () => {
    const rig = makeRig(SHORT);
    rig.responders['release_index_budget'] = () => {
      throw new DbError('network');
    };
    rig.embed.mockRejectedValueOnce(new ProviderError('transient', 'embedding request failed'));
    await expect(run(rig)).rejects.toBeInstanceOf(RetryJobError);
  });

  it('an RB003 on settle is tolerated and activation still happens', async () => {
    const rig = makeRig(SHORT);
    rig.responders['settle_index_budget'] = () => {
      throw new DbError('http', 400, 'RB003');
    };
    await run(rig);
    expect(rig.names()).toContain('activate_version_for_job');
  });
});

describe('index_document: lease loss and aborts touch nothing', () => {
  it('a refused heartbeat between batches stops with no release, fail, settle or activation', async () => {
    const rig = makeRig(SHORT);
    let beats = 0;
    rig.heartbeat.mockImplementation(() => {
      beats += 1;
      // 1: after the checksum, 2: before the first batch.
      return beats >= 2 ? Promise.reject(new LeaseLostError()) : Promise.resolve();
    });
    await run(rig);
    expect(rig.embed).not.toHaveBeenCalled();
    for (const name of [
      'release_index_budget',
      'fail_document_version',
      'settle_index_budget',
      'activate_version_for_job',
      'write_document_chunks',
    ]) {
      expect(rig.names()).not.toContain(name);
    }
  });

  it('RB013 on write_document_chunks stops without releasing, failing or activating', async () => {
    const rig = makeRig(SHORT);
    rig.responders['write_document_chunks'] = () => {
      throw new DbError('http', 400, 'RB013');
    };
    await run(rig);
    for (const name of [
      'release_index_budget',
      'fail_document_version',
      'settle_index_budget',
      'activate_version_for_job',
    ]) {
      expect(rig.names()).not.toContain(name);
    }
    // The usage of the paid-for batch was recorded before the write that lost the lease.
    expect(rig.names().indexOf('record_usage_event')).toBeLessThan(
      rig.names().indexOf('write_document_chunks'),
    );
  });

  it('RB013 on get_index_job_context stops at once', async () => {
    const rig = makeRig(SHORT);
    rig.responders['get_index_job_context'] = () => {
      throw new DbError('http', 400, 'RB013');
    };
    await run(rig);
    expect(rig.names()).toEqual(['get_index_job_context']);
  });

  it('an aborted signal during the provider call stops without releasing or failing', async () => {
    const rig = makeRig(SHORT);
    rig.embed.mockImplementationOnce(() => {
      rig.controller.abort(new LeaseLostError());
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    await run(rig);
    for (const name of [
      'release_index_budget',
      'fail_document_version',
      'settle_index_budget',
      'activate_version_for_job',
      'write_document_chunks',
    ]) {
      expect(rig.names()).not.toContain(name);
    }
  });

  it('a signal aborted before the first batch never reaches the provider', async () => {
    const rig = makeRig(SHORT);
    rig.heartbeat.mockImplementation(() => {
      rig.controller.abort(new LeaseLostError());
      return Promise.resolve();
    });
    await run(rig);
    expect(rig.embed).not.toHaveBeenCalled();
    expect(rig.names()).not.toContain('fail_document_version');
  });

  it('a lease lost while failing the version stops quietly', async () => {
    const rig = makeRig(SHORT, { byte_size: 1 });
    rig.responders['fail_document_version'] = () => {
      throw new DbError('http', 400, 'RB013');
    };
    await expect(run(rig)).resolves.toBeUndefined();
  });
});

describe('index_document: logging', () => {
  it('logs no document text, chunk text, vectors, keys or paths on success or failure', async () => {
    const ok = makeRig(SHORT);
    await run(ok);
    const bad = makeRig(SHORT, {}, { etag: '"other"' });
    await run(bad);
    const provider = makeRig(SHORT);
    provider.embed.mockRejectedValueOnce(
      new ProviderError('transient', `upstream said ${SENTINEL} with ${FAKE_KEY}`),
    );
    await run(provider).catch(() => undefined);
    const lines = [...ok.logs, ...bad.logs, ...provider.logs].join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines).not.toContain(SENTINEL);
    expect(lines).not.toContain(FAKE_KEY);
    expect(lines).not.toContain(PATH);
    expect(lines).not.toContain('0.1,0.2');
    expect(lines).toContain(VERSION_ID);
  });

  it('logs the resume offset as a number (it is not redacted)', async () => {
    const rig = makeRig(SHORT);
    await run(rig);
    const started = rig.logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find(
        (l) => l['msg'] === 'index_embedding_started' || l['event'] === 'index_embedding_started',
      );
    expect(started).toBeDefined();
    expect(started?.['resume_offset']).toBe(0);
    expect(rig.logs.join('\n')).not.toContain('resumed_from_chunk');
  });
});
