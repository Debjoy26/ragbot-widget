import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ProviderError, VECTOR_DIMENSIONS, type EmbeddingProvider } from '@ragbot/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createIndexDocumentHandler } from '../../../worker/src/jobs/index-document.ts';
import * as chunkModule from '../../../worker/src/lib/chunk.ts';
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
  return { ...actual, chunkDocument: vi.fn(actual.chunkDocument) };
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
    ...over,
  } as unknown as WorkerConfig;
}

interface Call {
  readonly name: string;
  readonly args: Record<string, unknown>;
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
    reserve_job_budget: () => RESERVATION_ID,
    write_document_chunks: (a) => (a['p_chunks'] as unknown[]).length,
    record_usage_event: () => randomUUID(),
    settle_budget_reservation: () => null,
    release_budget_reservation: () => null,
    activate_version_for_job: () => 7,
    fail_document_version: () => null,
  };
  const db: Db = {
    rpc: (name: string, args: Readonly<Record<string, unknown>>) => {
      calls.push({ name, args: { ...args } });
      events.push(`rpc:${name}`);
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

function noEmbedNoWrite(rig: Rig): void {
  expect(rig.embed).not.toHaveBeenCalled();
  expect(rig.of('write_document_chunks')).toHaveLength(0);
  expect(rig.of('reserve_job_budget')).toHaveLength(0);
  expect(rig.of('activate_version_for_job')).toHaveLength(0);
}

const SHORT = utf8(`${SENTINEL} is a short note about opening hours.`);

function longText(): Uint8Array {
  const paragraph = (n: number): string =>
    Array.from({ length: 140 }, (_, i) => `word${String(n)}x${String(i)}`).join(' ');
  return utf8(Array.from({ length: 10 }, (_, n) => `${SENTINEL} ${paragraph(n)}`).join('\n\n'));
}

beforeEach(() => {
  vi.mocked(chunkModule.chunkDocument).mockClear();
});

describe('index_document: success path', () => {
  it('runs the steps in order, reserving before any provider call and settling the actual cost', async () => {
    const rig = makeRig(SHORT);
    await run(rig);

    expect(rig.names()).toEqual([
      'get_index_job_context',
      'update_version_progress',
      'reserve_job_budget',
      'update_version_progress',
      'write_document_chunks',
      'record_usage_event',
      'update_version_progress',
      'settle_budget_reservation',
      'activate_version_for_job',
    ]);
    expect(rig.events.indexOf('rpc:reserve_job_budget')).toBeLessThan(rig.events.indexOf('embed'));
    expect(rig.events.indexOf('storage:download')).toBeLessThan(
      rig.events.indexOf('rpc:reserve_job_budget'),
    );
    expect(rig.names()).not.toContain('release_budget_reservation');
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
    const reserve = rig.of('reserve_job_budget')[0]?.args;
    expect(reserve?.['p_amount']).toBeGreaterThan(0);
    expect(reserve).toMatchObject({ p_bot_id: BOT_ID, p_job_id: JOB_ID });
    const settle = rig.of('settle_budget_reservation')[0]?.args;
    expect(settle).toMatchObject({ p_bot_id: BOT_ID, p_reservation_id: RESERVATION_ID });
    expect(settle?.['p_actual_amount']).toBe(usage?.['p_estimated_cost']);
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
    expect(rig.of('settle_budget_reservation')[0]?.args['p_actual_amount']).toBeCloseTo(total, 10);
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

  it('stops quietly when the document is deleted during the job (RB010 on write) and releases the reservation', async () => {
    const rig = makeRig(SHORT);
    rig.responders['write_document_chunks'] = () => {
      throw new DbError('http', 400, 'RB010');
    };
    await run(rig);
    expect(failedWith(rig)).toBeUndefined();
    expect(rig.names()).toContain('release_budget_reservation');
    expect(rig.names()).not.toContain('activate_version_for_job');
  });

  it('stops quietly when the version is no longer in embedding (RB030 on write)', async () => {
    const rig = makeRig(SHORT);
    rig.responders['write_document_chunks'] = () => {
      throw new DbError('http', 400, 'RB030');
    };
    await run(rig);
    expect(failedWith(rig)).toBeUndefined();
    expect(rig.names()).toContain('release_budget_reservation');
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

  it('passes max_bytes from the context to storage', async () => {
    const rig = makeRig(SHORT, { max_bytes: 4321 });
    const download = vi.spyOn(rig.ctx.storage, 'download');
    await run(rig);
    expect(download).toHaveBeenCalledWith(PATH, 4321, rig.ctx.signal);
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
    vi.mocked(chunkModule.chunkDocument).mockReturnValue({ chunks: [], version: 'c-test' });
    const pdfRig = makeRig(buildPdf({ pages: [['some words that are fine here']] }), {
      media_type: 'application/pdf',
    });
    await run(pdfRig);
    expect(failedWith(pdfRig)).toBe('OCR_REQUIRED');
    noEmbedNoWrite(pdfRig);

    vi.mocked(chunkModule.chunkDocument).mockReturnValue({ chunks: [], version: 'c-test' });
    const textRig = makeRig(SHORT);
    await run(textRig);
    expect(failedWith(textRig)).toBe('FILE_UNSUPPORTED');
    noEmbedNoWrite(textRig);
    vi.mocked(chunkModule.chunkDocument).mockRestore();
  });

  it('the daily cap (RB001) fails BUDGET_EXCEEDED with no provider call, no write, nothing to release', async () => {
    const rig = makeRig(SHORT);
    rig.responders['reserve_job_budget'] = () => {
      throw new DbError('http', 400, 'RB001');
    };
    await run(rig);
    expect(failedWith(rig)).toBe('BUDGET_EXCEEDED');
    expect(rig.embed).not.toHaveBeenCalled();
    expect(rig.of('write_document_chunks')).toHaveLength(0);
    expect(rig.names()).not.toContain('release_budget_reservation');
    expect(rig.names()).not.toContain('settle_budget_reservation');
    expect(rig.names()).not.toContain('activate_version_for_job');
  });

  it('other reserve failures are not file failures: they propagate for a retry', async () => {
    const rig = makeRig(SHORT);
    rig.responders['reserve_job_budget'] = () => {
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
    expect(rig.names()).toContain('release_budget_reservation');
    expect(rig.names()).not.toContain('settle_budget_reservation');
    expect(rig.names()).not.toContain('activate_version_for_job');
  });

  it('a wrong-length vector from the provider fails INDEXING_FAILED and nothing is written', async () => {
    const rig = makeRig(SHORT);
    rig.embed.mockResolvedValueOnce({ vectors: [[0.1, 0.2, 0.3]], inputTokens: 5 });
    await run(rig);
    expect(failedWith(rig)).toBe('INDEXING_FAILED');
    expect(rig.of('write_document_chunks')).toHaveLength(0);
    expect(rig.names()).toContain('release_budget_reservation');
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
    expect(rig.names()).toContain('settle_budget_reservation');
    expect(rig.names()).not.toContain('release_budget_reservation');
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
    expect(rig.of('settle_budget_reservation')).toHaveLength(1);
    expect(rig.of('release_budget_reservation')).toHaveLength(0);
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
    expect(rig.of('release_budget_reservation')).toHaveLength(1);
    expect(rig.of('release_budget_reservation')[0]?.args).toEqual({
      p_bot_id: BOT_ID,
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

  it('a failure after some batches leaves written chunks, never activates, and releases the reservation', async () => {
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
    expect(rig.names()).not.toContain('settle_budget_reservation');
    expect(rig.of('release_budget_reservation')).toHaveLength(1);
  });

  it.each([
    ['network', new DbError('network')],
    ['timeout', new DbError('timeout')],
    ['http 503', new DbError('http', 503)],
  ])(
    'a database %s error becomes RetryJobError(db_unavailable) and releases the reservation',
    async (_n, dbErr) => {
      const rig = makeRig(SHORT);
      rig.responders['write_document_chunks'] = () => {
        throw dbErr;
      };
      const err = await run(rig).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RetryJobError);
      expect((err as RetryJobError).code).toBe('db_unavailable');
      expect(rig.names()).toContain('release_budget_reservation');
    },
  );

  it('a storage network error becomes RetryJobError(storage_unavailable)', async () => {
    const rig = makeRig(SHORT, {}, { error: new StorageError('network') });
    const err = await run(rig).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryJobError);
    expect((err as RetryJobError).code).toBe('storage_unavailable');
    expect(failedWith(rig)).toBeUndefined();
  });

  it('an unexpected error is rethrown (the runtime retries it) after the reservation is released', async () => {
    const rig = makeRig(SHORT);
    rig.responders['record_usage_event'] = () => {
      throw new TypeError('boom');
    };
    await expect(run(rig)).rejects.toBeInstanceOf(TypeError);
    expect(rig.names()).toContain('release_budget_reservation');
    expect(failedWith(rig)).toBeUndefined();
  });

  it('a failing release never masks the original failure', async () => {
    const rig = makeRig(SHORT);
    rig.responders['release_budget_reservation'] = () => {
      throw new DbError('network');
    };
    rig.embed.mockRejectedValueOnce(new ProviderError('transient', 'embedding request failed'));
    await expect(run(rig)).rejects.toBeInstanceOf(RetryJobError);
  });

  it('an RB003 on settle is tolerated and activation still happens', async () => {
    const rig = makeRig(SHORT);
    rig.responders['settle_budget_reservation'] = () => {
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
      'release_budget_reservation',
      'fail_document_version',
      'settle_budget_reservation',
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
      'release_budget_reservation',
      'fail_document_version',
      'settle_budget_reservation',
      'activate_version_for_job',
      'record_usage_event',
    ]) {
      expect(rig.names()).not.toContain(name);
    }
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
      'release_budget_reservation',
      'fail_document_version',
      'settle_budget_reservation',
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
});
