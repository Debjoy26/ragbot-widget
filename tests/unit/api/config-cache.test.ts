import { describe, it, expect } from 'vitest';
import {
  ConfigCache,
  createConfigCache,
  isC2Enabled,
  extractSettingsVersion,
  extractCachePolicy,
  CONFIG_CACHE_TTL_MS,
  CONFIG_CACHE_TTL_MIN_MS,
  CONFIG_CACHE_TTL_MAX_MS,
} from '../../../api/src/services/config-cache.ts';

// Helper to build a minimal bot config snapshot (the three rows collapsed).
// The real DB shape is ChatContext-like: { bot: { id, settings_version, corpus_version } }
// plus a cache_policy somewhere (here top-level for simplicity).
function botConfig(opts: {
  botId: string;
  settingsVersion: number;
  corpusVersion?: number;
  cachePolicy?: unknown;
  extra?: Record<string, unknown>;
}) {
  return {
    bot: {
      id: opts.botId,
      settings_version: opts.settingsVersion,
      corpus_version: opts.corpusVersion ?? 1,
      slug: 'test-bot',
      enabled: true,
    },
    // Expose cache_policy at top level so extractCachePolicy finds it.
    cache_policy: opts.cachePolicy,
    // Also mirror into client_settings for the alternative extraction path.
    client_settings: { cache_policy: opts.cachePolicy },
    ...opts.extra,
  };
}

