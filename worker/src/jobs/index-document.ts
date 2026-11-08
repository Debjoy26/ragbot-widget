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
//    nothing. In particular the budget reservation is left to its TTL: a later attempt reuses it.
//  * Document deleted mid-job (RB010) or version no longer indexable (RB030): nothing to do.
//
// The retry model is "start over with idempotent writes": chunk upserts are keyed on
// (version, chunk_index) and extraction/chunking are deterministic, so a retried attempt writes
// the same rows. Migration 012 offers the worker no read of the chunks already written, so a retry
// re-embeds from the first batch (see the report).
//
// Budget (TECH_SPECS section 8): `reserve_job_budget` runs before any provider call. The
// reservation is settled with the actual cost once all batches are written, and released on every
// failure path that is not a lost lease.
//
// Logging: ids, counts, durations and codes only. Never document text, chunks, vectors or keys.
import { createHash } from 'node:crypto';
import {
  assertEmbeddingShape,
  indexDocumentPayloadSchema,
  isRetryableErrorKind,
  ProviderError,
  type EmbeddingProvider,
} from '@ragbot/shared';
import { chunkDocument, type Chunk } from '../lib/chunk.js';
import { DbError } from '../lib/db.js';
import { ExtractError, extractText } from '../lib/extract.js';
import { errorCode } from '../lib/logger.js';
import { declaredMatchesSniffed, sniffMediaType, type KnowledgeMediaType } from '../lib/sniff.js';
import { normalizeEtag, StorageError } from '../lib/storage.js';
import { LeaseLostError, RetryJobError, type JobHandler } from '../runtime.js';

export type FailureCode =
  'FILE_UNSUPPORTED' | 'OCR_REQUIRED' | 'INDEXING_FAILED' | 'BUDGET_EXCEEDED' | 'SUPERSEDED';

/** Reservation lifetime. A settled or released reservation ignores it; a stale one is swept. */
export const RESERVATION_TTL_SECONDS = 3600;
/** Smallest amount reserve_job_budget accepts is anything above zero. */
const MIN_RESERVATION_USD = 0.000001;

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
  readonly activeVersionNumber: number | null;
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
    activeVersionNumber:
      active === null || active === undefined ? null : int(row, 'active_version_number'),
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
    let botId: string | null = null;

    async function release(): Promise<void> {
      if (reservationId === null || botId === null) return;
      const id = reservationId;
      reservationId = null;
      try {
        await ctx.db.rpc<unknown>('release_budget_reservation', {
          p_bot_id: botId,
          p_reservation_id: id,
        });
      } catch (err) {
        // Left to the stale-reservation sweeper; never masks the original failure.
        log.warn('index_release_failed', { code: errorCode(err) });
      }
    }

    async function failVersion(code: FailureCode, reason: string): Promise<void> {
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
      botId = row.botId;
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
      let downloaded;
      try {
        downloaded = await ctx.storage.download(row.storagePath, row.maxBytes, signal);
      } catch (err) {
        if (err instanceof StorageError) {
          if (err.reason === 'too_large')
            throw new PermanentFailure('FILE_UNSUPPORTED', 'too_large');
          if (err.reason === 'http' && err.status === 404) {
            throw new PermanentFailure('FILE_UNSUPPORTED', 'object_missing');
          }
        }
        throw err;
      }
      if (
        downloaded.etag === null ||
        row.uploadEtag === null ||
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
          },
          { signal },
        );
      } catch (err) {
        if (err instanceof ExtractError) throw new PermanentFailure(err.code, err.reason);
        throw err;
      }

      // 6. Chunk.
      const chunked = chunkDocument(extracted.pages, mediaType);
      const chunks: readonly Chunk[] = chunked.chunks;
      if (chunks.length === 0) {
        throw new PermanentFailure(
          mediaType === 'application/pdf' ? 'OCR_REQUIRED' : 'FILE_UNSUPPORTED',
          'no_chunks',
        );
      }

      // 7. Estimate and reserve, before any provider call.
      const batchSize = config.embeddingBatchSize;
      const price = config.embeddingPricePerMillionTokens;
      const estimatedTokens = chunks.reduce((sum, c) => sum + c.token_count, 0);
      const estimatedCost = Math.max(MIN_RESERVATION_USD, usd(estimatedTokens, price));
      try {
        reservationId = await ctx.db.rpc<string>(
          'reserve_job_budget',
          {
            p_bot_id: row.botId,
            p_job_id: job.id,
            p_amount: estimatedCost,
            p_ttl_seconds: RESERVATION_TTL_SECONDS,
          },
          signal,
        );
      } catch (err) {
        if (dbCode(err) === 'RB001') throw new PermanentFailure('BUDGET_EXCEEDED', 'daily_cap');
        throw err;
      }
      if (typeof reservationId !== 'string' || reservationId === '') {
        reservationId = null;
        throw new Error('invalid reservation');
      }

      // 8. Embed in batches; each batch is written, its usage recorded, then counted.
      const batchesTotal = Math.ceil(chunks.length / batchSize);
      await progress({
        ...(startedStatus === 'embedding' ? {} : { status: 'embedding' }),
        batches_total: batchesTotal,
        batches_done: 0,
        extraction_method: extracted.method,
        extraction_version: extracted.version,
        chunking_version: chunked.version,
        embedding_model: embeddings.model,
      });
      log.info('index_embedding_started', {
        chunk_count: chunks.length,
        batches_total: batchesTotal,
        estimated_token_total: estimatedTokens,
      });

      let actualCost = 0;
      for (let b = 0; b < batchesTotal; b += 1) {
        if (signal.aborted) throw new LeaseLostError();
        await ctx.heartbeat();
        const slice = chunks.slice(b * batchSize, (b + 1) * batchSize);
        const started = Date.now();
        const result = await embeddings.embed(
          slice.map((c) => c.content),
          { taskType: 'document', signal },
        );
        const latencyMs = Date.now() - started;
        // Defence in depth: the adapter validates too, but a fake or a new adapter must not slip through.
        assertEmbeddingShape(result.vectors, slice.length);
        const tokens = result.inputTokens ?? slice.reduce((sum, c) => sum + c.token_count, 0);
        const cost = usd(tokens, price);

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
        await progress({ batches_done: b + 1 });
        actualCost += cost;
      }

      // 9. Settle with the actual cost.
      try {
        await ctx.db.rpc<unknown>(
          'settle_budget_reservation',
          { p_bot_id: row.botId, p_reservation_id: reservationId, p_actual_amount: actualCost },
          signal,
        );
        reservationId = null;
      } catch (err) {
        if (dbCode(err) !== 'RB003') throw err;
        // Already settled or released by someone else: the money is accounted for elsewhere.
        log.warn('index_settle_skipped', { code: 'RB003' });
        reservationId = null;
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
      await release();

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
