// C2 — Bot config cache (plan.md P7.5 C2, TECH_SPECS 6.2).
//
// In-process LRU for bot_profiles + client_settings + public_bot_config rows.
// Keyed by bot_id + settings_version (bust immediately when the version changes,
// checked with a cheap read of bot_profiles.settings_version). TTL 30–60 s.
// Respects the kill switch in client_settings.cache_policy:
//   { enabled: false } or { c2: false } => bypass (never read or write).
// corpus_version is NOT part of the key — a corpus bump does not bust C2.
//
// No secrets, no raw IP, no assistant messages are cached. Only the three config
// rows. Fail closed: missing/invalid version or a disabled policy never serves
// a stale entry.

export const CONFIG_CACHE_TTL_MS = 45_000;
export const CONFIG_CACHE_TTL_MIN_MS = 30_000;
export const CONFIG_CACHE_TTL_MAX_MS = 60_000;
export const CONFIG_CACHE_MAX_ENTRIES = 200;

export interface ConfigCacheOptions {
  /** TTL in ms; clamped to 30–60 s. Default 45 s. */
  readonly ttlMs?: number;
  /** Max number of bots held. Default 200. */
  readonly maxEntries?: number;
  /** Clock; injected for tests. */
  readonly now?: () => number;
}

function clampTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined) return CONFIG_CACHE_TTL_MS;
  if (!Number.isFinite(ttlMs)) return CONFIG_CACHE_TTL_MS;
  if (ttlMs < CONFIG_CACHE_TTL_MIN_MS) return CONFIG_CACHE_TTL_MIN_MS;
  if (ttlMs > CONFIG_CACHE_TTL_MAX_MS) return CONFIG_CACHE_TTL_MAX_MS;
  return Math.trunc(ttlMs);
}

function clampMax(max: number | undefined): number {
  if (max === undefined) return CONFIG_CACHE_MAX_ENTRIES;
  if (!Number.isFinite(max) || max <= 0) return CONFIG_CACHE_MAX_ENTRIES;
  return Math.trunc(max);
}

// ---------------------------------------------------------------------------
// Helpers to extract well-known fields from any config shape the caller uses.
// The real ChatContext is { bot: { id, settings_version, corpus_version } },
// but tests may use a flatter shape; support both.
// ---------------------------------------------------------------------------

export function extractSettingsVersion(config: unknown): number | undefined {
  if (config === null || config === undefined || typeof config !== 'object') return undefined;
  const c = config as Record<string, unknown>;
  if (typeof c['settings_version'] === 'number' && Number.isFinite(c['settings_version'])) {
    return c['settings_version'] as number;
  }
  if (typeof c['settingsVersion'] === 'number' && Number.isFinite(c['settingsVersion'])) {
    return c['settingsVersion'] as number;
  }
  const bot = c['bot'];
  if (bot !== null && bot !== undefined && typeof bot === 'object') {
    const b = bot as Record<string, unknown>;
    if (typeof b['settings_version'] === 'number' && Number.isFinite(b['settings_version'])) {
      return b['settings_version'] as number;
    }
    if (typeof b['settingsVersion'] === 'number' && Number.isFinite(b['settingsVersion'])) {
      return b['settingsVersion'] as number;
    }
  }
  return undefined;
}

export function extractCorpusVersion(config: unknown): number | undefined {
  if (config === null || config === undefined || typeof config !== 'object') return undefined;
  const c = config as Record<string, unknown>;
  if (typeof c['corpus_version'] === 'number' && Number.isFinite(c['corpus_version'])) {
    return c['corpus_version'] as number;
  }
  if (typeof c['corpusVersion'] === 'number' && Number.isFinite(c['corpusVersion'])) {
    return c['corpusVersion'] as number;
  }
  const bot = c['bot'];
  if (bot !== null && bot !== undefined && typeof bot === 'object') {
    const b = bot as Record<string, unknown>;
    if (typeof b['corpus_version'] === 'number' && Number.isFinite(b['corpus_version'])) {
      return b['corpus_version'] as number;
    }
    if (typeof b['corpusVersion'] === 'number' && Number.isFinite(b['corpusVersion'])) {
      return b['corpusVersion'] as number;
    }
  }
  return undefined;
}

export function extractBotId(config: unknown): string | undefined {
  if (config === null || config === undefined || typeof config !== 'object') return undefined;
  const c = config as Record<string, unknown>;
  if (typeof c['bot_id'] === 'string') return c['bot_id'] as string;
  if (typeof c['botId'] === 'string') return c['botId'] as string;
  const bot = c['bot'];
  if (bot !== null && bot !== undefined && typeof bot === 'object') {
    const b = bot as Record<string, unknown>;
    if (typeof b['id'] === 'string') return b['id'] as string;
    if (typeof b['bot_id'] === 'string') return b['bot_id'] as string;
  }
  return undefined;
}

