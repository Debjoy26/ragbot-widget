import { afterEach, describe, expect, it } from 'vitest';
import { CLASSIFIER_MAX_OUTPUT_TOKENS, CLASSIFIER_SYSTEM_PROMPT } from '@ragbot/shared/ai';
import { ProviderError, type ModerationProvider } from '@ragbot/shared';
import {
  ANSWER_HEADER,
  chatBody,
  closeApps,
  defaultContext,
  eventOf,
  parseSse,
  postChat,
  setup,
  type Harness,
} from './chat-harness.ts';
import { fakeProviderError } from '../../helpers/fake-ai.ts';
import { ConfigError, loadConfig } from '../../../api/src/lib/config.ts';
import { validEnv } from './helpers.ts';
import {
  createModerator,
  MODERATION_PROMPT_OVERHEAD_TOKENS,
} from '../../../api/src/services/moderation.ts';
import type { UsageEntry } from '../../../api/src/services/conversations.ts';

afterEach(closeApps);

// P7-D2 F7: spend. (a) the reservation covers output moderation once per attempt that can produce
// text, (b) an aborted moderation call that was sent is recorded at its input estimate, (c) no usage
// row is written after the budget is settled. (d) is in chat-context-min-d2.test.ts.

const FALLBACK_ENV = {
  CHAT_FALLBACK_PROVIDER: 'openai',
  CHAT_FALLBACK_MODEL: 'fake-fallback-model',
  OPENAI_API_KEY: 'k'.repeat(40),
  CHAT_FALLBACK_PRICE_INPUT_PER_MILLION: '0.2',
  CHAT_FALLBACK_PRICE_OUTPUT_PER_MILLION: '0.8',
};
const OVERHEAD = CLASSIFIER_SYSTEM_PROMPT.length + 64;
const PRICE_IN = 1.0;
const PRICE_OUT = 0.4;
const MOD_ENV = {
  MODERATION_PRICE_INPUT_PER_MILLION: String(PRICE_IN),
  MODERATION_PRICE_OUTPUT_PER_MILLION: String(PRICE_OUT),
};

async function reserved(options: Parameters<typeof setup>[0] = {}): Promise<number> {
  const h = setup(options);
  await postChat(h);
  return (h.limits.reserve.mock.calls[0] as unknown as [string, string, number])[2];
}

// One full chat call at the defaults: 6000 budget tokens at 3 characters, counted per character.
const chatCall = (inPrice: number, outPrice: number) =>
  (6000 * 3 * inPrice + 800 * outPrice) / 1_000_000;
// Output moderation of one answer of 8000 characters: the default rolling mode is
// ceil(8000 / 400) + 1 = 21 calls, buffer mode is one.
const outputModeration = (calls: number) =>
  ((calls * OVERHEAD + 8000) * PRICE_IN + calls * CLASSIFIER_MAX_OUTPUT_TOKENS * PRICE_OUT) /
  1_000_000;

describe('P7-D2 F7a: output moderation is reserved once per attempt that can produce text', () => {
  it('each extra attempt adds a chat call and an output moderation pass', async () => {
    const one = await reserved({
      env: { ...MOD_ENV, CHAT_PROVIDER_ATTEMPTS: '1' },
      attempts: 1,
    });
    const two = await reserved({
      env: { ...MOD_ENV, CHAT_PROVIDER_ATTEMPTS: '2' },
      attempts: 2,
    });
    const three = await reserved({
      env: { ...MOD_ENV, CHAT_PROVIDER_ATTEMPTS: '3' },
      attempts: 3,
    });
    expect(two - one).toBeCloseTo(chatCall(0.1, 0.4) + outputModeration(21), 5);
    expect(three - two).toBeCloseTo(chatCall(0.1, 0.4) + outputModeration(21), 5);
  });

  it('a fallback provider adds its attempts, each with an output moderation pass', async () => {
    const without = await reserved({
      env: { ...MOD_ENV, CHAT_PROVIDER_ATTEMPTS: '2' },
      attempts: 2,
    });
    const withFallback = await reserved({
      env: { ...MOD_ENV, CHAT_PROVIDER_ATTEMPTS: '2', ...FALLBACK_ENV },
      fallback: [{ chunks: ['unused'] }],
      attempts: 2,
    });
    expect(withFallback - without).toBeCloseTo(2 * (chatCall(0.2, 0.8) + outputModeration(21)), 5);
  });

  it('buffer mode: one output moderation call per attempt', async () => {
    const buffer = defaultContext({
      settings: { feature_flags: { output_moderation_mode: 'buffer' } },
    });
    const one = await reserved({
      env: { ...MOD_ENV, CHAT_PROVIDER_ATTEMPTS: '1' },
      attempts: 1,
      context: buffer,
    });
    const three = await reserved({
      env: { ...MOD_ENV, CHAT_PROVIDER_ATTEMPTS: '3' },
      attempts: 3,
      context: buffer,
    });
    expect(three - one).toBeCloseTo(2 * (chatCall(0.1, 0.4) + outputModeration(1)), 5);
  });
});

