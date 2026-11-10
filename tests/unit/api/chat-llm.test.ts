import { request as httpRequest } from 'node:http';
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

  it('with buffered output nothing was released, but the message is still stored as partial', async () => {
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
    expect(eventOf(events, 'error').data.code).toBe('STREAM_INTERRUPTED');
    expect(h.calls('finish_chat_turn')[0]?.args['p_status']).toBe('partial');
    expect(h.calls('finish_chat_turn')[0]?.args['p_content']).toBe('');
  });
});

describe('total deadline (C3)', () => {
  it('a stuck provider ends the request as unavailable at CHAT_DEADLINE_MS, and is aborted', async () => {
    const started = Date.now();
    const { h, events } = await run({
      env: { CHAT_DEADLINE_MS: '150' },
      chat: [{ hang: true }],
      attempts: 3,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(names(events)).toEqual(['meta', 'error', 'handoff']);
    expect(eventOf(events, 'error').data.code).toBe('PROVIDER_UNAVAILABLE');
    expect(h.chatProvider.abortedCalls).toBe(1);
    expect(h.chatProvider.calls).toBe(1); // no retry after the deadline
    expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'failed');
  });

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

  it('a deadline after the first token is STREAM_INTERRUPTED and stored partial', async () => {
    const { h, events } = await run({
      env: { CHAT_DEADLINE_MS: '250' },
      chat: [
        {
          chunks: [`${ANSWER_HEADER}${LONG}`, ...Array.from({ length: 20 }, () => LONG)],
          chunkDelayMs: 40,
        },
      ],
    });
    expect(eventOf(events, 'error').data.code).toBe('STREAM_INTERRUPTED');
    expect(h.calls('finish_chat_turn')[0]?.args['p_status']).toBe('partial');
    expect(h.chatProvider.abortedCalls).toBe(1);
  });

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

describe('client disconnect (C4)', () => {
  it('aborts the upstream call, records usage, settles and finishes the run', async () => {
    const h = setup({
      chat: [
        {
          chunks: [`${ANSWER_HEADER}${LONG}`, ...Array.from({ length: 200 }, () => LONG)],
          chunkDelayMs: 25,
        },
      ],
    });
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = h.app.server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
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
            // The first delta has arrived: leave mid-answer.
            if (seen.includes('event: delta')) {
              req.destroy();
              resolve();
            }
          });
          res.on('error', () => undefined);
        },
      );
      req.on('error', () => undefined);
      setTimeout(() => reject(new Error('no delta seen')), 5000).unref();
      req.end(JSON.stringify(chatBody()));
    });

    await vi.waitFor(() => expect(h.runs.finishRun).toHaveBeenCalled(), { timeout: 4000 });
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
  });

  it('a disconnect before generation still closes the run and the reservation', async () => {
    const h = setup({ moderation: () => 'allow' });
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = h.app.server.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      const req = httpRequest(
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
          res.once('data', () => {
            req.destroy();
            resolve();
          });
          res.on('error', () => undefined);
        },
      );
      req.on('error', () => undefined);
      req.end(JSON.stringify(chatBody()));
    });
    await vi.waitFor(() => expect(h.runs.finishRun).toHaveBeenCalled(), { timeout: 4000 });
    expect(['failed', 'partial', 'succeeded']).toContain(h.runs.finishRun.mock.calls[0]?.[2]);
    await vi.waitFor(
      () => expect(h.limits.settle.mock.calls.length + h.limits.release.mock.calls.length).toBe(1),
      { timeout: 4000 },
    );
  });
});
