// Offline warming contract tests: all providers, database calls and text are synthetic.
// Integrated at T12 from the isolated H1 draft; publish calls target the real
// per-layer fenced RPCs (T10/T11), not the draft's combined publish RPC.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  VECTOR_DIMENSIONS,
  type ChatProvider,
  type EmbeddingProvider,
  type ModerationProvider,
  type ModerationVerdict,
} from '@ragbot/shared';
import { embeddingKeyHash } from '@ragbot/shared/server/embedding-cache';
import { moderationKeyHash } from '@ragbot/shared/server/moderation-cache';
import { answerKeyHash } from '@ragbot/shared/server/answer-cache';
import { PROMPT_TEMPLATE_VERSION } from '@ragbot/shared';
import {
  createWarmAnswerCacheHandler,
  type WarmDeps,
} from '../../../worker/src/jobs/warm-answer-cache.ts';
import type { WarmingConfig } from '../../../worker/src/lib/warming-config.ts';
import type { ClaimedJob, JobContext } from '../../../worker/src/runtime.ts';
import { silentLogger } from '../../../worker/src/lib/logger.ts';

const botId = randomUUID();
const chunkId = randomUUID();
const versionId = randomUUID();
const question = 'FAKE product question';
const vector = new Array<number>(VECTOR_DIMENSIONS).fill(0.01);
function context() {
  return {
    bot: {
      id: botId,
      slug: 'fake',
      enabled: true,
      display_name: 'FAKE',
      identity_prompt: 'FAKE assistant',
      tone: 'plain',
      scope: 'FAKE products',
      allowed_languages: ['en'],
      embedding_model: 'fake-embed',
      embedding_dimensions: VECTOR_DIMENSIONS,
      settings_version: 4,
      corpus_version: 3,
    },
    settings: { feature_flags: {}, handoff_policy: {}, cache_policy: { enabled: true } },
    contact: {
      supported_languages: ['en'],
      escalation_label: 'FAKE contact',
      escalation_messages: { en: 'FAKE help' },
      email: null,
      phone: null,
      whatsapp_url: null,
      page_url: null,
      business_hours: null,
      timezone: null,
    },
  };
}
const PUBLISH_RPC_LAYER = {
  publish_warm_embedding: 'c4',
  publish_warm_retrieval: 'c5',
  publish_warm_moderation: 'c6',
  publish_warm_answer: 'c7',
} as const;
function rig(
  options: {
    state?: string;
    block?: boolean;
    outputBlock?: boolean;
    truncated?: boolean;
    noCitation?: boolean;
    failPending?: boolean;
    interrupted?: boolean;
    abortChat?: boolean;
    nullReserve?: boolean;
    publishFalse?: boolean;
    questions?: string[];
    languages?: string[];
    policy?: Record<string, unknown>;
    lateEmbedding?: boolean;
  } = {},
) {
  const controller = new AbortController();
  const calls: { name: string; args: Record<string, unknown>; signal?: AbortSignal }[] = [];
  const currentContext = context();
  if (options.policy) currentContext.settings.cache_policy = options.policy as { enabled: boolean };
  let moderationCalls = 0;
  let releaseEmbedding: (() => void) | undefined;
  const embeddingGate = new Promise<void>((resolve) => {
    releaseEmbedding = resolve;
  });
  const embedding: EmbeddingProvider = {
    provider: 'gemini',
    model: 'fake-embed',
    dimensions: VECTOR_DIMENSIONS,
    embed: vi.fn(async () => {
      if (options.lateEmbedding) {
        controller.abort();
        await embeddingGate;
      }
      return { vectors: [vector], inputTokens: 10 };
    }),
  };
  const moderation: ModerationProvider = {
    provider: 'gemini',
    model: 'fake-mod',
    moderate: vi.fn(async () => {
      moderationCalls++;
      const verdict: ModerationVerdict =
        options.block || (options.outputBlock && moderationCalls > 1) ? 'block' : 'allow';
      return { verdict, categories: [], usage: { inputTokens: 10, outputTokens: 1 } };
    }),
  };
  const chat: ChatProvider = {
    provider: 'gemini',
    model: 'fake-chat',
    stream: vi.fn(async function* () {
      if (options.abortChat) controller.abort();
      yield {
        text: `EVIDENCE: SUFFICIENT\nFAKE answer${options.noCitation ? '' : ` [[${chunkId}]]`}.`,
      };
      if (options.interrupted) throw new Error('synthetic interrupted stream');
      return { inputTokens: 20, outputTokens: 8, truncated: options.truncated ?? false };
    }),
  };
  const config = {
    ai: {
      embedding: { provider: 'gemini', model: embedding.model, dimensions: VECTOR_DIMENSIONS },
      chatPrimary: { provider: 'gemini', model: chat.model },
      moderation: { provider: 'gemini', model: moderation.model, mode: 'llm_classifier' },
    },
    contextMaxTokens: 4000,
    maxOutputTokens: 256,
    maxOutputChars: 2000,
    topK: 5,
    minSimilarity: 0.5,
    deadlineMs: 10000,
    reserveTtlSeconds: 60,
    moderationMaxChars: 4000,
    embeddingPricePerMillionTokens: 0.1,
    chatPrice: { inputPerMillion: 0.1, outputPerMillion: 0.4 },
    moderationPrice: { inputPerMillion: 0.1, outputPerMillion: 0.8 },
    chatModelKey: 'gemini/fake-chat',
    moderationModelKey: 'gemini/fake-mod/llm_classifier',
    moderationMode: 'llm_classifier',
  } as unknown as WarmingConfig;
  const deps: WarmDeps = { embedding, moderation, chat, config };
  const ctx = {
    signal: controller.signal,
    workerId: 'fake-worker',
    heartbeat: vi.fn(async () => {}),
    log: silentLogger,
    db: {
      rpc: vi.fn(async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
        calls.push({ name, args, ...(signal ? { signal } : {}) });
        if (name === 'get_warm_job_context')
          return {
            state: options.state ?? 'ready',
            context: currentContext,
            questions: options.questions ?? [question],
            languages: options.languages ?? [],
          };
        if (name === 'reserve_warm_budget') return options.nullReserve ? null : randomUUID();
        if (name === 'record_warm_usage' && options.failPending && !args['p_final'])
          throw new Error('synthetic usage write failure');
        if (name === 'match_document_chunks')
          return [
            {
              chunk_id: chunkId,
              document_id: randomUUID(),
              document_version_id: versionId,
              document_title: 'FAKE title',
              chunk_index: 0,
              content: 'FAKE public product evidence',
              page_number: null,
              section: null,
              similarity: 0.9,
            },
          ];
        if (
          name === 'publish_warm_embedding' ||
          name === 'publish_warm_retrieval' ||
          name === 'publish_warm_moderation' ||
          name === 'publish_warm_answer'
        )
          return options.publishFalse ? false : true;
        if (['record_warm_usage', 'settle_warm_budget'].includes(name)) return null;
        throw new Error('unexpected synthetic RPC');
      }),
    },
  } as unknown as JobContext;
  const job = {
    id: randomUUID(),
    type: 'warm_answer_cache',
    payload: { bot_id: botId, corpus_version: 3, settings_version: 4 },
    attempts: 1,
    maxAttempts: 3,
    warmGeneration: 1,
  } as ClaimedJob & { warmGeneration: number };
  const runJob = (j: ClaimedJob = job, injected: WarmDeps | null = deps) =>
    createWarmAnswerCacheHandler(injected)(j, ctx);
  const run = (injected: WarmDeps | null = deps) => runJob(job, injected);
  const entries = () =>
    calls
      .filter((call) => call.name in PUBLISH_RPC_LAYER)
      .map((call) => ({
        layer: PUBLISH_RPC_LAYER[call.name as keyof typeof PUBLISH_RPC_LAYER],
        record: call.args,
      }));
  return {
    run,
    runJob,
    deps,
    ctx,
    job,
    calls,
    entries,
    controller,
    releaseEmbedding: () => releaseEmbedding?.(),
  };
}

