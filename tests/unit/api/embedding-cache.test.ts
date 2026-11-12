import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  normalizeQuery,
  embeddingCacheKey,
  embeddingKeyHash,
  isEmbeddingCacheEnabled,
  createEmbeddingCache,
  EMBEDDING_CACHE_TTL_MS,
  EMBEDDING_CACHE_TTL_MIN_MS,
  EMBEDDING_CACHE_TTL_MAX_MS,
  type EmbeddingL2,
  type EmbeddingCacheRecord,
} from '../../../api/src/services/embedding-cache.ts';

// Helper to compute expected hash independently.
function expectedHash(model: string, dims: number, norm: string): string {
  return createHash('sha256')
    .update(`${model}\x1f${String(dims)}\x1f${norm}`, 'utf8')
    .digest('hex');
}

function fakeL2(): { l2: EmbeddingL2; store: Map<string, EmbeddingCacheRecord> } {
  const store = new Map<string, EmbeddingCacheRecord>();
  const l2: EmbeddingL2 = {
    async get(keyHash) {
      return store.get(keyHash) ?? null;
    },
    async set(record) {
      store.set(record.key_hash, record);
    },
  };
  return { l2, store };
}

const MODEL_A = 'gemini-embedding-001';
const MODEL_B = 'text-embedding-3-small';
const DIMS = 1536;
const DIMS_OTHER = 768;
const VECTOR_A = Array.from({ length: 3 }, (_, i) => i * 0.1);
const VECTOR_B = [0.9, 0.8, 0.7];