// ---------------------------------------------------------------------------------------------

describe('P7-D2 F7b: a moderation call that was sent and then aborted costs its input estimate', () => {
  const TEXT = 'x'.repeat(300);
  const PRICE = { inputPerMillion: 1, outputPerMillion: 2 };

  function sink() {
    const rows: UsageEntry[] = [];
    return { rows, record: (e: UsageEntry) => rows.push(e) };
  }

  /** A provider that waits for the abort and then throws, as a fetch does. */
  function abortingProvider(): ModerationProvider {
    return {
      provider: 'gemini',
      model: 'fake-moderation-model',
      moderate: (_text, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    };
  }

  it('llm_classifier: abort mid-call records the prompt and the text as input, no output', async () => {
    const usage = sink();
    const ctl = new AbortController();
    const moderator = createModerator({
      provider: abortingProvider(),
      mode: 'llm_classifier',
      price: PRICE,
    });
    const pending = moderator.moderate(TEXT, ctl.signal, usage);
    ctl.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]).toMatchObject({
      operation: 'moderation',
      inputTokens: MODERATION_PROMPT_OVERHEAD_TOKENS + TEXT.length,
      outputTokens: 0,
    });
    expect(usage.rows[0]?.cost).toBeCloseTo(
      ((MODERATION_PROMPT_OVERHEAD_TOKENS + TEXT.length) * 1) / 1_000_000,
      9,
    );
  });

  it('a call that was never sent (the signal was already aborted) costs nothing', async () => {
    const usage = sink();
    const ctl = new AbortController();
    ctl.abort();
    const provider: ModerationProvider = {
      provider: 'gemini',
      model: 'm',
      moderate: () => Promise.reject(new Error('aborted')),
    };
    await expect(
      createModerator({ provider, mode: 'llm_classifier', price: PRICE }).moderate(
        TEXT,
        ctl.signal,
        usage,
      ),
    ).rejects.toThrow('aborted');
    expect(usage.rows[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, cost: 0 });
  });

  it('endpoint mode is free even when aborted', async () => {
    const usage = sink();
    const ctl = new AbortController();
    const moderator = createModerator({
      provider: abortingProvider(),
      mode: 'endpoint',
      price: PRICE,
    });
    const pending = moderator.moderate(TEXT, ctl.signal, usage);
    ctl.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(usage.rows[0]).toMatchObject({ cost: 0 });
  });

  it('a failure that is not an abort and was not billed still costs nothing', async () => {
    const usage = sink();
    const provider: ModerationProvider = {
      provider: 'gemini',
      model: 'm',
      moderate: () => Promise.reject(new ProviderError('transient', 'FAKE')),
    };
    await expect(
      createModerator({ provider, mode: 'llm_classifier', price: PRICE }).moderate(
        TEXT,
        new AbortController().signal,
        usage,
      ),
    ).rejects.toMatchObject({ name: 'ModerationFailure' });
    expect(usage.rows[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, cost: 0 });
  });

  it('a billed failure keeps its estimate', async () => {
    const usage = sink();
    const provider: ModerationProvider = {
      provider: 'gemini',
      model: 'm',
      moderate: () => Promise.reject(new ProviderError('transient', 'FAKE', { billed: true })),
    };
    await expect(
      createModerator({ provider, mode: 'llm_classifier', price: PRICE }).moderate(
        TEXT,
        new AbortController().signal,
        usage,
      ),
    ).rejects.toMatchObject({ name: 'ModerationFailure' });
    expect(usage.rows[0]?.inputTokens).toBe(MODERATION_PROMPT_OVERHEAD_TOKENS + TEXT.length);
  });
});

