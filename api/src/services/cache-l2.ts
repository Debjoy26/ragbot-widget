// P7.5 L2 Postgres adapters (015_p75_cache_l2.sql). Service-role RPCs only.
// No raw query text, no secrets, no visitor identifiers cross the boundary —
// only 64-char hashes, vectors, verdicts, answer text with validated source refs.
// Fail closed: any DB error is swallowed by the caller (treated as miss), never thrown here
// except for programming faults; adapters never log content.

import type { Db } from '../lib/supabase.js';
import type { AnswerL2, AnswerCacheRecord } from './answer-cache.js';
import type { EmbeddingL2, EmbeddingCacheRecord } from './embedding-cache.js';
import type { ModerationL2 } from './moderation-cache.js';
import type { RetrievalL2, RetrievalCacheRecord } from './retrieval-cache.js';

function rowsOf(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
}

function vectorToText(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

function textToVector(text: string): number[] | null {
  const t = text.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  const inner = t.slice(1, -1);
  if (inner.trim() === '') return [];
  const parts = inner.split(',');
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

export function createEmbeddingL2(db: Pick<Db, 'rpc'>): EmbeddingL2 {
  return {
    async get(keyHash: string): Promise<EmbeddingCacheRecord | null> {
      const raw = await db.rpc<unknown>('cache_get_query_embedding', { p_key_hash: keyHash });
      const rows = rowsOf(raw);
      if (rows.length !== 1) return null;
      const r = rows[0] as Record<string, unknown>;
      if (
        typeof r['key_hash'] !== 'string' ||
        typeof r['embedding_model'] !== 'string' ||
        typeof r['embedding'] !== 'string' ||
        typeof r['expires_at'] !== 'string'
      ) {
        return null;
      }
      const vector = textToVector(r['embedding'] as string);
      if (vector === null) return null;
      const dims =
        typeof r['embedding_dimensions'] === 'number'
          ? (r['embedding_dimensions'] as number)
          : vector.length;
      return {
        key_hash: r['key_hash'] as string,
        embedding_model: r['embedding_model'] as string,
        embedding_dimensions: dims,
        embedding: vector,
        created_at: new Date().toISOString(),
        last_hit_at: null,
        expires_at: r['expires_at'] as string,
      };
    },
    async set(record: EmbeddingCacheRecord): Promise<void> {
      await db.rpc<unknown>('cache_set_query_embedding', {
        p_key_hash: record.key_hash,
        p_model: record.embedding_model,
        p_dimensions: record.embedding_dimensions,
        p_embedding_text: vectorToText(record.embedding),
        p_expires_at: record.expires_at,
      });
    },
  };
}

export function createModerationL2(db: Pick<Db, 'rpc'>): ModerationL2 {
  return {
    async get(keyHash: string) {
      const raw = await db.rpc<unknown>('cache_get_moderation', { p_key_hash: keyHash });
      const rows = rowsOf(raw);
      if (rows.length !== 1) return null;
      const r = rows[0] as Record<string, unknown>;
      if (
        typeof r['key_hash'] !== 'string' ||
        typeof r['policy_version'] !== 'string' ||
        (r['verdict'] !== 'allow' && r['verdict'] !== 'block') ||
        typeof r['expires_at'] !== 'string'
      ) {
        return null;
      }
      return {
        key_hash: r['key_hash'] as string,
        policy_version: r['policy_version'] as string,
        verdict: r['verdict'] as 'allow' | 'block',
        created_at: new Date().toISOString(),
        expires_at: r['expires_at'] as string,
      };
    },
    async set(record): Promise<void> {
      await db.rpc<unknown>('cache_set_moderation', {
        p_key_hash: record.key_hash,
        p_policy_version: record.policy_version,
        p_verdict: record.verdict,
        p_model: '',
        p_expires_at: record.expires_at,
      });
    },
  };
}

export function createAnswerL2(db: Pick<Db, 'rpc'>): AnswerL2 {
  return {
    async get(keyHash: string): Promise<AnswerCacheRecord | null> {
      const raw = await db.rpc<unknown>('cache_get_answer', { p_key_hash: keyHash });
      const rows = rowsOf(raw);
      if (rows.length !== 1) return null;
      const r = rows[0] as Record<string, unknown>;
      if (
        typeof r['bot_id'] !== 'string' ||
        typeof r['cache_key_hash'] !== 'string' ||
        typeof r['answer_text'] !== 'string'
      ) {
        return null;
      }
      const sourceRefs = Array.isArray(r['source_refs'])
        ? (r['source_refs'] as AnswerCacheRecord['source_refs'])
        : [];
      return {
        bot_id: r['bot_id'] as string,
        cache_key_hash: r['cache_key_hash'] as string,
        language: typeof r['language'] === 'string' ? (r['language'] as string) : 'en',
        answer_text: r['answer_text'] as string,
        source_refs: sourceRefs,
        handoff_reason:
          typeof r['handoff_reason'] === 'string' ? (r['handoff_reason'] as string) : null,
        corpus_version:
          typeof r['corpus_version'] === 'number' ? (r['corpus_version'] as number) : 0,
        settings_version:
          typeof r['settings_version'] === 'number' ? (r['settings_version'] as number) : 0,
        prompt_template_version:
          typeof r['prompt_template_version'] === 'string'
            ? (r['prompt_template_version'] as string)
            : '',
        chat_model: typeof r['chat_model'] === 'string' ? (r['chat_model'] as string) : '',
        hit_count: 0,
        created_at: new Date().toISOString(),
        last_hit_at: null,
        expires_at: r['expires_at'] as string,
      };
    },
    async set(record: AnswerCacheRecord): Promise<void> {
      await db.rpc<unknown>('cache_set_answer', {
        p_bot_id: record.bot_id,
        p_key_hash: record.cache_key_hash,
        p_language: record.language,
        p_answer_text: record.answer_text,
        p_source_refs: record.source_refs,
        p_handoff_reason: record.handoff_reason,
        p_corpus_version: record.corpus_version,
        p_settings_version: record.settings_version,
        p_prompt_template_version: record.prompt_template_version,
        p_chat_model: record.chat_model,
        p_expires_at: record.expires_at,
      });
    },
    async delete(keyHash: string): Promise<void> {
      await db.rpc<unknown>('cache_delete_answer', { p_key_hash: keyHash });
    },
    async incrementHit(keyHash: string): Promise<void> {
      await db.rpc<unknown>('cache_touch_answer', { p_key_hash: keyHash });
    },
  };
}

export function createRetrievalL2(db: Pick<Db, 'rpc'>): RetrievalL2 {
  return {
    async get(keyHash: string): Promise<RetrievalCacheRecord | null> {
      const raw = await db.rpc<unknown>('cache_get_retrieval', { p_key_hash: keyHash });
      const rows = rowsOf(raw);
      if (rows.length !== 1) return null;
      const r = rows[0] as Record<string, unknown>;
      if (typeof r['bot_id'] !== 'string' || !Array.isArray(r['chunk_refs'])) {
        return null;
      }
      return {
        key_hash: keyHash,
        bot_id: r['bot_id'] as string,
        corpus_version:
          typeof r['corpus_version'] === 'number' ? (r['corpus_version'] as number) : 0,
        embedding_hash:
          typeof r['embedding_hash'] === 'string' ? (r['embedding_hash'] as string) : '',
        k: typeof r['k'] === 'number' ? (r['k'] as number) : 0,
        threshold: typeof r['threshold'] === 'number' ? (r['threshold'] as number) : 0,
        language: typeof r['language'] === 'string' ? (r['language'] as string) : '',
        chunk_refs: r['chunk_refs'] as RetrievalCacheRecord['chunk_refs'],
        created_at: new Date().toISOString(),
        expires_at: r['expires_at'] as string,
      };
    },
    async set(record: RetrievalCacheRecord): Promise<void> {
      await db.rpc<unknown>('cache_set_retrieval', {
        p_key_hash: record.key_hash,
        p_bot_id: record.bot_id,
        p_corpus_version: record.corpus_version,
        p_embedding_hash: record.embedding_hash,
        p_k: record.k,
        p_threshold: record.threshold,
        p_language: record.language,
        p_chunk_refs: record.chunk_refs,
        p_expires_at: record.expires_at,
      });
    },
    async delete(keyHash: string): Promise<void> {
      await db.rpc<unknown>('cache_delete_retrieval', { p_key_hash: keyHash });
    },
  };
}
