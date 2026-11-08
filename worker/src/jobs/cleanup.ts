// `cleanup` job handler (P6-INDEX). Scope `document`: delete the chunks of a deleted document in
// batches, then remove the storage objects no live document still references. Idempotent: a repeat
// finds no chunks and no targets and completes. Other scopes (`conversation`, `expired`) are
// not part of P6: the job completes with no work and the skip is logged.
//
// Errors propagate to the runtime (retry_job_later with backoff) except RB010 (unknown document)
// and RB030 (the document is live, so its data must not be touched): both complete the job.
// Logging: ids and counts only.
import { cleanupPayloadSchema } from '@ragbot/shared';
import { DbError } from '../lib/db.js';
import { isSafeObjectPath } from '../lib/storage.js';
import type { JobHandler } from '../runtime.js';

/** cleanup_document accepts 1..1000 rows per call. */
const MAX_DB_BATCH = 1000;
/** A runaway guard: this many batches per run is far beyond any document. */
const MAX_BATCHES = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBatchRow(raw: unknown): { deleted: number; done: boolean } {
  const row: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (!isRecord(row)) throw new Error('invalid cleanup_document result');
  const deleted = row['deleted_chunks'];
  const done = row['done'];
  if (typeof deleted !== 'number' || !Number.isInteger(deleted) || typeof done !== 'boolean') {
    throw new Error('invalid cleanup_document result');
  }
  return { deleted, done };
}

function parsePaths(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('invalid cleanup_storage_targets result');
  const paths: string[] = [];
  for (const item of raw as unknown[]) {
    const path = isRecord(item) ? item['storage_path'] : item;
    if (typeof path === 'string') paths.push(path);
  }
  return paths;
}

export function createCleanupHandler(): JobHandler {
  return async (job, ctx) => {
    const payload = cleanupPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      ctx.log.error('cleanup_payload_invalid');
      return;
    }
    const { scope, resource_id: documentId } = payload.data;
    if (scope !== 'document' || documentId === undefined) {
      ctx.log.info('cleanup_scope_skipped', { scope });
      return;
    }
    const log = ctx.log.child({ document_id: documentId });
    const batch = Math.min(MAX_DB_BATCH, ctx.config.retentionBatchSize);
    const { signal } = ctx;

    try {
      let deletedChunks = 0;
      for (let i = 0; ; i += 1) {
        if (i >= MAX_BATCHES) throw new Error('cleanup did not finish');
        if (signal.aborted) return;
        const result = parseBatchRow(
          await ctx.db.rpc<unknown>(
            'cleanup_document',
            { p_document_id: documentId, p_batch: batch },
            signal,
          ),
        );
        deletedChunks += result.deleted;
        if (result.done) break;
        if (result.deleted === 0) throw new Error('cleanup made no progress');
        await ctx.heartbeat();
      }

      const all = parsePaths(
        await ctx.db.rpc<unknown>('cleanup_storage_targets', { p_document_id: documentId }, signal),
      );
      const paths = all.filter(isSafeObjectPath);
      if (paths.length > 0) await ctx.storage.remove(paths, signal);
      log.info('cleanup_document_done', {
        deleted_count: deletedChunks,
        removed_count: paths.length,
        skipped_count: all.length - paths.length,
      });
    } catch (err) {
      const sqlstate = err instanceof DbError ? err.sqlstate : undefined;
      if (sqlstate === 'RB010') {
        log.info('cleanup_document_unknown');
        return;
      }
      if (sqlstate === 'RB030') {
        log.warn('cleanup_document_is_live');
        return;
      }
      throw err;
    }
  };
}
