// `index_document` job handler (P6-INDEX): download, verify, extract, chunk, embed, activate.
//
// State machine (frozen contract on the P6 board):
//  * Permanent failure (bad file, scanned PDF, size/type/eTag mismatch, cap reached, superseded,
//    embedding model mismatch): fail the version with a failure code, then RETURN. The runtime
//    completes the job (the job did its work).
//  * Transient failure (provider 429/5xx, network, timeout, database unavailable): throw
//    RetryJobError. The runtime calls retry_job_later; after max_attempts the database dead-letters
//    the job and fails the version with INDEXING_FAILED.
//  * Lease lost (RB013) or an aborted signal (lease loss or shutdown): stop at once and touch
//    nothing. In particular the budget reservation is left to its TTL: the next attempt reserves anew
//    and the database expires (but keeps counting) the old one.
//  * Document deleted mid-job (RB010) or version no longer indexable (RB030): nothing to do.
//
// Retries resume: get_index_job_context reports `written_chunks`, the count of this version's chunks
// already written, and the chunking version, extraction version and embedding model they were made
// with. Batches are written in order from chunk 0 and extraction/chunking are deterministic, so a
// retried attempt skips chunk indexes below `written_chunks` (no embedding, no write, no usage row)
// and continues from the first unwritten chunk. If any stored version or the embedding model differs
// from the current one, or the chunking now yields fewer chunks than were written, the old chunks are
// not trustworthy: reset_version_chunks deletes them and the attempt starts again from chunk 0.
//
// Budget (TECH_SPECS section 8): every attempt calls reserve_index_budget before any provider call,
// for the chunks still to embed (re-estimated each time; the database expires the job's earlier
// reservation but keeps counting it). The estimate counts UTF-8 bytes (see ESTIMATE_BYTES_PER_TOKEN).
// Each batch's cost (provider token counts when given, else the estimate) is added up and its usage
// row is recorded right after the provider answered, before the chunks are written. When the total
// passes BUDGET_OVERRUN_FACTOR times the reservation the job stops: the spend is settled and the
// version fails BUDGET_EXCEEDED. Otherwise the reservation is settled with the actual cost once all
// batches are written; on any other failure that is not a lost lease it is settled with the cost
// spent so far when at least one batch was embedded, and released only when nothing was spent. Only
// reserve_index_budget, settle_index_budget and release_index_budget are used.
//
// Logging: ids, counts, durations and codes only. Never document text, chunks, vectors or keys.
import { createHash } from 'node:crypto';
import {
  assertEmbeddingShape,
  FAILURE_CODES,
  indexDocumentPayloadSchema,
  isRetryableErrorKind,
  ProviderError,
  type EmbeddingProvider,
  type FailureCode,
} from '@ragbot/shared';
import { ChunkLimitError, chunkDocumentAsync, type Chunk } from '../lib/chunk.js';
import { DbError } from '../lib/db.js';
import { assertVectorBounds } from '../lib/embeddings.js';
import { ExtractError, ExtractSpawnError, extractText } from '../lib/extract.js';
import { errorCode } from '../lib/logger.js';
import { declaredMatchesSniffed, sniffMediaType, type KnowledgeMediaType } from '../lib/sniff.js';
import { normalizeEtag, StorageError } from '../lib/storage.js';
import { LeaseLostError, RetryJobError, type JobHandler } from '../runtime.js';

/** Reservation lifetime. A settled or released reservation ignores it; a stale one is swept. */
export const RESERVATION_TTL_SECONDS = 3600;
/** reserve_index_budget accepts any amount above zero. */
const MIN_RESERVATION_USD = 0.000001;
/**
 * Budget estimates assume at least this many UTF-8 BYTES per token, i.e. at most one token per 3
 * bytes. That is deliberately pessimistic for English (about 4 characters per token) and about
 * right for CJK (3 bytes, roughly one token per character); counting bytes rather than characters
 * keeps non-Latin text from being underestimated. Estimates round up.
 */
export const ESTIMATE_BYTES_PER_TOKEN = 3;
/** Stop (and fail the version BUDGET_EXCEEDED) when the actual cost passes this times the reservation. */
export const BUDGET_OVERRUN_FACTOR = 1.5;

