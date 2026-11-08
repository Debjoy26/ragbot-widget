import { describe, expect, it, vi } from 'vitest';
import {
  CONTENTION_RETRY_MAX_MS,
  CONTENTION_RETRY_MIN_MS,
  createDb,
  DbError,
} from '../../../worker/src/lib/db.ts';

// P6-QUEUE: the worker's PostgREST client. The fetch is a labelled fake; no network.

const KEY = 'TEST-ONLY-opaque-secret-key-AAAA';
const URL_BASE = 'http://127.0.0.1:54321';

type Step = { status: number; sqlstate?: string; body?: string } | 'ok';

function setup(steps: Step[], extra: { timeoutMs?: number } = {}) {
  let i = 0;
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step === 'ok' || step === undefined) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    return Promise.resolve(
      new Response(
        step.body ?? JSON.stringify(step.sqlstate === undefined ? {} : { code: step.sqlstate }),
        { status: step.status },
      ),
    );
  }) as unknown as typeof fetch;
  const sleeps: number[] = [];
  const db = createDb({
    url: URL_BASE,
    secretKey: KEY,
    timeoutMs: extra.timeoutMs ?? 5000,
    fetchImpl,
    sleepImpl: async (ms) => void sleeps.push(ms),
    randomImpl: () => 0.5,
  });
  return { db, requests, sleeps };
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

describe('createDb: configuration (fail closed)', () => {
  const base = { secretKey: KEY, timeoutMs: 1000 };
  it.each([
    ['empty key', { url: URL_BASE, secretKey: '', timeoutMs: 1000 }],
    ['zero timeout', { url: URL_BASE, secretKey: KEY, timeoutMs: 0 }],
    ['fractional timeout', { url: URL_BASE, secretKey: KEY, timeoutMs: 1.5 }],
    ['bad url', { url: 'nope', ...base }],
    ['plain http to a remote host', { url: 'http://example.com', ...base }],
    ['credentials in the url', { url: 'https://u:p@example.com', ...base }],
    ['query in the url', { url: 'https://example.com/?a=1', ...base }],
  ])('throws for %s', (_label, options) => {
    expect(() => createDb(options)).toThrow(TypeError);
  });

  it('accepts https and loopback http', () => {
    expect(() => createDb({ url: 'https://example.com', ...base })).not.toThrow();
    expect(() => createDb({ url: 'http://localhost:54321', ...base })).not.toThrow();
  });
});

