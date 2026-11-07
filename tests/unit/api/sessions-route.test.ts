import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionResponseSchema } from '@ragbot/shared';
import { AppError } from '../../../api/src/lib/errors.ts';
import { DbError, type Db } from '../../../api/src/lib/supabase.ts';
import { buildLoggerOptions } from '../../../api/src/lib/logger.ts';
import { createVisitorAuth } from '../../../api/src/services/auth.ts';
import type { Limits } from '../../../api/src/services/limits.ts';
import type { ServerDeps } from '../../../api/src/server.ts';
import type { TurnstileVerifier } from '../../../api/src/services/turnstile.ts';
import {
  FAKE_VISITOR_SECRET,
  LogCapture,
  buildTestServer,
  fakeDb,
  fakeServices,
  testConfig,
} from './helpers.ts';

// P5-B unit tests for POST /v1/sessions. Everything behind the route is a labelled FAKE: the
// database answers from a script, the limits and the Turnstile verifier are stubs. No network.

const BOT = randomUUID();
const SESSION = randomUUID();
const CHALLENGE = 'TEST-ONLY-challenge-token-CCCC';
const POLICY = {
  bot_id: BOT,
  enabled: true,
  turnstile_required: false,
  session_limit: 10,
  session_window_seconds: 3600,
  bot_session_limit: 500,
  bot_session_window_seconds: 86_400,
};

interface Rpc {
  name: string;
  args: Record<string, unknown>;
}

interface Setup {
  app: FastifyInstance;
  rpcs: Rpc[];
  limits: {
    consumeSessionPreflight: ReturnType<typeof vi.fn>;
    consumeSessionCreate: ReturnType<typeof vi.fn>;
    consumeSessionCreateBot: ReturnType<typeof vi.fn>;
  };
  /** Order in which the limits, the database and Turnstile were called. */
  calls: string[];
  turnstile: { verify: ReturnType<typeof vi.fn> };
  capture: LogCapture;
  auth: ReturnType<typeof createVisitorAuth>;
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

function setup(
  over: {
    policy?: unknown;
    session?: unknown | ((rpcs: Rpc[]) => unknown);
    consume?: () => Promise<void>;
    preflight?: () => Promise<void>;
    consumeBot?: () => Promise<void>;
    verify?: () => Promise<boolean>;
    env?: Record<string, string | undefined>;
  } = {},
): Setup {
  const rpcs: Rpc[] = [];
  const calls: string[] = [];
  const base = fakeDb();
  const db: Db = {
    ...base,
    rpc: (async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      calls.push(`rpc:${name}`);
      const answer =
        name === 'get_session_policy'
          ? 'policy' in over
            ? over.policy
            : [POLICY]
          : 'session' in over
            ? typeof over.session === 'function'
              ? (over.session as (r: Rpc[]) => unknown)(rpcs)
              : over.session
            : [
                {
                  session_id: SESSION,
                  token_version: 1,
                  expires_at: new Date(Date.now() + 900_000).toISOString().replace('Z', '+00:00'),
                },
              ];
      if (answer instanceof Error) throw answer;
      return answer;
    }) as Db['rpc'],
  };
  const config = testConfig({ LOG_LEVEL: 'info', ...over.env });
  const auth = createVisitorAuth({
    secret: FAKE_VISITOR_SECRET,
    ttlSeconds: config.visitorTokenTtlSeconds,
    db: { selectOne: async () => null },
  });
  const tracked = (name: string, fn: (() => Promise<void>) | undefined) =>
    vi.fn(async () => {
      calls.push(name);
      await (fn ?? (async () => undefined))();
    });
  const limits = {
    consumeSessionPreflight: tracked('preflight', over.preflight),
    consumeSessionCreate: tracked('create_ip', over.consume),
    consumeSessionCreateBot: tracked('create_bot', over.consumeBot),
  };
  const turnstile = {
    verify: vi.fn(async () => {
      calls.push('turnstile');
      return (over.verify ?? (async () => true))();
    }),
  };
  const capture = new LogCapture();
  const app = buildTestServer({
    config,
    db,
    auth,
    limits: { ...fakeServices().limits, ...limits } as Limits,
    turnstile: turnstile as unknown as TurnstileVerifier,
    logger: { ...buildLoggerOptions('info'), stream: capture.stream },
  });
  apps.push(app);
  return { app, rpcs, limits, turnstile, capture, auth, calls };
}

const post = (app: FastifyInstance, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: { 'content-type': 'application/json', ...headers },
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });

const body = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