/** Conservative token estimate for budgeting: UTF-8 bytes divided by ESTIMATE_BYTES_PER_TOKEN, rounded up. */
export function estimateBudgetTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / ESTIMATE_BYTES_PER_TOKEN);
}

export interface IndexDocumentDeps {
  readonly embeddings: EmbeddingProvider;
}

interface IndexContext {
  readonly botId: string;
  readonly documentId: string;
  readonly versionNumber: number;
  readonly status: string;
  readonly storagePath: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly uploadEtag: string | null;
  readonly embeddingModel: string | null;
  readonly maxBytes: number;
  readonly maxPages: number;
  /** What the version row says its existing chunks were made with (null before the first batch). */
  readonly storedChunkingVersion: string | null;
  readonly storedExtractionVersion: string | null;
  readonly storedEmbeddingModel: string | null;
  readonly activeVersionNumber: number | null;
  /** Count of this version's chunks already written (resumption point). */
  readonly writtenChunks: number;
}

/** A permanent outcome for the version. `reason` is a log-safe token. */
class PermanentFailure extends Error {
  readonly failureCode: FailureCode;
  readonly reason: string;
  constructor(failureCode: FailureCode, reason: string) {
    super(`index failed (${failureCode}: ${reason})`);
    this.name = 'PermanentFailure';
    this.failureCode = failureCode;
    this.reason = reason;
  }
}

/** Nothing (more) to do: complete the job without changing any state. */
class Stop extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`index stopped (${reason})`);
    this.name = 'Stop';
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toInt(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : null;
}

function str(row: Record<string, unknown>, name: string): string {
  const v = row[name];
  if (typeof v !== 'string' || v === '') throw new Error('invalid index job context');
  return v;
}

function nullableStr(row: Record<string, unknown>, name: string): string | null {
  const v = row[name];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new Error('invalid index job context');
  return v;
}

function int(row: Record<string, unknown>, name: string): number {
  const n = toInt(row[name]);
  if (n === null) throw new Error('invalid index job context');
  return n;
}

function nonNegativeInt(row: Record<string, unknown>, name: string): number {
  const n = int(row, name);
  if (n < 0) throw new Error('invalid index job context');
  return n;
}

function parseContext(raw: unknown): IndexContext {
  const row: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (!isRecord(row)) throw new Error('invalid index job context');
  const active = row['active_version_number'];
  return {
    botId: str(row, 'bot_id'),
    documentId: str(row, 'document_id'),
    versionNumber: int(row, 'version_number'),
    status: str(row, 'status'),
    storagePath: str(row, 'storage_path'),
    mediaType: str(row, 'media_type'),
    byteSize: int(row, 'byte_size'),
    uploadEtag: nullableStr(row, 'upload_etag'),
    embeddingModel: nullableStr(row, 'embedding_model'),
    maxBytes: int(row, 'max_bytes'),
    maxPages: int(row, 'max_pages'),
    storedChunkingVersion: nullableStr(row, 'stored_chunking_version'),
    storedExtractionVersion: nullableStr(row, 'stored_extraction_version'),
    storedEmbeddingModel: nullableStr(row, 'stored_embedding_model'),
    activeVersionNumber:
      active === null || active === undefined ? null : int(row, 'active_version_number'),
    writtenChunks: nonNegativeInt(row, 'written_chunks'),
  };
}

function isKnowledgeMediaType(value: string): value is KnowledgeMediaType {
  return value === 'application/pdf' || value === 'text/markdown' || value === 'text/plain';
}

function dbCode(err: unknown): string | undefined {
  return err instanceof DbError ? err.sqlstate : undefined;
}

/** Rounds up to 8 decimals so a reservation never undershoots its estimate. */
function usd(tokens: number, pricePerMillion: number): number {
  // tokens * price / 1e6 dollars, in units of 1e-8; the small offset absorbs float noise.
  return Math.ceil(tokens * pricePerMillion * 100 - 1e-6) / 100_000_000;
}

