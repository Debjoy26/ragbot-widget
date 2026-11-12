// C5 — Retrieval result cache (plan.md P7.5 C5, TECH_SPECS §6.2).
//
// L1 in-process LRU + optional L2 Postgres.
// Key: bot_id ‖ corpus_version ‖ query_embedding_hash ‖ k ‖ threshold ‖ language
// Storage: ordered chunk IDs + scores only — never chunk text.
// TTL ≤10 min (default 5 min); corpus_version bump invalidates instantly.
// Chunk text is re-read by ID on hit so deleted chunks cannot leak.
// Kill switch via client_settings.cache_policy:
//   { enabled: false } or { c5: false } or { retrieval: false } => bypass.
//
// Fail closed: missing/invalid bot_id, corpus_version, embedding hash, k,
// threshold or language never hits.

import { createHash } from 'node:crypto';

export const RETRIEVAL_CACHE_TTL_MS = 5 * 60 * 1000;
export const RETRIEVAL_CACHE_MIN_TTL_MS = 60 * 1000;
export const RETRIEVAL_CACHE_MAX_TTL_MS = 10 * 60 * 1000;
export const RETRIEVAL_CACHE_MAX_ENTRIES = 500;

export interface RetrievalCacheOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

function clampTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined) return RETRIEVAL_CACHE_TTL_MS;
  if (!Number.isFinite(ttlMs)) return RETRIEVAL_CACHE_TTL_MS;
  if (ttlMs > RETRIEVAL_CACHE_MAX_TTL_MS) return RETRIEVAL_CACHE_MAX_TTL_MS;
  if (ttlMs < RETRIEVAL_CACHE_MIN_TTL_MS) return RETRIEVAL_CACHE_MIN_TTL_MS;
  return Math.trunc(ttlMs);
}

function clampMax(max: number | undefined): number {
  if (max === undefined) return RETRIEVAL_CACHE_MAX_ENTRIES;
  if (!Number.isFinite(max) || max <= 0) return RETRIEVAL_CACHE_MAX_ENTRIES;
  return Math.trunc(max);
}

// ---------------------------------------------------------------------------
// Normalisation / hashing
// ---------------------------------------------------------------------------

export function normalizeLanguage(language: string | undefined): string {
  if (typeof language !== 'string') return '';
  return language.trim().toLowerCase();
}

// Hash a query embedding vector into a 64-char hex. The vector is the raw
// floats joined with ',' — deterministic and stable for same model output.
export function queryEmbeddingHash(vector: readonly number[]): string {
  return createHash('sha256').update(vector.join(','), 'utf8').digest('hex');
}

