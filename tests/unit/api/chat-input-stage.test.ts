import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOT,
  RUN,
  closeApps,
  chatBody,
  eventOf,
  names,
  parseSse,
  postChat,
  setup,
  type Options,
} from './chat-harness.ts';
import { fakeProviderError } from '../../helpers/fake-ai.ts';

afterEach(async () => {
  vi.useRealTimers();
  await closeApps();
});

async function run(options: Options = {}) {
  const h = setup(options);
  const res = await postChat(h, chatBody());
  expect(res.statusCode).toBe(200);
  return { h, events: parseSse(res.body) };
}

// P7-D1 fix 7 (R1-6, R2-10): the input stage is moderation in parallel with the query embedding.
// Whatever ends it early, the other call is aborted; nothing waits past the total deadline; a
// transient failure of either is retried once.

describe('input stage: dangling work is aborted (fix 7)', () => {
  it('a moderation failure aborts the slow embedding instead of waiting for it', async () => {
    // The embedding would take a minute (it waits for the abort); the request must not.
    const { h, events } = await run({
      moderation: () => fakeProviderError('permanent'),
      embeddingOptions: { hang: true },
    });
    expect(names(events)).toEqual(['meta', 'error', 'handoff']);
    expect(eventOf(events, 'error').data.code).toBe('PROVIDER_UNAVAILABLE');
    expect(h.embedding.abortedCalls).toBe(1);
    expect(h.chatProvider.calls).toBe(0);
    expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'failed');
  }, 20_000);

  it('an embedding failure aborts the slow moderation call instead of waiting for it', async () => {
    const { h, events } = await run({
      moderation: () => 'hang',
      embeddingFail: fakeProviderError('permanent'),
    });
    expect(names(events)).toEqual(['meta', 'error', 'handoff']);
    expect(eventOf(events, 'error').data.code).toBe('PROVIDER_UNAVAILABLE');
    expect(h.moderationProvider.abortedCalls).toBe(1);
    expect(h.chatProvider.calls).toBe(0);
  }, 20_000);

  it('a blocked question aborts the slow embedding too', async () => {
    const { h, events } = await run({
      moderation: () => 'block',
      embeddingOptions: { hang: true },
    });
    expect(eventOf(events, 'handoff').data.reason).toBe('blocked');
    expect(h.embedding.abortedCalls).toBe(1);
    expect(h.calls('match_document_chunks')).toHaveLength(0);
  }, 20_000);

  it('a question for a person aborts nothing and embeds nothing', async () => {
    const h = setup({ embeddingOptions: { hang: true } });
    const res = await postChat(h, chatBody({ message: 'I want to talk to a real person' }));
    expect(res.statusCode).toBe(200);
    expect(h.embedding.calls).toBe(0);
  });

  it('every aborted call still has its usage row', async () => {
    const { h } = await run({
      moderation: () => fakeProviderError('permanent'),
      embeddingOptions: { hang: true },
    });
    const ops = h
      .calls('record_request_usage')
      .map((r) => r.args['p_operation'])
      .sort();
    expect(ops).toEqual(['embedding_query', 'moderation']);
  }, 20_000);

  it('does not wait past CHAT_DEADLINE_MS for a provider that ignores the abort', async () => {
    // The embedding never settles and never looks at the signal. Moderation answers; then the
    // request waits for the embedding until the deadline and ends there, without hanging.
    const { h, events } = await run({
      env: { CHAT_DEADLINE_MS: '400' },
      embeddingOptions: { ignoreAbort: true },
    });
    expect(names(events)).toEqual(['meta', 'error', 'handoff']);
    expect(eventOf(events, 'error').data.code).toBe('PROVIDER_UNAVAILABLE');
    expect(h.chatProvider.calls).toBe(0);
    expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'failed');
    expect(h.limits.settle.mock.calls.length + h.limits.release.mock.calls.length).toBe(1);
  }, 20_000);

  it('a block verdict does not wait for an embedding that ignores the abort', async () => {
    const { events } = await run({
      moderation: () => 'block',
      embeddingOptions: { ignoreAbort: true },
      env: { CHAT_DEADLINE_MS: '400' },
    });
    expect(eventOf(events, 'handoff').data.reason).toBe('blocked');
  }, 20_000);
});

