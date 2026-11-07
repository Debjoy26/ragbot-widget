import { describe, expect, it, vi } from 'vitest';
import {
  CONTENTION_RETRY_MAX_MS,
  CONTENTION_RETRY_MIN_MS,
  createDb,
  DbError,
} from '../../../api/src/lib/supabase.ts';

// P5-B: the opt-in contention retry of Db.rpc. The fetch is a labelled fake; no network.

const KEY = 'TEST-ONLY-opaque-secret-key-AAAA';

function setup(statuses: ({ status: number; sqlstate?: string } | 'ok')[]) {
  let i = 0;
  const calls: string[] = [];
  const fetchImpl = vi.fn((input: string | URL | Request) => {
    calls.push(String(input));
    const step = statuses[Math.min(i, statuses.length - 1)];
    i += 1;
    if (step === 'ok' || step === undefined) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(step.sqlstate === undefined ? {} : { code: step.sqlstate }), {
        status: step.status,
      }),
    );
  }) as unknown as typeof fetch;
  const sleeps: number[] = [];
  const db = createDb({
    url: 'http://127.0.0.1:54321',
    secretKey: KEY,
    timeoutMs: 5000,
    fetchImpl,
    sleepImpl: async (ms) => void sleeps.push(ms),
    randomImpl: () => 0.5,
  });
  return { db, calls, sleeps };
}

async function failure(p: Promise<unknown>): Promise<DbError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(DbError);
    return err as DbError;
  }
  throw new Error('expected a failure');
}

describe('rpc contention retry (opt-in)', () => {
  it.each(['40P01', '55P03'])(
    'retries once after %s and returns the second result',
    async (code) => {
      const { db, calls, sleeps } = setup([{ status: 500, sqlstate: code }, 'ok']);
      expect(await db.rpc('f', {}, undefined, { retryOnContention: true })).toEqual({ ok: true });
      expect(calls).toHaveLength(2);
      expect(sleeps).toHaveLength(1);
      expect(sleeps[0]).toBeGreaterThanOrEqual(CONTENTION_RETRY_MIN_MS);
      expect(sleeps[0]).toBeLessThan(CONTENTION_RETRY_MAX_MS);
    },
  );

  it('jitters the delay within the bounds', async () => {
    for (const r of [0, 0.999999]) {
      const sleeps: number[] = [];
      const db = createDb({
        url: 'http://127.0.0.1:54321',
        secretKey: KEY,
        timeoutMs: 5000,
        fetchImpl: (() => {
          const first = sleeps.length === 0 && calls++ === 0;
          return Promise.resolve(
            first
              ? new Response(JSON.stringify({ code: '40P01' }), { status: 500 })
              : new Response('{}', { status: 200 }),
          );
        }) as unknown as typeof fetch,
        sleepImpl: async (ms) => void sleeps.push(ms),
        randomImpl: () => r,
      });
      let calls = 0;
      await db.rpc('f', {}, undefined, { retryOnContention: true });
      expect(sleeps[0]).toBeGreaterThanOrEqual(CONTENTION_RETRY_MIN_MS);
      expect(sleeps[0]).toBeLessThanOrEqual(CONTENTION_RETRY_MAX_MS);
    }
  });

  it('retries only once: a second contention failure is final', async () => {
    const { db, calls } = setup([{ status: 500, sqlstate: '40P01' }]);
    const err = await failure(db.rpc('f', {}, undefined, { retryOnContention: true }));
    expect(err.sqlstate).toBe('40P01');
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['RB001', 400],
    ['23505', 409],
    ['22023', 400],
    ['40001', 500],
    ['57014', 500],
    [undefined, 500],
    [undefined, 503],
  ])('does not retry %s (http %i)', async (sqlstate, status) => {
    const { db, calls, sleeps } = setup([{ status, ...(sqlstate ? { sqlstate } : {}) }, 'ok']);
    await failure(db.rpc('f', {}, undefined, { retryOnContention: true }));
    expect(calls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it('does not retry a network error or a timeout', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new TypeError('fetch failed')),
    ) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const db = createDb({
      url: 'http://127.0.0.1:54321',
      secretKey: KEY,
      timeoutMs: 5000,
      fetchImpl,
      sleepImpl: async (ms) => void sleeps.push(ms),
    });
    await failure(db.rpc('f', {}, undefined, { retryOnContention: true }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleeps).toHaveLength(0);
  });

  it('is off by default: 40P01 and 55P03 are not retried without the option', async () => {
    for (const code of ['40P01', '55P03']) {
      const plain = setup([{ status: 500, sqlstate: code }, 'ok']);
      expect((await failure(plain.db.rpc('f', {}))).sqlstate).toBe(code);
      expect(plain.calls).toHaveLength(1);

      const empty = setup([{ status: 500, sqlstate: code }, 'ok']);
      await failure(empty.db.rpc('f', {}, undefined, {}));
      expect(empty.calls).toHaveLength(1);

      const off = setup([{ status: 500, sqlstate: code }, 'ok']);
      await failure(off.db.rpc('f', {}, undefined, { retryOnContention: false }));
      expect(off.calls).toHaveLength(1);
      expect(off.sleeps).toHaveLength(0);
    }
  });

  it('does not retry once the caller has aborted', async () => {
    const { db, calls } = setup([{ status: 500, sqlstate: '40P01' }, 'ok']);
    const controller = new AbortController();
    const fn = db.rpc('f', {}, controller.signal, { retryOnContention: true });
    controller.abort();
    await failure(fn);
    expect(calls.length).toBeLessThanOrEqual(1);
  });
});
