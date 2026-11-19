// C4 — Query embedding cache (plan.md P7.5 C4, TECH_SPECS §6.2).
//
// L1 in-process LRU + L2 Postgres query_embedding_cache.
// Key: sha256(embedding_model ‖ embedding_dimensions ‖ normalised_query)
//   where normalised_query = NFKC + trim + collapse whitespace + lower.
// Storage: embedding vector only (raw query text is never stored, only its hash).
// TTL 7–30 days (default 7). Expired entries are treated as miss.
// Kill switch via client_settings.cache_policy:
//   { enabled: false } or { c4: false } or { embedding: false } => bypass.
//
// No secrets, no visitor identifiers, no raw query are stored.
// Fail closed: missing/invalid model or dimensions never hits.

import { createHash } from 'node:crypto';

export const EMBEDDING_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const EMBEDDING_CACHE_TTL_MIN_MS = 7 * 24 * 60 * 60 * 1000;
export const EMBEDDING_CACHE_TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;
export const EMBEDDING_CACHE_MAX_ENTRIES = 500;

export interface EmbeddingCacheOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

function clampTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined) return EMBEDDING_CACHE_TTL_MS;
  if (!Number.isFinite(ttlMs)) return EMBEDDING_CACHE_TTL_MS;
  if (ttlMs < EMBEDDING_CACHE_TTL_MIN_MS) return EMBEDDING_CACHE_TTL_MIN_MS;
  if (ttlMs > EMBEDDING_CACHE_TTL_MAX_MS) return EMBEDDING_CACHE_TTL_MAX_MS;
  return Math.trunc(ttlMs);
}

function clampMax(max: number | undefined): number {
  if (max === undefined) return EMBEDDING_CACHE_MAX_ENTRIES;
  if (!Number.isFinite(max) || max <= 0) return EMBEDDING_CACHE_MAX_ENTRIES;
  return Math.trunc(max);
}

// ---------------------------------------------------------------------------
// Normalisation — must be exactly: NFKC → trim → collapse whitespace → lower.
// Assignment (§P7.5): normalised_query lower+trim+collapse+NFKC.
// Order is NFKC first (so compatibility characters are mapped before case
// folding), then trim/collapse/lower. Tests check the combined effect.
// ---------------------------------------------------------------------------

export function normalizeQuery(text: string): string {
  // NFKC normalisation
  const nfkc = text.normalize('NFKC');
  // trim + collapse whitespace (including newlines/tabs) to a single space
  const collapsed = nfkc.trim().replace(/\s+/g, ' ');
  return collapsed.toLowerCase();
}

// ---------------------------------------------------------------------------
// Hash: sha256(model‖dimensions‖normalised). Delimiter U+001F (unit separator)
// never appears in model IDs, dimensions or normalised queries, so the
// concatenation is unambiguous. Cross-model isolation follows from the hash
// including model and dimensions; a model change is an automatic miss.
// ---------------------------------------------------------------------------

