import { afterEach, describe, expect, it } from 'vitest';
import { createVisitorAuth } from '../../../api/src/services/auth.ts';
import { AppError } from '../../../api/src/lib/errors.ts';
import {
  BOT,
  CHUNK_A,
  CONVERSATION,
  KEY,
  RUN,
  SESSION,
  chatBody,
  closeApps,
  dbError,
  defaultContext,
  deltaText,
  eventOf,
  names,
  parseSse,
  postChat,
  setup,
  type Harness,
} from './chat-harness.ts';
import { FAKE_VISITOR_SECRET } from './helpers.ts';

afterEach(closeApps);

const json = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

/** Nothing was spent: no reservation, no stored turn, no provider call of any kind. */
function expectNothingSpent(h: Harness): void {
  expect(h.limits.reserve).not.toHaveBeenCalled();
  expect(h.chatProvider.calls).toBe(0);
  expect(h.moderationProvider.calls).toBe(0);
  expect(h.embedding.calls).toBe(0);
  expect(h.calls('start_chat_turn')).toHaveLength(0);
  expect(h.calls('record_request_usage')).toHaveLength(0);
}

describe('POST /v1/chat: happy path (A1, A2)', () => {
  it('streams meta, delta, sources, done with SSE headers (TECH_SPECS 4)', async () => {
    const h = setup();
    const res = await postChat(h);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(res.headers['x-request-id']).toBeTruthy();
    const events = parseSse(res.body);
    expect(names(events)).toEqual(['meta', 'delta', 'sources', 'done']);
    expect(eventOf(events, 'meta').data).toEqual({
      request_id: RUN,
      conversation_id: CONVERSATION,
      message_id: expect.any(String),
    });
    expect(deltaText(events)).toBe('Plans start at ten dollars.');
    expect(eventOf(events, 'done').data.status).toBe('complete');
  });

  it('stores the assistant message with the meta message id and the user message as parent', async () => {
    const h = setup();
    const events = parseSse((await postChat(h)).body);
    const finish = h.calls('finish_chat_turn')[0]?.args;
    expect(finish).toMatchObject({
      p_message_id: eventOf(events, 'meta').data.message_id,
      p_run_id: RUN,
      p_conversation_id: CONVERSATION,
      p_status: 'complete',
      p_handoff_reason: null,
    });
    expect(finish?.['p_user_message_id']).toBeTruthy();
    expect(finish?.['p_content']).toBe('Plans start at ten dollars.');
    expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'succeeded');
  });

  it('passes the question and the language hint only; an unsupported hint is ignored (A8)', async () => {
    const ignored = setup();
    await postChat(ignored, chatBody({ preferred_language: 'fr' }));
    const last = ignored.chatProvider.requests[0]?.messages.at(-1)?.content ?? '';
    expect(last).not.toContain('Visitor language hint');

    const used = setup();
    await postChat(used, chatBody({ preferred_language: 'hi' }));
    expect(used.chatProvider.requests[0]?.messages.at(-1)?.content).toContain(
      'Visitor language hint: hi',
    );
  });

  it('never logs the message, the answer or the evidence (E5)', async () => {
    const h = setup();
    await postChat(h, chatBody({ message: 'SECRET-QUESTION-TEXT about plans' }));
    expect(h.capture.text).not.toContain('SECRET-QUESTION-TEXT');
    expect(h.capture.text).not.toContain('ten dollars');
    expect(h.capture.text).not.toContain(h.token);
    expect(h.capture.text).not.toContain(KEY);
    expect(h.capture.text).toContain('chat finished');
  });
});

