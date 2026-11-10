import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { conversationHistoryResponseSchema } from '@ragbot/shared';
import { AppError } from '../../../api/src/lib/errors.ts';
import {
  BOT,
  CONVERSATION,
  SESSION,
  closeApps,
  dbError,
  defaultContext,
  setup,
  type Harness,
  type Options,
} from './chat-harness.ts';
import { historyEnabled } from '../../../api/src/services/conversations.ts';

afterEach(closeApps);

const row = (
  role: string,
  content: string,
  hasMore = false,
  extra: Record<string, unknown> = {},
) => ({
  id: randomUUID(),
  role,
  content,
  status: 'complete',
  handoff_reason: null,
  created_at: '2026-11-10T10:00:00.123456+00:00',
  has_more: hasMore,
  ...extra,
});

function get(h: Harness, url: string, headers: Record<string, string> = {}) {
  return h.app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${h.token}`, ...headers },
  });
}

const json = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

function withHistory(options: Options = {}) {
  return setup({ history: [row('user', 'q', true), row('assistant', 'a', true)], ...options });
}

describe('GET /v1/conversations/:id (E2, ADR 0009)', () => {
  it('returns a validated page, oldest first, for the session conversation', async () => {
    const h = withHistory();
    const res = await get(h, `/v1/conversations/${CONVERSATION}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = conversationHistoryResponseSchema.parse(json(res));
    expect(body.conversation_id).toBe(CONVERSATION);
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(body.has_more).toBe(true);
    expect(body.messages[0]?.created_at).toBe('2026-11-10T10:00:00.123Z');
    expect(h.calls('get_conversation_history')[0]?.args).toEqual({
      p_bot_id: BOT,
      p_visitor_session_id: SESSION,
      p_conversation_id: CONVERSATION,
      p_before: null,
      p_limit: h.config.historyPageSize,
    });
  });

  it('pages with ?before and uses HISTORY_PAGE_SIZE', async () => {
    const h = withHistory({ env: { HISTORY_PAGE_SIZE: '2' } });
    const before = randomUUID();
    await get(h, `/v1/conversations/${CONVERSATION}?before=${before}`);
    expect(h.calls('get_conversation_history')[0]?.args).toMatchObject({
      p_before: before,
      p_limit: 2,
    });
  });

  it('403 FORBIDDEN when history_enabled is false, and the database is not read', async () => {
    const h = withHistory({
      context: defaultContext({ settings: { feature_flags: { history_enabled: false } } }),
    });
    const res = await get(h, `/v1/conversations/${CONVERSATION}`);
    expect(res.statusCode).toBe(403);
    expect(json(res)['code']).toBe('FORBIDDEN');
    expect(h.calls('get_conversation_history')).toHaveLength(0);
  });

  describe('rate limit per session (P7-D1 fix 8, R1-7)', () => {
    const over = async () => {
      throw new AppError('RATE_LIMITED', { retryAfterSeconds: 11 });
    };

    it('429 RATE_LIMITED with a retry hint when over the limit; nothing is read', async () => {
      const h = withHistory({ consumeHistory: over });
      const res = await get(h, `/v1/conversations/${CONVERSATION}`);
      expect(res.statusCode).toBe(429);
      expect(json(res)).toMatchObject({ code: 'RATE_LIMITED', retry_after_seconds: 11 });
      expect(res.headers['retry-after']).toBe('11');
      expect(h.rpcs).toHaveLength(0);
    });

    it('counts every valid, authenticated read once, with the visitor of the token', async () => {
      const h = withHistory();
      await get(h, `/v1/conversations/${CONVERSATION}`);
      await get(h, `/v1/conversations/${CONVERSATION}`);
      expect(h.limits.consumeHistory).toHaveBeenCalledTimes(2);
      expect(h.limits.consumeHistory).toHaveBeenCalledWith(
        expect.objectContaining({ bot_id: BOT, session_id: SESSION }),
      );
    });

    it('counts a read even when history is switched off for the bot', async () => {
      const h = withHistory({
        context: defaultContext({ settings: { feature_flags: { history_enabled: false } } }),
      });
      expect((await get(h, `/v1/conversations/${CONVERSATION}`)).statusCode).toBe(403);
      expect(h.limits.consumeHistory).toHaveBeenCalledTimes(1);
    });

    it('does not count a request without a valid token or with an invalid id', async () => {
      const h = withHistory();
      await h.app.inject({ method: 'GET', url: `/v1/conversations/${CONVERSATION}` });
      await get(h, '/v1/conversations/not-a-uuid');
      expect(h.limits.consumeHistory).not.toHaveBeenCalled();
    });

    it('a limiter that is not configured fails closed as 500', async () => {
      const h = withHistory({
        consumeHistory: async () => {
          throw new AppError('INTERNAL_ERROR', { internalName: 'history_rate_not_configured' });
        },
      });
      expect((await get(h, `/v1/conversations/${CONVERSATION}`)).statusCode).toBe(500);
    });
  });

  it('is on when the flag is missing or true; anything else counts as off', () => {
    expect(historyEnabled({})).toBe(true);
    expect(historyEnabled({ history_enabled: true })).toBe(true);
    expect(historyEnabled({ history_enabled: false })).toBe(false);
    expect(historyEnabled({ history_enabled: 'yes' })).toBe(false);
    expect(historyEnabled({ history_enabled: null })).toBe(false);
  });

  it('403 for a disabled bot', async () => {
    const h = withHistory({ context: defaultContext({ bot: { enabled: false } }) });
    expect((await get(h, `/v1/conversations/${CONVERSATION}`)).statusCode).toBe(403);
  });

  it('answers 404 INVALID_REQUEST for another session conversation, with no way to tell why', async () => {
    const h = withHistory({ dbFail: { get_conversation_history: () => dbError('RB037') } });
    const res = await get(h, `/v1/conversations/${randomUUID()}`);
    expect(res.statusCode).toBe(404);
    expect(json(res)).toEqual({ code: 'INVALID_REQUEST', request_id: expect.any(String) });
    // A `before` that is not in the conversation looks the same.
    const again = await get(h, `/v1/conversations/${CONVERSATION}?before=${randomUUID()}`);
    expect(again.statusCode).toBe(404);
  });

  it.each([
    ['a bad id', '/v1/conversations/not-a-uuid'],
    ['a bad before', `/v1/conversations/${CONVERSATION}?before=nope`],
    ['an unknown query key', `/v1/conversations/${CONVERSATION}?limit=500`],
    [
      'a repeated before',
      `/v1/conversations/${CONVERSATION}?before=${randomUUID()}&before=${randomUUID()}`,
    ],
  ])('400 for %s', async (_name, url) => {
    const h = withHistory();
    const res = await get(h, url);
    expect(res.statusCode).toBe(400);
    expect(h.calls('get_conversation_history')).toHaveLength(0);
  });

  it('401 without a token and with a forged token', async () => {
    const h = withHistory();
    const none = await h.app.inject({ method: 'GET', url: `/v1/conversations/${CONVERSATION}` });
    expect(none.statusCode).toBe(401);
    const forged = await get(h, `/v1/conversations/${CONVERSATION}`, {
      authorization: 'Bearer v1.a.b',
    });
    expect(forged.statusCode).toBe(401);
    expect(h.rpcs).toHaveLength(0);
  });

  it('never returns a system row, even if the database did (fail closed)', async () => {
    const h = setup({ history: [row('system', 'secret instructions')] });
    const res = await get(h, `/v1/conversations/${CONVERSATION}`);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret instructions');
  });

  it('a malformed database row is an internal error', async () => {
    const h = setup({ history: [{ id: 'x' }] });
    expect((await get(h, `/v1/conversations/${CONVERSATION}`)).statusCode).toBe(500);
  });

  it('logs counts and ids only', async () => {
    const h = setup({ history: [row('user', 'PRIVATE-HISTORY-TEXT')] });
    await get(h, `/v1/conversations/${CONVERSATION}`);
    expect(h.capture.text).not.toContain('PRIVATE-HISTORY-TEXT');
    expect(h.capture.text).toContain('conversation history served');
  });
});
