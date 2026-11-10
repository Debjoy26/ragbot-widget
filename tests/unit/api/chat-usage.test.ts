import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANSWER_HEADER,
  BOT,
  CHUNK_A,
  CHUNK_B,
  CONVERSATION,
  RUN,
  USER_MESSAGE,
  VERSION_A,
  chatBody,
  chunkRow,
  closeApps,
  dbError,
  eventOf,
  names,
  parseSse,
  postChat,
  setup,
  type Options,
} from './chat-harness.ts';
import { fakeProviderError } from '../../helpers/fake-ai.ts';
import { UsageLedger } from '../../../api/src/services/conversations.ts';

afterEach(closeApps);

async function run(options: Options = {}, body: Record<string, unknown> = chatBody()) {
  const h = setup(options);
  const res = await postChat(h, body);
  expect(res.statusCode).toBe(200);
  return { h, events: parseSse(res.body) };
}

const usage = (h: ReturnType<typeof setup>) => h.calls('record_request_usage').map((r) => r.args);
const costOf = (rows: Record<string, unknown>[]) =>
  rows.reduce((sum, r) => sum + Number(r['p_estimated_cost']), 0);

describe('usage ledger and settlement (D2, D3)', () => {
  it('records one row per provider call, linked to the run, and settles at their sum', async () => {
    const { h } = await run();
    const rows = usage(h);
    expect(rows.map((r) => r['p_operation']).sort()).toEqual([
      'chat',
      'embedding_query',
      'moderation',
      'moderation',
    ]);
    for (const row of rows) {
      expect(row['p_run_id']).toBe(RUN);
      expect(row['p_bot_id']).toBe(BOT);
    }
    const settled = h.limits.settle.mock.calls[0] as unknown as [string, string, number];
    expect(settled[0]).toBe(BOT);
    expect(settled[2]).toBeCloseTo(costOf(rows), 8);
    expect(settled[2]).toBeGreaterThan(0);
    expect(h.limits.release).not.toHaveBeenCalled();
    // The reservation covered the actual spend.
    const reserved = (h.limits.reserve.mock.calls[0] as unknown as [string, string, number])[2];
    expect(reserved).toBeGreaterThanOrEqual(settled[2]);
  });

  it('prices the chat call from the usage the provider reported', async () => {
    const { h } = await run({
      chat: [
        {
          chunks: [`${ANSWER_HEADER}Hi [[${CHUNK_A}]].`],
          usage: { inputTokens: 1000, outputTokens: 200 },
        },
      ],
    });
    const chat = usage(h).find((r) => r['p_operation'] === 'chat');
    expect(chat).toMatchObject({
      p_input_tokens: 1000,
      p_output_tokens: 200,
      p_provider: 'gemini',
    });
    expect(Number(chat?.['p_estimated_cost'])).toBeCloseTo((1000 * 0.1 + 200 * 0.4) / 1e6, 10);
    expect(Number(chat?.['p_latency_ms'])).toBeGreaterThanOrEqual(0);
  });

  it('releases the reservation only when nothing was spent', async () => {
    const { h } = await run({
      chunks: [],
      moderationUsage: null,
      env: { EMBEDDING_PRICE_PER_MILLION_TOKENS: '0' },
    });
    expect(usage(h)).toHaveLength(2); // still a row per call, at zero cost
    expect(costOf(usage(h))).toBe(0);
    expect(h.limits.release).toHaveBeenCalledTimes(1);
    expect(h.limits.settle).not.toHaveBeenCalled();
  });

  it('counts a billed failed call at its estimate and an unbilled one at zero', async () => {
    const billed = await run({
      chat: [{ failBefore: fakeProviderError('auth', { billed: true }) }],
    });
    const row = usage(billed.h).find((r) => r['p_operation'] === 'chat');
    expect(Number(row?.['p_input_tokens'])).toBeGreaterThan(0);
    expect(Number(row?.['p_estimated_cost'])).toBeGreaterThan(0);

    const free = await run({ chat: [{ failBefore: fakeProviderError('auth') }] });
    const zero = usage(free.h).find((r) => r['p_operation'] === 'chat');
    expect(zero).toMatchObject({ p_input_tokens: 0, p_output_tokens: 0, p_estimated_cost: 0 });
  });

  it('a failed usage write does not change what is settled', async () => {
    const { h, events } = await run({
      dbFail: { record_request_usage: () => dbError('08006') },
    });
    expect(eventOf(events, 'done').data.status).toBe('complete');
    expect(h.limits.settle).toHaveBeenCalledTimes(1);
    expect(
      (h.limits.settle.mock.calls[0] as unknown as [string, string, number])[2],
    ).toBeGreaterThan(0);
    expect(h.capture.text).toContain('"usage_write_failures":4');
  });

  it('the ledger sums costs and ignores bad numbers', async () => {
    const written: number[] = [];
    const ledger = new UsageLedger(
      {
        recordUsage: async (_b, _r, e) => {
          written.push(e.cost);
        },
      },
      BOT,
      RUN,
    );
    const base = {
      provider: 'p',
      model: 'm',
      operation: 'chat',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    } as const;
    ledger.record({ ...base, cost: 0.1 });
    ledger.record({ ...base, cost: 0.2 });
    ledger.record({ ...base, cost: Number.NaN });
    ledger.record({ ...base, cost: -5 });
    await ledger.drain();
    expect(ledger.total).toBe(0.3);
    expect(ledger.count).toBe(4);
  });

  it('a settle that fails after a release problem is logged by code, never thrown', async () => {
    const h = setup();
    h.limits.settle.mockRejectedValueOnce(new Error('db down'));
    const res = await postChat(h);
    expect(res.statusCode).toBe(200);
    expect(h.capture.text).toContain('settle_failed');
    expect(h.runs.finishRun).toHaveBeenCalled();
  });
});

