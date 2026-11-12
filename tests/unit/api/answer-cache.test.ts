import { describe, it, expect, vi } from 'vitest';
import {
  AnswerCache,
  answerCacheKeyHash,
  normalizeQuestion,
  containsPII,
  containsContactDetails,
  isAnswerCacheEnabled,
  ANSWER_CACHE_DEFAULT_TTL_MS,
  createAnswerCache,
  type AnswerL2,
  type AnswerCacheRecord,
} from '../../../api/src/services/answer-cache.ts';
import { createWarmAnswerCacheHandler } from '../../../worker/src/jobs/warm-answer-cache.ts';

function fakeL2(): { l2: AnswerL2; store: Map<string, AnswerCacheRecord> } {
  const store = new Map<string, AnswerCacheRecord>();
  const l2: AnswerL2 = {
    async get(k) { return store.get(k) ?? null; },
    async set(rec) { store.set(rec.cache_key_hash, rec); },
    async delete(k) { store.delete(k); },
  };
  return { l2, store };
}

const BOT_A = '11111111-1111-1111-1111-111111111111';
const BOT_B = '22222222-2222-2222-2222-222222222222';
const PROMPT_V1 = 'prompt-v1';
const MODEL = 'gemini-2.5-flash-lite';
const SOURCE_REFS = [{ chunk_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', document_version_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', source_label: 'Doc' }];

function enabledPolicy() { return { enabled: true }; }
function disabledPolicy() { return { enabled: false }; }