describe('input stage: one retry of a transient failure (fix 7)', () => {
  it('a transient moderation failure is retried once and then the request goes on', async () => {
    const { h, events } = await run({
      moderation: (_t, i) => (i === 0 ? fakeProviderError('transient') : 'allow'),
    });
    expect(names(events)).toEqual(['meta', 'delta', 'sources', 'done']);
    // The failed call has its row too: question twice, then the answer batch.
    const moderationRows = h
      .calls('record_request_usage')
      .filter((r) => r.args['p_operation'] === 'moderation');
    expect(moderationRows.length).toBeGreaterThanOrEqual(3);
  });

  it('a rate-limited moderation call is retried too', async () => {
    const { events } = await run({
      moderation: (_t, i) =>
        i === 0 ? fakeProviderError('rate_limited', { retryAfterSeconds: 1 }) : 'allow',
    });
    expect(names(events)).toContain('done');
  });

  it('moderation that keeps failing is tried exactly twice and then fails closed', async () => {
    const { h, events } = await run({ moderation: () => fakeProviderError('transient') });
    expect(h.moderationProvider.calls).toBe(2);
    expect(names(events)).toEqual(['meta', 'error', 'handoff']);
    expect(h.chatProvider.calls).toBe(0);
  });

  it.each(['auth', 'billing', 'permanent'] as const)(
    'a %s moderation failure is not retried',
    async (kind) => {
      const { h } = await run({ moderation: () => fakeProviderError(kind) });
      expect(h.moderationProvider.calls).toBe(1);
    },
  );

  it('a transient embedding failure is retried once and then the request goes on', async () => {
    const { h, events } = await run({
      embeddingFail: fakeProviderError('transient'),
      embeddingOptions: { failTimes: 1 },
    });
    expect(h.embedding.calls).toBe(2);
    expect(names(events)).toEqual(['meta', 'delta', 'sources', 'done']);
    const rows = h
      .calls('record_request_usage')
      .filter((r) => r.args['p_operation'] === 'embedding_query');
    expect(rows).toHaveLength(2);
  });

  it('an embedding that keeps failing is tried exactly twice and then fails closed', async () => {
    const { h, events } = await run({ embeddingFail: fakeProviderError('rate_limited') });
    expect(h.embedding.calls).toBe(2);
    expect(names(events)).toEqual(['meta', 'error', 'handoff']);
  });

  it.each(['auth', 'billing', 'permanent'] as const)(
    'a %s embedding failure is not retried',
    async (kind) => {
      const { h } = await run({ embeddingFail: fakeProviderError(kind) });
      expect(h.embedding.calls).toBe(1);
    },
  );

  it('the retry is not attempted when the deadline has no room for it', async () => {
    const { h } = await run({
      env: { CHAT_DEADLINE_MS: '1' },
      moderation: () => fakeProviderError('transient'),
    });
    expect(h.moderationProvider.calls).toBeLessThanOrEqual(1);
  });

  it('the reservation covers both calls of each kind', async () => {
    const h = setup();
    await postChat(h);
    const amount = (h.limits.reserve.mock.calls[0] as unknown as [string, string, number])[2];
    // Two embeddings of the question at 1 char = 1 token, at the configured price.
    const twoEmbeddings =
      (2 * 'How much is the standard plan?'.length * h.config.embeddingPricePerMillionTokens) /
      1_000_000;
    expect(amount).toBeGreaterThan(twoEmbeddings);
  });
});

describe('heartbeat stops with the stream (fix 11, R2-8)', () => {
  it('writes no keep-alive after the error event, even if finishing takes a while', async () => {
    // Only the interval functions are faked, so the rest of the request runs on real timers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // An interruption after text was released: `error` with no handoff after it, so the stream
    // stays open for the whole of the finishing work below.
    const h = setup({
      chat: [
        {
          chunks: [`${'EVIDENCE: SUFFICIENT\n'}${'word '.repeat(100)}`, 'more'],
          failAfter: { chunks: 1, error: fakeProviderError('permanent') },
        },
      ],
      settle: async () => {
        // Settling is slow: the heartbeat period passes many times while the stream is finished.
        vi.advanceTimersByTime(60_000);
      },
    });
    const res = await postChat(h);
    const body = res.body;
    const errorAt = body.indexOf('event: error');
    expect(errorAt).toBeGreaterThan(-1);
    expect(body.slice(errorAt)).not.toContain(': keep-alive');
  });

  it('writes no keep-alive after done either', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = setup({
      settle: async () => {
        vi.advanceTimersByTime(60_000);
      },
    });
    const res = await postChat(h);
    const doneAt = res.body.indexOf('event: done');
    expect(doneAt).toBeGreaterThan(-1);
    expect(res.body.slice(doneAt)).not.toContain(': keep-alive');
  });

  it('still sends keep-alives while the answer is being produced', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = setup({
      // The answer is produced slowly; the heartbeat fires while it is pending.
      chat: [{ chunks: ['EVIDENCE: SUFFICIENT\nA short answer.'], chunkDelayMs: 50 }],
      moderation: () => {
        vi.advanceTimersByTime(60_000);
        return 'allow';
      },
    });
    const res = await postChat(h);
    expect(res.body).toContain(': keep-alive');
    expect(res.body.indexOf(': keep-alive')).toBeLessThan(res.body.indexOf('event: done'));
  });
});
