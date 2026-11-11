import { request as httpRequest, type ClientRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '@ragbot/shared';
import {
  ANSWER_HEADER,
  BOT,
  CHUNK_A,
  RUN,
  chatBody,
  closeApps,
  defaultContext,
  deltaText,
  eventOf,
  names,
  parseSse,
  postChat,
  setup,
  KEY,
  type Options,
} from './chat-harness.ts';
import { fakeProviderError } from '../../helpers/fake-ai.ts';
import { createLlm, LlmFailure, type LlmAttempt } from '../../../api/src/services/llm.ts';
import { MODERATION_PROMPT_OVERHEAD_TOKENS } from '../../../api/src/services/moderation.ts';
import { FakeChatProvider } from '../../helpers/fake-ai.ts';

afterEach(closeApps);

const PRICE = { inputPerMillion: 0.1, outputPerMillion: 0.4 };
const FALLBACK_PRICE = { inputPerMillion: 0.2, outputPerMillion: 0.8 };
const LONG = 'word '.repeat(100); // 500 characters: a full rolling batch

async function run(options: Options = {}, body: Record<string, unknown> = chatBody()) {
  const h = setup(options);
  const res = await postChat(h, body);
  expect(res.statusCode).toBe(200);
  return { h, events: parseSse(res.body) };
}

const chatRows = (h: ReturnType<typeof setup>) =>
  h.calls('record_request_usage').filter((r) => r.args['p_operation'] === 'chat');

describe('LLM retry and fallback before the first token (C1)', () => {
  it('retries the same provider on a transient error and then succeeds', async () => {
    const { h, events } = await run({
      chat: [
        { failBefore: fakeProviderError('transient') },
        { chunks: [`${ANSWER_HEADER}Plans start at ten dollars [[${CHUNK_A}]].`] },
      ],
      fallback: [{ chunks: ['unused'] }],
    });
    expect(h.chatProvider.calls).toBe(2);
    expect(h.fallbackProvider?.calls).toBe(0);
    expect(names(events)).toEqual(['meta', 'delta', 'sources', 'done']);
    expect(chatRows(h)).toHaveLength(2);
  });

  it('retries on rate_limited, then falls back after CHAT_PROVIDER_ATTEMPTS attempts', async () => {
    const { h, events } = await run({
      chat: [{ failBefore: fakeProviderError('rate_limited', { retryAfterSeconds: 1 }) }],
      fallback: [{ chunks: [`${ANSWER_HEADER}From the fallback [[${CHUNK_A}]].`] }],
      attempts: 2,
    });
    expect(h.chatProvider.calls).toBe(2);
    expect(h.fallbackProvider?.calls).toBe(1);
    expect(deltaText(events)).toBe('From the fallback.');
    expect(h.calls('finish_chat_turn')[0]?.args).toMatchObject({
      p_provider: 'openai',
      p_model: 'fake-fallback-model',
    });
    // One usage row per provider call, the failed and the fallback ones included.
    const providers = chatRows(h).map((r) => r.args['p_provider']);
    expect(providers).toEqual(['gemini', 'gemini', 'openai']);
  });

  it('the attempt count is a total per provider, not a retry count', async () => {
    const { h } = await run({
      chat: [{ failBefore: fakeProviderError('transient') }],
      fallback: [{ failBefore: fakeProviderError('transient') }],
      attempts: 3,
    });
    expect(h.chatProvider.calls).toBe(3);
    expect(h.fallbackProvider?.calls).toBe(3);
  });

  it.each(['auth', 'billing', 'permanent'] as const)(
    '%s errors neither retry nor fall back',
    async (kind) => {
      const { h, events } = await run({
        chat: [{ failBefore: fakeProviderError(kind) }],
        fallback: [{ chunks: ['unused'] }],
        attempts: 3,
      });
      expect(h.chatProvider.calls).toBe(1);
      expect(h.fallbackProvider?.calls).toBe(0);
      expect(names(events)).toEqual(['meta', 'error', 'handoff']);
      expect(eventOf(events, 'error').data.code).toBe('PROVIDER_UNAVAILABLE');
    },
  );

  it('an unexpected non-provider error is not retried either', async () => {
    const { h } = await run({
      chat: [{ failBefore: new TypeError('boom') }],
      fallback: [{ chunks: ['unused'] }],
    });
    expect(h.chatProvider.calls).toBe(1);
    expect(h.fallbackProvider?.calls).toBe(0);
  });

  it('exhausting primary and fallback is unavailable', async () => {
    const { h, events } = await run({
      chat: [{ failBefore: fakeProviderError('transient') }],
      fallback: [{ failBefore: fakeProviderError('rate_limited') }],
      attempts: 1,
    });
    expect(names(events)).toEqual(['meta', 'error', 'handoff']);
    expect(chatRows(h)).toHaveLength(2);
  });

  it('createLlm refuses an attempt count outside 1..3', () => {
    const p = new FakeChatProvider([{ chunks: [] }]);
    for (const attempts of [0, 4, 1.5]) {
      expect(() =>
        createLlm({ primary: { provider: p, price: PRICE }, fallback: null, attempts }),
      ).toThrow();
    }
  });
});

describe('failure after the first token (C2)', () => {
  it('ends with STREAM_INTERRUPTED and a retry hint; stores partial with the text sent; no switch', async () => {
    const { h, events } = await run({
      chat: [
        {
          chunks: [`${ANSWER_HEADER}${LONG}`, 'more text'],
          failAfter: { chunks: 1, error: fakeProviderError('transient') },
        },
      ],
      fallback: [{ chunks: ['unused'] }],
      attempts: 3,
    });
    expect(names(events).at(-1)).toBe('error');
    expect(names(events)).not.toContain('done');
    expect(names(events)).not.toContain('handoff');
    const error = eventOf(events, 'error').data;
    expect(error.code).toBe('STREAM_INTERRUPTED');
    expect(error.retry_after_seconds).toBeGreaterThanOrEqual(0);
    expect(error.request_id).toBe(RUN);
    expect(h.chatProvider.calls).toBe(1);
    expect(h.fallbackProvider?.calls).toBe(0);
    const stored = h.calls('finish_chat_turn')[0]?.args;
    expect(stored?.['p_status']).toBe('partial');
    expect(stored?.['p_content']).toBe(deltaText(events));
    expect(deltaText(events).length).toBeGreaterThan(300);
    expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'partial');
  });

  it('uses the provider retry-after for the hint', async () => {
    const { events } = await run({
      chat: [
        {
          chunks: [`${ANSWER_HEADER}${LONG}`],
          failAfter: {
            chunks: 1,
            error: fakeProviderError('rate_limited', { retryAfterSeconds: 9 }),
          },
        },
      ],
    });
    expect(eventOf(events, 'error').data.retry_after_seconds).toBe(9);
  });

  it('a billed safety stop after text is interrupted, and the call is still priced', async () => {
    const { h, events } = await run({
      chat: [
        {
          chunks: [`${ANSWER_HEADER}${LONG}`],
          failAfter: { chunks: 1, error: new ProviderError('permanent', 'x', { billed: true }) },
        },
      ],
    });
    expect(eventOf(events, 'error').data.code).toBe('STREAM_INTERRUPTED');
    const row = chatRows(h)[0]?.args;
    expect(Number(row?.['p_input_tokens'])).toBeGreaterThan(0);
    expect(Number(row?.['p_estimated_cost'])).toBeGreaterThan(0);
  });

  it('with buffered output nothing is released, so a failure is retried; after the last attempt it is unavailable', async () => {
    const { h, events } = await run({
      context: defaultContext({
        settings: { feature_flags: { output_moderation_mode: 'buffer' } },
      }),
      chat: [
        {
          chunks: [`${ANSWER_HEADER}short`],
          failAfter: { chunks: 1, error: fakeProviderError('transient') },
        },
      ],
    });
    // P7-D1 fix 3: text was received but never released, so the failure is not an interruption.
    expect(h.chatProvider.calls).toBe(2);
    expect(names(events)).toEqual(['meta', 'error', 'handoff']);
    expect(eventOf(events, 'error').data.code).toBe('PROVIDER_UNAVAILABLE');
    expect(h.calls('finish_chat_turn')[0]?.args['p_status']).toBe('failed');
    expect(h.calls('finish_chat_turn')[0]?.args['p_content']).toBe('');
  });
});