// ---------------------------------------------------------------------------------------------

describe('P7-D2 F7d: CHAT_CONTEXT_MAX_TOKENS must fit a real request', () => {
  it('refuses a value that cannot hold a 2000-character question and one chunk', () => {
    for (const value of ['256', '1000', '1400', '2000']) {
      let thrown: unknown;
      try {
        loadConfig(validEnv({ CHAT_CONTEXT_MAX_TOKENS: value }));
      } catch (err) {
        thrown = err;
      }
      expect(thrown, value).toBeInstanceOf(ConfigError);
      expect((thrown as ConfigError).variables, value).toEqual(['CHAT_CONTEXT_MAX_TOKENS']);
    }
  });

  it('still accepts a comfortable value', () => {
    expect(loadConfig(validEnv({ CHAT_CONTEXT_MAX_TOKENS: '6000' })).chatContextMaxTokens).toBe(
      6000,
    );
  });
});

// ---------------------------------------------------------------------------------------------

describe('P7-D2 F7c: moderation calls are part of the work that settlement waits for', () => {
  it('an input moderation abandoned after an embedding failure is recorded before settle', async () => {
    const holder: { h?: Harness } = {};
    // What the usage rows looked like when the reservation was closed (settled or released).
    const atClose: { how: string; rows: number; moderationRows: number; amount: number }[] = [];
    const snapshot = (how: string, amount: number): void => {
      const rows = holder.h?.calls('record_request_usage') ?? [];
      atClose.push({
        how,
        rows: rows.length,
        moderationRows: rows.filter((r) => r.args['p_operation'] === 'moderation').length,
        amount,
      });
    };
    const h = setup({
      // The embedding fails for good at once; the moderation call hangs and notices its abort late.
      embeddingFail: fakeProviderError('permanent'),
      moderation: () => 'hang',
      moderationAbortDelayMs: 60,
      settle: async (_bot, _reservation, amount) => snapshot('settle', amount),
      release: async () => snapshot('release', 0),
    });
    holder.h = h;
    const res = await postChat(h, chatBody());
    expect(res.statusCode).toBe(200);
    expect(eventOf(parseSse(res.body), 'error').data.code).toBe('PROVIDER_UNAVAILABLE');
    expect(atClose).toHaveLength(1);
    // Every provider call is already in usage_events when the budget is closed ...
    expect(atClose[0]?.moderationRows).toBe(1);
    // ... and nothing is written afterwards.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const rows = h.calls('record_request_usage');
    expect(rows).toHaveLength(atClose[0]?.rows ?? -1);
    // The aborted moderation call was sent: its estimate is spend, so the budget is settled at the
    // sum of the rows, not released.
    const sum = rows.reduce((s, r) => s + Number(r.args['p_estimated_cost']), 0);
    expect(sum).toBeGreaterThan(0);
    expect(atClose[0]?.how).toBe('settle');
    expect(atClose[0]?.amount).toBeCloseTo(sum, 8);
  });

  it('the answer path is unchanged: every call is recorded once, settle is the sum', async () => {
    const h = setup({
      chat: [{ chunks: [`${ANSWER_HEADER}Plans start at ten dollars.`] }],
    });
    const res = await postChat(h, chatBody());
    expect(res.statusCode).toBe(200);
    const rows = h.calls('record_request_usage');
    const ops = rows.map((r) => r.args['p_operation']).sort();
    expect(ops).toEqual(['chat', 'embedding_query', 'moderation', 'moderation']);
    const settled = (h.limits.settle.mock.calls[0] as unknown as [string, string, number])[2];
    expect(settled).toBeCloseTo(
      rows.reduce((s, r) => s + Number(r.args['p_estimated_cost']), 0),
      8,
    );
  });
});