// Composite key hash: bot_id ‖ corpus_version ‖ embedding_hash ‖ k ‖ threshold ‖ language
export function retrievalCacheKey(params: {
  readonly botId: string;
  readonly corpusVersion: number;
  readonly embeddingHash: string;
  readonly k: number;
  readonly threshold: number;
  readonly language: string;
}): string {
  const payload = [
    params.botId,
    String(params.corpusVersion),
    params.embeddingHash,
    String(params.k),
    String(params.threshold),
    normalizeLanguage(params.language),
  ].join('\x1f');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

// Convenience: build hash from raw vector.
export function retrievalKeyHash(
  botId: string,
  corpusVersion: number,
  vector: readonly number[],
  k: number,
  threshold: number,
  language: string,
): string {
  return retrievalCacheKey({
    botId,
    corpusVersion,
    embeddingHash: queryEmbeddingHash(vector),
    k,
    threshold,
    language,
  });
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

export function isRetrievalCacheEnabled(cachePolicy: unknown): boolean {
  if (cachePolicy === null || cachePolicy === undefined) return true;
  if (typeof cachePolicy !== 'object') return true;
  const p = cachePolicy as Record<string, unknown>;
  if (p['enabled'] === false) return false;
  if (p['c5'] === false) return false;
  if (p['retrieval'] === false) return false;
  if (p['retrieval_cache'] === false) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Stored shapes
// ---------------------------------------------------------------------------

export interface RetrievalCacheChunkRef {
  readonly chunk_id: string;
  readonly document_version_id: string;
  readonly similarity: number;
}

export interface RetrievalCacheRecord {
  readonly key_hash: string;
  readonly bot_id: string;
  readonly corpus_version: number;
  readonly embedding_hash: string;
  readonly k: number;
  readonly threshold: number;
  readonly language: string;
  readonly chunk_refs: readonly RetrievalCacheChunkRef[];
  readonly created_at: string;
  readonly expires_at: string;
}

interface L1Entry {
  readonly botId: string;
  readonly corpusVersion: number;
  readonly embeddingHash: string;
  readonly k: number;
  readonly threshold: number;
  readonly language: string;
  readonly chunkRefs: readonly RetrievalCacheChunkRef[];
  readonly keyHash: string;
  readonly cachedAt: number;
  readonly expiresAt: number;
}

export interface RetrievalL2 {
  get(keyHash: string): Promise<RetrievalCacheRecord | null>;
  set(record: RetrievalCacheRecord): Promise<void>;
  delete?(keyHash: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function isValidChunkRef(ref: unknown): ref is RetrievalCacheChunkRef {
  if (typeof ref !== 'object' || ref === null) return false;
  const r = ref as Record<string, unknown>;
  return (
    typeof r['chunk_id'] === 'string' &&
    typeof r['document_version_id'] === 'string' &&
    typeof r['similarity'] === 'number' &&
    Number.isFinite(r['similarity'])
  );
}

export class RetrievalCache {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #map: Map<string, L1Entry> = new Map();
  readonly #l2: RetrievalL2 | undefined;

  constructor(options: RetrievalCacheOptions & { l2?: RetrievalL2 } = {}) {
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

  #validateInputs(
    botId: unknown,
    corpusVersion: unknown,
    embeddingHash: unknown,
    k: unknown,
    threshold: unknown,
  ): boolean {
    if (typeof botId !== 'string' || botId.length === 0) return false;
    if (typeof corpusVersion !== 'number' || !Number.isFinite(corpusVersion)) return false;
    if (typeof embeddingHash !== 'string' || !/^[0-9a-f]{64}$/.test(embeddingHash)) return false;
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > 50) return false;
    if (
      typeof threshold !== 'number' ||
      !Number.isFinite(threshold) ||
      threshold < 0 ||
      threshold > 1
    )
      return false;
    return true;
  }

  // L1 only: return chunk refs or undefined on miss/expired/disabled/invalid/corpus mismatch.
  getL1(
    botId: string,
    corpusVersion: number,
    embeddingHash: string,
    k: number,
    threshold: number,
    language: string,
    cachePolicy?: unknown,
  ): readonly RetrievalCacheChunkRef[] | undefined {
    if (!isRetrievalCacheEnabled(cachePolicy)) return undefined;
    if (!this.#validateInputs(botId, corpusVersion, embeddingHash, k, threshold)) return undefined;
    const keyHash = retrievalCacheKey({
      botId,
      corpusVersion,
      embeddingHash,
      k,
      threshold,
      language,
    });
    const entry = this.#map.get(keyHash);
    if (entry === undefined) return undefined;
    const now = this.#now();
    if (this.#isExpired(entry, now)) {
      this.#map.delete(keyHash);
      return undefined;
    }
    // Corpus version must match exactly — bump invalidates.
    if (entry.corpusVersion !== corpusVersion) {
      this.#map.delete(keyHash);
      return undefined;
    }
    // Bot, k, threshold, language, hash must match stored entry to catch corruption.
    if (
      entry.botId !== botId ||
      entry.k !== k ||
      entry.threshold !== threshold ||
      normalizeLanguage(entry.language) !== normalizeLanguage(language) ||
      entry.embeddingHash !== embeddingHash
    ) {
      return undefined;
    }
    this.#promote(keyHash, entry);
    return entry.chunkRefs;
  }

  // L1 store: chunk IDs + scores only, never text. Returns key hash.
  setL1(
    botId: string,
    corpusVersion: number,
    embeddingHash: string,
    k: number,
    threshold: number,
    language: string,
    chunkRefs: readonly RetrievalCacheChunkRef[],
    cachePolicy?: unknown,
  ): string | undefined {
    if (!isRetrievalCacheEnabled(cachePolicy)) return undefined;
    if (!this.#validateInputs(botId, corpusVersion, embeddingHash, k, threshold)) return undefined;
    if (!Array.isArray(chunkRefs)) return undefined;
    for (const r of chunkRefs) {
      if (!isValidChunkRef(r)) return undefined;
    }
    const keyHash = retrievalCacheKey({
      botId,
      corpusVersion,
      embeddingHash,
      k,
      threshold,
      language,
    });
    const now = this.#now();
    const entry: L1Entry = {
      botId,
      corpusVersion,
      embeddingHash,
      k,
      threshold,
      language: normalizeLanguage(language),
      chunkRefs: chunkRefs.map((r) => ({ ...r })),
      keyHash,
      cachedAt: now,
      expiresAt: now + this.#ttlMs,
    };
    this.#map.delete(keyHash);
    this.#map.set(keyHash, entry);
    this.#evictIfNeeded();
    return keyHash;
  }

  // Full get: L1 then L2. Validates corpus version and re-checks TTL.
  async get(
    botId: string,
    corpusVersion: number,
    embeddingHash: string,
    k: number,
    threshold: number,
    language: string,
    cachePolicy?: unknown,
  ): Promise<readonly RetrievalCacheChunkRef[] | undefined> {
    if (!isRetrievalCacheEnabled(cachePolicy)) return undefined;
    const l1 = this.getL1(botId, corpusVersion, embeddingHash, k, threshold, language, cachePolicy);
    if (l1 !== undefined) return l1;
    if (this.#l2 === undefined) return undefined;
    const keyHash = retrievalCacheKey({
      botId,
      corpusVersion,
      embeddingHash,
      k,
      threshold,
      language,
    });
    const rec = await this.#l2.get(keyHash);
    if (rec === null) return undefined;
    // Validate record matches request and is not stale.
    if (
      rec.bot_id !== botId ||
      rec.corpus_version !== corpusVersion ||
      rec.embedding_hash !== embeddingHash ||
      rec.k !== k ||
      rec.threshold !== threshold ||
      normalizeLanguage(rec.language) !== normalizeLanguage(language)
    ) {
      return undefined;
    }
    const expiresAt = Date.parse(rec.expires_at);
    if (!Number.isFinite(expiresAt) || this.#now() >= expiresAt) return undefined;
    // Corpus version already checked; populate L1 without text.
    const now = this.#now();
    const entry: L1Entry = {
      botId,
      corpusVersion,
      embeddingHash,
      k,
      threshold,
      language: normalizeLanguage(language),
      chunkRefs: rec.chunk_refs.map((r) => ({ ...r })),
      keyHash,
      cachedAt: now,
      expiresAt,
    };
    this.#map.delete(keyHash);
    this.#map.set(keyHash, entry);
    this.#evictIfNeeded();
    return entry.chunkRefs;
  }

  async set(
    botId: string,
    corpusVersion: number,
    embeddingHash: string,
    k: number,
    threshold: number,
    language: string,
    chunkRefs: readonly RetrievalCacheChunkRef[],
    cachePolicy?: unknown,
  ): Promise<string | undefined> {
    const keyHash = this.setL1(
      botId,
      corpusVersion,
      embeddingHash,
      k,
      threshold,
      language,
      chunkRefs,
      cachePolicy,
    );
    if (keyHash === undefined) return undefined;
    if (this.#l2 === undefined) return keyHash;
    const now = this.#now();
    const record: RetrievalCacheRecord = {
      key_hash: keyHash,
      bot_id: botId,
      corpus_version: corpusVersion,
      embedding_hash: embeddingHash,
      k,
      threshold,
      language: normalizeLanguage(language),
      chunk_refs: chunkRefs.map((r) => ({ ...r })),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + this.#ttlMs).toISOString(),
    };
    await this.#l2.set(record);
    return keyHash;
  }

  // Rehydrate: fetch chunk text by ID for each ref. If any chunk is missing (deleted),
  // the cache entry is purged and undefined is returned so caller falls back to search.
  // `fetchByIds` is injected by the caller (DB read); it must return a map of chunk_id -> chunk
  // with text, or null/undefined for missing chunks.
  async getHydrated<T extends { chunk_id: string; content: string }>(
    botId: string,
    corpusVersion: number,
    embeddingHash: string,
    k: number,
    threshold: number,
    language: string,
    fetchByIds: (
      ids: readonly string[],
    ) => Promise<ReadonlyMap<string, T> | readonly T[] | Map<string, T> | null>,
    cachePolicy?: unknown,
  ): Promise<readonly T[] | undefined> {
    const refs = await this.get(
      botId,
      corpusVersion,
      embeddingHash,
      k,
      threshold,
      language,
      cachePolicy,
    );
    if (refs === undefined || refs.length === 0) return refs as unknown as readonly T[] | undefined;
    const ids = refs.map((r) => r.chunk_id);
    const result = await fetchByIds(ids);
    if (result === null || result === undefined) {
      // Fetcher indicates total miss — treat as cache miss and purge.
      const keyHash = retrievalCacheKey({
        botId,
        corpusVersion,
        embeddingHash,
        k,
        threshold,
        language,
      });
      this.#map.delete(keyHash);
      if (this.#l2?.delete) await this.#l2.delete(keyHash).catch(() => undefined);
      return undefined;
    }
    const map: ReadonlyMap<string, T> = Array.isArray(result)
      ? new Map(result.map((c) => [c.chunk_id, c] as const))
      : (result as ReadonlyMap<string, T>);
    // Deleted or missing chunk => purge and miss (prevents leaking deleted text, and stale scores).
    for (const id of ids) {
      if (!map.has(id)) {
        const keyHash = retrievalCacheKey({
          botId,
          corpusVersion,
          embeddingHash,
          k,
          threshold,
          language,
        });
        this.#map.delete(keyHash);
        if (this.#l2?.delete) await this.#l2.delete(keyHash).catch(() => undefined);
        return undefined;
      }
    }
    // Preserve cached order (similarity desc) while returning hydrated chunks.
    return ids.map((id) => map.get(id)!) as readonly T[];
  }

  // Visible for tests.
  _peekL1(keyHash: string): L1Entry | undefined {
    return this.#map.get(keyHash);
  }
  _l1Keys(): string[] {
    return [...this.#map.keys()];
  }
  // Purge a specific key (used when rehydration finds a deleted chunk).
  purge(keyHash: string): void {
    this.#map.delete(keyHash);
  }
}

export function createRetrievalCache(
  options?: RetrievalCacheOptions & { l2?: RetrievalL2 },
): RetrievalCache {
  return new RetrievalCache(options);
}