export function createIndexDocumentHandler(deps: IndexDocumentDeps): JobHandler {
  const { embeddings } = deps;

  return async (job, ctx) => {
    const payload = indexDocumentPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      // Nothing identifies a version, so nothing can be failed. Completing avoids a retry loop.
      ctx.log.error('index_payload_invalid');
      return;
    }
    const versionId = payload.data.version_id;
    const { signal, config } = ctx;
    const log = ctx.log.child({ document_id: payload.data.document_id, version_id: versionId });

    const call = <T>(name: string, args: Record<string, unknown>, idempotent = false): Promise<T> =>
      ctx.db.rpc<T>(
        name,
        { p_job_id: job.id, p_worker: ctx.workerId, p_version_id: versionId, ...args },
        signal,
        idempotent ? { retryOnContention: true } : undefined,
      );

    const fetchContext = async (): Promise<IndexContext> =>
      parseContext(await call<unknown>('get_index_job_context', {}));

    const progress = (patch: Record<string, unknown>): Promise<unknown> =>
      call('update_version_progress', { p_patch: patch }, true);

    let reservationId: string | null = null;
    // Amount reserved by THIS attempt, and the cost of the batches it has embedded so far (counted
    // as soon as the provider answered).
    let reservedAmount = 0;
    let actualCost = 0;

    // Fenced budget calls take exactly the job, the worker and the reservation.
    const budgetCall = (name: string, args: Record<string, unknown>): Promise<unknown> =>
      ctx.db.rpc<unknown>(name, { p_job_id: job.id, p_worker: ctx.workerId, ...args });

    async function release(): Promise<void> {
      if (reservationId === null) return;
      const id = reservationId;
      reservationId = null;
      try {
        await budgetCall('release_index_budget', { p_reservation_id: id });
      } catch (err) {
        // Left to the stale-reservation sweeper; never masks the original failure.
        log.warn('index_release_failed', { code: errorCode(err) });
      }
    }

    // After a failure: pay for what was spent. Settles with the cost so far when a batch was
    // embedded, releases when nothing was spent. Never masks the original failure.
    async function settleOrRelease(): Promise<void> {
      if (reservationId === null) return;
      if (!(actualCost > 0)) {
        await release();
        return;
      }
      const id = reservationId;
      reservationId = null;
      try {
        await budgetCall('settle_index_budget', { p_reservation_id: id, p_actual: actualCost });
        log.info('index_partial_spend_settled');
      } catch (err) {
        // RB003: already settled or released elsewhere. Anything else is left to the sweeper.
        log.warn('index_settle_failed', { code: errorCode(err) });
      }
    }

    async function failVersion(code: FailureCode, reason: string): Promise<void> {
      if (!(FAILURE_CODES as readonly string[]).includes(code)) {
        throw new Error('unknown failure code');
      }
      try {
        await call('fail_document_version', { p_failure_code: code }, true);
        log.warn('index_version_failed', { failure_code: code, reason });
      } catch (err) {
        const sqlstate = dbCode(err);
        if (err instanceof LeaseLostError || sqlstate === 'RB013' || signal.aborted) {
          log.warn('index_stopped', { reason: 'lease_lost' });
          return;
        }
        // The version is already terminal or the document is gone: nothing left to record.
        if (sqlstate === 'RB030' || sqlstate === 'RB010') {
          log.info('index_fail_skipped', { code: sqlstate });
          return;
        }
        throw err;
      }
    }

    async function run(): Promise<void> {
      // 1. Context.
      const row = await fetchContext();
      if (row.status === 'ready' || row.status === 'superseded' || row.status === 'failed') {
        throw new Stop(`version_${row.status}`);
      }
      if (row.status !== 'uploaded' && row.status !== 'extracting' && row.status !== 'embedding') {
        throw new Stop('version_not_indexable');
      }

      // 2. An older version never replaces a newer active one.
      if (row.activeVersionNumber !== null && row.versionNumber < row.activeVersionNumber) {
        throw new PermanentFailure('SUPERSEDED', 'older_than_active');
      }
      // The bot's model must be the one this worker embeds with; activation would refuse it later.
      if (row.embeddingModel !== embeddings.model) {
        throw new PermanentFailure('INDEXING_FAILED', 'embedding_model_mismatch');
      }

      // 3. Download and verify.
      if (!isKnowledgeMediaType(row.mediaType)) {
        throw new PermanentFailure('FILE_UNSUPPORTED', 'media_type_not_allowed');
      }
      const mediaType: KnowledgeMediaType = row.mediaType;
      // The registered upload is the only object this version may index: no registered eTag, no
      // download. The cap is the smallest of the registered size, the bot's policy and the
      // worker's own hard limit; the eTag is checked on the response headers before the body.
      if (row.uploadEtag === null) throw new PermanentFailure('FILE_UNSUPPORTED', 'etag_mismatch');
      const maxDownload = config.maxDownloadBytes;
      if (!Number.isSafeInteger(maxDownload) || maxDownload < 1) {
        throw new Error('invalid worker download limit');
      }
      const downloadCap = Math.min(row.byteSize, row.maxBytes, maxDownload);
      if (downloadCap < 1) throw new PermanentFailure('FILE_UNSUPPORTED', 'size_mismatch');
      let downloaded;
      try {
        downloaded = await ctx.storage.download(row.storagePath, downloadCap, signal, {
          expectedEtag: row.uploadEtag,
        });
      } catch (err) {
        if (err instanceof StorageError) {
          if (err.reason === 'too_large')
            throw new PermanentFailure('FILE_UNSUPPORTED', 'too_large');
          if (err.reason === 'etag_mismatch') {
            throw new PermanentFailure('FILE_UNSUPPORTED', 'etag_mismatch');
          }
          if (err.reason === 'http' && err.status === 404) {
            throw new PermanentFailure('FILE_UNSUPPORTED', 'object_missing');
          }
        }
        throw err;
      }
      // Defence in depth: the storage client checked already; a fake or a new client must not slip through.
      if (
        downloaded.etag === null ||
        normalizeEtag(downloaded.etag) !== normalizeEtag(row.uploadEtag)
      ) {
        throw new PermanentFailure('FILE_UNSUPPORTED', 'etag_mismatch');
      }
      const { bytes } = downloaded;
      if (bytes.length !== row.byteSize) {
        throw new PermanentFailure('FILE_UNSUPPORTED', 'size_mismatch');
      }
      if (!declaredMatchesSniffed(row.mediaType, sniffMediaType(bytes))) {
        throw new PermanentFailure('FILE_UNSUPPORTED', 'type_mismatch');
      }
      const checksum = createHash('sha256').update(bytes).digest('hex');

      // 4. Progress: extracting (never backward: a retry may already be at embedding).
      const startedStatus = row.status;
      await progress({
        ...(startedStatus === 'uploaded' ? { status: 'extracting' } : {}),
        checksum,
      });
      await ctx.heartbeat();

      // 5. Extract.
      let extracted;
      try {
        extracted = await extractText(
          bytes,
          mediaType,
          {
            timeoutMs: config.extraction.timeoutMs,
            maxMemoryMb: config.extraction.childMemoryMb,
            maxPages: row.maxPages,
            maxChars: config.extraction.maxExtractedChars,
          },
          { signal },
        );
      } catch (err) {
        if (err instanceof ExtractError) throw new PermanentFailure(err.code, err.reason);
        throw err;
      }

      await ctx.heartbeat();

      // 6. Chunk (yields to the event loop so heartbeats run; stops at the chunk cap).
      let chunked;
      try {
        chunked = await chunkDocumentAsync(extracted.pages, mediaType, {
          maxChunks: config.maxChunksPerVersion,
          signal,
        });
      } catch (err) {
        if (err instanceof ChunkLimitError) {
          throw new PermanentFailure('FILE_UNSUPPORTED', 'too_many_chunks');
        }
        throw err;
      }
      const chunks: readonly Chunk[] = chunked.chunks;
      if (chunks.length === 0) {
        throw new PermanentFailure(
          mediaType === 'application/pdf' ? 'OCR_REQUIRED' : 'FILE_UNSUPPORTED',
          'no_chunks',
        );
      }

      // 7. Resume point. Written chunks are only trusted when everything that shaped them is
      // unchanged and the chunking still yields at least that many; otherwise delete them and
      // start again from chunk 0.
      const batchSize = config.embeddingBatchSize;
      const price = config.embeddingPricePerMillionTokens;
      let start = row.writtenChunks;
      if (row.writtenChunks > 0) {
        const versionsDiffer =
          row.storedChunkingVersion !== chunked.version ||
          row.storedExtractionVersion !== extracted.version ||
          row.storedEmbeddingModel !== embeddings.model;
        const fewer = chunks.length < row.writtenChunks;
        if (versionsDiffer || fewer) {
          const deleted = await call<unknown>('reset_version_chunks', {}, true);
          log.warn('index_chunks_reset', {
            reason: versionsDiffer ? 'version_changed' : 'fewer_chunks',
            deleted_count: typeof deleted === 'number' ? deleted : null,
          });
          start = 0;
        }
      }
      const batchesBefore = Math.ceil(start / batchSize);
      const remaining = chunks.slice(start);

      // Estimate the chunks still to embed and reserve, before any provider call.
      const estimatedTokens = remaining.reduce(
        (sum, c) => sum + estimateBudgetTokens(c.content),
        0,
      );
      if (remaining.length > 0) {
        reservedAmount = Math.max(MIN_RESERVATION_USD, usd(estimatedTokens, price));
        try {
          const reserved = await call<unknown>('reserve_index_budget', {
            p_amount: reservedAmount,
            p_ttl_seconds: RESERVATION_TTL_SECONDS,
          });
          if (typeof reserved !== 'string' || reserved === '')
            throw new Error('invalid reservation');
          reservationId = reserved;
        } catch (err) {
          if (dbCode(err) === 'RB001') throw new PermanentFailure('BUDGET_EXCEEDED', 'daily_cap');
          // A disabled bot spends nothing; retry later (the database dead-letters after max attempts).
          if (dbCode(err) === 'RB039') throw new RetryJobError('bot_disabled');
          throw err;
        }
      }

      // 8. Embed in batches; each batch is written, its usage recorded, then counted.
      const batchesTotal = batchesBefore + Math.ceil(remaining.length / batchSize);
      await progress({
        ...(startedStatus === 'embedding' ? {} : { status: 'embedding' }),
        batches_total: batchesTotal,
        batches_done: batchesBefore,
        extraction_method: extracted.method,
        extraction_version: extracted.version,
        chunking_version: chunked.version,
        embedding_model: embeddings.model,
      });
      log.info('index_embedding_started', {
        chunk_count: chunks.length,
        batches_total: batchesTotal,
        resume_offset: start,
        estimated_token_total: estimatedTokens,
      });

      for (let b = batchesBefore; b < batchesTotal; b += 1) {
        if (signal.aborted) throw new LeaseLostError();
        await ctx.heartbeat();
        const from = start + (b - batchesBefore) * batchSize;
        const slice = chunks.slice(from, from + batchSize);
        const started = Date.now();
        const result = await embeddings.embed(
          slice.map((c) => c.content),
          { taskType: 'document', signal },
        );
        const latencyMs = Date.now() - started;
        // Provider token counts when given, else the conservative estimate.
        const reported = result.inputTokens;
        const tokens =
          typeof reported === 'number' && Number.isSafeInteger(reported) && reported > 0
            ? reported
            : slice.reduce((sum, c) => sum + estimateBudgetTokens(c.content), 0);
        const cost = usd(tokens, price);
        // The provider has been paid for this batch whatever happens next: count it and record the
        // usage now, before anything is validated or written.
        actualCost += cost;
        await ctx.db.rpc<unknown>(
          'record_usage_event',
          {
            p_bot_id: row.botId,
            p_job_id: job.id,
            p_provider: embeddings.provider,
            p_model: embeddings.model,
            p_operation: 'embedding_index',
            p_input_tokens: tokens,
            p_estimated_cost: cost,
            p_latency_ms: latencyMs,
          },
          signal,
        );
        // Spent far more than reserved: stop here. The spend is settled by the failure path.
        if (actualCost > reservedAmount * BUDGET_OVERRUN_FACTOR) {
          throw new PermanentFailure('BUDGET_EXCEEDED', 'overrun');
        }
        // Defence in depth: the adapter validates too, but a fake or a new adapter must not slip through.
        assertEmbeddingShape(result.vectors, slice.length);
        assertVectorBounds(result.vectors);

        await call(
          'write_document_chunks',
          {
            p_chunks: slice.map((c, i) => ({
              chunk_index: c.chunk_index,
              content: c.content,
              token_count: c.token_count,
              page_number: c.page_number,
              section: c.section,
              metadata: {},
              embedding: result.vectors[i],
            })),
          },
          true,
        );
        await progress({ batches_done: b + 1 });
      }

      // 9. Settle with the actual cost.
      if (reservationId !== null) {
        const id = reservationId;
        try {
          await budgetCall('settle_index_budget', { p_reservation_id: id, p_actual: actualCost });
          reservationId = null;
        } catch (err) {
          if (dbCode(err) !== 'RB003') throw err;
          // Already settled or released by someone else: the money is accounted for elsewhere.
          log.warn('index_settle_skipped', { code: 'RB003' });
          reservationId = null;
        }
      }

      // 10. Activate.
      try {
        const corpusVersion = await call<unknown>('activate_version_for_job', {
          p_expected_chunks: chunks.length,
        });
        log.info('index_activated', {
          chunk_count: chunks.length,
          corpus_version: typeof corpusVersion === 'number' ? corpusVersion : null,
        });
      } catch (err) {
        if (dbCode(err) !== 'RB011') throw err;
        // Older than the active version, or the bot's embedding model changed under us.
        const now = await fetchContext();
        if (now.status !== 'embedding') throw new Stop(`version_${now.status}`);
        const older =
          now.activeVersionNumber !== null && now.versionNumber < now.activeVersionNumber;
        throw new PermanentFailure(older ? 'SUPERSEDED' : 'INDEXING_FAILED', 'activation_refused');
      }
    }

    try {
      await run();
    } catch (err) {
      // A lost lease or an abort: stop and touch nothing, not even the reservation.
      if (err instanceof LeaseLostError || dbCode(err) === 'RB013' || signal.aborted) {
        log.warn('index_stopped', { reason: 'lease_lost_or_aborted' });
        return;
      }
      await settleOrRelease();

      if (err instanceof Stop) {
        log.info('index_nothing_to_do', { reason: err.reason });
        return;
      }
      const sqlstate = dbCode(err);
      if (sqlstate === 'RB010') {
        log.info('index_document_deleted');
        return;
      }
      if (sqlstate === 'RB030') {
        log.warn('index_version_not_indexable', { code: 'RB030' });
        return;
      }
      if (err instanceof PermanentFailure) {
        await failVersion(err.failureCode, err.reason);
        return;
      }
      if (err instanceof RetryJobError) {
        log.warn('index_retry_requested', { code: err.code });
        throw err;
      }
      if (err instanceof ProviderError) {
        if (isRetryableErrorKind(err.kind)) {
          log.warn('index_provider_retryable', { kind: err.kind });
          throw new RetryJobError(
            `provider_${err.kind}`,
            err.retryAfterSeconds === null ? {} : { retryAfterSeconds: err.retryAfterSeconds },
          );
        }
        await failVersion('INDEXING_FAILED', `provider_${err.kind}`);
        return;
      }
      if (err instanceof ExtractSpawnError) {
        log.warn('index_extractor_unavailable', { code: err.code });
        throw new RetryJobError('extractor_unavailable');
      }
      if (err instanceof StorageError) {
        log.warn('index_storage_retryable', { reason: err.reason });
        throw new RetryJobError('storage_unavailable');
      }
      if (err instanceof DbError && (err.reason !== 'http' || (err.status ?? 500) >= 500)) {
        log.warn('index_db_retryable', { reason: err.reason });
        throw new RetryJobError('db_unavailable');
      }
      // Unknown: log the class only (a message can carry content); the runtime retries.
      log.error('index_unexpected_error', { code: errorCode(err) });
      throw err;
    }
  };
}