describe('persistence failures', () => {
  it('on 22023 from finish with sources, retries once without them and keeps the answer', async () => {
    const { h, events } = await run({
      dbFail: { finish_chat_turn: (n) => (n === 0 ? dbError('22023') : undefined) },
    });
    const finishes = h.calls('finish_chat_turn');
    expect(finishes).toHaveLength(2);
    expect((finishes[0]?.args['p_sources'] as unknown[]).length).toBe(1);
    expect(finishes[1]?.args['p_sources']).toEqual([]);
    expect(finishes[1]?.args['p_status']).toBe('complete');
    expect(finishes[1]?.args['p_content']).toBe(finishes[0]?.args['p_content']);
    expect(names(events)).toEqual(['meta', 'delta', 'sources', 'done']);
    expect(eventOf(events, 'sources').data.sources).toEqual([]);
    expect(h.capture.text).toContain('sources_dropped');
    expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'succeeded');
  });

  it('on 22023 without sources there is no retry: an error event and a failed run', async () => {
    const { h, events } = await run({
      chunks: [],
      dbFail: { finish_chat_turn: () => dbError('22023') },
    });
    expect(h.calls('finish_chat_turn')).toHaveLength(1);
    expect(names(events)).toEqual(['meta', 'delta', 'error']);
    expect(eventOf(events, 'error').data.code).toBe('INTERNAL_ERROR');
    expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'failed');
  });

  it.each(['RB030', 'RB037'])(
    'a %s from finish is never success: error event, code logged, run failed, budget closed',
    async (sqlstate) => {
      const { h, events } = await run({
        dbFail: { finish_chat_turn: () => dbError(sqlstate) },
      });
      expect(h.calls('finish_chat_turn')).toHaveLength(1);
      expect(names(events)).toEqual(['meta', 'delta', 'error']);
      expect(eventOf(events, 'error').data.code).toBe('INTERNAL_ERROR');
      expect(h.capture.text).toContain(sqlstate);
      expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'failed');
      expect(h.limits.settle).toHaveBeenCalledTimes(1);
    },
  );
});

describe('sources and citations in the stored turn (A3, W-07)', () => {
  const second = chunkRow(CHUNK_B, {
    document_title: 'Other <b>doc</b>',
    content: 'Refunds   are\nissued within 14 days.',
    page_number: null,
    section: null,
    similarity: 0.7,
  });

  it('keeps only cited, retrieved chunks; invented ids are dropped; page and section are snapshotted', async () => {
    const invented = randomUUID();
    const { h, events } = await run({
      chunks: [chunkRow(CHUNK_A), second],
      chat: [
        {
          chunks: [
            `${ANSWER_HEADER}Plans cost ten dollars [[${CHUNK_A.slice(0, 20)}`,
            `${CHUNK_A.slice(20)}]] and [[${invented}]] refunds are quick[[${CHUNK_B}]].`,
          ],
        },
      ],
    });
    const sources = eventOf(events, 'sources').data.sources;
    expect(sources.map((s) => s.chunk_id)).toEqual([CHUNK_A, CHUNK_B]);
    expect(sources[0]).toMatchObject({ title: 'Pricing guide', section: 'Plans' });
    expect(sources[0]?.url).toBeUndefined();
    expect(sources[1]?.title).not.toMatch(/[<>]/);
    expect(sources[1]?.excerpt).toBe('Refunds are issued within 14 days.');
    expect(sources[1]?.section).toBeUndefined();

    const wire = events.map((e) => (e.event === 'delta' ? e.data.text : '')).join('');
    expect(wire).toBe('Plans cost ten dollars and refunds are quick.');
    expect(wire).not.toContain('[[');

    const stored = h.calls('finish_chat_turn')[0]?.args['p_sources'] as Record<string, unknown>[];
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      chunk_id: CHUNK_A,
      document_version_id: VERSION_A,
      source_label: 'Pricing guide',
      page_number: 3,
      section: 'Plans',
    });
    expect(stored[1]).toMatchObject({ chunk_id: CHUNK_B, page_number: null, section: null });
    expect(JSON.stringify(events)).not.toContain(invented);
  });

  it('a chunk that was retrieved but did not fit the prompt cannot be cited', async () => {
    const { events } = await run({
      chunks: [chunkRow(CHUNK_A), chunkRow(CHUNK_B, { content: 'word '.repeat(10_000) })],
      chat: [{ chunks: [`${ANSWER_HEADER}Text [[${CHUNK_B}]] and [[${CHUNK_A}]].`] }],
    });
    expect(eventOf(events, 'sources').data.sources.map((s) => s.chunk_id)).toEqual([CHUNK_A]);
  });

  it('an answer that cites nothing still completes, with an empty sources list', async () => {
    const { events } = await run({ chat: [{ chunks: [`${ANSWER_HEADER}Plans are cheap.`] }] });
    expect(eventOf(events, 'sources').data.sources).toEqual([]);
    expect(eventOf(events, 'done').data.status).toBe('complete');
  });
});

