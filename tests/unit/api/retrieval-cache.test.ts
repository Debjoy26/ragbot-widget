import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  RetrievalCache,
  retrievalCacheKey,
  queryEmbeddingHash,
  isRetrievalCacheEnabled,
  RETRIEVAL_CACHE_TTL_MS,
  RETRIEVAL_CACHE_MAX_TTL_MS,
  RETRIEVAL_CACHE_MIN_TTL_MS,
  createRetrievalCache,
  type RetrievalL2,
  type RetrievalCacheRecord,
} from '../../../api/src/services/retrieval-cache.ts';

function fakeL2(): { l2: RetrievalL2; store: Map<string, RetrievalCacheRecord> } {
  const store = new Map<string, RetrievalCacheRecord>();
  const l2: RetrievalL2 = {
    async get(k) { return store.get(k) ?? null; },
    async set(rec) { store.set(rec.key_hash, rec); },
    async delete(k) { store.delete(k); },
  };
  return { l2, store };
}

const BOT_A = '11111111-1111-1111-1111-111111111111';
const BOT_B = '22222222-2222-2222-2222-222222222222';
const EH = 'a'.repeat(64);
const EH2 = 'b'.repeat(64);
const CHUNK_REFS = [
  { chunk_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', document_version_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', similarity: 0.92 },
  { chunk_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', document_version_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', similarity: 0.81 },
];