export function extractCachePolicy(config: unknown): unknown {
  if (config === null || config === undefined || typeof config !== 'object') return undefined;
  const c = config as Record<string, unknown>;
  // Direct field
  if ('cache_policy' in c) return c['cache_policy'];
  if ('cachePolicy' in c) return c['cachePolicy'];
  // Nested under client_settings / clientSettings
  const cs =
    (c['client_settings'] as unknown) ??
    (c['clientSettings'] as unknown) ??
    (c['client_settings'] as unknown);
  if (cs !== null && cs !== undefined && typeof cs === 'object') {
    const inner = cs as Record<string, unknown>;
    if ('cache_policy' in inner) return inner['cache_policy'];
    if ('cachePolicy' in inner) return inner['cachePolicy'];
  }
  // Production get_chat_context nests the policy under settings. Preserve
  // the legacy top-level/client_settings precedence before this fallback.
  const settings = c['settings'];
  if (settings !== null && typeof settings === 'object') {
    const inner = settings as Record<string, unknown>;
    if ('cache_policy' in inner) return inner['cache_policy'];
    if ('cachePolicy' in inner) return inner['cachePolicy'];
  }
  return undefined;
}

// Kill switch: enabled === false OR c2 === false => C2 disabled. Missing => enabled.
// This mirrors the assignment packet wording exactly.
export function isC2Enabled(cachePolicy: unknown): boolean {
  if (cachePolicy === null || cachePolicy === undefined) return true;
  if (typeof cachePolicy !== 'object') return true;
  const p = cachePolicy as Record<string, unknown>;
  if (p['kill_switch'] === true) return false;
  if (p['enabled'] === false) return false;
  if (p['c2'] === false) return false;
  return true;
}

interface Entry<T> {
  readonly config: T;
  readonly settingsVersion: number;
  readonly cachedAt: number;
}

/**
 * In-process LRU for one bot's config. The caller owns fetching.
 *
 * Usage:
 *  const cache = new ConfigCache({ ttlMs: 45_000 });
 *  // cheap version check (e.g. SELECT settings_version FROM bot_profiles WHERE id = $1)
 *  const version = await getSettingsVersion(botId); // cheap
 *  const hit = cache.get(botId, version); // undefined => miss
 *  if (hit === undefined) {
 *    const fresh = await fetchFullConfig(botId); // get_chat_context
 *    cache.set(botId, fresh); // respects kill switch; no-op when disabled
 *  }
 *
 *  Or the convenience loader:
 *  const cfg = await cache.load(botId, fetchFullConfig, getSettingsVersion);
 */
export class ConfigCache<T = unknown> {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #map: Map<string, Entry<T>> = new Map();

  constructor(options: ConfigCacheOptions = {}) {
    this.#ttlMs = clampTtl(options.ttlMs);
    this.#maxEntries = clampMax(options.maxEntries);
    this.#now = options.now ?? Date.now;
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  get maxEntries(): number {
    return this.#maxEntries;
  }

  size(): number {
    return this.#map.size;
  }

  clear(): void {
    this.#map.clear();
  }

  delete(botId: string): boolean {
    return this.#map.delete(botId);
  }

  has(botId: string): boolean {
    return this.#map.has(botId);
  }

  #isExpired(entry: Entry<T>): boolean {
    return this.#now() - entry.cachedAt >= this.#ttlMs;
  }

