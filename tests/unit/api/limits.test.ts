import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../api/src/lib/errors.ts';
import { DbError } from '../../../api/src/lib/supabase.ts';
import { createLimits, type Limits } from '../../../api/src/services/limits.ts';

// FAKE db: records rpc calls and answers from a script. No network, no database.
const SECRET = randomBytes(32).toString('hex');
const BOT = randomUUID();
const SESSION = randomUUID();
const NOW = Date.parse('2026-11-07T12:00:10.000Z');

interface Rpc {
  name: string;
  args: Record<string, unknown>;
  opts: unknown;
}

function fake(answer: (rpc: Rpc) => unknown) {
  const calls: Rpc[] = [];
  const db = {
    rpc: vi.fn(
      async (
        name: string,
        args: Record<string, unknown>,
        _signal?: AbortSignal,
        opts?: unknown,
      ) => {
        const call = { name, args, opts };
        calls.push(call);
        const out = answer(call);
        if (out instanceof Error) throw out;
        return out;
      },
    ),
  };
  const limits: Limits = createLimits({ db: db as never, rateKeySecret: SECRET, now: () => NOW });
  return { limits, calls };
}

const row = (allowed: boolean, expires = '2026-11-07T12:00:40.000Z') => [
  {
    request_count: allowed ? 1 : 3,
    allowed,
    window_start: '2026-11-07T12:00:00.000Z',
    window_expires_at: expires,
  },
];

const POLICY = {
  message_per_session: { limit: 20, window_seconds: 600 },
  message_per_ip: { limit: 60, window_seconds: 3600 },
};
const visitor = { bot_id: BOT, session_id: SESSION, token_version: 1 };

async function appError(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error('expected an AppError');
}

describe('consumeSessionCreate', () => {
  const policy = { session_limit: 10, session_window_seconds: 3600 };

  it('records one hashed attempt with the policy and returns when allowed', async () => {
    const { limits, calls } = fake(() => row(true));
    await limits.consumeSessionCreate(BOT, '203.0.113.9', policy);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('record_rate_limit_attempt');
    expect(calls[0]?.args).toMatchObject({ p_window_seconds: 3600, p_limit: 10 });
    expect(String(calls[0]?.args['p_key_hash'])).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(calls[0]?.args)).not.toContain('203.0.113.9');
    expect(calls[0]?.opts).toEqual({ retryOnContention: true });
  });

  it('refuses with RATE_LIMITED and a retry-after taken from window_expires_at', async () => {
    const { limits } = fake(() => row(false, '2026-11-07T12:00:40.000Z'));
    const err = await appError(limits.consumeSessionCreate(BOT, '203.0.113.9', policy));
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterSeconds).toBe(30);
  });

  it('never gives a retry-after below 1 second', async () => {
    const { limits } = fake(() => row(false, '2026-11-07T12:00:10.000Z'));
    const err = await appError(limits.consumeSessionCreate(BOT, '203.0.113.9', policy));
    expect(err.retryAfterSeconds).toBe(1);
  });

  it('uses one key for one IPv6 /64 and different keys per bot and per kind', async () => {
    const { limits, calls } = fake(() => row(true));
    await limits.consumeSessionCreate(BOT, '2001:db8:1:2::1', policy);
    await limits.consumeSessionCreate(BOT, '2001:db8:1:2:ffff::9', policy);
    await limits.consumeSessionCreate(randomUUID(), '2001:db8:1:2::1', policy);
    const keys = calls.map((c) => c.args['p_key_hash']);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it.each([
    undefined,
    null,
    {},
    { session_limit: 0, session_window_seconds: 60 },
    { session_limit: 5 },
    { session_limit: 5, session_window_seconds: 100000 },
    { session_limit: '5', session_window_seconds: 60 },
  ])('fails closed as INTERNAL_ERROR, without counting, for policy %j', async (bad) => {
    const { limits, calls } = fake(() => row(true));
    const err = await appError(limits.consumeSessionCreate(BOT, '1.2.3.4', bad));
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(calls).toHaveLength(0);
  });

  it.each([[[]], [[{}]], [[{ allowed: 'yes' }]], [null], ['x'], [[...row(true), ...row(true)]]])(
    'a malformed counter answer %j is INTERNAL_ERROR, never a pass',
    async (answer) => {
      const { limits } = fake(() => answer);
      expect((await appError(limits.consumeSessionCreate(BOT, '1.2.3.4', policy))).code).toBe(
        'INTERNAL_ERROR',
      );
    },
  );

  it('lets a database failure through for the error handler to map', async () => {
    const { limits } = fake(() => new DbError('timeout'));
    await expect(limits.consumeSessionCreate(BOT, '1.2.3.4', policy)).rejects.toBeInstanceOf(
      DbError,
    );
  });
});