describe('Db.rpc: request shape and safety', () => {
  it('POSTs JSON to /rest/v1/rpc/<name> with the key, refusing redirects', async () => {
    const { db, requests } = setup(['ok']);
    expect(await db.rpc('claim_jobs', { p_limit: 2 })).toEqual({ ok: true });
    const req = requests[0];
    expect(req?.url).toBe(`${URL_BASE}/rest/v1/rpc/claim_jobs`);
    expect(req?.init.method).toBe('POST');
    expect(req?.init.redirect).toBe('error');
    expect(req?.init.body).toBe(JSON.stringify({ p_limit: 2 }));
    expect((req?.init.headers as Record<string, string>)['apikey']).toBe(KEY);
  });

  it('sends a JWT-style key as bearer token too, a non-JWT key only as apikey', async () => {
    const jwt = 'aaa.bbb.ccc';
    const seen: Record<string, string>[] = [];
    const db = createDb({
      url: URL_BASE,
      secretKey: jwt,
      timeoutMs: 1000,
      fetchImpl: ((_u: string, init: RequestInit) => {
        seen.push(init.headers as Record<string, string>);
        return Promise.resolve(new Response('null', { status: 200 }));
      }) as unknown as typeof fetch,
    });
    await db.rpc('f', {});
    expect(seen[0]?.['authorization']).toBe(`Bearer ${jwt}`);
    const { requests } = setup(['ok']);
    expect(requests).toHaveLength(0);
  });

  it.each(['Bad-Name', 'a/b', 'a?b=1', '', 'a b', 'f1', '../x'])(
    'rejects function name %j before any request',
    async (name) => {
      const { db, requests } = setup(['ok']);
      await expect(db.rpc(name, {})).rejects.toThrow(TypeError);
      expect(requests).toHaveLength(0);
    },
  );

  it('returns null for an empty body (void function)', async () => {
    const db = createDb({
      url: URL_BASE,
      secretKey: KEY,
      timeoutMs: 1000,
      fetchImpl: (() =>
        Promise.resolve(new Response(null, { status: 204 }))) as unknown as typeof fetch,
    });
    expect(await db.rpc('complete_job', {})).toBeNull();
  });

  it('turns a non-JSON success body into invalid_response', async () => {
    const db = createDb({
      url: URL_BASE,
      secretKey: KEY,
      timeoutMs: 1000,
      fetchImpl: (() =>
        Promise.resolve(new Response('<html>', { status: 200 }))) as unknown as typeof fetch,
    });
    expect((await failure(db.rpc('f', {}))).reason).toBe('invalid_response');
  });

  it('carries only the SQLSTATE and status, never body text or the key', async () => {
    const { db } = setup([
      {
        status: 400,
        body: JSON.stringify({ code: 'RB013', message: `leaked ${KEY} secret text` }),
      },
    ]);
    const err = await failure(db.rpc('heartbeat_job', {}));
    expect(err.sqlstate).toBe('RB013');
    expect(err.status).toBe(400);
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain('leaked');
  });

  it('ignores a malformed SQLSTATE in the body', async () => {
    const { db } = setup([{ status: 400, body: JSON.stringify({ code: 'not a state!' }) }]);
    expect((await failure(db.rpc('f', {}))).sqlstate).toBeUndefined();
  });

  it('reports a network failure and a timeout as such', async () => {
    const down = createDb({
      url: URL_BASE,
      secretKey: KEY,
      timeoutMs: 1000,
      fetchImpl: (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch,
    });
    expect((await failure(down.rpc('f', {}))).reason).toBe('network');

    const hang = createDb({
      url: URL_BASE,
      secretKey: KEY,
      timeoutMs: 20,
      fetchImpl: ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener('abort', () => {
            rej(new DOMException('aborted', 'AbortError'));
          });
        })) as unknown as typeof fetch,
    });
    expect((await failure(hang.rpc('f', {}))).reason).toBe('timeout');
  });

  it('an aborted caller signal ends the call as a network failure, not a timeout', async () => {
    const controller = new AbortController();
    const db = createDb({
      url: URL_BASE,
      secretKey: KEY,
      timeoutMs: 5000,
      fetchImpl: ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener('abort', () => {
            rej(new DOMException('aborted', 'AbortError'));
          });
        })) as unknown as typeof fetch,
    });
    const p = failure(db.rpc('f', {}, controller.signal));
    controller.abort();
    expect((await p).reason).toBe('network');
  });
});

describe('Db.rpc: contention retry (opt-in)', () => {
  it.each(['40P01', '55P03'])('retries once after %s with a jittered delay', async (code) => {
    const { db, requests, sleeps } = setup([{ status: 500, sqlstate: code }, 'ok']);
    expect(await db.rpc('f', {}, undefined, { retryOnContention: true })).toEqual({ ok: true });
    expect(requests).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(CONTENTION_RETRY_MIN_MS);
    expect(sleeps[0]).toBeLessThan(CONTENTION_RETRY_MAX_MS);
  });

  it('retries only once: a second contention failure is final', async () => {
    const { db, requests } = setup([{ status: 500, sqlstate: '40P01' }]);
    expect((await failure(db.rpc('f', {}, undefined, { retryOnContention: true }))).sqlstate).toBe(
      '40P01',
    );
    expect(requests).toHaveLength(2);
  });

  it.each([
    ['RB013', 400],
    ['22023', 400],
    ['40001', 500],
    [undefined, 503],
  ])('never retries %s (http %i)', async (sqlstate, status) => {
    const { db, requests, sleeps } = setup([
      { status, ...(sqlstate === undefined ? {} : { sqlstate }) },
      'ok',
    ]);
    await failure(db.rpc('f', {}, undefined, { retryOnContention: true }));
    expect(requests).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it('is off by default', async () => {
    for (const code of ['40P01', '55P03']) {
      const { db, requests } = setup([{ status: 500, sqlstate: code }, 'ok']);
      await failure(db.rpc('f', {}));
      expect(requests).toHaveLength(1);
    }
  });
});
