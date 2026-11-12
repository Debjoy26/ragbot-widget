import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  normalizeModerationText,
  moderationCacheKey,
  moderationKeyHash,
  isModerationCacheEnabled,
  createModerationCache,
  MODERATION_CACHE_TTL_MS,
  type ModerationL2,
  type ModerationCacheRecord,
} from '../../../api/src/services/moderation-cache.ts';

function expectedHash(model: string, policy: string, norm: string): string {
  return createHash('sha256').update(`${model}\x1f${policy}\x1f${norm}`, 'utf8').digest('hex');
}

function fakeL2(): { l2: ModerationL2; store: Map<string, ModerationCacheRecord> } {
  const store = new Map<string, ModerationCacheRecord>();
  const l2: ModerationL2 = {
    async get(keyHash) {
      return store.get(keyHash) ?? null;
    },
    async set(record) {
      store.set(record.key_hash, record);
    },
  };
  return { l2, store };
}

const MOD_MODEL_A = 'gemini-2.5-flash-lite';
const MOD_MODEL_B = 'gpt-moderation-001';
const POLICY_V1 = 'policy-v1';
const POLICY_V2 = 'policy-v2';

describe('C6 moderation cache — api/src/services/moderation-cache.ts', () => {
  describe('hash canonicalisation (lower+trim+collapse+NFKC)', () => {
    it('lower + trim + collapse gives same hash', () => {
      const a = moderationKeyHash(MOD_MODEL_A, POLICY_V1, '  Hello   WORLD  ');
      const b = moderationKeyHash(MOD_MODEL_A, POLICY_V1, 'hello world');
      const c = moderationKeyHash(MOD_MODEL_A, POLICY_V1, 'HELLO\tWORLD\n');
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(a).toBe(expectedHash(MOD_MODEL_A, POLICY_V1, 'hello world'));
    });

    it('NFKC normalisation is applied', () => {
      const ligature = 'ﬁ';
      expect(normalizeModerationText(ligature)).toBe('fi');
      const h1 = moderationKeyHash(MOD_MODEL_A, POLICY_V1, ligature);
      const h2 = moderationKeyHash(MOD_MODEL_A, POLICY_V1, 'fi');
      expect(h1).toBe(h2);
    });

    it('whitespace collapse includes newlines and tabs', () => {
      const q1 = 'bad  word\n\n test\t!';
      const q2 = 'bad word test !';
      expect(normalizeModerationText(q1)).toBe(normalizeModerationText(q2));
      expect(moderationKeyHash(MOD_MODEL_A, POLICY_V1, q1)).toBe(
        moderationKeyHash(MOD_MODEL_A, POLICY_V1, q2),
      );
    });

    it('normalize is lower, trimmed and collapsed', () => {
      expect(normalizeModerationText('  Foo  BAR  ')).toBe('foo bar');
      expect(normalizeModerationText('  ')).toBe('');
    });
  });

  describe('key includes moderation_model and policy_version', () => {
    it('different moderation_model yields different hash', () => {
      const norm = normalizeModerationText('hello world');
      const ha = moderationCacheKey(MOD_MODEL_A, POLICY_V1, norm);
      const hb = moderationCacheKey(MOD_MODEL_B, POLICY_V1, norm);
      expect(ha).not.toBe(hb);
    });

    it('different policy_version yields different hash', () => {
      const norm = normalizeModerationText('hello world');
      const ha = moderationCacheKey(MOD_MODEL_A, POLICY_V1, norm);
      const hb = moderationCacheKey(MOD_MODEL_A, POLICY_V2, norm);
      expect(ha).not.toBe(hb);
    });

    it('key is sha256 hex 64 chars', () => {
      const norm = normalizeModerationText('test');
      const key = moderationCacheKey(MOD_MODEL_A, POLICY_V1, norm);
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(key).toBe(expectedHash(MOD_MODEL_A, POLICY_V1, norm));
    });
  });

  describe('TTL and invalidation on policy/model change', () => {
    it('serves within TTL and misses after expiry', () => {
      let now = 0;
      const cache = createModerationCache({ now: () => now, ttlMs: MODERATION_CACHE_TTL_MS });
      cache.setL1(MOD_MODEL_A, POLICY_V1, 'hello', 'allow');
      expect(cache.getL1(MOD_MODEL_A, POLICY_V1, 'hello')).toBe('allow');
      now = MODERATION_CACHE_TTL_MS - 1;
      expect(cache.getL1(MOD_MODEL_A, POLICY_V1, 'hello')).toBe('allow');
      now = MODERATION_CACHE_TTL_MS;
      expect(cache.getL1(MOD_MODEL_A, POLICY_V1, 'hello')).toBeUndefined();
    });

    it('policy version change is automatic invalidation', () => {
      const cache = createModerationCache();
      cache.setL1(MOD_MODEL_A, POLICY_V1, 'same text', 'allow');
      expect(cache.getL1(MOD_MODEL_A, POLICY_V2, 'same text')).toBeUndefined();
      expect(cache.getL1(MOD_MODEL_A, POLICY_V1, 'same text')).toBe('allow');
    });

    it('model change also invalidates', () => {
      const cache = createModerationCache();
      cache.setL1(MOD_MODEL_A, POLICY_V1, 'same text', 'block');
      expect(cache.getL1(MOD_MODEL_B, POLICY_V1, 'same text')).toBeUndefined();
      expect(cache.getL1(MOD_MODEL_A, POLICY_V1, 'same text')).toBe('block');
    });

    it('L2 TTL is respected', async () => {
      let now = 0;
      const { l2, store } = fakeL2();
      const cache = createModerationCache({ now: () => now, l2 });
      await cache.set(MOD_MODEL_A, POLICY_V1, 'hello', 'allow');
      expect(store.size).toBe(1);
      now = MODERATION_CACHE_TTL_MS + 1;
      const cache2 = createModerationCache({ now: () => now, l2 });
      const miss = await cache2.get(MOD_MODEL_A, POLICY_V1, 'hello');
      expect(miss).toBeUndefined();
    });
  });

  describe('isolation (bot model vs shared key)', () => {
    it('same text with different moderation_model is isolated', () => {
      const cache = createModerationCache();
      cache.setL1(MOD_MODEL_A, POLICY_V1, 'what is rag?', 'allow');
      expect(cache.getL1(MOD_MODEL_B, POLICY_V1, 'what is rag?')).toBeUndefined();
    });

    it('same model and policy is shared (hit) — moderation verdict is global per model+policy', () => {
      const cache = createModerationCache();
      cache.setL1(MOD_MODEL_A, POLICY_V1, 'hello world', 'allow');
      expect(cache.getL1(MOD_MODEL_A, POLICY_V1, 'hello world')).toBe('allow');
      expect(cache.getL1(MOD_MODEL_A, POLICY_V1, 'HELLO WORLD')).toBe('allow');
    });

    it('negative: different bot with different moderation_model must miss', () => {
      const cache = createModerationCache();
      cache.setL1(MOD_MODEL_A, POLICY_V1, 'hello', 'allow');
      // Bot B uses different moderation model -> miss
      expect(cache.getL1(MOD_MODEL_B, POLICY_V1, 'hello')).toBeUndefined();
    });

    it('negative: different bot with different policy_version must miss', () => {
      const cache = createModerationCache();
      cache.setL1(MOD_MODEL_A, POLICY_V1, 'hello', 'allow');
      expect(cache.getL1(MOD_MODEL_A, POLICY_V2, 'hello')).toBeUndefined();
    });

    it('L2 is also isolated by model+policy', async () => {
      const { l2 } = fakeL2();
      const now = 0;
      const cache = createModerationCache({ now: () => now, l2 });
      await cache.set(MOD_MODEL_A, POLICY_V1, 'shared', 'block');
      expect(await cache.get(MOD_MODEL_B, POLICY_V1, 'shared')).toBeUndefined();
      expect(await cache.get(MOD_MODEL_A, POLICY_V2, 'shared')).toBeUndefined();
      expect(await cache.get(MOD_MODEL_A, POLICY_V1, 'shared')).toBe('block');
    });
  });

  describe('raw query text never stored', () => {
    it('L1 keys are hashes, never raw text', () => {
      const cache = createModerationCache();
      const raw = 'Super Secret Moderation Text 123';
      cache.setL1(MOD_MODEL_A, POLICY_V1, raw, 'allow');
      const keys = cache._l1Keys();
      expect(keys.length).toBe(1);
      expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(keys[0]).not.toContain('Secret');
      const keyHash = moderationKeyHash(MOD_MODEL_A, POLICY_V1, raw);
      expect(keys[0]).toBe(keyHash);
    });

    it('L2 record never contains raw text', async () => {
      const { l2, store } = fakeL2();
      const cache = createModerationCache({ l2 });
      const raw = 'Another Secret Moderation Query';
      await cache.set(MOD_MODEL_A, POLICY_V1, raw, 'block');
      expect(store.size).toBe(1);
      const rec = [...store.values()][0]!;
      expect(rec.key_hash).toMatch(/^[0-9a-f]{64}$/);
      const keys = Object.keys(rec);
      expect(keys).not.toContain('text');
      expect(keys).not.toContain('query');
      expect(keys).not.toContain('normalised');
      expect(JSON.stringify(rec)).not.toContain('Secret');
      expect(rec.verdict).toBe('block');
      expect(rec.policy_version).toBe(POLICY_V1);
    });
  });

  describe('kill switch via cache_policy', () => {
    it('isModerationCacheEnabled true when missing or enabled', () => {
      expect(isModerationCacheEnabled(undefined)).toBe(true);
      expect(isModerationCacheEnabled(null)).toBe(true);
      expect(isModerationCacheEnabled({})).toBe(true);
      expect(isModerationCacheEnabled({ enabled: true })).toBe(true);
      expect(isModerationCacheEnabled({ c6: true })).toBe(true);
    });

    it('disabled when enabled:false or c6:false or moderation:false', () => {
      expect(isModerationCacheEnabled({ enabled: false })).toBe(false);
      expect(isModerationCacheEnabled({ c6: false })).toBe(false);
      expect(isModerationCacheEnabled({ moderation: false })).toBe(false);
      expect(isModerationCacheEnabled({ enabled: true, c6: false })).toBe(false);
    });

    it('bypass on setL1 and getL1 when kill switch disabled', () => {
      const cache = createModerationCache();
      const policy = { enabled: false };
      const hash = cache.setL1(MOD_MODEL_A, POLICY_V1, 'hello', 'allow', policy);
      expect(hash).toBeUndefined();
      expect(cache.size()).toBe(0);
      cache.setL1(MOD_MODEL_A, POLICY_V1, 'hello', 'allow');
      expect(cache.getL1(MOD_MODEL_A, POLICY_V1, 'hello', policy)).toBeUndefined();
    });

    it('bypass on full get/set with L2', async () => {
      const { l2, store } = fakeL2();
      const cache = createModerationCache({ l2 });
      const policy = { c6: false };
      const h = await cache.set(MOD_MODEL_A, POLICY_V1, 'hello', 'allow', policy);
      expect(h).toBeUndefined();
      expect(store.size).toBe(0);
      await cache.set(MOD_MODEL_A, POLICY_V1, 'hello', 'allow');
      expect(await cache.get(MOD_MODEL_A, POLICY_V1, 'hello', policy)).toBeUndefined();
      expect(await cache.get(MOD_MODEL_A, POLICY_V1, 'hello')).toBe('allow');
    });

    it('kill switch respects moderation_cache alias', () => {
      expect(isModerationCacheEnabled({ moderation_cache: false })).toBe(false);
    });
  });

  describe('fail closed and LRU', () => {
    it('missing/invalid model or policy never hits', () => {
      const cache = createModerationCache();
      cache.setL1(MOD_MODEL_A, POLICY_V1, 'hi', 'allow');
      expect(cache.getL1('', POLICY_V1, 'hi')).toBeUndefined();
      expect(cache.getL1(MOD_MODEL_A, '', 'hi')).toBeUndefined();
      expect(cache.setL1('', POLICY_V1, 'hi', 'allow')).toBeUndefined();
      expect(cache.setL1(MOD_MODEL_A, POLICY_V1, 'hi', 'invalid' as never)).toBeUndefined();
    });

    it('evicts LRU when over maxEntries', () => {
      const cache = createModerationCache({ maxEntries: 2 });
      cache.setL1(MOD_MODEL_A, POLICY_V1, 'q1', 'allow');
      cache.setL1(MOD_MODEL_A, POLICY_V1, 'q2', 'allow');
      cache.setL1(MOD_MODEL_A, POLICY_V1, 'q3', 'allow');
      expect(cache.size()).toBe(2);
      expect(cache.getL1(MOD_MODEL_A, POLICY_V1, 'q1')).toBeUndefined();
      expect(cache.getL1(MOD_MODEL_A, POLICY_V1, 'q2')).toBe('allow');
      expect(cache.getL1(MOD_MODEL_A, POLICY_V1, 'q3')).toBe('allow');
    });
  });
});