describe('consumeMessage', () => {
  it('checks the session first, then the IP bucket', async () => {
    const { limits, calls } = fake(() => row(true));
    await limits.consumeMessage(visitor, '203.0.113.9', POLICY);
    expect(calls.map((c) => [c.args['p_limit'], c.args['p_window_seconds']])).toEqual([
      [20, 600],
      [60, 3600],
    ]);
    expect(calls[0]?.args['p_key_hash']).not.toBe(calls[1]?.args['p_key_hash']);
  });

  it('a refused session does not spend IP allowance', async () => {
    const { limits, calls } = fake((c) => row(c.args['p_limit'] !== 20));
    const err = await appError(limits.consumeMessage(visitor, '203.0.113.9', POLICY));
    expect(err.code).toBe('RATE_LIMITED');
    expect(calls).toHaveLength(1);
  });

  it('refuses on the IP bucket with a retry-after from its window', async () => {
    const { limits, calls } = fake((c) =>
      c.args['p_limit'] === 60 ? row(false, '2026-11-07T12:05:10.000Z') : row(true),
    );
    const err = await appError(limits.consumeMessage(visitor, '203.0.113.9', POLICY));
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterSeconds).toBe(300);
    expect(calls).toHaveLength(2);
  });

  it('counts two sessions of one IP in the same IP bucket', async () => {
    const { limits, calls } = fake(() => row(true));
    await limits.consumeMessage(visitor, '203.0.113.9', POLICY);
    await limits.consumeMessage({ ...visitor, session_id: randomUUID() }, '203.0.113.9', POLICY);
    expect(calls[0]?.args['p_key_hash']).not.toBe(calls[2]?.args['p_key_hash']);
    expect(calls[1]?.args['p_key_hash']).toBe(calls[3]?.args['p_key_hash']);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', {}],
    ['no ip rule', { message_per_session: POLICY.message_per_session }],
    ['no session rule', { message_per_ip: POLICY.message_per_ip }],
    ['zero limit', { ...POLICY, message_per_ip: { limit: 0, window_seconds: 60 } }],
    ['string limit', { ...POLICY, message_per_ip: { limit: '5', window_seconds: 60 } }],
    ['window too long', { ...POLICY, message_per_session: { limit: 5, window_seconds: 86401 } }],
    ['extra key in a rule', { ...POLICY, message_per_ip: { limit: 5, window_seconds: 60, x: 1 } }],
  ])('fails closed as INTERNAL_ERROR before any counting: %s policy', async (_label, bad) => {
    const { limits, calls } = fake(() => row(true));
    const err = await appError(limits.consumeMessage(visitor, '1.2.3.4', bad));
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(calls).toHaveLength(0);
  });
});

describe('loadMessagePolicy', () => {
  it('reads get_rate_policy and validates it', async () => {
    const { limits, calls } = fake(() => ({ ...POLICY, concurrent_requests_per_session: 1 }));
    expect((await limits.loadMessagePolicy(BOT)).message_per_ip.limit).toBe(60);
    expect(calls[0]).toMatchObject({ name: 'get_rate_policy', args: { p_bot_id: BOT } });
  });

  it.each([null, {}, { concurrent_requests_per_session: 1 }])(
    'fails closed for %j',
    async (answer) => {
      const { limits } = fake(() => answer);
      expect((await appError(limits.loadMessagePolicy(BOT))).code).toBe('INTERNAL_ERROR');
    },
  );
});

describe('reserve, settle, release', () => {
  const RUN = randomUUID();
  const RESERVATION = randomUUID();

  it('reserve passes the run as the request id and returns the reservation id', async () => {
    const { limits, calls } = fake(() => RESERVATION);
    expect(await limits.reserve(BOT, RUN, 0.01, 120)).toBe(RESERVATION);
    expect(calls[0]).toMatchObject({
      name: 'reserve_request_budget',
      args: { p_bot_id: BOT, p_request_id: RUN, p_amount: 0.01, p_ttl_seconds: 120 },
      opts: { retryOnContention: true },
    });
  });

  it('a budget refusal (RB001) reaches the caller as the DbError the handler maps', async () => {
    const { limits } = fake(() => new DbError('http', 400, 'RB001'));
    const err = await limits.reserve(BOT, RUN, 1, 60).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).sqlstate).toBe('RB001');
  });

  it('settle and release use the 3-arg and 2-arg functions', async () => {
    const { limits, calls } = fake(() => null);
    await limits.settle(BOT, RESERVATION, 0.5);
    await limits.release(BOT, RESERVATION);
    expect(calls[0]).toMatchObject({
      name: 'settle_budget_reservation',
      args: { p_bot_id: BOT, p_reservation_id: RESERVATION, p_actual_amount: 0.5 },
    });
    expect(calls[1]).toMatchObject({
      name: 'release_budget_reservation',
      args: { p_bot_id: BOT, p_reservation_id: RESERVATION },
    });
  });

  it('a malformed reservation id is INTERNAL_ERROR', async () => {
    const { limits } = fake(() => 'not-a-uuid');
    expect((await appError(limits.reserve(BOT, RUN, 1, 60))).code).toBe('INTERNAL_ERROR');
  });

  it('rejects bad arguments before calling the database', async () => {
    const { limits, calls } = fake(() => RESERVATION);
    await expect(limits.reserve('x', RUN, 1, 60)).rejects.toThrow(TypeError);
    await expect(limits.reserve(BOT, RUN, 0, 60)).rejects.toThrow(TypeError);
    await expect(limits.reserve(BOT, RUN, Number.NaN, 60)).rejects.toThrow(TypeError);
    await expect(limits.reserve(BOT, RUN, 1, 0)).rejects.toThrow(TypeError);
    await expect(limits.reserve(BOT, RUN, 1, 86401)).rejects.toThrow(TypeError);
    await expect(limits.settle(BOT, RESERVATION, -1)).rejects.toThrow(TypeError);
    await expect(limits.release(BOT, 'x')).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe('createLimits', () => {
  it('refuses an unusable secret at construction', () => {
    const db = { rpc: vi.fn() } as never;
    expect(() => createLimits({ db, rateKeySecret: '' })).toThrow(TypeError);
    expect(() => createLimits({ db, rateKeySecret: 'short' })).toThrow(TypeError);
  });
});
