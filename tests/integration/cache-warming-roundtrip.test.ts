// T14: real LOCAL DB + labelled fake providers warm shared L2, and a separate
// built API instance serves the warmed answer as a first-turn cache hit.
// No real provider is called anywhere: the worker side uses labelled in-process
// fakes, the API side uses the loopback FakeLlmServer. Everything created is
// removed afterwards. Run this file alone (integration files run one at a time).
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { PROMPT_TEMPLATE_VERSION } from '@ragbot/shared';
import { answerKeyHash } from '../../shared/src/server/answer-cache.ts';
import type { ChatProvider, EmbeddingProvider, ModerationProvider } from '@ragbot/shared';
import type { WarmingConfig } from '../../worker/src/lib/warming-config.ts';
import { createWarmAnswerCacheHandler } from '../../worker/src/jobs/warm-answer-cache.ts';
import { createDb, type Db } from '../../worker/src/lib/db.ts';
import { silentLogger } from '../../worker/src/lib/logger.ts';
import { getLocalPrivilegedKey, getLocalStack } from './helpers/local-stack.ts';
import {
  ChatHarness,
  deltaText,
  metaOf,
  postChat,
  type ApiHandle,
  type ChatBot,
} from './helpers/chat-fixtures.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const QUESTION = 'T14 how long is the Acme Pro warranty';
const ANSWER_MARK = 'T14-WARMED-WARRANTY-ANSWER';
const WARM_CHAT_KEY = 'openai_compatible/fake-chat-primary|openai_compatible/fake-chat-fallback';

let h: ChatHarness;
let api: ApiHandle;
let db: Db;

beforeAll(async () => {
  h = await ChatHarness.create();
  api = await h.api('t14-warm');
  db = createDb({
    url: getLocalStack().apiUrl,
    secretKey: getLocalPrivilegedKey(),
    timeoutMs: 10000,
  });
});

afterEach(() => {
  // A live chat call would mean the hit path regressed (the warmed answer must
  // serve without generation). Moderation/embedding calls are expected.
  expect(h.primary.unscripted(), 'unscripted chat calls on the primary fake').toBe(0);
  expect(h.fallbackServer.unscripted(), 'unscripted chat calls on the fallback fake').toBe(0);
  expect(h.primary.authFailures(), 'fake key rejections').toBe(0);
});

afterAll(async () => {
  await h?.close();
});