describe('contact details in model text are de-linked (A4, W-16)', () => {
  it('leaves configured contact values alone and breaks every other email, phone and URL', async () => {
    const { events } = await run({
      chat: [
        {
          chunks: [
            `${ANSWER_HEADER}Write to help@acme.example or scam@evil.example. `,
            'Call +1 415 555 0100 or +1 202 555 0199. ',
            'See https://acme.example/contact and https://evil.example/pay or www.evil.example.',
          ],
        },
      ],
    });
    const text = events.map((e) => (e.event === 'delta' ? e.data.text : '')).join('');
    expect(text).toContain('help@acme.example');
    expect(text).toContain('+1 415 555 0100');
    expect(text).toContain('https://acme.example/contact');
    expect(text).not.toContain('scam@evil.example');
    expect(text).not.toContain('+1 202 555 0199');
    expect(text).not.toContain('https://evil.example/pay');
    expect(text).not.toContain('www.evil.example');
    // The zero-width space is the only change.
    expect(text.replace(/\u200B/g, '')).toContain('scam@evil.example');
    expect(text.replace(/\u200B/g, '')).toContain('https://evil.example/pay');
  });
});

describe('server-owned history (A5, E2)', () => {
  const row = (role: string, content: string, status = 'complete', id = randomUUID()) => ({
    id,
    role,
    content,
    status,
    handoff_reason: null,
    created_at: '2026-11-10T10:00:00.000000+00:00',
    has_more: false,
  });

  it('puts at most CHAT_HISTORY_MAX_MESSAGES prior messages, oldest first, in the prompt', async () => {
    const history = [
      row('user', 'q1'),
      row('assistant', 'a1'),
      row('user', 'q2'),
      row('assistant', 'a2 partial text', 'partial'),
      row('user', 'q3'),
      row('assistant', '', 'failed'),
      row('user', 'q4'),
      row('assistant', 'a4'),
      row('user', 'How much is the standard plan?', 'complete', USER_MESSAGE),
    ];
    const { h } = await run({ history }, chatBody({ conversation_id: CONVERSATION }));
    expect(h.calls('get_conversation_history')[0]?.args).toMatchObject({
      p_conversation_id: CONVERSATION,
      p_before: null,
      p_limit: h.config.chatHistoryMaxMessages + 1,
    });
    const messages = h.chatProvider.requests[0]?.messages ?? [];
    expect(messages.slice(0, -1).map((m) => m.content)).toEqual([
      'q2',
      'a2 partial text',
      'q3',
      'q4',
      'a4',
    ]);
    expect(messages.slice(0, -1).length).toBeLessThanOrEqual(h.config.chatHistoryMaxMessages);
    expect(messages.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
    expect(messages.at(-1)?.content).toContain('How much is the standard plan?');
  });

  it('takes only the newest CHAT_HISTORY_MAX_MESSAGES messages', async () => {
    const history = Array.from({ length: 12 }, (_, i) =>
      row(i % 2 === 0 ? 'user' : 'assistant', `m${i}`),
    );
    const { h } = await run(
      { history, env: { CHAT_HISTORY_MAX_MESSAGES: '3' } },
      chatBody({ conversation_id: CONVERSATION }),
    );
    const prior = (h.chatProvider.requests[0]?.messages ?? []).slice(0, -1);
    expect(prior.map((m) => m.content)).toEqual(['m9', 'm10', 'm11']);
  });

  it('loads no history for a new conversation or when the setting is 0', async () => {
    const fresh = await run();
    expect(fresh.h.calls('get_conversation_history')).toHaveLength(0);
    const off = await run(
      { env: { CHAT_HISTORY_MAX_MESSAGES: '0' } },
      chatBody({ conversation_id: CONVERSATION }),
    );
    expect(off.h.calls('get_conversation_history')).toHaveLength(0);
    expect(off.h.chatProvider.requests[0]?.messages).toHaveLength(1);
  });

  it('drops the oldest history first when the context budget is tight', async () => {
    const history = [row('user', 'x'.repeat(4000)), row('assistant', 'recent short answer')];
    const { h } = await run(
      { history, env: { CHAT_CONTEXT_MAX_TOKENS: '1400' } },
      chatBody({ conversation_id: CONVERSATION }),
    );
    const prior = (h.chatProvider.requests[0]?.messages ?? []).slice(0, -1).map((m) => m.content);
    expect(prior).not.toContain('x'.repeat(4000));
    expect(prior).toEqual(['recent short answer']);
  });
});