export function embeddingCacheKey(
  model: string,
  dimensions: number,
  normalisedQuery: string,
): string {
  const payload = `${model}\x1f${String(dimensions)}\x1f${normalisedQuery}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

// Convenience that normalises then hashes.
export function embeddingKeyHash(model: string, dimensions: number, rawQuery: string): string {
  return embeddingCacheKey(model, dimensions, normalizeQuery(rawQuery));
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

export function isEmbeddingCacheEnabled(cachePolicy: unknown): boolean {
  if (cachePolicy === null || cachePolicy === undefined) return true;
  if (typeof cachePolicy !== 'object') return true;
  const p = cachePolicy as Record<string, unknown>;
  if (p['kill_switch'] === true) return false;
  if (p['enabled'] === false) return false;
  if (p['c4'] === false) return false;
  if (p['embedding'] === false) return false;
  if (p['embeddings'] === false) return false;
  if (p['query_embedding'] === false) return false;
  return true;
}

// L2 record shape as stored in Postgres (never includes raw text).
export interface EmbeddingCacheRecord {
  readonly key_hash: string;
  readonly embedding_model: string;
  readonly embedding_dimensions: number;
  readonly embedding: readonly number[];
  readonly created_at: string;
  readonly last_hit_at: string | null;
  readonly expires_at: string;
}

// L1 entry — raw text never stored.
interface L1Entry {
  readonly vector: readonly number[];
  readonly model: string;
  readonly dimensions: number;
  readonly normalised: string;
  readonly keyHash: string;
  readonly cachedAt: number;
  readonly expiresAt: number;
}

// Minimal L2 interface that tests can fake and production can adapt to Db.
// Raw query text is never passed to L2.
export interface EmbeddingL2 {
  get(keyHash: string): Promise<EmbeddingCacheRecord | null>;
  set(record: EmbeddingCacheRecord): Promise<void>;
}

export class EmbeddingCache {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #map: Map<string, L1Entry> = new Map();
  readonly #l2: EmbeddingL2 | undefined;

  constructor(options: EmbeddingCacheOptions & { l2?: EmbeddingL2 } = {}) {
    this.#ttlMs = clampTtl(options.ttlMs);
    this.#maxEntries = clampMax(options.maxEntries);
    this.#now = options.now ?? Date.now;
    this.#l2 = options.l2;
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

  #isExpired(entry: L1Entry, now: number): boolean {
    return now >= entry.expiresAt;
  }

  #promote(keyHash: string, entry: L1Entry): void {
    this.#map.delete(keyHash);
    this.#map.set(keyHash, entry);
  }

  #evictIfNeeded(): void {
    while (this.#map.size > this.#maxEntries) {
      const first = this.#map.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.#map.delete(first);
    }
  }

  // Try L1 only. Returns vector or undefined on miss/expired/disabled.
  getL1(
    model: string,
    dimensions: number,
    rawQuery: string,
    cachePolicy?: unknown,
  ): readonly number[] | undefined {
    if (!isEmbeddingCacheEnabled(cachePolicy)) return undefined;
    if (typeof model !== 'string' || model.length === 0) return undefined;
    if (!Number.isFinite(dimensions) || dimensions <= 0) return undefined;
    const normalised = normalizeQuery(rawQuery);
    const keyHash = embeddingCacheKey(model, dimensions, normalised);
    const entry = this.#map.get(keyHash);
    if (entry === undefined) return undefined;
    const now = this.#now();
    if (this.#isExpired(entry, now)) {
      this.#map.delete(keyHash);
      return undefined;
    }
    // Model/dimensions already in hash, but double-check stored entry matches to catch corruption
    if (entry.model !== model || entry.dimensions !== dimensions) return undefined;
    this.#promote(keyHash, entry);
    return entry.vector;
  }

  // Store in L1. Raw text never stored — only normalised hash path.
  // No-op when kill switch disabled or inputs invalid.
  setL1(
    model: string,
    dimensions: number,
    rawQuery: string,
    vector: readonly number[],
    cachePolicy?: unknown,
  ): string | undefined {
    if (!isEmbeddingCacheEnabled(cachePolicy)) return undefined;
    if (typeof model !== 'string' || model.length === 0) return undefined;
    if (!Number.isFinite(dimensions) || dimensions <= 0) return undefined;
    if (!Array.isArray(vector) || vector.length === 0) return undefined;
    const normalised = normalizeQuery(rawQuery);
    const keyHash = embeddingCacheKey(model, dimensions, normalised);
    const now = this.#now();
    const entry: L1Entry = {
      vector: [...vector],
      model,
      dimensions,
      normalised,
      keyHash,
      cachedAt: now,
      expiresAt: now + this.#ttlMs,
    };
    this.#map.delete(keyHash);
    this.#map.set(keyHash, entry);
    this.#evictIfNeeded();
    return keyHash;
  }

  // Full get: L1 then L2 (if configured). Respects kill switch.
  async get(
    model: string,
    dimensions: number,
    rawQuery: string,
    cachePolicy?: unknown,
  ): Promise<readonly number[] | undefined> {
    if (!isEmbeddingCacheEnabled(cachePolicy)) return undefined;
    const l1 = this.getL1(model, dimensions, rawQuery, cachePolicy);
    if (l1 !== undefined) return l1;
    if (this.#l2 === undefined) return undefined;
    const normalised = normalizeQuery(rawQuery);
    const keyHash = embeddingCacheKey(model, dimensions, normalised);
    const rec = await this.#l2.get(keyHash);
    if (rec === null) return undefined;
    // Validate that L2 record matches the requested model/dimensions.
    if (rec.embedding_model !== model || rec.embedding_dimensions !== dimensions) return undefined;
    const expiresAt = Date.parse(rec.expires_at);
    if (!Number.isFinite(expiresAt) || this.#now() >= expiresAt) return undefined;
    // Populate L1 (never store raw text).
    const now = this.#now();
    const entry: L1Entry = {
      vector: [...rec.embedding],
      model,
      dimensions,
      normalised,
      keyHash,
      cachedAt: now,
      expiresAt: expiresAt,
    };
    this.#map.delete(keyHash);
    this.#map.set(keyHash, entry);
    this.#evictIfNeeded();
    return entry.vector;
  }

  // Full set: L1 + L2 (if configured). Returns the key hash.
  async set(
    model: string,
    dimensions: number,
    rawQuery: string,
    vector: readonly number[],
    cachePolicy?: unknown,
  ): Promise<string | undefined> {
    const keyHash = this.setL1(model, dimensions, rawQuery, vector, cachePolicy);
    if (keyHash === undefined) return undefined;
    if (this.#l2 === undefined) return keyHash;
    const now = this.#now();
    const record: EmbeddingCacheRecord = {
      key_hash: keyHash,
      embedding_model: model,
      embedding_dimensions: dimensions,
      embedding: [...vector],
      created_at: new Date(now).toISOString(),
      last_hit_at: null,
      expires_at: new Date(now + this.#ttlMs).toISOString(),
    };
    await this.#l2.set(record);
    return keyHash;
  }

  // Visible for tests.
  _peekL1(keyHash: string): L1Entry | undefined {
    return this.#map.get(keyHash);
  }

  // Expose internal map for raw-text-leak tests (keys are hashes only).
  _l1Keys(): string[] {
    return [...this.#map.keys()];
  }
}

export function createEmbeddingCache(
  options?: EmbeddingCacheOptions & { l2?: EmbeddingL2 },
): EmbeddingCache {
  return new EmbeddingCache(options);
}
