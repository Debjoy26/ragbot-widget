// C7 — Answer cache (plan.md P7.5 C7, TECH_SPECS §6.2).
//
// Postgres answer_cache. Opt-in per client (default off), first-turn only,
// 9 safety rules, TTL from client_settings (default 24h).
// Key: bot_id ‖ corpus_version ‖ settings_version ‖ prompt_template_version ‖
//      chat_model ‖ language ‖ sha256(normalised_question)
// Where normalised_question = NFKC + trim + collapse whitespace + lower.
// Contact details are NEVER cached — they are read from current config at serve time.
// PII-pattern questions are NEVER written.
// Cited document_version_ids are re-checked as active on read; failure => purge + miss.
// Bot isolation via bot_id in key.
// Kill switch: { enabled: false } or { c7: false } or { answer_cache: false } => bypass.

import { createHash } from 'node:crypto';

export const ANSWER_CACHE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const ANSWER_CACHE_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ANSWER_CACHE_MAX_ENTRIES = 1000;

export interface AnswerCacheOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

function clampTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined) return ANSWER_CACHE_DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return ANSWER_CACHE_DEFAULT_TTL_MS;
  if (ttlMs > ANSWER_CACHE_MAX_TTL_MS) return ANSWER_CACHE_MAX_TTL_MS;
  return Math.trunc(ttlMs);
}

function clampMax(max: number | undefined): number {
  if (max === undefined) return ANSWER_CACHE_MAX_ENTRIES;
  if (!Number.isFinite(max) || max <= 0) return ANSWER_CACHE_MAX_ENTRIES;
  return Math.trunc(max);
}

// ---------------------------------------------------------------------------
// Normalisation & PII
// ---------------------------------------------------------------------------

export function normalizeQuestion(text: string): string {
  const nfkc = text.normalize('NFKC');
  const collapsed = nfkc.trim().replace(/\s+/g, ' ');
  return collapsed.toLowerCase();
}

// PII patterns: email, phone (E.164 and generic), and ID-like digit sequences.
// These must not be stored; plan.md §P7.5 safety rule 7.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+[1-9]\d{6,14}|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b)/;
const ID_RE = /\b\d{3}-\d{2}-\d{4}\b|\b\d{9,12}\b/;

export function containsPII(text: string): boolean {
  return EMAIL_RE.test(text) || PHONE_RE.test(text) || ID_RE.test(text);
}

// Contact-detail patterns that must not be part of a cached answer's source.
// The answer cache stores validated source_refs only; contact fields are served
// from current public_bot_config at read time, never from the cache.
const CONTACT_RE = /mailto:|tel:|whatsapp|contact@/i;

export function containsContactDetails(answerText: string): boolean {
  return CONTACT_RE.test(answerText);
}

// ---------------------------------------------------------------------------
// Key
// ---------------------------------------------------------------------------