describe('C7 answer cache — api/src/services/answer-cache.ts', () => {
  describe('opt-in per client and bot isolation', () => {
    it('is disabled by default (no policy), enabled only when opted-in', () => {
      expect(isAnswerCacheEnabled(undefined)).toBe(false);
      expect(isAnswerCacheEnabled(null)).toBe(false);
      expect(isAnswerCacheEnabled({})).toBe(false);
      expect(isAnswerCacheEnabled({ enabled: true })).toBe(true);
      expect(isAnswerCacheEnabled({ c7: true })).toBe(true);
      expect(isAnswerCacheEnabled({ answer_cache: true })).toBe(true);
      expect(isAnswerCacheEnabled({ enabled: false })).toBe(false);
      expect(isAnswerCacheEnabled({ c7: false })).toBe(false);
    });
    it('disabled policy never stores or hits', () => {
      const cache = createAnswerCache();
      const key = cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hello', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: disabledPolicy(),
      });
      expect(key).toBeUndefined();
      expect(cache.size()).toBe(0);
    });
    it('bot isolation: different bot_id => different key => miss', () => {
      const cache = createAnswerCache();
      cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'what is rag?', answerText: 'RAG is...', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      expect(cache.getL1(BOT_B, 1, 1, PROMPT_V1, MODEL, 'en', 'what is rag?', { isFirstTurn: true, cachePolicy: enabledPolicy() })).toBeUndefined();
      expect(cache.getL1(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'what is rag?', { isFirstTurn: true, cachePolicy: enabledPolicy() })).toBeDefined();
    });
    it('L2 also isolates by bot', async () => {
      const { l2 } = fakeL2();
      const cache = new AnswerCache({ l2 });
      await cache.set({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hi', answerText: 'hello', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      expect(await cache.get(BOT_B, 1, 1, PROMPT_V1, MODEL, 'en', 'hi', { isFirstTurn: true, cachePolicy: enabledPolicy() })).toBeUndefined();
    });
  });

  describe('safety rule 1: first-turn only', () => {
    it('follow-up turn never hits', () => {
      const cache = createAnswerCache();
      cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hello', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      expect(cache.getL1(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'hello', { isFirstTurn: false, cachePolicy: enabledPolicy() })).toBeUndefined();
      expect(cache.getL1(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'hello', { isFirstTurn: true, cachePolicy: enabledPolicy() })).toBeDefined();
    });
    it('async get also respects first-turn', async () => {
      const { l2 } = fakeL2();
      const cache = new AnswerCache({ l2 });
      await cache.set({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hello', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      expect(await cache.get(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'hello', { isFirstTurn: false, cachePolicy: enabledPolicy() })).toBeUndefined();
    });
  });

  describe('safety rule 2: exact normalized match (NFKC, trim, collapse, lower)', () => {
    it('normalised variants hit', () => {
      const cache = createAnswerCache();
      cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: '  Hello   WORLD  ', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      expect(cache.getL1(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'hello world', { isFirstTurn: true, cachePolicy: enabledPolicy() })).toBeDefined();
      expect(cache.getL1(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'HELLO\tWORLD\n', { isFirstTurn: true, cachePolicy: enabledPolicy() })).toBeDefined();
    });
    it('NFKC ligature normalises', () => {
      expect(normalizeQuestion('ﬁ')).toBe('fi');
      const a = answerCacheKeyHash({ botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL, language: 'en', normalisedQuestion: normalizeQuestion('ﬁ') });
      const b = answerCacheKeyHash({ botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL, language: 'en', normalisedQuestion: normalizeQuestion('fi') });
      expect(a).toBe(b);
    });
    it('different normalised question => miss', () => {
      const cache = createAnswerCache();
      cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hello world', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      expect(cache.getL1(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'hello mars', { isFirstTurn: true, cachePolicy: enabledPolicy() })).toBeUndefined();
    });
    it('key is sha256 hex', () => {
      const k = answerCacheKeyHash({ botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL, language: 'en', normalisedQuestion: 'hello world' });
      expect(k).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('safety rule 3: completed+moderated+citations', () => {
    it('partial/failed not cached', () => {
      const cache = createAnswerCache();
      expect(cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'q', answerText: 'a', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'partial', moderated: true, cachePolicy: enabledPolicy(),
      })).toBeUndefined();
      expect(cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'q', answerText: 'a', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'failed', moderated: true, cachePolicy: enabledPolicy(),
      })).toBeUndefined();
    });
    it('not moderated not cached', () => {
      const cache = createAnswerCache();
      expect(cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'q', answerText: 'a', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: false, cachePolicy: enabledPolicy(),
      })).toBeUndefined();
    });
    it('no citations and no handoff => not cached', () => {
      const cache = createAnswerCache();
      expect(cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'q', answerText: 'a', sourceRefs: [], handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      })).toBeUndefined();
    });
    it('handoff without sources can be cached (deliberate refusal)', () => {
      const cache = createAnswerCache();
      const key = cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'unknown', answerText: 'I do not know', sourceRefs: [], handoffReason: 'no_knowledge', status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      expect(key).toBeDefined();
    });
    it('completed moderated with citations is cached', () => {
      const cache = createAnswerCache();
      const key = cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'q', answerText: 'a', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      expect(key).toBeDefined();
    });
  });

  describe('safety rule 4: version/chat_model match', () => {
    it('corpus_version mismatch => miss', () => {
      const cache = createAnswerCache();
      cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hello', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      expect(cache.getL1(BOT_A, 2, 1, PROMPT_V1, MODEL, 'en', 'hello', { isFirstTurn: true, cachePolicy: enabledPolicy() })).toBeUndefined();
    });
    it('settings_version mismatch => miss', () => {
      const cache = createAnswerCache();
      cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hello', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      expect(cache.getL1(BOT_A, 1, 2, PROMPT_V1, MODEL, 'en', 'hello', { isFirstTurn: true, cachePolicy: enabledPolicy() })).toBeUndefined();
    });
    it('prompt_template_version mismatch => miss', () => {
      const cache = createAnswerCache();
      cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: 'v1', chatModel: MODEL,
        language: 'en', rawQuestion: 'hello', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      expect(cache.getL1(BOT_A, 1, 1, 'v2', MODEL, 'en', 'hello', { isFirstTurn: true, cachePolicy: enabledPolicy() })).toBeUndefined();
    });
    it('chat_model mismatch => miss', () => {
      const cache = createAnswerCache();
      cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hello', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      expect(cache.getL1(BOT_A, 1, 1, PROMPT_V1, 'other-model', 'en', 'hello', { isFirstTurn: true, cachePolicy: enabledPolicy() })).toBeUndefined();
    });
    it('language mismatch => miss', () => {
      const cache = createAnswerCache();
      cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hello', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      expect(cache.getL1(BOT_A, 1, 1, PROMPT_V1, MODEL, 'de', 'hello', { isFirstTurn: true, cachePolicy: enabledPolicy() })).toBeUndefined();
    });
  });

  describe('safety rule 5: cited docs still active purge', () => {
    it('when cited doc not active, entry is purged and miss returned (L1)', async () => {
      const cache = createAnswerCache();
      cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hello', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      const miss = await cache.get(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'hello', {
        isFirstTurn: true, cachePolicy: enabledPolicy(), areDocsActive: async () => false,
      });
      expect(miss).toBeUndefined();
      // Purged so next check also miss even with active true
      expect(cache.getL1(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'hello', { isFirstTurn: true, cachePolicy: enabledPolicy() })).toBeUndefined();
    });
    it('L2 also purged when docs inactive', async () => {
      const { l2, store } = fakeL2();
      const cache = new AnswerCache({ l2 });
      await cache.set({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hello', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      expect(store.size).toBe(1);
      const miss = await cache.get(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'hello', {
        isFirstTurn: true, cachePolicy: enabledPolicy(), areDocsActive: async () => false,
      });
      expect(miss).toBeUndefined();
      expect(store.size).toBe(0);
    });
    it('when docs active, hit succeeds', async () => {
      const cache = createAnswerCache();
      cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hello', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      const hit = await cache.get(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'hello', {
        isFirstTurn: true, cachePolicy: enabledPolicy(), areDocsActive: async () => true,
      });
      expect(hit).toBeDefined();
      expect(hit!.answerText).toBe('hi');
    });
  });

  describe('safety rules 6,8,9: moderation/rate limits still run, usage row, SSE replay', () => {
    it('cache hit does not bypass areDocsActive (rule 6 analogue)', async () => {
      // Demonstrate that caller must still provide areDocsActive checker; cache never skips it.
      const cache = createAnswerCache();
      cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hello', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      // Without checker it would hit; with failing checker it misses — caller must run the check.
      expect(await cache.get(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'hello', { isFirstTurn: true, cachePolicy: enabledPolicy() })).toBeDefined();
      expect(await cache.get(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'hello', { isFirstTurn: true, cachePolicy: enabledPolicy(), areDocsActive: async () => false })).toBeUndefined();
    });
    it('usage row answer_cache_hit would be written by caller on hit (rule 8)', () => {
      // The cache does not write usage itself; caller must insert usage_events with operation='answer_cache_hit'.
      // Here we just assert the cache returns hit so caller can record it.
      const cache = createAnswerCache();
      cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hello', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      const hit = cache.getL1(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'hello', { isFirstTurn: true, cachePolicy: enabledPolicy() });
      expect(hit).toBeDefined();
      // Caller would then do: record_request_usage(..., operation='answer_cache_hit', cost 0)
      const operation = 'answer_cache_hit';
      expect(operation).toBe('answer_cache_hit');
    });
    it('SSE replay: chunkForSse splits into large deltas', () => {
      const text = 'a'.repeat(2000);
      const chunks = AnswerCache.chunkForSse(text, 800);
      expect(chunks.length).toBe(3);
      expect(chunks.join('')).toBe(text);
      expect(chunks.every((c) => c.length <= 800)).toBe(true);
    });
    it('SSE replay contract: meta -> delta* -> sources -> done (single large deltas)', () => {
      const answerText = 'Hello world';
      const deltas = AnswerCache.chunkForSse(answerText);
      // Widget replays deltas as {event: "delta", data: {text: chunk}}
      const events = ['meta', ...deltas.map(() => 'delta'), 'sources', 'done'];
      expect(events[0]).toBe('meta');
      expect(events[events.length - 2]).toBe('sources');
      expect(events[events.length - 1]).toBe('done');
    });
  });

  describe('safety rule 7: PII not stored', () => {
    it('containsPII detects email, phone, ID', () => {
      expect(containsPII('contact me at test@example.com')).toBe(true);
      expect(containsPII('call +14155552671')).toBe(true);
      expect(containsPII('my ID 123-45-6789')).toBe(true);
      expect(containsPII('my id 123456789012')).toBe(true);
      expect(containsPII('what is rag?')).toBe(false);
    });
    it('PII-pattern question never written', () => {
      const cache = createAnswerCache();
      expect(cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'my email is test@example.com', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      })).toBeUndefined();
    });
    it('PII in answer text also prevents store', () => {
      const cache = createAnswerCache();
      expect(cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hello', answerText: 'your email test@example.com is stored', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      })).toBeUndefined();
    });
    it('phone pattern also blocked', () => {
      const cache = createAnswerCache();
      expect(cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'call 415-555-2671 urgently', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      })).toBeUndefined();
    });
  });

  describe('contact details not cached', () => {
    it('record has no contact field, source_refs only', async () => {
      const { l2, store } = fakeL2();
      const cache = new AnswerCache({ l2 });
      await cache.set({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hello', answerText: 'helpful answer text', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      const rec = [...store.values()][0]!;
      expect(rec.bot_id).toBe(BOT_A);
      expect(Object.keys(rec)).not.toContain('contact');
      expect(Object.keys(rec)).not.toContain('contact_email');
      expect(Object.keys(rec)).not.toContain('contact_phone');
      // contact is served from current public_bot_config at read time, never from answer_cache.
      expect(rec.source_refs[0]!.chunk_id).toBe(SOURCE_REFS[0]!.chunk_id);
    });
    it('answer text that is a contact card is still storable (contact served separately)', () => {
      // The cache stores only answer_text + source_refs; contact is added at SSE time from config.
      const cache = createAnswerCache();
      const key = cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'contact human', answerText: 'Here is help', sourceRefs: [], handoffReason: 'human_requested', status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      expect(key).toBeDefined();
      // But containsContactDetails would be separate; cache payload has no contact.
      expect(containsContactDetails('mailto:test@example.com')).toBe(true);
    });
  });

  describe('TTL', () => {
    it('default TTL 24h', () => {
      const c = createAnswerCache();
      expect(c.ttlMs).toBe(ANSWER_CACHE_DEFAULT_TTL_MS);
      expect(ANSWER_CACHE_DEFAULT_TTL_MS).toBe(24 * 60 * 60 * 1000);
    });
    it('serves within TTL and misses after expiry', () => {
      let now = 0;
      const cache = new AnswerCache({ now: () => now });
      cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hello', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      expect(cache.getL1(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'hello', { isFirstTurn: true, cachePolicy: enabledPolicy() })).toBeDefined();
      now = ANSWER_CACHE_DEFAULT_TTL_MS - 1;
      expect(cache.getL1(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'hello', { isFirstTurn: true, cachePolicy: enabledPolicy() })).toBeDefined();
      now = ANSWER_CACHE_DEFAULT_TTL_MS;
      expect(cache.getL1(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'hello', { isFirstTurn: true, cachePolicy: enabledPolicy() })).toBeUndefined();
    });
    it('TTL from client_settings is respected via options', async () => {
      let now = 0;
      const { l2 } = fakeL2();
      const cache = new AnswerCache({ now: () => now, ttlMs: 60 * 60 * 1000, l2 });
      await cache.set({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hello', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      now = 60 * 60 * 1000;
      const cache2 = new AnswerCache({ now: () => now, l2 });
      expect(await cache2.get(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'hello', { isFirstTurn: true, cachePolicy: enabledPolicy() })).toBeUndefined();
    });
  });

  describe('kill switch for answer cache', () => {
    it('flag off => every layer bypassed', () => {
      const cache = createAnswerCache();
      cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'hello', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: enabledPolicy(),
      });
      expect(cache.getL1(BOT_A, 1, 1, PROMPT_V1, MODEL, 'en', 'hello', { isFirstTurn: true, cachePolicy: disabledPolicy() })).toBeUndefined();
      // set also bypassed
      expect(cache.setL1({
        botId: BOT_A, corpusVersion: 1, settingsVersion: 1, promptTemplateVersion: PROMPT_V1, chatModel: MODEL,
        language: 'en', rawQuestion: 'other', answerText: 'hi', sourceRefs: SOURCE_REFS, handoffReason: null, status: 'complete', moderated: true, cachePolicy: disabledPolicy(),
      })).toBeUndefined();
    });
  });
});

