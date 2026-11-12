// C6 — Moderation verdict cache (plan.md P7.5 C6, TECH_SPECS §6.2).
//
// L1 in-process LRU + L2 Postgres moderation_cache.
// Key: sha256(moderation_model ‖ policy_version ‖ normalised_text)
//   where normalised_text = NFKC + trim + collapse whitespace + lower.
// Storage: verdict allow/block only (raw text is never stored, only its hash).
// TTL 24 h. Kill switch via client_settings.cache_policy:
//   { enabled: false } or { c6: false } or { moderation: false } => bypass.
//
// Fail closed: missing/invalid model or policy version never hits.

import { createHash } from 'node:crypto';

export const MODERATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const MODERATION_CACHE_MAX_ENTRIES = 1000;

export interface ModerationCacheOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

export type ModerationVerdict = 'allow' | 'block';

function clampTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined) return MODERATION_CACHE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return MODERATION_CACHE_TTL_MS;
  // C6 is fixed at 24h; allow caller override only within a small window for tests.
  return Math.trunc(ttlMs);
}

function clampMax(max: number | undefined): number {
  if (max === undefined) return MODERATION_CACHE_MAX_ENTRIES;
  if (!Number.isFinite(max) || max <= 0) return MODERATION_CACHE_MAX_ENTRIES;
  return Math.trunc(max);
}

// Same canonicalisation as embedding-cache (Dedup: keep local copy so the two
// caches can be imported independently).
export function normalizeModerationText(text: string): string {
  const nfkc = text.normalize('NFKC');
  const collapsed = nfkc.trim().replace(/\s+/g, ' ');
  return collapsed.toLowerCase();
}

export function moderationCacheKey(
  model: string,
  policyVersion: string,
  normalisedText: string,
): string {
  const payload = `${model}\x1f${policyVersion}\x1f${normalisedText}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function moderationKeyHash(model: string, policyVersion: string, rawText: string): string {
  return moderationCacheKey(model, policyVersion, normalizeModerationText(rawText));
}

export function isModerationCacheEnabled(cachePolicy: unknown): boolean {
  if (cachePolicy === null || cachePolicy === undefined) return true;
  if (typeof cachePolicy !== 'object') return true;
  const p = cachePolicy as Record<string, unknown>;
  if (p['enabled'] === false) return false;
  if (p['c6'] === false) return false;
  if (p['moderation'] === false) return false;
  if (p['moderation_cache'] === false) return false;
  return true;
}

export interface ModerationCacheRecord {
  readonly key_hash: string;
  readonly policy_version: string;
  readonly verdict: ModerationVerdict;
  readonly created_at: string;
  readonly expires_at: string;
}

interface L1Entry {
  readonly verdict: ModerationVerdict;
  readonly model: string;
  readonly policyVersion: string;
  readonly normalised: string;
  readonly keyHash: string;
  readonly cachedAt: number;
  readonly expiresAt: number;
}

export interface ModerationL2 {
  get(keyHash: string): Promise<ModerationCacheRecord | null>;
  set(record: ModerationCacheRecord): Promise<void>;
}

export class ModerationCache {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #map: Map<string, L1Entry> = new Map();
  readonly #l2: ModerationL2 | undefined;

  constructor(options: ModerationCacheOptions & { l2?: ModerationL2 } = {}) {
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

  getL1(
    model: string,
    policyVersion: string,
    rawText: string,
    cachePolicy?: unknown,
  ): ModerationVerdict | undefined {
    if (!isModerationCacheEnabled(cachePolicy)) return undefined;
    if (typeof model !== 'string' || model.length === 0) return undefined;
    if (typeof policyVersion !== 'string' || policyVersion.length === 0) return undefined;
    const normalised = normalizeModerationText(rawText);
    const keyHash = moderationCacheKey(model, policyVersion, normalised);
    const entry = this.#map.get(keyHash);
    if (entry === undefined) return undefined;
    const now = this.#now();
    if (this.#isExpired(entry, now)) {
      this.#map.delete(keyHash);
      return undefined;
    }
    if (entry.model !== model || entry.policyVersion !== policyVersion) return undefined;
    this.#promote(keyHash, entry);
    return entry.verdict;
  }

  setL1(
    model: string,
    policyVersion: string,
    rawText: string,
    verdict: ModerationVerdict,
    cachePolicy?: unknown,
  ): string | undefined {
    if (!isModerationCacheEnabled(cachePolicy)) return undefined;
    if (typeof model !== 'string' || model.length === 0) return undefined;
    if (typeof policyVersion !== 'string' || policyVersion.length === 0) return undefined;
    if (verdict !== 'allow' && verdict !== 'block') return undefined;
    const normalised = normalizeModerationText(rawText);
    const keyHash = moderationCacheKey(model, policyVersion, normalised);
    const now = this.#now();
    const entry: L1Entry = {
      verdict,
      model,
      policyVersion,
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

  async get(
    model: string,
    policyVersion: string,
    rawText: string,
    cachePolicy?: unknown,
  ): Promise<ModerationVerdict | undefined> {
    if (!isModerationCacheEnabled(cachePolicy)) return undefined;
    const l1 = this.getL1(model, policyVersion, rawText, cachePolicy);
    if (l1 !== undefined) return l1;
    if (this.#l2 === undefined) return undefined;
    const normalised = normalizeModerationText(rawText);
    const keyHash = moderationCacheKey(model, policyVersion, normalised);
    const rec = await this.#l2.get(keyHash);
    if (rec === null) return undefined;
    if (rec.policy_version !== policyVersion) return undefined;
    const expiresAt = Date.parse(rec.expires_at);
    if (!Number.isFinite(expiresAt) || this.#now() >= expiresAt) return undefined;
    if (rec.verdict !== 'allow' && rec.verdict !== 'block') return undefined;
    const now = this.#now();
    const entry: L1Entry = {
      verdict: rec.verdict,
      model,
      policyVersion,
      normalised,
      keyHash,
      cachedAt: now,
      expiresAt,
    };
    this.#map.delete(keyHash);
    this.#map.set(keyHash, entry);
    this.#evictIfNeeded();
    return entry.verdict;
  }

  async set(
    model: string,
    policyVersion: string,
    rawText: string,
    verdict: ModerationVerdict,
    cachePolicy?: unknown,
  ): Promise<string | undefined> {
    const keyHash = this.setL1(model, policyVersion, rawText, verdict, cachePolicy);
    if (keyHash === undefined) return undefined;
    if (this.#l2 === undefined) return keyHash;
    const now = this.#now();
    const record: ModerationCacheRecord = {
      key_hash: keyHash,
      policy_version: policyVersion,
      verdict,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + this.#ttlMs).toISOString(),
    };
    await this.#l2.set(record);
    return keyHash;
  }

  _peekL1(keyHash: string): L1Entry | undefined {
    return this.#map.get(keyHash);
  }

  _l1Keys(): string[] {
    return [...this.#map.keys()];
  }
}

export function createModerationCache(
  options?: ModerationCacheOptions & { l2?: ModerationL2 },
): ModerationCache {
  return new ModerationCache(options);
}