describe('POST /v1/sessions: success', () => {
  it('creates a session and returns a valid token response', async () => {
    const s = setup();
    const res = await post(s.app, { bot_slug: 'dev-bot' });
    expect(res.statusCode).toBe(200);
    const out = createSessionResponseSchema.parse(body(res));
    expect(Object.keys(out).sort()).toEqual(['expires_at', 'token']);
    const claims = s.auth.verifyToken(out.token);
    expect(claims).toMatchObject({ bot_id: BOT, session_id: SESSION, token_version: 1 });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('asks the database in order with the configured TTL and the slug', async () => {
    const s = setup();
    await post(s.app, { bot_slug: 'dev-bot' });
    expect(s.rpcs.map((r) => r.name)).toEqual(['get_session_policy', 'create_visitor_session']);
    expect(s.rpcs[0]?.args).toEqual({ p_bot_slug: 'dev-bot' });
    expect(s.rpcs[1]?.args).toEqual({ p_bot_id: BOT, p_ttl_seconds: 900 });
  });

  it('counts the session-create limit with the bot, the client IP and the database policy', async () => {
    const s = setup();
    await post(s.app, { bot_slug: 'dev-bot' });
    expect(s.limits.consumeSessionCreate).toHaveBeenCalledTimes(1);
    const [bot, ip, policy] = s.limits.consumeSessionCreate.mock.calls[0] as [
      string,
      string,
      unknown,
    ];
    expect(bot).toBe(BOT);
    expect(ip).toBe('127.0.0.1');
    expect(policy).toEqual({ session_limit: 10, session_window_seconds: 3600 });
  });

  it('counts the bot aggregate limit with the bot id and the policy columns', async () => {
    const s = setup();
    await post(s.app, { bot_slug: 'dev-bot' });
    expect(s.limits.consumeSessionCreateBot).toHaveBeenCalledTimes(1);
    expect(s.limits.consumeSessionCreateBot.mock.calls[0]).toEqual([
      BOT,
      { bot_session_limit: 500, bot_session_window_seconds: 86_400 },
    ]);
  });

  it('counts the preflight with the client IP only, before the policy and everything else', async () => {
    const s = setup();
    await post(s.app, { bot_slug: 'dev-bot' });
    expect(s.limits.consumeSessionPreflight.mock.calls).toEqual([['127.0.0.1']]);
    expect(s.calls).toEqual([
      'preflight',
      'rpc:get_session_policy',
      'create_ip',
      'create_bot',
      'rpc:create_visitor_session',
    ]);
  });

  it('returns an expiry that is a valid ISO instant, no later than the database row', async () => {
    const s = setup();
    const out = body(await post(s.app, { bot_slug: 'dev-bot' }));
    const ms = Date.parse(String(out['expires_at']));
    expect(ms).toBeGreaterThan(Date.now());
    expect(ms).toBeLessThanOrEqual(Date.now() + 900_000);
  });

  it('does not call Turnstile when the bot does not require it', async () => {
    const s = setup();
    await post(s.app, { bot_slug: 'dev-bot', challenge_token: CHALLENGE });
    expect(s.turnstile.verify).not.toHaveBeenCalled();
  });
});

describe('POST /v1/sessions: bot refusals', () => {
  it('an unknown slug and a disabled bot get the identical response', async () => {
    const unknown = await post(setup({ policy: [] }).app, { bot_slug: 'nope' });
    const disabled = await post(setup({ policy: [{ ...POLICY, enabled: false }] }).app, {
      bot_slug: 'nope',
    });
    expect(unknown.statusCode).toBe(403);
    expect(disabled.statusCode).toBe(403);
    const a = body(unknown);
    const b = body(disabled);
    expect(a['code']).toBe('FORBIDDEN');
    expect(Object.keys(a).sort()).toEqual(['code', 'request_id']);
    delete a['request_id'];
    delete b['request_id'];
    expect(a).toEqual(b);
    expect({ ...unknown.headers, 'x-request-id': '', date: '' }).toEqual({
      ...disabled.headers,
      'x-request-id': '',
      date: '',
    });
  });

  it('a disabled bot whose other policy columns are null is the same FORBIDDEN as an unknown slug', async () => {
    const nulls = {
      bot_id: null,
      enabled: false,
      turnstile_required: null,
      session_limit: null,
      session_window_seconds: null,
      bot_session_limit: null,
      bot_session_window_seconds: null,
    };
    const disabled = await post(setup({ policy: [nulls] }).app, { bot_slug: 'nope' });
    const unknown = await post(setup({ policy: [] }).app, { bot_slug: 'nope' });
    expect(disabled.statusCode).toBe(403);
    const a = body(disabled);
    const b = body(unknown);
    delete a['request_id'];
    delete b['request_id'];
    expect(a).toEqual(b);
  });

  it('a database that raises RB039 for a disabled bot at the policy read is the same FORBIDDEN', async () => {
    const res = await post(setup({ policy: new DbError('http', 400, 'RB039') }).app, {
      bot_slug: 'nope',
    });
    expect(res.statusCode).toBe(403);
    expect(body(res)['code']).toBe('FORBIDDEN');
  });

  it('refuses before counting a limit, creating a session or calling Turnstile', async () => {
    for (const policy of [[], [{ ...POLICY, enabled: false, turnstile_required: true }]]) {
      const s = setup({ policy });
      await post(s.app, { bot_slug: 'x', challenge_token: CHALLENGE });
      expect(s.limits.consumeSessionCreate).not.toHaveBeenCalled();
      expect(s.limits.consumeSessionCreateBot).not.toHaveBeenCalled();
      expect(s.turnstile.verify).not.toHaveBeenCalled();
      expect(s.rpcs.map((r) => r.name)).toEqual(['get_session_policy']);
    }
  });

  it('a bot disabled between the policy read and the insert (RB039) is the same FORBIDDEN', async () => {
    const s = setup({ session: new DbError('http', 400, 'RB039') });
    const res = await post(s.app, { bot_slug: 'dev-bot' });
    expect(res.statusCode).toBe(403);
    expect(body(res)['code']).toBe('FORBIDDEN');
  });
});

describe('POST /v1/sessions: rate limit', () => {
  it('a refusal is 429 RATE_LIMITED with retry-after, and no session is created', async () => {
    const s = setup({
      consume: async () => {
        throw new AppError('RATE_LIMITED', { retryAfterSeconds: 42 });
      },
    });
    const res = await post(s.app, { bot_slug: 'dev-bot' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('42');
    expect(body(res)).toMatchObject({ code: 'RATE_LIMITED', retry_after_seconds: 42 });
    expect(s.rpcs.map((r) => r.name)).toEqual(['get_session_policy']);
  });

  it('the preflight refuses before any policy read: no database call, no later limit', async () => {
    const s = setup({
      preflight: async () => {
        throw new AppError('RATE_LIMITED', { retryAfterSeconds: 7 });
      },
    });
    const res = await post(s.app, { bot_slug: 'dev-bot', challenge_token: CHALLENGE });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('7');
    expect(body(res)).toMatchObject({ code: 'RATE_LIMITED', retry_after_seconds: 7 });
    expect(s.rpcs).toHaveLength(0);
    expect(s.limits.consumeSessionCreate).not.toHaveBeenCalled();
    expect(s.limits.consumeSessionCreateBot).not.toHaveBeenCalled();
    expect(s.turnstile.verify).not.toHaveBeenCalled();
  });

  it('an invalid body is refused before the preflight is spent', async () => {
    const s = setup();
    await post(s.app, { bot_slug: 'Bad Slug!' });
    expect(s.limits.consumeSessionPreflight).not.toHaveBeenCalled();
  });

  it('the bot aggregate limit refuses with 429 and retry-after, before Turnstile and the insert', async () => {
    const s = setup({
      policy: [{ ...POLICY, turnstile_required: true }],
      consumeBot: async () => {
        throw new AppError('RATE_LIMITED', { retryAfterSeconds: 90 });
      },
    });
    const res = await post(s.app, { bot_slug: 'dev-bot', challenge_token: CHALLENGE });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('90');
    expect(s.limits.consumeSessionCreate).toHaveBeenCalledTimes(1);
    expect(s.turnstile.verify).not.toHaveBeenCalled();
    expect(s.rpcs.map((r) => r.name)).toEqual(['get_session_policy']);
  });

  it('the per-IP limit refusing means the bot aggregate is not spent', async () => {
    const s = setup({
      consume: async () => {
        throw new AppError('RATE_LIMITED', { retryAfterSeconds: 5 });
      },
    });
    await post(s.app, { bot_slug: 'dev-bot' });
    expect(s.limits.consumeSessionCreateBot).not.toHaveBeenCalled();
  });

  it('counts before the challenge: a refused caller never reaches Turnstile', async () => {
    const s = setup({
      policy: [{ ...POLICY, turnstile_required: true }],
      consume: async () => {
        throw new AppError('RATE_LIMITED', { retryAfterSeconds: 5 });
      },
    });
    await post(s.app, { bot_slug: 'dev-bot', challenge_token: CHALLENGE });
    expect(s.turnstile.verify).not.toHaveBeenCalled();
  });
});

describe('POST /v1/sessions: Turnstile', () => {
  const required = { policy: [{ ...POLICY, turnstile_required: true }] };

  it('a valid challenge creates the session and is verified with the client IP', async () => {
    const s = setup(required);
    const res = await post(s.app, { bot_slug: 'dev-bot', challenge_token: CHALLENGE });
    expect(res.statusCode).toBe(200);
    expect(s.turnstile.verify).toHaveBeenCalledWith(CHALLENGE, '127.0.0.1');
  });

  it('a missing challenge token is FORBIDDEN and does not call Turnstile', async () => {
    const s = setup(required);
    const res = await post(s.app, { bot_slug: 'dev-bot' });
    expect(res.statusCode).toBe(403);
    expect(body(res)['code']).toBe('FORBIDDEN');
    expect(s.turnstile.verify).not.toHaveBeenCalled();
    expect(s.rpcs.map((r) => r.name)).toEqual(['get_session_policy']);
  });

  it('a failing challenge is FORBIDDEN and creates no session', async () => {
    const s = setup({ ...required, verify: async () => false });
    const res = await post(s.app, { bot_slug: 'dev-bot', challenge_token: CHALLENGE });
    expect(res.statusCode).toBe(403);
    expect(s.rpcs.map((r) => r.name)).toEqual(['get_session_policy']);
  });

  it('a failed challenge looks like an unknown bot', async () => {
    const failed = body(
      await post(setup({ ...required, verify: async () => false }).app, {
        bot_slug: 'dev-bot',
        challenge_token: CHALLENGE,
      }),
    );
    const unknown = body(await post(setup({ policy: [] }).app, { bot_slug: 'dev-bot' }));
    delete failed['request_id'];
    delete unknown['request_id'];
    expect(failed).toEqual(unknown);
  });
});

describe('POST /v1/sessions: body validation', () => {
  it.each([
    ['empty object', {}],
    ['no slug', { challenge_token: CHALLENGE }],
    ['extra field', { bot_slug: 'dev-bot', extra: 1 }],
    ['api_key field', { bot_slug: 'dev-bot', api_key: 'x' }],
    ['bad slug', { bot_slug: 'Bad Slug!' }],
    ['numeric slug', { bot_slug: 5 }],
    ['empty challenge', { bot_slug: 'dev-bot', challenge_token: '' }],
    ['array', [{ bot_slug: 'dev-bot' }]],
    ['null', 'null'],
    ['string', '"dev-bot"'],
  ])('rejects %s with INVALID_REQUEST before touching the database', async (_label, payload) => {
    const s = setup();
    const res = await post(s.app, payload);
    expect(res.statusCode).toBe(400);
    expect(body(res)['code']).toBe('INVALID_REQUEST');
    expect(s.rpcs).toHaveLength(0);
    expect(s.limits.consumeSessionPreflight).not.toHaveBeenCalled();
    expect(s.limits.consumeSessionCreate).not.toHaveBeenCalled();
  });

  it('rejects a challenge token over the schema limit', async () => {
    const s = setup({ env: { BODY_LIMIT_BYTES: '20000' } });
    const res = await post(s.app, { bot_slug: 'dev-bot', challenge_token: 'x'.repeat(4097) });
    expect(res.statusCode).toBe(400);
    expect(s.rpcs).toHaveLength(0);
  });

  it('rejects a body over BODY_LIMIT_BYTES before routing', async () => {
    const s = setup();
    const res = await post(s.app, { bot_slug: 'dev-bot', challenge_token: 'x'.repeat(2000) });
    expect(res.statusCode).toBe(413);
    expect(s.rpcs).toHaveLength(0);
  });

  it('rejects malformed JSON and a missing body', async () => {
    const s = setup();
    expect((await post(s.app, '{not json')).statusCode).toBe(400);
    const none = await s.app.inject({ method: 'POST', url: '/v1/sessions' });
    expect(none.statusCode).toBe(400);
    expect(s.rpcs).toHaveLength(0);
  });

  it('rejects a text/plain body', async () => {
    const s = setup();
    const res = await post(s.app, '{"bot_slug":"dev-bot"}', { 'content-type': 'text/plain' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(s.rpcs).toHaveLength(0);
  });

  it('only POST is routed', async () => {
    const s = setup();
    const res = await s.app.inject({ method: 'GET', url: '/v1/sessions' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/sessions: fail closed on a bad database answer', () => {
  it.each([
    ['policy not an array of one', [POLICY, POLICY]],
    ['policy enabled missing', [{ bot_id: BOT, turnstile_required: false }]],
    ['policy enabled as string', [{ ...POLICY, enabled: 'true' }]],
    ['policy turnstile_required missing', [{ bot_id: BOT, enabled: true }]],
    ['policy bot id bad', [{ ...POLICY, bot_id: 'x' }]],
    ['policy null', null],
  ])('%s is INTERNAL_ERROR', async (_label, policy) => {
    const s = setup({ policy });
    const res = await post(s.app, { bot_slug: 'dev-bot' });
    expect(res.statusCode).toBe(500);
    expect(body(res)['code']).toBe('INTERNAL_ERROR');
    expect(s.rpcs.map((r) => r.name)).toEqual(['get_session_policy']);
  });

  it.each([
    ['no rows', []],
    ['missing token_version', [{ session_id: SESSION, expires_at: new Date().toISOString() }]],
    [
      'bad session id',
      [{ session_id: 'x', token_version: 1, expires_at: new Date().toISOString() }],
    ],
    ['bad expiry', [{ session_id: SESSION, token_version: 1, expires_at: 'soon' }]],
    [
      'token_version 0',
      [{ session_id: SESSION, token_version: 0, expires_at: new Date().toISOString() }],
    ],
  ])('session row: %s is INTERNAL_ERROR', async (_label, session) => {
    const res = await post(setup({ session }).app, { bot_slug: 'dev-bot' });
    expect(res.statusCode).toBe(500);
    expect(body(res)['code']).toBe('INTERNAL_ERROR');
  });

  it('a database outage is PROVIDER_UNAVAILABLE', async () => {
    const res = await post(setup({ policy: new DbError('timeout') }).app, { bot_slug: 'dev-bot' });
    expect(res.statusCode).toBe(503);
    expect(body(res)['code']).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('POST /v1/sessions: logging', () => {
  it('logs ids and codes only: never the token, the challenge token, the slug or the body', async () => {
    const s = setup({ policy: [{ ...POLICY, turnstile_required: true }] });
    const slug = 'secret-looking-slug';
    const ok = await post(s.app, { bot_slug: slug, challenge_token: CHALLENGE });
    const token = String(body(ok)['token']);
    await post(setup().app, { bot_slug: slug, junk: CHALLENGE });
    const refused = setup({
      policy: [{ ...POLICY, turnstile_required: true }],
      verify: async () => false,
    });
    await post(refused.app, { bot_slug: slug, challenge_token: CHALLENGE });
    for (const text of [s.capture.text, refused.capture.text]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(CHALLENGE);
      expect(text).not.toContain(FAKE_VISITOR_SECRET);
    }
    expect(s.capture.text).toContain(BOT);
    expect(s.capture.text).toContain(SESSION);
  });
});

describe('route registration', () => {
  it('is always registered: a server built with labelled fakes routes POST /v1/sessions', async () => {
    const app = buildTestServer({ config: testConfig({ LOG_LEVEL: 'silent' }), db: fakeDb() });
    apps.push(app);
    // The fake preflight throws, which is a 500, not a 404: the route exists.
    const res = await post(app, { bot_slug: 'dev-bot' });
    expect(res.statusCode).toBe(500);
    expect(body(res)['code']).toBe('INTERNAL_ERROR');
  });

  it('auth, limits, runs and turnstile are required in ServerDeps (compile-time check)', () => {
    const deps: ServerDeps = {
      config: testConfig({ LOG_LEVEL: 'silent' }),
      db: fakeDb(),
      ...fakeServices(),
    };
    // @ts-expect-error runs is required
    const noRuns: ServerDeps = {
      config: deps.config,
      db: deps.db,
      auth: deps.auth,
      limits: deps.limits,
      turnstile: deps.turnstile,
    };
    // @ts-expect-error auth is required
    const noAuth: ServerDeps = {
      config: deps.config,
      db: deps.db,
      limits: deps.limits,
      runs: deps.runs,
      turnstile: deps.turnstile,
    };
    // @ts-expect-error limits is required
    const noLimits: ServerDeps = {
      config: deps.config,
      db: deps.db,
      auth: deps.auth,
      runs: deps.runs,
      turnstile: deps.turnstile,
    };
    // @ts-expect-error turnstile is required
    const noTurnstile: ServerDeps = {
      config: deps.config,
      db: deps.db,
      auth: deps.auth,
      limits: deps.limits,
      runs: deps.runs,
    };
    expect([noRuns, noAuth, noLimits, noTurnstile]).toHaveLength(4);
  });
});