it('warms shared L2 on the real DB and serves the first turn from cache', async () => {
  const bot: ChatBot = await h.createBot({ supportedLanguages: ['en'] });
  try {
    await h.rest.patch(`client_settings?bot_id=eq.${bot.id}`, {
      cache_policy: {
        warm_enabled: true,
        warm_max_attempts: 3,
        c7: true,
        warm_questions: [QUESTION],
      },
    });
    const [chunk] = await bot.addDocument('Acme Pro Warranty', [
      { content: 'The Acme Pro plan includes a two year limited warranty.', topic: 'warranty' },
    ]);
    if (chunk === undefined) throw new Error('chunk missing');

    // Real enqueue path, then a deterministic claim (live lease, generation 1).
    const jobId = await db.rpc<string>('queue_warm_job', { p_bot_id: bot.id });
    expect(typeof jobId).toBe('string');
    await h.rest.patch(`jobs?id=eq.${jobId}`, {
      state: 'running',
      attempts: 1,
      locked_by: 't14-roundtrip',
      locked_until: new Date(Date.now() + 600000).toISOString(),
    });
    const [claimed] = (await h.rest.get<{
      id: string;
      payload: Record<string, unknown>;
      warm_generation: number;
    }>(`jobs?id=eq.${jobId}&select=id,payload,warm_generation`)) as {
      id: string;
      payload: Record<string, unknown>;
      warm_generation: number;
    }[];
    if (claimed === undefined) throw new Error('claimed job missing');
    expect(claimed.warm_generation).toBe(1);

    // Labelled in-process fakes. Nothing here touches the network.
    const vector = h.primary.vectorFor('warranty');
    const embedding: EmbeddingProvider = {
      provider: 'openai_compatible',
      model: h.embeddingModel,
      dimensions: 1536,
      embed: () => Promise.resolve({ vectors: [vector], inputTokens: 10 }),
    };
    const moderation: ModerationProvider = {
      provider: 'openai_compatible',
      model: 'fake-moderation-classifier',
      moderate: () =>
        Promise.resolve({
          verdict: 'allow',
          categories: [],
          usage: { inputTokens: 10, outputTokens: 1 },
        }),
    };
    const chat: ChatProvider = {
      provider: 'openai_compatible',
      model: 'fake-chat-primary',
      stream: async function* () {
        yield { text: `EVIDENCE: SUFFICIENT\n${ANSWER_MARK} two years [[${chunk.id}]].` };
        return { inputTokens: 20, outputTokens: 8, truncated: false };
      },
    };
    const warming: WarmingConfig = {
      ai: {
        embedding: {
          role: 'embedding',
          provider: 'openai_compatible',
          model: h.embeddingModel,
          apiKey: 'fake-t14-ke',
          baseUrl: null,
          dimensions: 1536,
        },
      } as WarmingConfig['ai'],
      chatProvider: 'openai_compatible',
      chatModel: 'fake-chat-primary',
      moderationProvider: 'openai_compatible',
      moderationModel: 'fake-moderation-classifier',
      contextMaxTokens: 6000,
      maxOutputTokens: 800,
      maxOutputChars: 6000,
      topK: 3,
      minSimilarity: 0.5,
      deadlineMs: 30000,
      reserveTtlSeconds: 300,
      moderationMaxChars: 4000,
      embeddingPricePerMillionTokens: 3,
      chatPrice: { inputPerMillion: 10, outputPerMillion: 20 },
      moderationPrice: { inputPerMillion: 1, outputPerMillion: 2 },
      chatModelKey: WARM_CHAT_KEY,
      moderationModelKey: 'openai_compatible/fake-moderation-classifier/llm_classifier',
      moderationMode: 'llm_classifier',
    };
    const controller = new AbortController();
    await createWarmAnswerCacheHandler({ embedding, chat, moderation, config: warming })(
      {
        id: jobId,
        type: 'warm_answer_cache',
        payload: claimed.payload,
        attempts: 1,
        maxAttempts: 3,
        warmGeneration: claimed.warm_generation,
      },
      {
        db,
        storage: undefined as never,
        config: undefined as never,
        signal: controller.signal,
        workerId: 't14-roundtrip',
        heartbeat: () => Promise.resolve(),
        log: silentLogger,
      },
    );

    // Shared L2 really warmed on the real database, under the exact live key.
    const [brow] = (await h.rest.get<{ corpus_version: number; settings_version: number }>(
      `bot_profiles?id=eq.${bot.id}&select=corpus_version,settings_version`,
    )) as { corpus_version: number; settings_version: number }[];
    if (brow === undefined) throw new Error('bot row missing');
    const expectedKey = answerKeyHash(
      bot.id,
      brow.corpus_version,
      brow.settings_version,
      PROMPT_TEMPLATE_VERSION,
      WARM_CHAT_KEY,
      '',
      QUESTION,
    );
    const answers = (await h.rest.get<{
      cache_key_hash: string;
      answer_text: string;
      language: string;
    }>(`answer_cache?bot_id=eq.${bot.id}&select=cache_key_hash,answer_text,language`)) as {
      cache_key_hash: string;
      answer_text: string;
      language: string;
    }[];
    expect(answers.length).toBeGreaterThanOrEqual(1);
    expect(
      answers.some((a) => a.cache_key_hash === expectedKey && a.answer_text.includes(ANSWER_MARK)),
    ).toBe(true);
    const embeddings = (await h.rest.get(
      `query_embedding_cache?select=key_hash&limit=1`,
    )) as unknown[];
    expect(embeddings.length).toBeGreaterThanOrEqual(1);

    // Separate API instance serves the same question as a first-turn cache hit:
    // input moderation and auth still run, but generation never happens.
    const chatCallsBefore = h.primary.count('chat');
    const session = await bot.session(api);
    const r = await postChat(api, session.token, {
      bot_slug: bot.slug,
      conversation_id: null,
      message: QUESTION,
    });
    expect(r.status).toBe(200);
    expect(deltaText(r)).toContain(ANSWER_MARK);
    expect(h.primary.count('chat')).toBe(chatCallsBefore);
    const meta = metaOf(r);
    await bot.waitTerminal(meta.request_id);
    const usage = await bot.usage(meta.request_id);
    // The production hit path records provider/model, not a special operation.
    expect(usage.some((u) => u.provider === 'cache' && u.model === 'answer_cache')).toBe(true);
  } finally {
    await h.rest
      .delete(`jobs?type=eq.warm_answer_cache&payload->>bot_id=eq.${bot.id}`)
      .catch(() => undefined);
    await bot.dispose().catch(() => undefined);
  }
});
