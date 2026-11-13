// P7-D1/D2: answer-cache safety at the chat-service call site.
// P7-D1 (High): L1/L2 hits must re-check that cited documents are still
// active via `get_chunks_by_ids` — the stub `areDocsActive: async () => true`
// served answers citing deleted documents. Test-first: these fail before the
// fix (no `get_chunks_by_ids` call is ever made) and pass after.
// P7-D2 (Medium): the cache key must pin the real chat model, not the
// `'chat'` literal — otherwise a model change serves stale answers.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createAnswerCache } from '../../../api/src/services/answer-cache.ts';
import { createModerationCache } from '../../../api/src/services/moderation-cache.ts';
import {
  ANSWER_HEADER,
  CHUNK_A,
  chatBody,
  chunkRow,
  closeApps,
  defaultContext,
  deltaText,
  names,
  parseSse,
  postChat,
  setup,
} from './chat-harness.ts';

afterEach(closeApps);

const ANSWER = `${ANSWER_HEADER}Plans start at ten dollars [[${CHUNK_A}]].`;
const ENABLED_CTX = () => defaultContext({ settings: { cache_policy: { enabled: true } } });

function scripts() {
  return [{ chunks: [ANSWER] }, { chunks: [ANSWER] }];
}

async function turn(
  h: ReturnType<typeof setup>,
  key: string = randomUUID(),
): Promise<ReturnType<typeof parseSse>> {
  const res = await postChat(h, chatBody(), { 'idempotency-key': key });
  expect(res.statusCode).toBe(200);
  return parseSse(res.body);
}

describe('P7-D1: cached answers re-check cited documents', () => {
  it('re-runs retrieval when the cited chunk is gone (purges the entry)', async () => {
    const cache = createAnswerCache();
    const h = setup({
      answerCache: cache,
      chatModelKey: 'test/model-a',
      context: ENABLED_CTX(),
      chunks: [chunkRow(CHUNK_A)],
      chat: scripts(),
      activeChunkIds: [],
    });
    const first = await turn(h);
    expect(names(first)).toContain('done');
    expect(deltaText(first)).toContain('ten dollars');

    // Same question, new idempotency key. The cached entry cites CHUNK_A,
    // which `get_chunks_by_ids` no longer reports (document deleted).
    const second = await turn(h);
    expect(h.calls('get_chunks_by_ids').length).toBeGreaterThan(0);
    expect(h.calls('match_document_chunks').length).toBe(2);
    expect(names(second)).toContain('done');
  });

  it('serves the cached answer when the cited chunk is still active', async () => {
    const cache = createAnswerCache();
    const h = setup({
      answerCache: cache,
      chatModelKey: 'test/model-a',
      context: ENABLED_CTX(),
      chunks: [chunkRow(CHUNK_A)],
      chat: scripts(),
      activeChunkIds: [CHUNK_A],
    });
    await turn(h);
    const before = h.calls('match_document_chunks').length;
    const second = await turn(h);
    // The recheck ran, the docs are active, the hit is served: no retrieval.
    expect(h.calls('get_chunks_by_ids').length).toBeGreaterThan(0);
    expect(h.calls('match_document_chunks').length).toBe(before);
    expect(deltaText(second)).toContain('ten dollars');
  });
});

describe('P7-D3: moderation verdicts are keyed by the real model', () => {
  it('re-moderates when the moderation model changes', async () => {
    const cache = createModerationCache();
    const base = {
      chunks: [chunkRow(CHUNK_A)],
      chat: scripts(),
      moderationCache: cache,
    };
    const h1 = setup({ ...base, moderationModelKey: 'test/moderation-a' });
    const first = await turn(h1);
    expect(names(first)).toContain('done');
    const callsAfterFirst = h1.moderationProvider.texts.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const h2 = setup({ ...base, moderationModelKey: 'test/moderation-b' });
    const second = await turn(h2);
    expect(names(second)).toContain('done');
    // Different model key: cache miss, the input is moderated again.
    // (Output moderation also consults the provider, so count the input text.)
    const question = String(chatBody().message);
    expect(h2.moderationProvider.texts).toContain(question);

    const h3 = setup({ ...base, moderationModelKey: 'test/moderation-a' });
    await turn(h3);
    // Same model key as turn 1: input verdict served from cache.
    expect(h3.moderationProvider.texts).not.toContain(question);
  });
});

describe('P7-D2: cache keys pin the real chat model', () => {
  it('does not serve a model-a answer to a model-b request', async () => {
    const cache = createAnswerCache();
    const ctx = ENABLED_CTX();
    const h1 = setup({
      answerCache: cache,
      chatModelKey: 'test/model-a',
      context: ctx,
      chunks: [chunkRow(CHUNK_A)],
      chat: scripts(),
      activeChunkIds: [CHUNK_A],
    });
    const first = await turn(h1);
    expect(deltaText(first)).toContain('ten dollars');

    const h2 = setup({
      answerCache: cache,
      chatModelKey: 'test/model-b',
      context: ctx,
      chunks: [chunkRow(CHUNK_A)],
      chat: scripts(),
      activeChunkIds: [CHUNK_A],
    });
    await turn(h2);
    // Different model key: cache miss, pipeline re-ran on the second service.
    expect(h2.calls('match_document_chunks').length).toBe(1);
    expect(h2.chatProvider.calls).toBe(1);
  });
});