describe('retry and fallback are decided by what was released, not received (P7-D1 fix 3, R2-3)', () => {
  const GOOD = `${ANSWER_HEADER}Plans start at ten dollars [[${CHUNK_A}]].`;
  const buffer = defaultContext({
    settings: { feature_flags: { output_moderation_mode: 'buffer' } },
  });

  it('retries after text was received but is still held back (buffer mode); the draft never reaches the wire', async () => {
    const { h, events } = await run({
      context: buffer,
      chat: [
        {
          chunks: [`${ANSWER_HEADER}DRAFT-TEXT-ONE`],
          failAfter: { chunks: 1, error: fakeProviderError('transient') },
        },
        { chunks: [GOOD] },
      ],
      attempts: 2,
    });
    expect(h.chatProvider.calls).toBe(2);
    expect(names(events)).toEqual(['meta', 'delta', 'sources', 'done']);
    expect(deltaText(events)).toBe('Plans start at ten dollars.');
    expect(JSON.stringify(events)).not.toContain('DRAFT');
    expect(eventOf(events, 'done').data.status).toBe('complete');
    expect(h.calls('finish_chat_turn')[0]?.args['p_content']).toBe('Plans start at ten dollars.');
    // Both calls are in the ledger.
    expect(chatRows(h)).toHaveLength(2);
  });

  it('retries after only part of the header line was received', async () => {
    const { h, events } = await run({
      chat: [
        {
          chunks: ['EVIDENCE: SUFF'],
          failAfter: { chunks: 1, error: fakeProviderError('transient') },
        },
        { chunks: [GOOD] },
      ],
      attempts: 2,
    });
    expect(h.chatProvider.calls).toBe(2);
    expect(deltaText(events)).toBe('Plans start at ten dollars.');
  });

  it('retries after rolling-mode text shorter than a batch was received (still held)', async () => {
    const { h, events } = await run({
      chat: [
        {
          chunks: [`${ANSWER_HEADER}a short draft`],
          failAfter: { chunks: 1, error: fakeProviderError('rate_limited') },
        },
        { chunks: [GOOD] },
      ],
      attempts: 2,
    });
    expect(h.chatProvider.calls).toBe(2);
    expect(deltaText(events)).toBe('Plans start at ten dollars.');
    expect(JSON.stringify(events)).not.toContain('draft');
  });

  it('falls back to the other provider after text was received but not released', async () => {
    const { h, events } = await run({
      context: buffer,
      chat: [
        {
          chunks: [`${ANSWER_HEADER}DRAFT`],
          failAfter: { chunks: 1, error: fakeProviderError('transient') },
        },
      ],
      fallback: [{ chunks: [GOOD] }],
      attempts: 1,
    });
    expect(h.chatProvider.calls).toBe(1);
    expect(h.fallbackProvider?.calls).toBe(1);
    expect(deltaText(events)).toBe('Plans start at ten dollars.');
    expect(h.calls('finish_chat_turn')[0]?.args).toMatchObject({ p_provider: 'openai' });
  });

  it('a non-retryable failure after unreleased text is unavailable at once: no retry, no fallback', async () => {
    const { h, events } = await run({
      context: buffer,
      chat: [
        {
          chunks: [`${ANSWER_HEADER}DRAFT`],
          failAfter: { chunks: 1, error: new ProviderError('permanent', 'x', { billed: true }) },
        },
      ],
      fallback: [{ chunks: [GOOD] }],
      attempts: 3,
    });
    expect(h.chatProvider.calls).toBe(1);
    expect(h.fallbackProvider?.calls).toBe(0);
    expect(names(events)).toEqual(['meta', 'error', 'handoff']);
    expect(eventOf(events, 'error').data.code).toBe('PROVIDER_UNAVAILABLE');
    expect(eventOf(events, 'error').data.retry_after_seconds).toBeUndefined();
  });

  it('once a delta was sent, the next failure is STREAM_INTERRUPTED and nothing is retried', async () => {
    const { h, events } = await run({
      chat: [
        {
          chunks: [`${ANSWER_HEADER}${LONG}`, 'more'],
          failAfter: { chunks: 1, error: fakeProviderError('transient') },
        },
        { chunks: [GOOD] },
      ],
      fallback: [{ chunks: [GOOD] }],
      attempts: 3,
    });
    expect(h.chatProvider.calls).toBe(1);
    expect(h.fallbackProvider?.calls).toBe(0);
    expect(eventOf(events, 'error').data.code).toBe('STREAM_INTERRUPTED');
    expect(h.calls('finish_chat_turn')[0]?.args['p_status']).toBe('partial');
  });

  it.each(['auth', 'billing', 'permanent'] as const)(
    'a %s failure after release is STREAM_INTERRUPTED without retry_after_seconds',
    async (kind) => {
      const { events } = await run({
        chat: [
          {
            chunks: [`${ANSWER_HEADER}${LONG}`, 'more'],
            failAfter: { chunks: 1, error: new ProviderError(kind, 'x', { billed: true }) },
          },
        ],
      });
      const error = eventOf(events, 'error').data;
      expect(error.code).toBe('STREAM_INTERRUPTED');
      expect(error.retry_after_seconds).toBeUndefined();
    },
  );

  it('a billed safety stop (permanent) after release has no retry hint', async () => {
    const { events } = await run({
      chat: [
        {
          chunks: [`${ANSWER_HEADER}${LONG}`],
          failAfter: {
            chunks: 1,
            error: new ProviderError('permanent', 'safety', { billed: true }),
          },
        },
      ],
    });
    expect(eventOf(events, 'error').data.retry_after_seconds).toBeUndefined();
  });

  it.each(['auth', 'billing', 'permanent'] as const)(
    'a %s failure before any token is unavailable without retry_after_seconds',
    async (kind) => {
      const { events } = await run({ chat: [{ failBefore: fakeProviderError(kind) }] });
      expect(eventOf(events, 'error').data.code).toBe('PROVIDER_UNAVAILABLE');
      expect(eventOf(events, 'error').data.retry_after_seconds).toBeUndefined();
    },
  );

  it('createLlm asks the caller what was released, and says when an attempt is thrown away', async () => {
    const restarts: number[] = [];
    let released = false;
    const provider = new FakeChatProvider([
      { chunks: ['draft'], failAfter: { chunks: 1, error: fakeProviderError('transient') } },
      { chunks: ['final'], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const llm = createLlm({
      primary: { provider, price: PRICE },
      fallback: null,
      attempts: 2,
      sleep: async () => undefined,
    });
    const ctl = new AbortController();
    const received: string[] = [];
    for await (const t of llm.generate(
      { system: 's', messages: [], maxOutputTokens: 10, estimatedInputTokens: 10 },
      {
        client: ctl.signal,
        deadline: ctl.signal,
        stop: ctl.signal,
        released: () => released,
        onRestart: () => restarts.push(received.length),
        onAttempt: () => undefined,
      },
    )) {
      received.push(t);
    }
    expect(received).toEqual(['draft', 'final']);
    expect(restarts).toEqual([1]); // told once, after the first chunk of the thrown-away attempt

    // Released: the same failure is final.
    released = true;
    const again = new FakeChatProvider([
      { chunks: ['draft'], failAfter: { chunks: 1, error: fakeProviderError('transient') } },
    ]);
    const llm2 = createLlm({
      primary: { provider: again, price: PRICE },
      fallback: null,
      attempts: 3,
      sleep: async () => undefined,
    });
    const failure = await (async () => {
      try {
        for await (const _ of llm2.generate(
          { system: 's', messages: [], maxOutputTokens: 10, estimatedInputTokens: 10 },
          {
            client: ctl.signal,
            deadline: ctl.signal,
            stop: ctl.signal,
            released: () => released,
            onRestart: () => undefined,
            onAttempt: () => undefined,
          },
        )) {
          // drain
        }
      } catch (err) {
        return err;
      }
      return null;
    })();
    expect(failure).toBeInstanceOf(LlmFailure);
    expect((failure as LlmFailure).reason).toBe('interrupted');
    expect(again.calls).toBe(1);
  });
});

describe('total deadline (C3)', () => {
  it('a stuck provider ends the request as unavailable at CHAT_DEADLINE_MS, and is aborted', async () => {
    // The provider never answers by itself (it waits for the abort), so finishing at all is the
    // proof that the deadline fired; there is no wall-clock bound to flake under load.
    const { h, events } = await run({
      env: { CHAT_DEADLINE_MS: '150' },
      chat: [{ hang: true }],
      attempts: 3,
    });
    expect(names(events)).toEqual(['meta', 'error', 'handoff']);
    expect(eventOf(events, 'error').data.code).toBe('PROVIDER_UNAVAILABLE');
    expect(h.chatProvider.abortedCalls).toBe(1);
    expect(h.chatProvider.calls).toBe(1); // no retry after the deadline
    expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'failed');
  }, 20_000);

  it('retries and backoff count against the same deadline', async () => {
    const { h, events } = await run({
      env: { CHAT_DEADLINE_MS: '150' },
      chat: [{ failBefore: fakeProviderError('transient') }],
      fallback: [{ chunks: ['unused'] }],
      attempts: 3,
      sleep: (_ms, signal) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
    });
    expect(names(events)).toEqual(['meta', 'error', 'handoff']);
    expect(h.chatProvider.calls).toBe(1);
    expect(h.fallbackProvider?.calls).toBe(0);
  });

  it('a deadline after text was released is STREAM_INTERRUPTED and stored partial', async () => {
    // The first batch is released at once, then the provider stalls until the deadline aborts it.
    // The deadline is long next to the work before the first release, so load cannot reorder them.
    const { h, events } = await run({
      env: { CHAT_DEADLINE_MS: '1500' },
      chat: [{ chunks: [`${ANSWER_HEADER}${LONG}`, 'never sent'], hangAfter: 1 }],
    });
    expect(deltaText(events).length).toBeGreaterThan(300);
    expect(eventOf(events, 'error').data.code).toBe('STREAM_INTERRUPTED');
    expect(names(events)).not.toContain('handoff');
    expect(h.calls('finish_chat_turn')[0]?.args['p_status']).toBe('partial');
    expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'partial');
    expect(h.chatProvider.abortedCalls).toBe(1);
  }, 20_000);

  it('a deadline that fires while the next batch is being moderated is also STREAM_INTERRUPTED (P7-D1 fix 10, R2-7)', async () => {
    const { h, events } = await run({
      env: { CHAT_DEADLINE_MS: '1500' },
      // Call 0 is the question, call 1 the first batch; the second batch never answers.
      moderation: (_t, i) => (i < 2 ? 'allow' : 'hang'),
      chat: [{ chunks: [`${ANSWER_HEADER}${LONG}`, LONG, 'tail'] }],
    });
    expect(deltaText(events).length).toBeGreaterThan(300);
    expect(eventOf(events, 'error').data.code).toBe('STREAM_INTERRUPTED');
    expect(names(events)).toEqual(['meta', 'delta', 'error']);
    expect(h.calls('finish_chat_turn')[0]?.args['p_status']).toBe('partial');
    expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'partial');
    expect(h.moderationProvider.abortedCalls).toBe(1);
  }, 20_000);

  it('a deadline before anything was released stays unavailable, with the handoff', async () => {
    const { events } = await run({
      env: { CHAT_DEADLINE_MS: '150' },
      moderation: (_t, i) => (i === 0 ? 'allow' : 'hang'),
      chat: [{ chunks: [`${ANSWER_HEADER}${LONG}`] }],
    });
    expect(names(events)).toEqual(['meta', 'error', 'handoff']);
    expect(eventOf(events, 'error').data.code).toBe('PROVIDER_UNAVAILABLE');
  }, 20_000);

  it('the llm service reports every attempt, with priced estimates for a billed failure', async () => {
    const attempts: LlmAttempt[] = [];
    const provider = new FakeChatProvider([
      { failBefore: new ProviderError('transient', 'x', { billed: true }) },
      { chunks: ['hello'], usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
    const llm = createLlm({
      primary: { provider, price: PRICE },
      fallback: { provider: new FakeChatProvider([{ chunks: [] }]), price: FALLBACK_PRICE },
      attempts: 2,
      sleep: async () => undefined,
    });
    const ctl = new AbortController();
    const received: string[] = [];
    for await (const t of llm.generate(
      { system: 's', messages: [], maxOutputTokens: 10, estimatedInputTokens: 300 },
      {
        client: ctl.signal,
        deadline: ctl.signal,
        stop: ctl.signal,
        released: () => false,
        onRestart: () => undefined,
        onAttempt: (a) => attempts.push(a),
      },
    )) {
      received.push(t);
    }
    expect(received).toEqual(['hello']);
    expect(attempts.map((a) => [a.outcome, a.inputTokens, a.estimated])).toEqual([
      ['failed', 300, true],
      ['ok', 10, false],
    ]);
    expect(attempts[0]?.cost).toBeCloseTo((300 * 0.1) / 1e6, 10);
    expect(attempts[1]?.cost).toBeCloseTo((10 * 0.1 + 5 * 0.4) / 1e6, 10);
    expect(new LlmFailure('unavailable', false, 'transient').reason).toBe('unavailable');
  });
});

/** A raw HTTP client for the real server; `onData` may destroy the connection. */
function connect(
  h: ReturnType<typeof setup>,
  onData: (seen: string, req: ClientRequest) => void,
): { req: ClientRequest; closed: Promise<void> } {
  const { port } = h.app.server.address() as AddressInfo;
  let request!: ClientRequest;
  const closed = new Promise<void>((resolve, reject) => {
    request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/chat',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${h.token}`,
          'idempotency-key': KEY,
        },
      },
      (res) => {
        let seen = '';
        res.on('data', (chunk: Buffer) => {
          seen += chunk.toString('utf8');
          onData(seen, request);
        });
        res.on('error', () => undefined);
      },
    );
    request.on('error', () => undefined);
    request.on('close', () => resolve());
    setTimeout(() => reject(new Error('client timed out')), 10_000).unref();
    request.end(JSON.stringify(chatBody()));
  });
  return { req: request, closed };
}