  #promote(botId: string, entry: Entry<T>): void {
    // Move to most-recently-used (end of Map iteration).
    this.#map.delete(botId);
    this.#map.set(botId, entry);
  }

  #evictIfNeeded(): void {
    while (this.#map.size > this.#maxEntries) {
      const first = this.#map.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.#map.delete(first);
    }
  }

  /**
   * Try to return a cached config for botId.
   *
   * @param botId - visitor's bot
   * @param currentSettingsVersion - cheap current version from bot_profiles.settings_version.
   *   When provided and it differs from the cached entry's version, the entry is
   *   treated as a miss and evicted (immediate bust). When omitted, only TTL is checked.
   * @returns cached config or undefined on miss/expired/disabled.
   */
  get(botId: string, currentSettingsVersion?: number): T | undefined {
    const entry = this.#map.get(botId);
    if (entry === undefined) return undefined;

    // TTL: 30–60 s (clamped at construction).
    if (this.#isExpired(entry)) {
      this.#map.delete(botId);
      return undefined;
    }

    // Kill switch: cached entry whose policy says disabled is never served.
    if (!isC2Enabled(extractCachePolicy(entry.config))) {
      this.#map.delete(botId);
      return undefined;
    }

    // Immediate bust when settings_version changed (checked cheaply).
    if (
      currentSettingsVersion !== undefined &&
      Number.isFinite(currentSettingsVersion) &&
      currentSettingsVersion !== entry.settingsVersion
    ) {
      this.#map.delete(botId);
      return undefined;
    }

    // Corpus version must NOT bust C2 — intentionally not checked here.
    this.#promote(botId, entry);
    return entry.config;
  }

  /**
   * Store config for botId. No-op when the kill switch is disabled or when
   * settings_version cannot be determined (fail closed: do not cache).
   */
  set(botId: string, config: T): void {
    const policy = extractCachePolicy(config);
    if (!isC2Enabled(policy)) {
      // Disabled: do not cache; remove any stale entry.
      this.#map.delete(botId);
      return;
    }

    const version = extractSettingsVersion(config);
    if (version === undefined || !Number.isFinite(version)) {
      // Fail closed: without a version we cannot bust correctly.
      return;
    }

    // Validate that the config's bot id matches the key when both are present
    // (prevents cross-bot poisoning if caller mixed keys).
    const cfgBotId = extractBotId(config);
    if (cfgBotId !== undefined && cfgBotId !== botId) {
      // Caller supplied a config for a different bot — do not store under this key.
      return;
    }

    const entry: Entry<T> = { config, settingsVersion: version, cachedAt: this.#now() };
    // Promote to MRU.
    this.#map.delete(botId);
    this.#map.set(botId, entry);
    this.#evictIfNeeded();
  }

  /**
   * Convenience: get-or-fetch with one call. On miss (expired, version bust,
   * kill switch, or absent) it calls fetcher, stores the result when caching
   * is enabled, and returns it. The cheap version check is done via
   * versionFetcher when provided; otherwise only TTL and kill switch apply
   * before the fetch, and the fresh fetch is always taken.
   *
   * @param botId
   * @param fetcher - loads the full config (e.g. get_chat_context)
   * @param versionFetcher - cheap read of bot_profiles.settings_version (optional)
   * @param cachePolicyGetter - optional override to obtain the policy from the config
   */
  async load(
    botId: string,
    fetcher: (botId: string) => Promise<T>,
    versionFetcher?: (botId: string) => Promise<number>,
    cachePolicyGetter?: (config: T) => unknown,
  ): Promise<T> {
    // Fast path: cached and not expired, with optional cheap version bust.
    const cached = this.#map.get(botId);
    if (cached !== undefined && !this.#isExpired(cached)) {
      const cachedPolicy = cachePolicyGetter
        ? cachePolicyGetter(cached.config)
        : extractCachePolicy(cached.config);
      if (!isC2Enabled(cachedPolicy)) {
        this.#map.delete(botId);
      } else {
        let currentVersion: number | undefined;
        let versionOk = true;
        if (versionFetcher !== undefined) {
          try {
            currentVersion = await versionFetcher(botId);
          } catch {
            // Version check failed — fail closed: treat as miss so we refetch.
            versionOk = false;
            this.#map.delete(botId);
          }
          if (
            versionOk &&
            currentVersion !== undefined &&
            Number.isFinite(currentVersion) &&
            currentVersion !== cached.settingsVersion
          ) {
            this.#map.delete(botId);
          } else if (versionOk) {
            this.#promote(botId, cached);
            return cached.config;
          }
        } else {
          // No cheap checker — serve the TTL-valid entry.
          this.#promote(botId, cached);
          return cached.config;
        }
      }
    } else if (cached !== undefined) {
      this.#map.delete(botId);
    }

    // Miss: fetch fresh.
    const fresh = await fetcher(botId);
    const policy = cachePolicyGetter ? cachePolicyGetter(fresh) : extractCachePolicy(fresh);
    if (!isC2Enabled(policy)) {
      this.#map.delete(botId);
      return fresh;
    }
    const version = extractSettingsVersion(fresh);
    if (version === undefined || !Number.isFinite(version)) {
      // Fail closed: do not cache entries without a version.
      return fresh;
    }
    const freshBotId = extractBotId(fresh);
    if (freshBotId !== undefined && freshBotId !== botId) {
      return fresh;
    }
    const entry: Entry<T> = { config: fresh, settingsVersion: version, cachedAt: this.#now() };
    this.#map.delete(botId);
    this.#map.set(botId, entry);
    this.#evictIfNeeded();
    return fresh;
  }

  /** Visible for tests: snapshot of internal entry. */
  _peekEntry(botId: string): { settingsVersion: number; cachedAt: number } | undefined {
    const e = this.#map.get(botId);
    if (e === undefined) return undefined;
    return { settingsVersion: e.settingsVersion, cachedAt: e.cachedAt };
  }
}

export function createConfigCache<T = unknown>(options?: ConfigCacheOptions): ConfigCache<T> {
  return new ConfigCache<T>(options);
}