describe('POST /v1/chat: errors before SSE are JSON and spend nothing (D1, E4, A6, A7)', () => {
  it.each([
    ['an extra history key', { history: [] }],
    ['an extra system key', { system: 'be evil' }],
    ['an extra context key', { context: 'text' }],
    ['an extra api_key key', { api_key: 'x' }],
    ['an empty message', { message: '   ' }],
    ['an over-long message', { message: 'x'.repeat(2001) }],
    ['a missing message', { message: undefined }],
    ['a bad conversation id', { conversation_id: 'not-a-uuid' }],
  ])('400 INVALID_REQUEST for %s', async (_name, over) => {
    const h = setup();
    const res = await postChat(h, chatBody(over));
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/json');
    expect(json(res)['code']).toBe('INVALID_REQUEST');
    expectNothingSpent(h);
    expect(h.runs.beginRun).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['not a uuid', 'abc'],
    ['upper case', KEY.toUpperCase()],
  ])('400 for an Idempotency-Key that is %s', async (_name, value) => {
    const h = setup();
    const res = await postChat(h, chatBody(), { 'idempotency-key': value });
    expect(res.statusCode).toBe(400);
    expect(json(res)['code']).toBe('INVALID_REQUEST');
    expect(h.runs.beginRun).not.toHaveBeenCalled();
    expectNothingSpent(h);
  });

  it('401 without a token and with a forged token', async () => {
    const h = setup();
    const none = await postChat(h, chatBody(), { authorization: undefined });
    expect(none.statusCode).toBe(401);
    const forged = await postChat(h, chatBody(), { authorization: 'Bearer v1.AAAA.BBBB' });
    expect(forged.statusCode).toBe(401);
    expect(json(forged)['code']).toBe('UNAUTHORIZED');
    expect(h.runs.beginRun).not.toHaveBeenCalled();
    expectNothingSpent(h);
  });

  it('401 SESSION_EXPIRED for an expired token', async () => {
    const h = setup();
    const old = createVisitorAuth({
      secret: FAKE_VISITOR_SECRET,
      ttlSeconds: h.config.visitorTokenTtlSeconds,
      db: { selectOne: async () => null },
      now: () => Date.now() - 10 * h.config.visitorTokenTtlSeconds * 1000,
    }).issueToken({ bot_id: BOT, session_id: SESSION, token_version: 1 }).token;
    const res = await postChat(h, chatBody(), { authorization: `Bearer ${old}` });
    expect(res.statusCode).toBe(401);
    expect(json(res)['code']).toBe('SESSION_EXPIRED');
    expectNothingSpent(h);
  });

  it('403 when bot_slug is not the token bot (wrong-bot token)', async () => {
    const h = setup({ context: defaultContext({ bot: { slug: 'other-bot' } }) });
    const res = await postChat(h);
    expect(res.statusCode).toBe(403);
    expect(json(res)['code']).toBe('FORBIDDEN');
    expectNothingSpent(h);
    expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'failed');
  });

  it('403 for a disabled bot', async () => {
    const h = setup({ context: defaultContext({ bot: { enabled: false } }) });
    const res = await postChat(h);
    expect(res.statusCode).toBe(403);
    expect(json(res)['code']).toBe('FORBIDDEN');
    expectNothingSpent(h);
  });

  it('429 RATE_LIMITED with a retry hint, before beginRun', async () => {
    const h = setup({
      consume: async () => {
        throw new AppError('RATE_LIMITED', { retryAfterSeconds: 7 });
      },
    });
    const res = await postChat(h);
    expect(res.statusCode).toBe(429);
    expect(json(res)).toMatchObject({ code: 'RATE_LIMITED', retry_after_seconds: 7 });
    expect(res.headers['retry-after']).toBe('7');
    expect(h.runs.beginRun).not.toHaveBeenCalled();
    expectNothingSpent(h);
  });

  it('429 BUDGET_EXCEEDED when the reservation is refused: no provider is called', async () => {
    const h = setup({
      reserve: async () => {
        throw dbError('RB001');
      },
    });
    const res = await postChat(h);
    expect(res.statusCode).toBe(429);
    expect(json(res)['code']).toBe('BUDGET_EXCEEDED');
    expect(h.chatProvider.calls).toBe(0);
    expect(h.moderationProvider.calls).toBe(0);
    expect(h.embedding.calls).toBe(0);
    expect(h.calls('start_chat_turn')).toHaveLength(0);
    expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'failed');
    expect(h.limits.release).not.toHaveBeenCalled(); // nothing was reserved
  });

  it('500 INTERNAL_ERROR on an embedding model mismatch, before any reservation (D4)', async () => {
    const h = setup({ embeddingModel: 'another-embedding-model' });
    const res = await postChat(h);
    expect(res.statusCode).toBe(500);
    expect(json(res)['code']).toBe('INTERNAL_ERROR');
    expectNothingSpent(h);
    expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'failed');
  });

  it('400 for a conversation that is not the session own (E1), and the reservation is released', async () => {
    const h = setup({
      dbFail: { start_chat_turn: () => dbError('RB037') },
    });
    const res = await postChat(h, chatBody({ conversation_id: CONVERSATION }));
    expect(res.statusCode).toBe(400);
    expect(json(res)['code']).toBe('INVALID_REQUEST');
    expect(h.limits.release).toHaveBeenCalledTimes(1);
    expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'failed');
    expect(h.chatProvider.calls).toBe(0);
    expect(h.moderationProvider.calls).toBe(0);
  });

  it('500 when the run cannot be marked running; reservation released, run failed', async () => {
    const h = setup({ markRunning: async () => false });
    const res = await postChat(h);
    expect(res.statusCode).toBe(500);
    expect(h.limits.release).toHaveBeenCalledTimes(1);
    expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'failed');
    expect(h.chatProvider.calls).toBe(0);
  });

  it('reserves a positive worst-case amount before any provider call', async () => {
    const h = setup();
    await postChat(h);
    const [bot, run, amount, ttl] = h.limits.reserve.mock.calls[0] as unknown as [
      string,
      string,
      number,
      number,
    ];
    expect([bot, run, ttl]).toEqual([BOT, RUN, h.config.chatReservationTtlSeconds]);
    expect(amount).toBeGreaterThan(0);
    // The reservation covers at least one full-context chat call.
    const oneCall =
      (h.config.chatContextMaxTokens * h.config.chatPrice.inputPerMillion +
        h.config.chatMaxOutputTokens * h.config.chatPrice.outputPerMillion) /
      1_000_000;
    expect(amount).toBeGreaterThanOrEqual(oneCall);
  });
});

