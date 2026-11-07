import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../api/src/lib/errors.ts';
import { DbError } from '../../../api/src/lib/supabase.ts';
import {
  createRuns,
  isCanonicalIdempotencyKey,
  requestHash,
} from '../../../api/src/services/runs.ts';

// FAKE db: answers from a script. No network, no database.
const BOT = randomUUID();
const SESSION = randomUUID();
const RUN = randomUUID();
const KEY = randomUUID();
const HASH = requestHash({ message: 'hello' });
const visitor = { bot_id: BOT, session_id: SESSION, token_version: 3 };

interface Rpc {
  name: string;
  args: Record<string, unknown>;
}

function fake(answer: (rpc: Rpc) => unknown) {
  const calls: Rpc[] = [];
  const db = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const out = answer({ name, args });
      if (out instanceof Error) throw out;
      return out;
    }),
  };
  return { runs: createRuns({ db: db as never }), calls };
}

const begin = (run_id: string | null, outcome: string) => [{ run_id, outcome }];
const stored = (run_state: string, extra: Record<string, unknown> = {}) => [
  { run_state, conversation_id: null, message_id: null, message_status: null, ...extra },
];

async function appError(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error('expected an AppError');
}

describe('requestHash', () => {
  it('is 64 lowercase hex', () => {
    expect(requestHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable under key order, at any depth', () => {
    const a = { bot_slug: 'x', message: 'hi', nested: { b: 1, a: [{ y: 1, x: 2 }] } };
    const b = { nested: { a: [{ x: 2, y: 1 }], b: 1 }, message: 'hi', bot_slug: 'x' };
    expect(requestHash(a)).toBe(requestHash(b));
  });

  it('changes with any value, with array order and with type', () => {
    const base = requestHash({ m: 'a', l: [1, 2] });
    expect(requestHash({ m: 'b', l: [1, 2] })).not.toBe(base);
    expect(requestHash({ m: 'a', l: [2, 1] })).not.toBe(base);
    expect(requestHash({ m: 'a', l: ['1', 2] })).not.toBe(base);
    expect(requestHash({ m: 'a', l: [1, 2], extra: null })).not.toBe(base);
  });

  it('ignores undefined properties like JSON does, and refuses what JSON cannot hold', () => {
    expect(requestHash({ a: 1, b: undefined })).toBe(requestHash({ a: 1 }));
    expect(() => requestHash({ a: Number.NaN })).toThrow(TypeError);
    expect(() => requestHash({ a: 10n })).toThrow(TypeError);
    expect(() => requestHash({ a: () => 1 })).toThrow(TypeError);
  });
});

describe('idempotency key format', () => {
  it('accepts only a canonical lowercase UUID', () => {
    expect(isCanonicalIdempotencyKey(KEY)).toBe(true);
    for (const bad of [
      KEY.toUpperCase(),
      KEY.replace(/-/g, ''),
      `${KEY} `,
      `{${KEY}}`,
      'abc',
      '',
      undefined,
      42,
    ]) {
      expect(isCanonicalIdempotencyKey(bad)).toBe(false);
    }
  });

  it.each([KEY.toUpperCase(), 'not-a-uuid', '', ` ${KEY}`])(
    'beginRun refuses %j as INVALID_REQUEST without calling the database',
    async (bad) => {
      const { runs, calls } = fake(() => begin(RUN, 'new'));
      const err = await appError(runs.beginRun(visitor, bad, HASH));
      expect(err.code).toBe('INVALID_REQUEST');
      expect(err.httpStatus).toBe(400);
      expect(calls).toHaveLength(0);
    },
  );
});

describe('beginRun outcomes', () => {
  it('new returns the run id and passes the token version', async () => {
    const { runs, calls } = fake(() => begin(RUN, 'new'));
    expect(await runs.beginRun(visitor, KEY, HASH)).toEqual({ kind: 'new', runId: RUN });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      name: 'begin_request_run',
      args: {
        p_bot_id: BOT,
        p_visitor_session_id: SESSION,
        p_token_version: 3,
        p_idempotency_key: KEY,
        p_request_hash: HASH,
      },
    });
  });

  it.each(['succeeded', 'failed', 'partial'])(
    'duplicate of a %s run returns the stored outcome, not a new run',
    async (state) => {
      const msg = randomUUID();
      const conv = randomUUID();
      const { runs, calls } = fake((c) =>
        c.name === 'begin_request_run'
          ? begin(RUN, 'duplicate')
          : stored(state, { conversation_id: conv, message_id: msg, message_status: 'complete' }),
      );
      const out = await runs.beginRun(visitor, KEY, HASH);
      expect(out).toEqual({
        kind: 'replay',
        response: {
          request_id: RUN,
          run_state: state,
          conversation_id: conv,
          message_id: msg,
          status: 'complete',
        },
      });
      expect(calls.map((c) => c.name)).toEqual(['begin_request_run', 'get_request_run']);
      expect(calls[1]?.args).toEqual({ p_bot_id: BOT, p_run_id: RUN });
    },
  );

  it('duplicate of a finished run with no message has null ids and status', async () => {
    const { runs } = fake((c) =>
      c.name === 'begin_request_run' ? begin(RUN, 'duplicate') : stored('failed'),
    );
    const out = await runs.beginRun(visitor, KEY, HASH);
    expect(out).toMatchObject({
      kind: 'replay',
      response: { run_state: 'failed', message_id: null, status: null },
    });
  });

  it.each(['reserved', 'running'])(
    'duplicate of a %s run is INVALID_REQUEST with HTTP 409',
    async (state) => {
      const { runs } = fake((c) =>
        c.name === 'begin_request_run' ? begin(RUN, 'duplicate') : stored(state),
      );
      const err = await appError(runs.beginRun(visitor, KEY, HASH));
      expect(err.code).toBe('INVALID_REQUEST');
      expect(err.httpStatus).toBe(409);
    },
  );

  it('a session the database no longer accepts (RB004) is UNAUTHORIZED, other errors pass through', async () => {
    const stale = fake(() => new DbError('http', 400, 'RB004'));
    const err = await appError(stale.runs.beginRun(visitor, KEY, HASH));
    expect(err.code).toBe('UNAUTHORIZED');
    const other = fake(() => new DbError('http', 400, 'RB002'));
    await expect(other.runs.beginRun(visitor, KEY, HASH)).rejects.toBeInstanceOf(DbError);
  });

  it('hash_mismatch is INVALID_REQUEST with HTTP 400', async () => {
    const { runs, calls } = fake(() => begin(null, 'hash_mismatch'));
    const err = await appError(runs.beginRun(visitor, KEY, HASH));
    expect(err.code).toBe('INVALID_REQUEST');
    expect(err.httpStatus).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('concurrency_limited is RATE_LIMITED with HTTP 429', async () => {
    const { runs } = fake(() => begin(null, 'concurrency_limited'));
    const err = await appError(runs.beginRun(visitor, KEY, HASH));
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.httpStatus).toBe(429);
  });

  it.each([
    ['unknown outcome', begin(RUN, 'maybe')],
    ['new without a run id', begin(null, 'new')],
    ['duplicate without a run id', begin(null, 'duplicate')],
    ['no rows', []],
    ['two rows', [...begin(RUN, 'new'), ...begin(RUN, 'new')]],
    ['null', null],
    ['bad run id', begin('nope', 'new')],
  ])('a malformed answer is INTERNAL_ERROR: %s', async (_label, answer) => {
    const { runs } = fake(() => answer);
    expect((await appError(runs.beginRun(visitor, KEY, HASH))).code).toBe('INTERNAL_ERROR');
  });

  it.each([
    ['no row', []],
    ['unknown state', stored('weird')],
    ['status without message id', stored('succeeded', { message_status: 'complete' })],
  ])('a malformed stored run is INTERNAL_ERROR: %s', async (_label, answer) => {
    const { runs } = fake((c) =>
      c.name === 'begin_request_run' ? begin(RUN, 'duplicate') : answer,
    );
    expect((await appError(runs.beginRun(visitor, KEY, HASH))).code).toBe('INTERNAL_ERROR');
  });

  it('rejects a bad hash before calling the database', async () => {
    const { runs, calls } = fake(() => begin(RUN, 'new'));
    await expect(runs.beginRun(visitor, KEY, 'nope')).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe('markRunning and finishRun', () => {
  it('go through set_request_run_state only and return its boolean', async () => {
    const { runs, calls } = fake(() => true);
    expect(await runs.markRunning(BOT, RUN)).toBe(true);
    expect(await runs.finishRun(BOT, RUN, 'succeeded')).toBe(true);
    expect(calls).toEqual([
      { name: 'set_request_run_state', args: { p_bot_id: BOT, p_run_id: RUN, p_state: 'running' } },
      {
        name: 'set_request_run_state',
        args: { p_bot_id: BOT, p_run_id: RUN, p_state: 'succeeded' },
      },
    ]);
  });

  it('returns false (no change) when the database refuses the transition', async () => {
    const { runs } = fake(() => false);
    expect(await runs.finishRun(BOT, RUN, 'failed')).toBe(false);
  });

  it('refuses a non-terminal or unknown target state before the database', async () => {
    const { runs, calls } = fake(() => true);
    for (const bad of ['running', 'reserved', 'done', ''] as const) {
      await expect(runs.finishRun(BOT, RUN, bad as 'failed')).rejects.toThrow(TypeError);
    }
    expect(calls).toHaveLength(0);
  });

  it('a non-boolean answer is INTERNAL_ERROR', async () => {
    const { runs } = fake(() => 'true');
    expect((await appError(runs.markRunning(BOT, RUN))).code).toBe('INTERNAL_ERROR');
  });

  it('rejects non-uuid ids before the database', async () => {
    const { runs, calls } = fake(() => true);
    await expect(runs.markRunning('x', RUN)).rejects.toThrow(TypeError);
    await expect(runs.finishRun(BOT, 'x', 'failed')).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});