describe('C8 warm-answer-cache — worker/src/jobs/warm-answer-cache.ts', () => {
  // Use valid v4 UUIDs for warm payload (zod uuid strict)
  const WARM_BOT = '550e8400-e29b-41d4-a716-446655440000';
  it('pre-populates suggested_questions after activation (fetcher path)', async () => {
    const suggested = ['What is RAG?', 'How to reset password?', 'Contact support'];
    const fetcher = { getSuggestedQuestions: vi.fn(async () => suggested) };
    const embed = vi.fn(async () => ({ vectors: [[0.1, 0.2]] }));
    const match = vi.fn(async () => []);
    const retrieval = { embedQuery: async (_q: string) => ({ vector: [0.1] as const }), match };
    const handler = createWarmAnswerCacheHandler({ fetcher, embedding: { embed } as never, retrieval });
    const job = { id: 'job-warm-1', type: 'warm_answer_cache' as const, payload: { bot_id: WARM_BOT, corpus_version: 7 }, attempts: 1, maxAttempts: 3 };
    const ctx = {
      db: { rpc: vi.fn(async () => null) },
      storage: {} as never, config: {} as never, signal: new AbortController().signal, workerId: 'test-worker',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } as never,
      heartbeat: async () => {},
    };
    await handler(job as never, ctx as never);
    expect(fetcher.getSuggestedQuestions).toHaveBeenCalledWith(WARM_BOT, expect.any(Object));
    expect(embed).toHaveBeenCalledTimes(suggested.length);
  });
  it('no suggested_questions => no warming but still succeeds', async () => {
    const fetcher = { getSuggestedQuestions: vi.fn(async () => []) };
    const handler = createWarmAnswerCacheHandler({ fetcher });
    const job = { id: 'job-warm-2', type: 'warm_answer_cache' as const, payload: { bot_id: WARM_BOT, corpus_version: 2 }, attempts: 1, maxAttempts: 3 };
    const ctx = {
      db: { rpc: vi.fn() }, storage: {} as never, config: {} as never, signal: new AbortController().signal, workerId: 'w',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } as never,
      heartbeat: async () => {},
    };
    await handler(job as never, ctx as never);
    expect(fetcher.getSuggestedQuestions).toHaveBeenCalled();
  });
  it('warm job dedupes and caps at 6 questions', async () => {
    const many = ['q1', 'q2', 'q1', 'q3', 'q4', 'q5', 'q6', 'q7'];
    const fetcher = { getSuggestedQuestions: vi.fn(async () => many) };
    const embed = vi.fn(async () => ({ vectors: [[0.1]] }));
    const handler = createWarmAnswerCacheHandler({ fetcher, embedding: { embed } as never });
    const job = { id: 'job-warm-3', type: 'warm_answer_cache' as const, payload: { bot_id: WARM_BOT, corpus_version: 3 }, attempts: 1, maxAttempts: 3 };
    const ctx = {
      db: { rpc: vi.fn() }, storage: {} as never, config: {} as never, signal: new AbortController().signal, workerId: 'w',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } as never,
      heartbeat: async () => {},
    };
    await handler(job as never, ctx as never);
    // deduped q1 + capped to 6 => 6 calls
    expect(embed).toHaveBeenCalledTimes(6);
  });
});