describe('C4 embedding cache — api/src/services/embedding-cache.ts', () => {
  describe('hash canonicalisation (lower+trim+collapse+NFKC)', () => {
    it('lower + trim + collapse gives same hash', () => {
      const a = embeddingKeyHash(MODEL_A, DIMS, '  Hello   WORLD  ');
      const b = embeddingKeyHash(MODEL_A, DIMS, 'hello world');
      const c = embeddingKeyHash(MODEL_A, DIMS, 'HELLO\tWORLD\n');
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(a).toBe(expectedHash(MODEL_A, DIMS, 'hello world'));
    });

    it('NFKC normalisation is applied (e.g. ﬁ → fi)', () => {
      // U+FB01 LATIN SMALL LIGATURE FI normalises to 'fi' under NFKC
      const ligature = 'ﬁ';
      const decomposed = 'fi';
      expect(normalizeQuery(ligature)).toBe('fi');
      const h1 = embeddingKeyHash(MODEL_A, DIMS, ligature);
      const h2 = embeddingKeyHash(MODEL_A, DIMS, decomposed);
      expect(h1).toBe(h2);
    });

    it('whitespace collapse includes newlines and tabs', () => {
      const q1 = 'what  is\n\n AI\t ?';
      const q2 = 'what is ai ?';
      expect(normalizeQuery(q1)).toBe(normalizeQuery(q2));
      expect(embeddingKeyHash(MODEL_A, DIMS, q1)).toBe(embeddingKeyHash(MODEL_A, DIMS, q2));
    });

    it('normalizeQuery is lower, trimmed and collapsed', () => {
      expect(normalizeQuery('  Foo  BAR  ')).toBe('foo bar');
      expect(normalizeQuery('  ')).toBe('');
    });
  });

  describe('key includes model and dimensions', () => {
    it('different model yields different hash (isolation via model)', () => {
      const norm = normalizeQuery('hello world');
      const ha = embeddingCacheKey(MODEL_A, DIMS, norm);
      const hb = embeddingCacheKey(MODEL_B, DIMS, norm);
      expect(ha).not.toBe(hb);
    });

    it('different dimensions yields different hash', () => {
      const norm = normalizeQuery('hello world');
      const ha = embeddingCacheKey(MODEL_A, DIMS, norm);
      const hb = embeddingCacheKey(MODEL_A, DIMS_OTHER, norm);
      expect(ha).not.toBe(hb);
    });

    it('key is sha256 hex 64 chars and matches model‖dims‖norm composition', () => {
      const norm = normalizeQuery('test query');
      const key = embeddingCacheKey(MODEL_A, DIMS, norm);
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(key).toBe(expectedHash(MODEL_A, DIMS, norm));
    });
  });

  describe('TTL and invalidation on model change', () => {
    it('serves within TTL and misses after expiry', () => {
      let now = 0;
      const cache = createEmbeddingCache({ now: () => now, ttlMs: EMBEDDING_CACHE_TTL_MS });
      cache.setL1(MODEL_A, DIMS, 'hello', VECTOR_A);
      expect(cache.getL1(MODEL_A, DIMS, 'hello')).toEqual(VECTOR_A);
      // Just before expiry
      now = EMBEDDING_CACHE_TTL_MS - 1;
      expect(cache.getL1(MODEL_A, DIMS, 'hello')).toEqual(VECTOR_A);
      // At expiry
      now = EMBEDDING_CACHE_TTL_MS;
      expect(cache.getL1(MODEL_A, DIMS, 'hello')).toBeUndefined();
    });

    it('TTL is clamped to 7–30 days', () => {
      const tooLow = createEmbeddingCache({ ttlMs: 1000 });
      expect(tooLow.ttlMs).toBe(EMBEDDING_CACHE_TTL_MIN_MS);
      const tooHigh = createEmbeddingCache({ ttlMs: 100 * 24 * 60 * 60 * 1000 });
      expect(tooHigh.ttlMs).toBe(EMBEDDING_CACHE_TTL_MAX_MS);
    });

    it('model change is automatic invalidation (different hash => miss)', () => {
      const cache = createEmbeddingCache();
      cache.setL1(MODEL_A, DIMS, 'same question', VECTOR_A);
      // Same normalised text but different model => miss
      expect(cache.getL1(MODEL_B, DIMS, 'same question')).toBeUndefined();
      // And dimensions change also miss
      expect(cache.getL1(MODEL_A, DIMS_OTHER, 'same question')).toBeUndefined();
      // Original still hits with correct model/dims
      expect(cache.getL1(MODEL_A, DIMS, 'same question')).toEqual(VECTOR_A);
    });

    it('L2 TTL is respected (expired record treated as miss)', async () => {
      let now = 0;
      const { l2, store } = fakeL2();
      const cache = createEmbeddingCache({ now: () => now, l2 });
      await cache.set(MODEL_A, DIMS, 'hello', VECTOR_A);
      expect(store.size).toBe(1);
      // Move past TTL — L2 record is expired
      now = EMBEDDING_CACHE_TTL_MS + 1;
      // L1 also expired, so get should go to L2 and then miss due to expiry, not repopulate.
      // Clear L1 to force L2 path
      const cache2 = createEmbeddingCache({ now: () => now, l2 });
      // Manually keep store expired: the record's expires_at is in the past.
      const miss = await cache2.get(MODEL_A, DIMS, 'hello');
      expect(miss).toBeUndefined();
    });
  });

  describe('isolation (bot model vs shared key)', () => {
    it('same query with different model is isolated (miss)', () => {
      const cache = createEmbeddingCache();
      // Simulate bot A uses MODEL_A, bot B uses MODEL_B
      cache.setL1(MODEL_A, DIMS, 'what is rag?', VECTOR_A);
      // Bot B querying same text but with its own model must miss
      expect(cache.getL1(MODEL_B, DIMS, 'what is rag?')).toBeUndefined();
    });

    it('same model same query is shared (hit) — query embedding cache is global per model', () => {
      const cache = createEmbeddingCache();
      cache.setL1(MODEL_A, DIMS, 'what is rag?', VECTOR_A);
      // Another bot with same embedding_model/dimensions can reuse (no bot_id in key by design, TECH_SPECS §6.2)
      expect(cache.getL1(MODEL_A, DIMS, 'what is rag?')).toEqual(VECTOR_A);
      expect(cache.getL1(MODEL_A, DIMS, 'WHAT IS RAG?')).toEqual(VECTOR_A); // canonicalised
    });

    it('negative: different bot with different model must miss (even same normalised query)', () => {
      const cache = createEmbeddingCache();
      const botA_model = MODEL_A;
      const botB_model = MODEL_B;
      cache.setL1(botA_model, DIMS, 'hello world', VECTOR_A);
      const hitForB = cache.getL1(botB_model, DIMS, 'hello world');
      expect(hitForB).toBeUndefined();
    });

    it('L2 is also isolated by model/dimensions', async () => {
      const { l2 } = fakeL2();
      const now = 0;
      const cacheA = createEmbeddingCache({ now: () => now, l2 });
      await cacheA.set(MODEL_A, DIMS, 'shared q', VECTOR_A);
      // Different model querying L2 must miss
      const miss = await cacheA.get(MODEL_B, DIMS, 'shared q');
      expect(miss).toBeUndefined();
      const hit = await cacheA.get(MODEL_A, DIMS, 'shared q');
      expect(hit).toEqual(VECTOR_A);
    });
  });

  describe('raw query text never stored', () => {
    it('L1 keys are hashes, never raw text', () => {
      const cache = createEmbeddingCache();
      const raw = 'Super Secret Query 123';
      cache.setL1(MODEL_A, DIMS, raw, VECTOR_A);
      const keys = cache._l1Keys();
      expect(keys.length).toBe(1);
      expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(keys[0]).not.toContain('Secret');
      // Internal entry's normalised is stored for debugging but raw is not indexed; ensure map key is hash
      const keyHash = embeddingKeyHash(MODEL_A, DIMS, raw);
      expect(keys[0]).toBe(keyHash);
    });

    it('L2 record never contains raw text or normalised text beyond hash', async () => {
      const { l2, store } = fakeL2();
      const cache = createEmbeddingCache({ l2 });
      const raw = 'Another Secret Query';
      await cache.set(MODEL_A, DIMS, raw, VECTOR_B);
      expect(store.size).toBe(1);
      const rec = [...store.values()][0]!;
      expect(rec.key_hash).toMatch(/^[0-9a-f]{64}$/);
      // Record fields are only hash, model, dims, embedding, timestamps — no text
      const keys = Object.keys(rec);
      expect(keys).not.toContain('query');
      expect(keys).not.toContain('text');
      expect(keys).not.toContain('normalised');
      expect(JSON.stringify(rec)).not.toContain('Secret');
      // Embedding vector is stored
      expect(rec.embedding).toEqual(VECTOR_B);
      expect(rec.embedding_model).toBe(MODEL_A);
    });
  });

  describe('kill switch via cache_policy', () => {
    it('isEmbeddingCacheEnabled true when missing or enabled', () => {
      expect(isEmbeddingCacheEnabled(undefined)).toBe(true);
      expect(isEmbeddingCacheEnabled(null)).toBe(true);
      expect(isEmbeddingCacheEnabled({})).toBe(true);
      expect(isEmbeddingCacheEnabled({ enabled: true })).toBe(true);
      expect(isEmbeddingCacheEnabled({ c4: true })).toBe(true);
    });

    it('disabled when enabled:false or c4:false or embedding:false', () => {
      expect(isEmbeddingCacheEnabled({ enabled: false })).toBe(false);
      expect(isEmbeddingCacheEnabled({ c4: false })).toBe(false);
      expect(isEmbeddingCacheEnabled({ embedding: false })).toBe(false);
      expect(isEmbeddingCacheEnabled({ enabled: true, c4: false })).toBe(false);
    });

    it('bypass on setL1 and getL1 when kill switch disabled', () => {
      const cache = createEmbeddingCache();
      const policy = { enabled: false };
      const hash = cache.setL1(MODEL_A, DIMS, 'hello', VECTOR_A, policy);
      expect(hash).toBeUndefined();
      expect(cache.size()).toBe(0);
      // Also get bypass
      cache.setL1(MODEL_A, DIMS, 'hello', VECTOR_A); // without policy => stored
      expect(cache.getL1(MODEL_A, DIMS, 'hello', policy)).toBeUndefined();
    });

    it('bypass on full get/set with L2', async () => {
      const { l2, store } = fakeL2();
      const cache = createEmbeddingCache({ l2 });
      const policy = { c4: false };
      const h = await cache.set(MODEL_A, DIMS, 'hello', VECTOR_A, policy);
      expect(h).toBeUndefined();
      expect(store.size).toBe(0);
      // Store with enabled then try to fetch with disabled => miss
      await cache.set(MODEL_A, DIMS, 'hello', VECTOR_A);
      expect(await cache.get(MODEL_A, DIMS, 'hello', policy)).toBeUndefined();
      // Without policy it hits
      expect(await cache.get(MODEL_A, DIMS, 'hello')).toEqual(VECTOR_A);
    });

    it('kill switch respects embeddings alias', () => {
      expect(isEmbeddingCacheEnabled({ embeddings: false })).toBe(false);
      expect(isEmbeddingCacheEnabled({ query_embedding: false })).toBe(false);
    });
  });

  describe('fail closed and LRU', () => {
    it('missing/invalid model or dimensions never hits', () => {
      const cache = createEmbeddingCache();
      cache.setL1(MODEL_A, DIMS, 'hi', VECTOR_A);
      expect(cache.getL1('', DIMS, 'hi')).toBeUndefined();
      expect(cache.getL1(MODEL_A, 0, 'hi')).toBeUndefined();
      expect(cache.getL1(MODEL_A, NaN, 'hi')).toBeUndefined();
      expect(cache.setL1('', DIMS, 'hi', VECTOR_A)).toBeUndefined();
      expect(cache.setL1(MODEL_A, DIMS, 'hi', [])).toBeUndefined();
    });

    it('evicts LRU when over maxEntries', () => {
      const cache = createEmbeddingCache({ maxEntries: 2 });
      cache.setL1(MODEL_A, DIMS, 'q1', VECTOR_A);
      cache.setL1(MODEL_A, DIMS, 'q2', VECTOR_A);
      cache.setL1(MODEL_A, DIMS, 'q3', VECTOR_A);
      expect(cache.size()).toBe(2);
      expect(cache.getL1(MODEL_A, DIMS, 'q1')).toBeUndefined();
      expect(cache.getL1(MODEL_A, DIMS, 'q2')).toBeDefined();
      expect(cache.getL1(MODEL_A, DIMS, 'q3')).toBeDefined();
    });
  });
});