describe('C5 retrieval cache — api/src/services/retrieval-cache.ts', () => {
  describe('TTL ≤10min', () => {
    it('default TTL is ≤10min', () => {
      const c = createRetrievalCache();
      expect(c.ttlMs).toBeLessThanOrEqual(RETRIEVAL_CACHE_MAX_TTL_MS);
      expect(c.ttlMs).toBe(RETRIEVAL_CACHE_TTL_MS);
      expect(RETRIEVAL_CACHE_MAX_TTL_MS).toBe(10 * 60 * 1000);
    });
    it('clamps TTL above 10min to 10min and below 1min to 1min', () => {
      expect(new RetrievalCache({ ttlMs: 60 * 60 * 1000 }).ttlMs).toBe(RETRIEVAL_CACHE_MAX_TTL_MS);
      expect(new RetrievalCache({ ttlMs: 1 }).ttlMs).toBe(RETRIEVAL_CACHE_MIN_TTL_MS);
    });
    it('serves within TTL and misses after expiry', () => {
      let now = 0;
      const cache = new RetrievalCache({ now: () => now, ttlMs: 5 * 60 * 1000 });
      cache.setL1(BOT_A, 1, EH, 5, 0.5, 'en', CHUNK_REFS);
      expect(cache.getL1(BOT_A, 1, EH, 5, 0.5, 'en')).toBeDefined();
      now = 5 * 60 * 1000 - 1;
      expect(cache.getL1(BOT_A, 1, EH, 5, 0.5, 'en')).toBeDefined();
      now = 5 * 60 * 1000;
      expect(cache.getL1(BOT_A, 1, EH, 5, 0.5, 'en')).toBeUndefined();
    });
    it('L2 TTL is respected', async () => {
      let now = 0;
      const { l2 } = fakeL2();
      const c1 = new RetrievalCache({ now: () => now, l2 });
      await c1.set(BOT_A, 1, EH, 5, 0.5, 'en', CHUNK_REFS);
      now = RETRIEVAL_CACHE_MAX_TTL_MS + 1;
      const c2 = new RetrievalCache({ now: () => now, l2 });
      expect(await c2.get(BOT_A, 1, EH, 5, 0.5, 'en')).toBeUndefined();
    });
  });

  describe('isolation by bot_id, corpus_version, embedding_hash, k, threshold, language', () => {
    it('different bot_id => miss', () => {
      const c = createRetrievalCache();
      c.setL1(BOT_A, 1, EH, 5, 0.5, 'en', CHUNK_REFS);
      expect(c.getL1(BOT_B, 1, EH, 5, 0.5, 'en')).toBeUndefined();
      expect(c.getL1(BOT_A, 1, EH, 5, 0.5, 'en')).toBeDefined();
    });
    it('different corpus_version => miss (bump invalidates)', () => {
      const c = createRetrievalCache();
      c.setL1(BOT_A, 1, EH, 5, 0.5, 'en', CHUNK_REFS);
      expect(c.getL1(BOT_A, 2, EH, 5, 0.5, 'en')).toBeUndefined();
      // old version hit with old key, new version can be set
      c.setL1(BOT_A, 2, EH, 5, 0.5, 'en', CHUNK_REFS);
      expect(c.getL1(BOT_A, 2, EH, 5, 0.5, 'en')).toBeDefined();
      // querying new version never returns old version's entry
      expect(c.getL1(BOT_A, 2, EH, 5, 0.5, 'en')).toBeDefined();
      // old key still exists but is separate; bump is demonstrated by new version being needed
      expect(c.getL1(BOT_A, 1, EH, 5, 0.5, 'en')).toBeDefined();
    });
    it('different embedding_hash => miss', () => {
      const c = createRetrievalCache();
      c.setL1(BOT_A, 1, EH, 5, 0.5, 'en', CHUNK_REFS);
      expect(c.getL1(BOT_A, 1, EH2, 5, 0.5, 'en')).toBeUndefined();
    });
    it('different k => miss', () => {
      const c = createRetrievalCache();
      c.setL1(BOT_A, 1, EH, 5, 0.5, 'en', CHUNK_REFS);
      expect(c.getL1(BOT_A, 1, EH, 10, 0.5, 'en')).toBeUndefined();
    });
    it('different threshold => miss', () => {
      const c = createRetrievalCache();
      c.setL1(BOT_A, 1, EH, 5, 0.5, 'en', CHUNK_REFS);
      expect(c.getL1(BOT_A, 1, EH, 5, 0.8, 'en')).toBeUndefined();
    });
    it('different language => miss', () => {
      const c = createRetrievalCache();
      c.setL1(BOT_A, 1, EH, 5, 0.5, 'en', CHUNK_REFS);
      expect(c.getL1(BOT_A, 1, EH, 5, 0.5, 'de')).toBeUndefined();
      expect(c.getL1(BOT_A, 1, EH, 5, 0.5, 'EN')).toBeDefined(); // language normalized
    });
    it('same params => hit', () => {
      const c = createRetrievalCache();
      c.setL1(BOT_A, 1, EH, 5, 0.5, 'en', CHUNK_REFS);
      expect(c.getL1(BOT_A, 1, EH, 5, 0.5, 'en')).toEqual(CHUNK_REFS);
    });
    it('L2 isolation also respects all key parts', async () => {
      const { l2 } = fakeL2();
      const cache = new RetrievalCache({ l2 });
      await cache.set(BOT_A, 1, EH, 5, 0.5, 'en', CHUNK_REFS);
      expect(await cache.get(BOT_B, 1, EH, 5, 0.5, 'en')).toBeUndefined();
      expect(await cache.get(BOT_A, 2, EH, 5, 0.5, 'en')).toBeUndefined();
      expect(await cache.get(BOT_A, 1, EH, 5, 0.5, 'en')).toBeDefined();
    });
    it('stores ordered chunk IDs+scores not text, key is hash', () => {
      const c = createRetrievalCache();
      c.setL1(BOT_A, 1, EH, 5, 0.5, 'en', CHUNK_REFS);
      const keys = c._l1Keys();
      expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
      const entry = c._peekL1(keys[0]!);
      expect(entry?.chunkRefs).toEqual(CHUNK_REFS);
      // Ensure no content field leaked
      expect(JSON.stringify(entry?.chunkRefs)).not.toContain('content');
    });
    it('queryEmbeddingHash is 64-char hex and stable', () => {
      const v = [0.1, 0.2, 0.3];
      const h = queryEmbeddingHash(v);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
      expect(queryEmbeddingHash(v)).toBe(h);
      expect(createHash('sha256').update(v.join(','), 'utf8').digest('hex')).toBe(h);
    });
    it('retrievalCacheKey is sha256 of composite', () => {
      const k = retrievalCacheKey({ botId: BOT_A, corpusVersion: 1, embeddingHash: EH, k: 5, threshold: 0.5, language: 'en' });
      expect(k).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('chunk text re-read by ID (deleted chunks not leaked)', () => {
    it('getHydrated returns hydrated chunks when all exist', async () => {
      const c = createRetrievalCache();
      c.setL1(BOT_A, 1, EH, 5, 0.5, 'en', CHUNK_REFS);
      const hydrated = await c.getHydrated(BOT_A, 1, EH, 5, 0.5, 'en', async (ids) => {
        const map = new Map();
        for (const id of ids) map.set(id, { chunk_id: id, content: `text for ${id}` });
        return map;
      });
      expect(hydrated).toBeDefined();
      expect(hydrated!.length).toBe(2);
      expect(hydrated![0]!.content).toBe(`text for ${CHUNK_REFS[0]!.chunk_id}`);
    });
    it('getHydrated purges and misses when a chunk was deleted', async () => {
      const c = createRetrievalCache();
      c.setL1(BOT_A, 1, EH, 5, 0.5, 'en', CHUNK_REFS);
      const before = c._l1Keys().length;
      expect(before).toBe(1);
      const hydrated = await c.getHydrated(BOT_A, 1, EH, 5, 0.5, 'en', async (ids) => {
        const map = new Map();
        // Return only first chunk — second was deleted.
        map.set(ids[0]!, { chunk_id: ids[0]!, content: 'only one' });
        return map;
      });
      expect(hydrated).toBeUndefined();
      // Entry purged so subsequent get is miss
      expect(c.getL1(BOT_A, 1, EH, 5, 0.5, 'en')).toBeUndefined();
      expect(c._l1Keys().length).toBe(0);
    });
    it('getHydrated with L2 also purges L2', async () => {
      const { l2, store } = fakeL2();
      const c = new RetrievalCache({ l2 });
      await c.set(BOT_A, 1, EH, 5, 0.5, 'en', CHUNK_REFS);
      expect(store.size).toBe(1);
      const key = retrievalCacheKey({ botId: BOT_A, corpusVersion: 1, embeddingHash: EH, k: 5, threshold: 0.5, language: 'en' });
      // Hydrate with missing chunk -> purge L2
      const miss = await c.getHydrated(BOT_A, 1, EH, 5, 0.5, 'en', async () => new Map());
      expect(miss).toBeUndefined();
      expect(store.has(key)).toBe(false);
    });
    it('does not leak deleted chunk text', async () => {
      // Simulate old cached text vs re-read text: cache stores IDs only, so old text cannot leak.
      const c = createRetrievalCache();
      c.setL1(BOT_A, 1, EH, 5, 0.5, 'en', [{ chunk_id: 'aaaa', document_version_id: 'bbbb', similarity: 0.9 }]);
      const hydrated = await c.getHydrated(BOT_A, 1, EH, 5, 0.5, 'en', async (_ids) => {
        // Deleted: return empty for that ID -> miss
        return new Map();
      });
      expect(hydrated).toBeUndefined();
    });
  });

  describe('kill switch', () => {
    it('isRetrievalCacheEnabled true when missing or enabled', () => {
      expect(isRetrievalCacheEnabled(undefined)).toBe(true);
      expect(isRetrievalCacheEnabled(null)).toBe(true);
      expect(isRetrievalCacheEnabled({})).toBe(true);
      expect(isRetrievalCacheEnabled({ enabled: true })).toBe(true);
    });
    it('disabled when enabled:false or c5:false or retrieval:false', () => {
      expect(isRetrievalCacheEnabled({ enabled: false })).toBe(false);
      expect(isRetrievalCacheEnabled({ c5: false })).toBe(false);
      expect(isRetrievalCacheEnabled({ retrieval: false })).toBe(false);
      expect(isRetrievalCacheEnabled({ enabled: true, c5: false })).toBe(false);
    });
    it('bypass on setL1 and getL1 when kill switch disabled', () => {
      const c = createRetrievalCache();
      const policy = { enabled: false };
      const h = c.setL1(BOT_A, 1, EH, 5, 0.5, 'en', CHUNK_REFS, policy);
      expect(h).toBeUndefined();
      expect(c.size()).toBe(0);
      c.setL1(BOT_A, 1, EH, 5, 0.5, 'en', CHUNK_REFS);
      expect(c.getL1(BOT_A, 1, EH, 5, 0.5, 'en', policy)).toBeUndefined();
      expect(c.getL1(BOT_A, 1, EH, 5, 0.5, 'en')).toBeDefined();
    });
    it('bypass on full get/set with L2', async () => {
      const { l2, store } = fakeL2();
      const c = new RetrievalCache({ l2 });
      const policy = { c5: false };
      expect(await c.set(BOT_A, 1, EH, 5, 0.5, 'en', CHUNK_REFS, policy)).toBeUndefined();
      expect(store.size).toBe(0);
    });
  });

  describe('LRU and fail closed', () => {
    it('evicts LRU when over maxEntries', () => {
      const c = new RetrievalCache({ maxEntries: 2 });
      const eh2 = 'c'.repeat(64);
      const eh3 = 'd'.repeat(64);
      c.setL1(BOT_A, 1, EH, 5, 0.5, 'en', CHUNK_REFS);
      c.setL1(BOT_A, 1, eh2, 5, 0.5, 'en', CHUNK_REFS);
      c.setL1(BOT_A, 1, eh3, 5, 0.5, 'en', CHUNK_REFS);
      expect(c.size()).toBe(2);
      expect(c.getL1(BOT_A, 1, EH, 5, 0.5, 'en')).toBeUndefined();
    });
    it('invalid inputs never hit or store', () => {
      const c = createRetrievalCache();
      expect(c.setL1('', 1, EH, 5, 0.5, 'en', CHUNK_REFS)).toBeUndefined();
      expect(c.setL1(BOT_A, 1, 'not-hex', 5, 0.5, 'en', CHUNK_REFS)).toBeUndefined();
      expect(c.setL1(BOT_A, 1, EH, 0, 0.5, 'en', CHUNK_REFS)).toBeUndefined();
      expect(c.getL1(BOT_A, 1, EH, 5, 0.5, 'en')).toBeUndefined();
    });
  });
});