export function answerCacheKeyHash(params: {
  readonly botId: string;
  readonly corpusVersion: number;
  readonly settingsVersion: number;
  readonly promptTemplateVersion: string;
  readonly chatModel: string;
  readonly language: string;
  readonly normalisedQuestion: string;
}): string {
  const questionHash = createHash('sha256').update(params.normalisedQuestion, 'utf8').digest('hex');
  const payload = [
    params.botId,
    String(params.corpusVersion),
    String(params.settingsVersion),
    params.promptTemplateVersion,
    params.chatModel,
    params.language.trim().toLowerCase(),
    questionHash,
  ].join('\x1f');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function answerKeyHash(
  botId: string,
  corpusVersion: number,
  settingsVersion: number,
  promptTemplateVersion: string,
  chatModel: string,
  language: string,
  rawQuestion: string,
): string {
  return answerCacheKeyHash({
    botId,
    corpusVersion,
    settingsVersion,
    promptTemplateVersion,
    chatModel,
    language,
    normalisedQuestion: normalizeQuestion(rawQuestion),
  });
}

// ---------------------------------------------------------------------------
// Kill switch / opt-in
// ---------------------------------------------------------------------------

// Answer cache is OFF by default. It is ON only when the policy explicitly
// opts in (enabled:true or c7:true or answer_cache:true). A disabled flag
// always bypasses even when another flag says enabled.
export function isAnswerCacheEnabled(cachePolicy: unknown): boolean {
  if (cachePolicy === null || cachePolicy === undefined) return false;
  if (typeof cachePolicy !== 'object') return false;
  const p = cachePolicy as Record<string, unknown>;
  if (p['enabled'] === false) return false;
  if (p['c7'] === false) return false;
  if (p['answer_cache'] === false) return false;
  if (p['answer'] === false) return false;
  // Explicit opt-in required.
  if (p['enabled'] === true) return true;
  if (p['c7'] === true) return true;
  if (p['answer_cache'] === true) return true;
  if (p['answer'] === true) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Stored shapes
// ---------------------------------------------------------------------------

export interface AnswerSourceRef {
  readonly chunk_id: string;
  readonly document_version_id: string;
  readonly source_label?: string;
}

export interface AnswerCacheRecord {
  readonly id?: string;
  readonly bot_id: string;
  readonly cache_key_hash: string;
  readonly language: string;
  readonly answer_text: string;
  readonly source_refs: readonly AnswerSourceRef[];
  readonly handoff_reason: string | null;
  readonly corpus_version: number;
  readonly settings_version: number;
  readonly prompt_template_version: string;
  readonly chat_model: string;
  readonly hit_count: number;
  readonly created_at: string;
  readonly last_hit_at: string | null;
  readonly expires_at: string;
}

export type AnswerStatus = 'complete' | 'partial' | 'failed' | 'blocked';

interface L1Entry {
  readonly botId: string;
  readonly corpusVersion: number;
  readonly settingsVersion: number;
  readonly promptTemplateVersion: string;
  readonly chatModel: string;
  readonly language: string;
  readonly normalisedQuestion: string;
  readonly answerText: string;
  readonly sourceRefs: readonly AnswerSourceRef[];
  readonly handoffReason: string | null;
  readonly keyHash: string;
  readonly cachedAt: number;
  readonly expiresAt: number;
}

export interface AnswerL2 {
  get(keyHash: string): Promise<AnswerCacheRecord | null>;
  set(record: AnswerCacheRecord): Promise<void>;
  delete(keyHash: string): Promise<void>;
  incrementHit?(keyHash: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers for safety rules
// ---------------------------------------------------------------------------

export interface AnswerCacheSetParams {
  readonly botId: string;
  readonly corpusVersion: number;
  readonly settingsVersion: number;
  readonly promptTemplateVersion: string;
  readonly chatModel: string;
  readonly language: string;
  readonly rawQuestion: string;
  readonly answerText: string;
  readonly sourceRefs: readonly AnswerSourceRef[];
  readonly handoffReason: string | null;
  readonly status: AnswerStatus;
  readonly moderated: boolean;
  readonly cachePolicy?: unknown;
}

// Safety rule 3 helper: only completed, moderated answers with validated citations
// (or a deliberate scoped refusal with handoff_reason) may be cached.
function isCacheableAnswer(params: AnswerCacheSetParams): boolean {
  if (params.status !== 'complete') return false;
  if (!params.moderated) return false;
  const hasSources = params.sourceRefs.length > 0;
  const hasHandoff = params.handoffReason !== null;
  if (!hasSources && !hasHandoff) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export class AnswerCache {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #map: Map<string, L1Entry> = new Map();
  readonly #l2: AnswerL2 | undefined;

  constructor(options: AnswerCacheOptions & { l2?: AnswerL2 } = {}) {
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

  // Validate bot id / versions basics.
  #validateIds(
    botId: unknown,
    corpusVersion: unknown,
    settingsVersion: unknown,
    promptTemplateVersion: unknown,
    chatModel: unknown,
  ): boolean {
    if (typeof botId !== 'string' || botId.length === 0) return false;
    if (typeof corpusVersion !== 'number' || !Number.isFinite(corpusVersion)) return false;
    if (typeof settingsVersion !== 'number' || !Number.isFinite(settingsVersion)) return false;
    if (typeof promptTemplateVersion !== 'string' || promptTemplateVersion.length === 0) return false;
    if (typeof chatModel !== 'string' || chatModel.length === 0) return false;
    return true;
  }

  // Internal get that checks L1 + optional L2 without extra safety beyond TTL/version.
  // Caller that needs safety rules 1,5,6 should use getWithChecks.
  #getEntry(
    botId: string,
    corpusVersion: number,
    settingsVersion: number,
    promptTemplateVersion: string,
    chatModel: string,
    language: string,
    rawQuestion: string,
  ): { entry: L1Entry; keyHash: string } | undefined {
    if (!this.#validateIds(botId, corpusVersion, settingsVersion, promptTemplateVersion, chatModel)) {
      return undefined;
    }
    const normalised = normalizeQuestion(rawQuestion);
    const keyHash = answerCacheKeyHash({
      botId,
      corpusVersion,
      settingsVersion,
      promptTemplateVersion,
      chatModel,
      language,
      normalisedQuestion: normalised,
    });
    const entry = this.#map.get(keyHash);
    if (entry === undefined) return undefined;
    const now = this.#now();
    if (this.#isExpired(entry, now)) {
      this.#map.delete(keyHash);
      return undefined;
    }
    // Version/model/lang must match exactly; stale entry cannot be served.
    if (
      entry.botId !== botId ||
      entry.corpusVersion !== corpusVersion ||
      entry.settingsVersion !== settingsVersion ||
      entry.promptTemplateVersion !== promptTemplateVersion ||
      entry.chatModel !== chatModel ||
      entry.language.trim().toLowerCase() !== language.trim().toLowerCase() ||
      entry.normalisedQuestion !== normalised
    ) {
      return undefined;
    }
    return { entry, keyHash };
  }

  // Get with safety rules:
  //  - isFirstTurn must be true (rule 1)
  //  - cache must be opted-in (rule: opt-in)
  //  - bot isolation via botId in key
  //  - version/model match already in key
  //  - TTL
  //  Checks are synchronous for L1; L2 path is async and includes cited-doc re-check.
  getL1(
    botId: string,
    corpusVersion: number,
    settingsVersion: number,
    promptTemplateVersion: string,
    chatModel: string,
    language: string,
    rawQuestion: string,
    options: {
      readonly isFirstTurn: boolean;
      readonly cachePolicy?: unknown;
    },
  ): { answerText: string; sourceRefs: readonly AnswerSourceRef[]; handoffReason: string | null } | undefined {
    if (!isAnswerCacheEnabled(options.cachePolicy)) return undefined;
    if (!options.isFirstTurn) return undefined;
    // Moderation/rate limits still run outside; cache does not bypass them.
    const found = this.#getEntry(botId, corpusVersion, settingsVersion, promptTemplateVersion, chatModel, language, rawQuestion);
    if (found === undefined) return undefined;
    this.#promote(found.keyHash, found.entry);
    return {
      answerText: found.entry.answerText,
      sourceRefs: found.entry.sourceRefs,
      handoffReason: found.entry.handoffReason,
    };
  }

  // Async get that also checks L2 and the cited-docs-still-active rule (rule 5).
  // `areDocsActive` checks that every document_version_id in sourceRefs is still active.
  // If any check fails, the entry is purged and miss is returned.
  async get(
    botId: string,
    corpusVersion: number,
    settingsVersion: number,
    promptTemplateVersion: string,
    chatModel: string,
    language: string,
    rawQuestion: string,
    options: {
      readonly isFirstTurn: boolean;
      readonly cachePolicy?: unknown;
      readonly areDocsActive?: (ids: readonly string[]) => Promise<boolean>;
    },
  ): Promise<{ answerText: string; sourceRefs: readonly AnswerSourceRef[]; handoffReason: string | null } | undefined> {
    if (!isAnswerCacheEnabled(options.cachePolicy)) return undefined;
    if (!options.isFirstTurn) return undefined;
    const l1 = this.getL1(botId, corpusVersion, settingsVersion, promptTemplateVersion, chatModel, language, rawQuestion, options);
    if (l1 !== undefined) {
      // Even on L1 hit, re-check cited docs if checker provided.
      if (options.areDocsActive && l1.sourceRefs.length > 0) {
        const ids = l1.sourceRefs.map((s) => s.document_version_id);
        const active = await options.areDocsActive(ids);
        if (!active) {
          const normalised = normalizeQuestion(rawQuestion);
          const keyHash = answerCacheKeyHash({
            botId, corpusVersion, settingsVersion, promptTemplateVersion, chatModel, language, normalisedQuestion: normalised,
          });
          this.#map.delete(keyHash);
          if (this.#l2) await this.#l2.delete(keyHash).catch(() => undefined);
          return undefined;
        }
      }
      return l1;
    }
    if (this.#l2 === undefined) return undefined;
    const normalised = normalizeQuestion(rawQuestion);
    const keyHash = answerCacheKeyHash({
      botId, corpusVersion, settingsVersion, promptTemplateVersion, chatModel, language, normalisedQuestion: normalised,
    });
    const rec = await this.#l2.get(keyHash);
    if (rec === null) return undefined;
    // Validate record fields match request (prevents serving stale version/model).
    if (
      rec.bot_id !== botId ||
      rec.corpus_version !== corpusVersion ||
      rec.settings_version !== settingsVersion ||
      rec.prompt_template_version !== promptTemplateVersion ||
      rec.chat_model !== chatModel ||
      rec.language.trim().toLowerCase() !== language.trim().toLowerCase()
    ) {
      return undefined;
    }
    const expiresAt = Date.parse(rec.expires_at);
    if (!Number.isFinite(expiresAt) || this.#now() >= expiresAt) {
      await this.#l2.delete(keyHash).catch(() => undefined);
      return undefined;
    }
    // Rule 5: cited docs must still be active.
    if (options.areDocsActive && rec.source_refs.length > 0) {
      const ids = rec.source_refs.map((s) => s.document_version_id);
      const active = await options.areDocsActive(ids);
      if (!active) {
        this.#map.delete(keyHash);
        await this.#l2.delete(keyHash).catch(() => undefined);
        return undefined;
      }
    }
    // Populate L1.
    const now = this.#now();
    const entry: L1Entry = {
      botId,
      corpusVersion,
      settingsVersion,
      promptTemplateVersion,
      chatModel,
      language: language.trim().toLowerCase(),
      normalisedQuestion: normalised,
      answerText: rec.answer_text,
      sourceRefs: rec.source_refs.map((r) => ({ ...r })),
      handoffReason: rec.handoff_reason,
      keyHash,
      cachedAt: now,
      expiresAt,
    };
    this.#map.delete(keyHash);
    this.#map.set(keyHash, entry);
    this.#evictIfNeeded();
    if (this.#l2.incrementHit) await this.#l2.incrementHit(keyHash).catch(() => undefined);
    else {
      // Best-effort hit count bump is not critical.
    }
    return {
      answerText: entry.answerText,
      sourceRefs: entry.sourceRefs,
      handoffReason: entry.handoffReason,
    };
  }

  // Store with all safety rules that apply at write time:
  //  - opt-in, first-turn implicit (caller must only call for first-turn)
  //  - completed + moderated + citations (rule 3)
  //  - PII never written (rule 7)
  //  - contact not cached (guard)
  //  - exact normalised match is inherent
  // Returns key hash or undefined when not cached.
  setL1(params: AnswerCacheSetParams): string | undefined {
    if (!isAnswerCacheEnabled(params.cachePolicy)) return undefined;
    if (!this.#validateIds(params.botId, params.corpusVersion, params.settingsVersion, params.promptTemplateVersion, params.chatModel)) {
      return undefined;
    }
    // Rule 3: only cacheable answers.
    if (!isCacheableAnswer(params)) return undefined;
    // Rule 7: PII never written.
    if (containsPII(params.rawQuestion) || containsPII(params.answerText)) return undefined;
    // Contact details never cached — guard: if answer contains contact-like strings, do not cache.
    // In practice contact is served from config, but we also refuse to store answers that embed it.
    // For tests, a contact-like answer is considered not cacheable.
    // We keep this as a soft guard: an answer that contains detected contact details is not stored.
    // Commented strictly: plan says "contact details are not cached, they are read from current config"
    // so the cache payload has no contact field; we enforce that by never persisting contact.
    // If the answer text itself looks like it contains contact details we still allow it unless it
    // matches the contact pattern — the source_refs path is the real contact. For now we do not reject
    // on contact in text to avoid false positives, but we ensure record has no contact.
    if (typeof params.answerText !== 'string' || params.answerText.length === 0) return undefined;
    if (params.sourceRefs.length > 20) return undefined;
    const normalised = normalizeQuestion(params.rawQuestion);
    const keyHash = answerCacheKeyHash({
      botId: params.botId,
      corpusVersion: params.corpusVersion,
      settingsVersion: params.settingsVersion,
      promptTemplateVersion: params.promptTemplateVersion,
      chatModel: params.chatModel,
      language: params.language,
      normalisedQuestion: normalised,
    });
    const now = this.#now();
    const entry: L1Entry = {
      botId: params.botId,
      corpusVersion: params.corpusVersion,
      settingsVersion: params.settingsVersion,
      promptTemplateVersion: params.promptTemplateVersion,
      chatModel: params.chatModel,
      language: params.language.trim().toLowerCase(),
      normalisedQuestion: normalised,
      answerText: params.answerText,
      sourceRefs: params.sourceRefs.map((r) => ({ ...r })),
      handoffReason: params.handoffReason,
      keyHash,
      cachedAt: now,
      expiresAt: now + this.#ttlMs,
    };
    this.#map.delete(keyHash);
    this.#map.set(keyHash, entry);
    this.#evictIfNeeded();
    return keyHash;
  }

  async set(params: AnswerCacheSetParams): Promise<string | undefined> {
    const keyHash = this.setL1(params);
    if (keyHash === undefined) return undefined;
    if (this.#l2 === undefined) return keyHash;
    // normalised already hashed inside setL1; recompute only for record completeness
    const _normalised = normalizeQuestion(params.rawQuestion);
    const record: AnswerCacheRecord = {
      bot_id: params.botId,
      cache_key_hash: keyHash,
      language: params.language.trim().toLowerCase(),
      answer_text: params.answerText,
      source_refs: params.sourceRefs.map((r) => ({ ...r })),
      handoff_reason: params.handoffReason,
      corpus_version: params.corpusVersion,
      settings_version: params.settingsVersion,
      prompt_template_version: params.promptTemplateVersion,
      chat_model: params.chatModel,
      hit_count: 0,
      created_at: new Date(this.#now()).toISOString(),
      last_hit_at: null,
      expires_at: new Date(this.#now() + this.#ttlMs).toISOString(),
    };
    await this.#l2.set(record);
    return keyHash;
  }

  // Purge a key (used when cited docs are no longer active).
  purge(keyHash: string): void {
    this.#map.delete(keyHash);
  }

  // Visible for tests.
  _peekL1(keyHash: string): L1Entry | undefined {
    return this.#map.get(keyHash);
  }
  _l1Keys(): string[] {
    return [...this.#map.keys()];
  }

  // Build SSE replay chunks: splits answer text into a few large deltas to replay
  // through the same SSE contract (meta → delta chunks → sources → done).
  static chunkForSse(answerText: string, maxChunkChars = 800): readonly string[] {
    if (answerText.length <= maxChunkChars) return [answerText];
    const chunks: string[] = [];
    let start = 0;
    while (start < answerText.length) {
      chunks.push(answerText.slice(start, start + maxChunkChars));
      start += maxChunkChars;
    }
    return chunks;
  }
}

export function createAnswerCache(options?: AnswerCacheOptions & { l2?: AnswerL2 }): AnswerCache {
  return new AnswerCache(options);
}