describe('client disconnect (C4)', () => {
  it('aborts the upstream call, records usage, settles and finishes the run', async () => {
    // One batch is released and then the provider stalls, so exactly one batch is moderated
    // whatever the timing: the usage rows below do not depend on how fast the client leaves.
    const h = setup({
      chat: [{ chunks: [`${ANSWER_HEADER}${LONG}`, 'never sent'], hangAfter: 1 }],
    });
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    await connect(h, (seen, req) => {
      // The first delta has arrived: leave mid-answer.
      if (seen.includes('event: delta')) req.destroy();
    }).closed;

    await vi.waitFor(() => expect(h.runs.finishRun).toHaveBeenCalled(), { timeout: 8000 });
    expect(h.chatProvider.abortedCalls).toBe(1);
    expect(h.runs.finishRun.mock.calls[0]?.[2]).toBe('partial');
    expect(h.calls('finish_chat_turn')[0]?.args['p_status']).toBe('partial');
    const ops = h
      .calls('record_request_usage')
      .map((r) => r.args['p_operation'])
      .sort();
    // input moderation, the one rolling batch that was released, the query embedding, the chat call
    expect(ops).toEqual(['chat', 'embedding_query', 'moderation', 'moderation']);
    const chat = chatRows(h)[0]?.args;
    expect(Number(chat?.['p_estimated_cost'])).toBeGreaterThan(0); // aborted call is priced
    expect(h.limits.settle).toHaveBeenCalledTimes(1);
    expect(h.limits.release).not.toHaveBeenCalled();
  }, 20_000);

  it('a disconnect before generation fails the run, stores no text and settles only the aborted moderation call', async () => {
    // Moderation and the embedding wait for the abort, so the client always leaves first: the one
    // possible outcome is a failed run. P7-D2 F7b: the moderation request was SENT and then aborted,
    // so its input estimate counts as spent (it used to be recorded as 0 and the reservation was
    // released); the embedding is not billed on an abort. Nothing here is a race.
    const h = setup({
      moderation: () => 'hang',
      embeddingOptions: { hang: true },
    });
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    await connect(h, (seen, req) => {
      if (seen.includes('event: meta')) req.destroy();
    }).closed;
    await vi.waitFor(() => expect(h.runs.finishRun).toHaveBeenCalled(), { timeout: 8000 });
    expect(h.runs.finishRun.mock.calls[0]?.[2]).toBe('failed');
    expect(h.calls('finish_chat_turn')[0]?.args).toMatchObject({
      p_status: 'failed',
      p_content: '',
    });
    expect(h.chatProvider.calls).toBe(0);
    await vi.waitFor(() => expect(h.limits.settle).toHaveBeenCalledTimes(1), { timeout: 8000 });
    expect(h.limits.release).not.toHaveBeenCalled();
    // The settled amount is the aborted moderation call's input estimate: the classifier prompt
    // plus the question, at 1 character = 1 token, at the moderation input price (0.1 per million).
    const message = chatBody()['message'] as string;
    const settled = (h.limits.settle.mock.calls[0] as unknown as [string, string, number])[2];
    expect(settled).toBeCloseTo(
      ((MODERATION_PROMPT_OVERHEAD_TOKENS + message.length) * 0.1) / 1e6,
      9,
    );
    expect(h.moderationProvider.abortedCalls).toBe(1);
    expect(h.embedding.abortedCalls).toBe(1);
  }, 20_000);

  it('a client already gone when the stream would start never causes a provider call (P7-D1 fix 6, R1-5)', async () => {
    // The client leaves while the server is still preparing (markRunning waits); only then is the
    // response hijacked. The close event has already fired by then.
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const h = setup({
      markRunning: async () => {
        await gate;
        return true;
      },
    });
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const { req, closed } = connect(h, () => undefined);
    await vi.waitFor(() => expect(h.runs.markRunning).toHaveBeenCalled(), { timeout: 8000 });
    req.destroy();
    await closed;
    // Wait until the server has seen the socket close, then let prepare() finish.
    await vi.waitFor(
      () =>
        new Promise<void>((resolve, reject) => {
          h.app.server.getConnections((err, count) =>
            err === null && count === 0 ? resolve() : reject(new Error('connection still open')),
          );
        }),
      { timeout: 8000 },
    );
    open();
    await vi.waitFor(() => expect(h.runs.finishRun).toHaveBeenCalled(), { timeout: 8000 });
    expect(h.moderationProvider.calls).toBe(0);
    expect(h.embedding.calls).toBe(0);
    expect(h.chatProvider.calls).toBe(0);
    expect(h.runs.finishRun.mock.calls[0]?.[2]).toBe('failed');
    expect(h.limits.release).toHaveBeenCalledTimes(1);
  }, 20_000);
});