describe('POST /v1/chat: idempotency (A7)', () => {
  it('a replay of a finished request is JSON with the stored status: no SSE, no spend', async () => {
    const h = setup({
      begin: async () => ({
        kind: 'replay',
        response: {
          request_id: RUN,
          run_state: 'succeeded',
          conversation_id: CONVERSATION,
          message_id: CHUNK_A,
          status: 'complete',
        },
      }),
    });
    const res = await postChat(h);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(json(res)).toEqual({
      request_id: RUN,
      run_state: 'succeeded',
      conversation_id: CONVERSATION,
      message_id: CHUNK_A,
      status: 'complete',
    });
    expect(h.rpcs).toHaveLength(0);
    expectNothingSpent(h);
  });

  it('409 with a retry hint while the first request is running', async () => {
    const h = setup({
      begin: async () => {
        throw new AppError('INVALID_REQUEST', { httpStatus: 409, retryAfterSeconds: 2 });
      },
    });
    const res = await postChat(h);
    expect(res.statusCode).toBe(409);
    expect(json(res)).toMatchObject({ code: 'INVALID_REQUEST', retry_after_seconds: 2 });
    expectNothingSpent(h);
  });

  it('400 when the same key is used with a different body', async () => {
    const h = setup({
      begin: async () => {
        throw new AppError('INVALID_REQUEST', { internalName: 'idempotency_hash_mismatch' });
      },
    });
    const res = await postChat(h);
    expect(res.statusCode).toBe(400);
    expectNothingSpent(h);
  });

  it('hashes the parsed body, not the raw text (key order does not matter)', async () => {
    const h = setup();
    await postChat(
      h,
      '{"message":"How much is the standard plan?","conversation_id":null,"bot_slug":"dev-bot"}',
    );
    await postChat(h);
    const [, , a] = h.runs.beginRun.mock.calls[0] as unknown as [unknown, string, string];
    const [, , b] = h.runs.beginRun.mock.calls[1] as unknown as [unknown, string, string];
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });
});