describe('fenced cache warming', () => {
  it('ready context creates four real cache-class records with API-compatible identities', async () => {
    const h = rig();
    await h.run();
    const entries = h.entries();
    expect(entries.map((entry) => entry.layer).sort()).toEqual(['c4', 'c5', 'c6', 'c7']);
    expect(entries.find((entry) => entry.layer === 'c4')?.record['p_key_hash']).toBe(
      embeddingKeyHash('fake-embed', VECTOR_DIMENSIONS, question),
    );
    expect(entries.find((entry) => entry.layer === 'c6')?.record['p_key_hash']).toBe(
      moderationKeyHash(h.deps.config.moderationModelKey, 'v1', question),
    );
    expect(entries.find((entry) => entry.layer === 'c6')?.record['p_model']).toBe(
      h.deps.config.moderationModelKey,
    );
    expect(entries.find((entry) => entry.layer === 'c7')?.record['p_key_hash']).toBe(
      answerKeyHash(botId, 3, 4, PROMPT_TEMPLATE_VERSION, h.deps.config.chatModelKey, '', question),
    );
    expect(entries.find((entry) => entry.layer === 'c7')?.record['p_language']).toBe('');
    expect(entries.find((entry) => entry.layer === 'c7')?.record['p_raw_question']).toBe(question);
    expect(entries.find((entry) => entry.layer === 'c7')?.record['p_status']).toBe('complete');
    expect(entries.find((entry) => entry.layer === 'c7')?.record['p_moderated']).toBe(true);
    expect(entries.find((entry) => entry.layer === 'c7')?.record['p_truncated']).toBe(false);
    expect(entries.find((entry) => entry.layer === 'c7')?.record['p_chat_model']).toBe(
      h.deps.config.chatModelKey,
    );
    // C5 anchors on the live C4 row, so the embedding publishes first.
    const order = h.calls.map((call) => call.name);
    expect(order.indexOf('publish_warm_embedding')).toBeLessThan(
      order.indexOf('publish_warm_retrieval'),
    );
    expect(h.deps.embedding.embed).toHaveBeenCalledOnce();
    const usages = h.calls.filter((call) => call.name === 'record_warm_usage');
    expect(usages.filter((call) => !call.args['p_final'])).toHaveLength(4);
    expect(usages.filter((call) => call.args['p_final'])).toHaveLength(4);
    for (const final of usages.filter((call) => call.args['p_final'])) {
      expect(
        usages.find(
          (call) =>
            call.args['p_invocation_id'] === final.args['p_invocation_id'] && !call.args['p_final'],
        ),
      ).toBeDefined();
    }
    expect(h.calls.at(-1)?.name).toBe('settle_warm_budget');
  });
  it.each(['disabled', 'superseded'])(
    '%s returns without providers or reservations',
    async (state) => {
      const h = rig({ state });
      await h.run(null);
      expect(h.deps.embedding.embed).not.toHaveBeenCalled();
      expect(h.calls.map((call) => call.name)).toEqual(['get_warm_job_context']);
    },
  );
  it('ready without dependencies retries rather than claiming success', async () => {
    await expect(rig().run(null)).rejects.toMatchObject({ code: 'warm_config_missing' });
  });
  it('missing warm generation retries without providers or reservations', async () => {
    const h = rig();
    const bare = { ...h.job, warmGeneration: undefined } as unknown as ClaimedJob;
    await expect(h.runJob(bare)).rejects.toMatchObject({ code: 'warm_generation_missing' });
    expect(h.calls).toEqual([]);
  });
  it('payload without settings_version resolves without warming', async () => {
    const h = rig();
    await h.runJob({ ...h.job, payload: { bot_id: botId, corpus_version: 3 } });
    expect(h.calls).toEqual([]);
  });
  it('accepts the real context shape with the default language variant', async () => {
    const h = rig({ languages: ['', 'en'] });
    await h.run();
    expect(h.entries().some((entry) => entry.layer === 'c7')).toBe(true);
    expect(h.calls.filter((call) => call.name === 'reserve_warm_budget')).toHaveLength(2);
  });
  it('PII and normalized duplicates skip work while warming the surviving variant', async () => {
    const h = rig({ questions: ['fake@example.com', question, `  ${question.toUpperCase()}  `] });
    await h.run();
    const reserves = h.calls.filter((call) => call.name === 'reserve_warm_budget');
    expect(reserves).toHaveLength(1);
    expect(reserves[0]?.args['p_question_hash']).toMatch(/^[0-9a-f]{64}$/);
  });
  it('global kill switch starts no provider invocation', async () => {
    const h = rig({ policy: { kill_switch: true, enabled: true } });
    await h.run();
    expect(h.deps.moderation.moderate).not.toHaveBeenCalled();
    expect(h.calls.some((call) => call.name === 'reserve_warm_budget')).toBe(false);
  });
  it('blocked input produces only the C6 candidate', async () => {
    const h = rig({ block: true });
    await h.run();
    expect(h.entries().map((entry) => entry.layer)).toEqual(['c6']);
    expect(h.deps.embedding.embed).not.toHaveBeenCalled();
    expect(h.deps.chat.stream).not.toHaveBeenCalled();
  });
  it.each([{ truncated: true }, { noCitation: true }, { outputBlock: true }])(
    'unsafe final outcome never produces C7: %j',
    async (options) => {
      const h = rig(options);
      await h.run();
      expect(h.entries().some((entry) => entry.layer === 'c7')).toBe(false);
    },
  );
  it('failed pending usage registration prevents the external invocation', async () => {
    const h = rig({ failPending: true });
    await h.run();
    expect(h.deps.moderation.moderate).not.toHaveBeenCalled();
    expect(h.entries()).toEqual([]);
    expect(h.calls.at(-1)?.name).toBe('settle_warm_budget');
  });
  it('null reservation is a quiet skip with no settle and no publish', async () => {
    const h = rig({ nullReserve: true });
    await h.run();
    expect(h.deps.moderation.moderate).not.toHaveBeenCalled();
    expect(h.entries()).toEqual([]);
    expect(h.calls.some((call) => call.name === 'settle_warm_budget')).toBe(false);
    expect(h.calls.some((call) => call.name.startsWith('publish_warm_'))).toBe(false);
  });
  it('publish refusal does not fail the variant and spend is still settled', async () => {
    const h = rig({ publishFalse: true });
    await h.run();
    expect(h.entries().some((entry) => entry.layer === 'c7')).toBe(true);
    expect(h.calls.at(-1)?.name).toBe('settle_warm_budget');
  });
  it('interrupted stream leaves conservative chat charge and settles without publishing', async () => {
    const h = rig({ interrupted: true });
    await h.run();
    const chatCalls = h.calls.filter(
      (call) => call.name === 'record_warm_usage' && call.args['p_operation'] === 'chat',
    );
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]?.args['p_final']).toBe(false);
    expect(Number(chatCalls[0]?.args['p_estimated_cost'])).toBeGreaterThan(0);
    expect(h.entries()).toEqual([]);
    expect(h.calls.at(-1)?.name).toBe('settle_warm_budget');
  });
  it('abort during generation prevents publication', async () => {
    const h = rig({ abortChat: true });
    await h.run();
    expect(h.entries()).toEqual([]);
    expect(h.calls.some((call) => call.name === 'settle_warm_budget')).toBe(true);
  });
  it('a provider completing after abort finalizes accounting on an independent signal', async () => {
    const h = rig({ lateEmbedding: true });
    await h.run();
    expect(h.entries()).toEqual([]);
    h.releaseEmbedding();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    const final = h.calls.find(
      (call) =>
        call.name === 'record_warm_usage' &&
        call.args['p_operation'] === 'embedding_query' &&
        call.args['p_final'],
    );
    expect(final).toBeDefined();
    expect(final?.signal?.aborted).toBe(false);
    expect(final?.signal).not.toBe(h.ctx.signal);
  });
});
