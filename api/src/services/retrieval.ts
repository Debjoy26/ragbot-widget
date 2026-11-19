// Query embedding and vector retrieval (TECH_SPECS section 6, PRD W-07). P7.
//
//  * The query is embedded with the SAME model as the corpus: the model guard in the chat service
//    refuses a request whose configured embedding model differs from the bot's before any spend,
//    and there is no silent switch to another model on a provider outage.
//  * `match_document_chunks` filters in SQL to this bot's active, ready, public-answer chunks of
//    the bot's embedding model, with a bounded count and a minimum similarity. Rows are validated
//    again here; a malformed row is an internal fault, never evidence.
//  * Chunk text is untrusted data and is never logged by this module.

import type { EmbeddingProvider } from '@ragbot/shared';
import {
  retrievedChunkSchema as rowSchema,
  type RetrievedChunk,
} from '@ragbot/shared/server/retrieval-types';
export type { RetrievedChunk } from '@ragbot/shared/server/retrieval-types';
import { AppError } from '../lib/errors.js';
import type { Db } from '../lib/supabase.js';

export interface EmbeddedQuery {
  readonly vector: readonly number[];
  /** Billable tokens when the provider reported them, else null. */
  readonly inputTokens: number | null;
}

export interface Retrieval {
  embedQuery(text: string, signal: AbortSignal): Promise<EmbeddedQuery>;
  /** At most `topK` chunks with similarity >= the minimum, best first. */
  match(botId: string, vector: readonly number[], signal: AbortSignal): Promise<RetrievedChunk[]>;
  /** Rehydrate cached chunk refs by ID (C5). Bot-scoped: missing/foreign => []. */
  hydrate(
    refs: readonly { readonly chunk_id: string; readonly similarity: number }[],
    signal: AbortSignal,
    botId: string,
  ): Promise<RetrievedChunk[]>;
}

export interface CreateRetrievalOptions {
  readonly db: Pick<Db, 'rpc'>;
  readonly embedding: EmbeddingProvider;
  /** RETRIEVAL_TOP_K (1..50). */
  readonly topK: number;
  /** RETRIEVAL_MIN_SIMILARITY (0..1). */
  readonly minSimilarity: number;
}

export function createRetrieval(options: CreateRetrievalOptions): Retrieval {
  const { db, embedding, topK, minSimilarity } = options;
  if (!Number.isInteger(topK) || topK < 1 || topK > 50) throw new TypeError('topK must be 1..50');
  if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) {
    throw new TypeError('minSimilarity must be 0..1');
  }

  return {
    async embedQuery(text, signal) {
      const result = await embedding.embed([text], { taskType: 'query', signal });
      const vector = result.vectors[0];
      if (result.vectors.length !== 1 || vector === undefined) {
        throw new AppError('INTERNAL_ERROR', { internalName: 'query_embedding_shape' });
      }
      return { vector, inputTokens: result.inputTokens };
    },

    async match(botId, vector, signal) {
      const raw = await db.rpc<unknown>(
        'match_document_chunks',
        {
          p_bot_id: botId,
          // pgvector's text form; PostgREST casts it to the vector parameter.
          p_query_embedding: `[${vector.join(',')}]`,
          p_match_count: topK,
          p_min_similarity: minSimilarity,
        },
        signal,
      );
      if (!Array.isArray(raw) || raw.length > topK) {
        throw new AppError('INTERNAL_ERROR', { internalName: 'retrieval_bad_result' });
      }
      const chunks: RetrievedChunk[] = [];
      const seen = new Set<string>();
      for (const row of raw) {
        const parsed = rowSchema.safeParse(row);
        if (!parsed.success) {
          throw new AppError('INTERNAL_ERROR', { internalName: 'retrieval_bad_row' });
        }
        const r = parsed.data;
        // Defence in depth: SQL already filters, but nothing below the threshold is evidence.
        if (r.similarity < minSimilarity || seen.has(r.chunk_id)) continue;
        seen.add(r.chunk_id);
        chunks.push({
          chunk_id: r.chunk_id,
          document_id: r.document_id,
          document_version_id: r.document_version_id,
          document_title: r.document_title,
          chunk_index: r.chunk_index,
          content: r.content,
          page_number: r.page_number,
          section: r.section,
          similarity: r.similarity,
        });
      }
      return chunks.sort((a, b) => b.similarity - a.similarity);
    },

    async hydrate(refs, signal, botId: string) {
      if (refs.length === 0) return [];
      const raw = await db.rpc<unknown>(
        'get_chunks_by_ids',
        { p_chunk_ids: refs.map((r) => r.chunk_id), p_bot_id: botId },
        signal,
      );
      if (!Array.isArray(raw)) {
        throw new AppError('INTERNAL_ERROR', { internalName: 'retrieval_hydrate_bad' });
      }
      const byId = new Map<string, RetrievedChunk>();
      for (const row of raw) {
        const parsed = rowSchema.safeParse({ ...row, similarity: 1 });
        if (!parsed.success) continue;
        const r = parsed.data;
        byId.set(r.chunk_id, {
          chunk_id: r.chunk_id,
          document_id: r.document_id,
          document_version_id: r.document_version_id,
          document_title: r.document_title,
          chunk_index: r.chunk_index,
          content: r.content,
          page_number: r.page_number,
          section: r.section,
          similarity: 1,
        });
      }
      // Preserve cached order; missing => drop (caller treats shortfall as miss via getHydrated purge).
      const out: RetrievedChunk[] = [];
      const simById = new Map(refs.map((r) => [r.chunk_id, r.similarity] as const));
      for (const ref of refs) {
        const c = byId.get(ref.chunk_id);
        if (c === undefined) continue;
        out.push({ ...c, similarity: simById.get(ref.chunk_id) ?? c.similarity });
      }
      return out;
    },
  };
}