describe('C2 config cache — api/src/services/config-cache.ts', () => {
  describe('TTL', () => {
    it('default TTL is within 30–60 s', () => {
      const c = createConfigCache();
      expect(c.ttlMs).toBeGreaterThanOrEqual(CONFIG_CACHE_TTL_MIN_MS);
      expect(c.ttlMs).toBeLessThanOrEqual(CONFIG_CACHE_TTL_MAX_MS);
      expect(c.ttlMs).toBe(CONFIG_CACHE_TTL_MS);
    });

    it('clamps TTL below 30 s to 30 s and above 60 s to 60 s', () => {
      expect(new ConfigCache({ ttlMs: 1_000 }).ttlMs).toBe(CONFIG_CACHE_TTL_MIN_MS);
      expect(new ConfigCache({ ttlMs: 5_000 }).ttlMs).toBe(CONFIG_CACHE_TTL_MIN_MS);
      expect(new ConfigCache({ ttlMs: 120_000 }).ttlMs).toBe(CONFIG_CACHE_TTL_MAX_MS);
    });

    it('serves within TTL and misses after expiry (injected clock)', () => {
      let now = 0;
      const cache = new ConfigCache({ ttlMs: 30_000, now: () => now });
      const id = 'bot-ttl-1';
      cache.set(id, botConfig({ botId: id, settingsVersion: 1 }));
      expect(cache.get(id, 1)).toBeDefined();

      now = 29_999;
      expect(cache.get(id, 1)).toBeDefined();

      now = 30_000; // exactly TTL -> expired (>=)
      expect(cache.get(id, 1)).toBeUndefined();

      // After expiry, a fresh set is required.
      now = 30_001;
      cache.set(id, botConfig({ botId: id, settingsVersion: 1 }));
      expect(cache.get(id, 1)).toBeDefined();
    });

    it('TTL 60 s still holds at 59.9 s', () => {
      let now = 0;
      const cache = new ConfigCache({ ttlMs: 60_000, now: () => now });
      const id = 'bot-ttl-60';
      cache.set(id, botConfig({ botId: id, settingsVersion: 1 }));
      now = 59_900;
      expect(cache.get(id, 1)).toBeDefined();
      now = 60_000;
      expect(cache.get(id, 1)).toBeUndefined();
    });
  });

  describe('kill switch via client_settings.cache_policy', () => {
    it('isC2Enabled: missing or empty policy => enabled', () => {
      expect(isC2Enabled(undefined)).toBe(true);
      expect(isC2Enabled(null)).toBe(true);
      expect(isC2Enabled({})).toBe(true);
      expect(isC2Enabled({ enabled: true })).toBe(true);
      expect(isC2Enabled({ c2: true })).toBe(true);
      expect(isC2Enabled({ enabled: true, c2: true })).toBe(true);
    });

    it('isC2Enabled: enabled false => disabled', () => {
      expect(isC2Enabled({ enabled: false })).toBe(false);
      expect(isC2Enabled({ enabled: false, c2: true })).toBe(false);
    });

    it('isC2Enabled: c2 false => disabled', () => {
      expect(isC2Enabled({ c2: false })).toBe(false);
      expect(isC2Enabled({ enabled: true, c2: false })).toBe(false);
      expect(isC2Enabled({ c2: false, extra: 1 })).toBe(false);
    });

    it('bypass on set: when policy says disabled, nothing is cached', () => {
      const cache = new ConfigCache();
      const id = 'bot-kill-1';
      cache.set(id, botConfig({ botId: id, settingsVersion: 1, cachePolicy: { enabled: false } }));
      expect(cache.size()).toBe(0);
      expect(cache.get(id, 1)).toBeUndefined();

      cache.set(id, botConfig({ botId: id, settingsVersion: 1, cachePolicy: { c2: false } }));
      expect(cache.size()).toBe(0);
    });

    it('bypass on get: a cached entry whose policy later reads as disabled is treated as a miss', () => {
      // Simulate a policy that was enabled at set time but the cached object
      // itself carries a disabled flag (e.g. caller mutated it or policy shape changed).
      const cache = new ConfigCache();
      const id = 'bot-kill-2';
      const cfg = botConfig({ botId: id, settingsVersion: 1, cachePolicy: { enabled: true } });
      cache.set(id, cfg);
      expect(cache.get(id, 1)).toBeDefined();
      // Mutate the cached object's policy to disabled — get should miss.
      (cfg as unknown as Record<string, unknown>)['cache_policy'] = { enabled: false };
      // The entry still holds the same object reference, so the check sees disabled.
      expect(cache.get(id, 1)).toBeUndefined();
      expect(cache.size()).toBe(0);
    });

    it('load(): fetcher that returns a disabled policy is not cached', async () => {
      const cache = new ConfigCache();
      const id = 'bot-kill-load';
      let calls = 0;
      const fetcher = async () => {
        calls += 1;
        return botConfig({ botId: id, settingsVersion: 1, cachePolicy: { enabled: false } });
      };
      const first = await cache.load(id, fetcher);
      expect(first).toBeDefined();
      expect(cache.size()).toBe(0);
      const second = await cache.load(id, fetcher);
      expect(second).toBeDefined();
      expect(calls).toBe(2); // second call fetched again, not from cache
    });

    it('load(): enabled policy is cached, disabled fetch after bypass does not pollute', async () => {
      const cache = new ConfigCache();
      const id = 'bot-kill-mix';
      let mode: 'enabled' | 'disabled' = 'enabled';
      const fetcher = async () =>
        mode === 'enabled'
          ? botConfig({ botId: id, settingsVersion: 1, cachePolicy: { enabled: true } })
          : botConfig({ botId: id, settingsVersion: 1, cachePolicy: { enabled: false } });

      // First enabled => cached
      await cache.load(id, fetcher);
      expect(cache.size()).toBe(1);

      // Switch to disabled fetcher but bypass path when loading should still not cache.
      // Force a miss via version bump so we actually call fetcher.
      mode = 'disabled';
      // Use versionFetcher to force bust: current version 2 vs cached 1
      const versionFetcher = async () => 2;
      const fetched = await cache.load(id, fetcher, versionFetcher);
      expect((fetched as unknown as Record<string, unknown>)['cache_policy']).toEqual({ enabled: false });
      expect(cache.size()).toBe(0); // disabled result not stored
    });
  });

  describe('isolation (bot A vs B)', () => {
    it('bot A and B have independent entries', () => {
      const cache = new ConfigCache();
      const a = 'bot-A';
      const b = 'bot-B';
      cache.set(a, botConfig({ botId: a, settingsVersion: 1 }));
      cache.set(b, botConfig({ botId: b, settingsVersion: 1 }));

      expect((cache.get(a, 1) as ReturnType<typeof botConfig>)?.bot.id).toBe(a);
      expect((cache.get(b, 1) as ReturnType<typeof botConfig>)?.bot.id).toBe(b);

      // Updating A does not affect B
      cache.set(a, botConfig({ botId: a, settingsVersion: 2 }));
      expect((cache.get(a, 2) as ReturnType<typeof botConfig>)?.bot.settings_version).toBe(2);
      expect((cache.get(b, 1) as ReturnType<typeof botConfig>)?.bot.settings_version).toBe(1);
    });

    it('a stale version for one bot does not leak to another', () => {
      const cache = new ConfigCache();
      const a = 'bot-A2';
      const b = 'bot-B2';
      cache.set(a, botConfig({ botId: a, settingsVersion: 5 }));
      cache.set(b, botConfig({ botId: b, settingsVersion: 9 }));

      // Query A with B's version => miss (but B still hit with its own)
      expect(cache.get(a, 9)).toBeUndefined();
      expect(cache.get(b, 9)).toBeDefined();
      // Re-insert A with correct version
      cache.set(a, botConfig({ botId: a, settingsVersion: 9 }));
      expect(cache.get(a, 9)).toBeDefined();
    });

    it('load() keeps bot isolation', async () => {
      const cache = new ConfigCache();
      const a = 'bot-iso-a';
      const b = 'bot-iso-b';
      const fetchA = async () => botConfig({ botId: a, settingsVersion: 3 });
      const fetchB = async () => botConfig({ botId: b, settingsVersion: 7 });
      await cache.load(a, fetchA);
      await cache.load(b, fetchB);
      expect((cache.get(a, 3) as ReturnType<typeof botConfig>)?.bot.settings_version).toBe(3);
      expect((cache.get(b, 7) as ReturnType<typeof botConfig>)?.bot.settings_version).toBe(7);
      expect(cache.get(a, 7)).toBeUndefined();
      expect(cache.get(b, 3)).toBeUndefined();
    });

    it('mismatched bot id on set is rejected (no cross-poisoning)', () => {
      const cache = new ConfigCache();
      const real = 'bot-real';
      const other = 'bot-other';
      // Try to store a config whose inner bot id is "other" under key "real"
      cache.set(real, botConfig({ botId: other, settingsVersion: 1 }));
      expect(cache.get(real, 1)).toBeUndefined();
      expect(cache.size()).toBe(0);
    });
  });

  describe('invalidation on settings_version bump', () => {
    it('a bump busts immediately even though TTL has not elapsed (get with currentVersion)', () => {
      let now = 0;
      const cache = new ConfigCache({ ttlMs: 60_000, now: () => now });
      const id = 'bot-bump-1';
      cache.set(id, botConfig({ botId: id, settingsVersion: 1 }));
      now = 1_000; // well within TTL
      // Cheap check says current is still 1 => hit
      expect(cache.get(id, 1)).toBeDefined();
      // Cheap check says current is now 2 => bust
      expect(cache.get(id, 2)).toBeUndefined();
      expect(cache.size()).toBe(0);
    });

    it('negative case: stale cache must miss after settings_version change (the bug if not bust)', () => {
      // This is the regression: without version check, a 30-s-old entry would incorrectly hit.
      let now = 0;
      const cache = new ConfigCache({ ttlMs: 60_000, now: () => now });
      const id = 'bot-stale-neg';
      cache.set(id, botConfig({ botId: id, settingsVersion: 1 }));
      now = 10_000; // within TTL, stale would still appear fresh by time alone

      // Correct: version 2 => miss
      const staleHit = cache.get(id, 2);
      expect(staleHit).toBeUndefined();
      // If the implementation only used TTL, staleHit would be defined — that would be the bug.

      // After miss, caller refetches v2 and caches it; subsequent get with v2 hits.
      cache.set(id, botConfig({ botId: id, settingsVersion: 2 }));
      expect(cache.get(id, 2)).toBeDefined();
      // Old version never returns again
      expect(cache.get(id, 1)).toBeUndefined();
    });

    it('load() with versionFetcher busts on bump and re-caches the new version', async () => {
      const cache = new ConfigCache();
      const id = 'bot-load-bump';
      let currentVersion = 1;
      const versionFetcher = async () => currentVersion;
      let fetcherCalls = 0;
      const fetcher = async () => {
        fetcherCalls += 1;
        return botConfig({ botId: id, settingsVersion: currentVersion });
      };

      // First load caches v1
      await cache.load(id, fetcher, versionFetcher);
      expect(fetcherCalls).toBe(1);
      // Second load, same version => hit, no fetch
      await cache.load(id, fetcher, versionFetcher);
      expect(fetcherCalls).toBe(1);

      // Bump version
      currentVersion = 2;
      await cache.load(id, fetcher, versionFetcher);
      expect(fetcherCalls).toBe(2);
      // Now cached is v2
      expect(cache.get(id, 2)).toBeDefined();
      expect(cache.get(id, 1)).toBeUndefined();
    });

    it('load() fails closed when version check throws: refetches', async () => {
      const cache = new ConfigCache();
      const id = 'bot-version-err';
      cache.set(id, botConfig({ botId: id, settingsVersion: 1 }));
      const versionFetcher = async () => {
        throw new Error('cheap check failed');
      };
      let fetcherCalls = 0;
      const fetcher = async () => {
        fetcherCalls += 1;
        return botConfig({ botId: id, settingsVersion: 2 });
      };
      await cache.load(id, fetcher, versionFetcher);
      expect(fetcherCalls).toBe(1);
      expect(cache.get(id, 2)).toBeDefined();
    });
  });

  describe('corpus_version bump does NOT affect C2', () => {
    it('a corpus_version change alone still hits when settings_version is unchanged', () => {
      const cache = new ConfigCache();
      const id = 'bot-corpus-1';
      cache.set(id, botConfig({ botId: id, settingsVersion: 4, corpusVersion: 10 }));
      // Same settings_version, different corpus_version in the stored vs "current" world
      // The cache only keys on settings_version, so this must still hit.
      expect(cache.get(id, 4)).toBeDefined();

      // Simulate that the DB now has corpus_version 11 but same settings_version.
      // Our get does not check corpus_version at all, so it stays a hit.
      const hit = cache.get(id, 4) as ReturnType<typeof botConfig>;
      expect(hit?.bot.corpus_version).toBe(10); // the cached value, not the new DB one

      // If the caller stored a fresh config with bumped corpus_version but same settings_version,
      // the second set overwrites; get still hits (by settings_version).
      cache.set(id, botConfig({ botId: id, settingsVersion: 4, corpusVersion: 11 }));
      expect(cache.get(id, 4)).toBeDefined();
      expect((cache.get(id, 4) as ReturnType<typeof botConfig>)?.bot.corpus_version).toBe(11);
    });

    it('corpus_version bump with settings_version bump does bust (because settings_version did)', () => {
      const id = 'bot-corpus-2';
      // Before bump: v4 hits
      const before = new ConfigCache();
      before.set(id, botConfig({ botId: id, settingsVersion: 4, corpusVersion: 10 }));
      expect(before.get(id, 4)).toBeDefined();
      // After bump: v5 hits, v4 misses (separate caches so eviction does not interfere)
      const after = new ConfigCache();
      after.set(id, botConfig({ botId: id, settingsVersion: 5, corpusVersion: 11 }));
      expect(after.get(id, 5)).toBeDefined();
      const miss = new ConfigCache();
      miss.set(id, botConfig({ botId: id, settingsVersion: 5, corpusVersion: 11 }));
      expect(miss.get(id, 4)).toBeUndefined();
    });

    it('extract helpers do not conflate the two versions', () => {
      const cfg = botConfig({ botId: 'x', settingsVersion: 7, corpusVersion: 99 });
      expect(extractSettingsVersion(cfg)).toBe(7);
      // Corpus extractor should see 99
      // (imported helper not exported for corpus but we check via direct field)
      expect((cfg as { bot: { corpus_version: number } }).bot.corpus_version).toBe(99);
    });
  });

  describe('LRU and fail closed', () => {
    it('evicts the least-recently-used entry when over maxEntries', () => {
      const cache = new ConfigCache({ maxEntries: 2 });
      cache.set('b1', botConfig({ botId: 'b1', settingsVersion: 1 }));
      cache.set('b2', botConfig({ botId: 'b2', settingsVersion: 1 }));
      cache.set('b3', botConfig({ botId: 'b3', settingsVersion: 1 }));
      expect(cache.size()).toBe(2);
      expect(cache.get('b1', 1)).toBeUndefined(); // evicted
      expect(cache.get('b2', 1)).toBeDefined();
      expect(cache.get('b3', 1)).toBeDefined();
    });

    it('access promotes to MRU, so the next eviction spares it', () => {
      const cache = new ConfigCache({ maxEntries: 2 });
      cache.set('b1', botConfig({ botId: 'b1', settingsVersion: 1 }));
      cache.set('b2', botConfig({ botId: 'b2', settingsVersion: 1 }));
      // Touch b1 -> MRU, so b2 becomes LRU
      expect(cache.get('b1', 1)).toBeDefined();
      cache.set('b3', botConfig({ botId: 'b3', settingsVersion: 1 }));
      expect(cache.get('b2', 1)).toBeUndefined();
      expect(cache.get('b1', 1)).toBeDefined();
      expect(cache.get('b3', 1)).toBeDefined();
    });

    it('missing settings_version => fail closed (do not cache)', () => {
      const cache = new ConfigCache();
      const bad = { bot: { id: 'bad', slug: 'x' } } as unknown as ReturnType<typeof botConfig>;
      cache.set('bad', bad);
      expect(cache.size()).toBe(0);
      expect(cache.get('bad')).toBeUndefined();
    });

    it('extract helpers handle flat and nested shapes', () => {
      expect(extractSettingsVersion({ settings_version: 3 })).toBe(3);
      expect(extractSettingsVersion({ bot: { settings_version: 4 } })).toBe(4);
      expect(extractSettingsVersion({ settingsVersion: 5 })).toBe(5);
      expect(extractCachePolicy({ cache_policy: { enabled: false } })).toEqual({ enabled: false });
      expect(extractCachePolicy({ client_settings: { cache_policy: { c2: false } } })).toEqual({
        c2: false,
      });
    });
  });
});
