import { describe, expect, it, vi } from 'vitest';
import { createDb, DbError, type Db } from '../../../api/src/lib/supabase.ts';

// P4-T2 unit tests for the server-only PostgREST client. The fetch is a labelled fake; the key is a
// labelled fake and must never appear in any error.

const KEY = 'TEST-ONLY-opaque-secret-key-AAAA';
const JWT_KEY = 'TEST-ONLY.legacy-jwt-shaped.key';
const URL_BASE = 'http://127.0.0.1:54321';

interface Call {
  url: string;
  init: RequestInit;
}

function json(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return Promise.resolve(respond(call));
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

function makeDb(
  respond: (call: Call) => Response | Promise<Response>,
  over: { timeoutMs?: number; secretKey?: string; url?: string } = {},
): { db: Db; calls: Call[] } {
  const f = fakeFetch(respond);
  const db = createDb({
    url: over.url ?? URL_BASE,
    secretKey: over.secretKey ?? KEY,
    timeoutMs: over.timeoutMs ?? 5000,
    fetchImpl: f.impl,
  });
  return { db, calls: f.calls };
}

/** Like a real fetch: rejects at once for an already aborted signal, otherwise when it aborts. */
function hang(call: Call): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = call.init.signal as AbortSignal;
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

async function thrown(p: Promise<unknown>): Promise<DbError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(DbError);
    return err as DbError;
  }
  throw new Error('expected a DbError');
}

function everythingAbout(err: Error): string {
  return [
    err.message,
    err.stack ?? '',
    JSON.stringify(err),
    String(err),
    Object.keys(err).join(),
  ].join('\n');
}

describe('createDb configuration (fail closed)', () => {
  const base = { url: URL_BASE, secretKey: KEY, timeoutMs: 1000 };
  it('rejects bad configuration without echoing the key', () => {
    for (const bad of [
      { ...base, url: 'not a url' },
      { ...base, url: 'ftp://host' },
      { ...base, url: 'http://user:pw@127.0.0.1:54321' },
      { ...base, url: 'http://127.0.0.1:54321?x=1' },
      // http is for loopback only (P4-D1)
      { ...base, url: 'http://project.supabase.co' },
      { ...base, url: 'http://10.0.0.5:54321' },
      { ...base, url: 'http://127.0.0.1.evil.example' },
      { ...base, secretKey: '' },
      { ...base, timeoutMs: 0 },
      { ...base, timeoutMs: -5 },
      { ...base, timeoutMs: 1.5 },
      { ...base, timeoutMs: Number.NaN },
    ]) {
      try {
        createDb(bad);
      } catch (err) {
        expect(err).toBeInstanceOf(TypeError);
        expect((err as Error).message).not.toContain(KEY);
        expect((err as Error).message).not.toContain('pw@');
        continue;
      }
      throw new Error(
        `expected a throw for ${JSON.stringify({ ...bad, secretKey: '<redacted>' })}`,
      );
    }
  });
});

describe('createDb URL scheme (P4-D1)', () => {
  const base = { secretKey: KEY, timeoutMs: 1000 };
  it('allows https anywhere and http on loopback only', () => {
    for (const url of [
      'https://project.supabase.co',
      'http://127.0.0.1:54321',
      'http://localhost:54321',
      'http://[::1]:54321',
    ]) {
      expect(() => createDb({ ...base, url })).not.toThrow();
    }
    expect(() => createDb({ ...base, url: 'http://project.supabase.co' })).toThrow(TypeError);
  });
});

describe('selectOne request encoding', () => {
  it('builds the exact URL for plain values', async () => {
    const { db, calls } = makeDb(() => json([{ token_version: 1 }]));
    const row = await db.selectOne<{ token_version: number }>(
      'visitor_sessions',
      { id: 'abc', bot_id: 'def' },
      ['token_version', 'expires_at'],
    );
    expect(row).toEqual({ token_version: 1 });
    expect(calls[0]?.url).toBe(
      `${URL_BASE}/rest/v1/visitor_sessions?select=token_version,expires_at&id=eq.abc&bot_id=eq.def&limit=2`,
    );
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('keeps an injection-shaped value as one encoded value', async () => {
    const evil =
      'x&bot_id=neq.00000000-0000-0000-0000-000000000000&select=*&or=(id.eq.1,id.neq.1)#frag';
    const { db, calls } = makeDb(() => json([]));
    await db.selectOne('visitor_sessions', { id: evil }, ['token_version']);
    const url = new URL(calls[0]?.url ?? '');
    const keys = [...url.searchParams.keys()];
    expect(keys).toEqual(['select', 'id', 'limit']);
    expect(url.searchParams.get('id')).toBe(`eq.${evil}`);
    expect(url.searchParams.get('select')).toBe('token_version');
    expect(url.hash).toBe('');
    expect(calls[0]?.url).not.toContain('&bot_id=');
    expect(calls[0]?.url).not.toContain('#');
  });

  it.each(['a,b', 'a)b', '%41', '%', '../../x', 'a b', 'ü', '\n', '"', "'"])(
    'round-trips the special value %j',
    async (value) => {
      const { db, calls } = makeDb(() => json([]));
      await db.selectOne('visitor_sessions', { id: value }, ['token_version']);
      const url = new URL(calls[0]?.url ?? '');
      expect([...url.searchParams.keys()]).toEqual(['select', 'id', 'limit']);
      expect(url.searchParams.get('id')).toBe(`eq.${value}`);
      expect(url.pathname).toBe('/rest/v1/visitor_sessions');
    },
  );

  it('encodes numbers and booleans', async () => {
    const { db, calls } = makeDb(() => json([]));
    await db.selectOne('visitor_sessions', { token_version: 3, enabled: true }, ['id']);
    expect(calls[0]?.url).toContain('token_version=eq.3&enabled=eq.true');
  });

  it('rejects filter values that are not primitives', async () => {
    const { db, calls } = makeDb(() => json([]));
    for (const bad of [{ a: 1 }, ['x'], null, undefined]) {
      await expect(
        db.selectOne('visitor_sessions', { id: bad as never }, ['token_version']),
      ).rejects.toThrow(TypeError);
    }
    expect(calls).toHaveLength(0);
  });

  const BAD_NAMES = [
    '',
    'Visitor',
    'a;b',
    'a b',
    'a.b',
    'a-b',
    'a?x=1',
    '../x',
    'a/b',
    'a,b',
    'a=b',
    'a(b)',
    'a*',
    'a1',
    'é',
    'a\nb',
    'a'.repeat(64),
    '*',
  ];

  it.each(BAD_NAMES)('rejects the table name %j', async (name) => {
    const { db, calls } = makeDb(() => json([]));
    await expect(db.selectOne(name, { id: 'x' }, ['id'])).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it.each(BAD_NAMES)('rejects the column name %j (in columns and in filters)', async (name) => {
    const { db, calls } = makeDb(() => json([]));
    await expect(db.selectOne('visitor_sessions', { id: 'x' }, [name])).rejects.toThrow(TypeError);
    await expect(db.selectOne('visitor_sessions', { [name]: 'x' }, ['id'])).rejects.toThrow(
      TypeError,
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects empty filters and empty columns', async () => {
    const { db, calls } = makeDb(() => json([]));
    await expect(db.selectOne('visitor_sessions', {}, ['id'])).rejects.toThrow(TypeError);
    await expect(db.selectOne('visitor_sessions', { id: 'x' }, [])).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('asks for two rows, so a filter that matches more than one is visible (P4-D1)', async () => {
    const { db, calls } = makeDb(() => json([{ a: 1 }, { a: 2 }]));
    expect((await thrown(db.selectOne('t', { a: 'b' }, ['a']))).reason).toBe('invalid_response');
    expect(new URL(calls[0]?.url ?? '').searchParams.get('limit')).toBe('2');
    // One matching row is still returned.
    expect(await makeDb(() => json([{ a: 1 }])).db.selectOne('t', { a: 'b' }, ['a'])).toEqual({
      a: 1,
    });
  });

  it('returns null for no row and refuses more than one row or a non-array', async () => {
    expect(await makeDb(() => json([])).db.selectOne('t', { a: 'b' }, ['a'])).toBeNull();
    expect(
      (await thrown(makeDb(() => json([{}, {}])).db.selectOne('t', { a: 'b' }, ['a']))).reason,
    ).toBe('invalid_response');
    expect(
      (await thrown(makeDb(() => json({ a: 1 })).db.selectOne('t', { a: 'b' }, ['a']))).reason,
    ).toBe('invalid_response');
    expect(
      (await thrown(makeDb(() => json('<html>')).db.selectOne('t', { a: 'b' }, ['a']))).reason,
    ).toBe('invalid_response');
  });
});

describe('request headers and options', () => {
  it('sends an opaque key as apikey only', async () => {
    const { db, calls } = makeDb(() => json([]));
    await db.selectOne('t', { a: 'b' }, ['a']);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['apikey']).toBe(KEY);
    expect(headers['authorization']).toBeUndefined();
  });

  it('also sends a JWT-shaped key as the bearer token', async () => {
    const { db, calls } = makeDb(() => json([]), { secretKey: JWT_KEY });
    await db.selectOne('t', { a: 'b' }, ['a']);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${JWT_KEY}`);
  });

  it('refuses redirects and always attaches an abort signal', async () => {
    const { db, calls } = makeDb(() => json([]));
    await db.selectOne('t', { a: 'b' }, ['a']);
    expect(calls[0]?.init.redirect).toBe('error');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps the base path of the URL', async () => {
    const { db, calls } = makeDb(() => json([]), { url: 'https://example.invalid/proxy/' });
    await db.selectOne('t', { a: 'b' }, ['a']);
    expect(calls[0]?.url.startsWith('https://example.invalid/proxy/rest/v1/t?')).toBe(true);
  });
});

describe('error mapping', () => {
  it('carries only the SQLSTATE and HTTP status', async () => {
    const body = {
      code: '42501',
      message: `permission denied for table visitor_sessions apikey=${KEY}`,
      details: 'SECRET-DETAIL-TEXT',
      hint: null,
    };
    const { db } = makeDb(() => json(body, 403));
    const err = await thrown(db.selectOne('t', { a: 'b' }, ['a']));
    expect(err.status).toBe(403);
    expect(err.sqlstate).toBe('42501');
    expect(err.reason).toBe('http');
    const all = everythingAbout(err);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain('SECRET-DETAIL-TEXT');
    expect(all).not.toContain('permission denied');
    expect(all).not.toContain('visitor_sessions');
    expect(all).not.toContain('apikey');
  });

  it('maps a custom application SQLSTATE from rpc', async () => {
    const { db } = makeDb(() => json({ code: 'RB001', message: 'x' }, 400));
    const err = await thrown(db.rpc('some_function', { p: 1 }));
    expect(err.sqlstate).toBe('RB001');
    expect(err.status).toBe(400);
  });

  it.each([
    ['PostgREST code', { code: 'PGRST301', message: 'm' }],
    ['injection-shaped code', { code: '42501\nSET x', message: 'm' }],
    ['lowercase code', { code: 'rb001' }],
    ['numeric code', { code: 42501 }],
    ['no code', { message: 'm' }],
    ['array', ['x']],
    ['null', null],
  ])('drops a non-SQLSTATE code: %s', async (_name, body) => {
    const { db } = makeDb(() => json(body, 500));
    const err = await thrown(db.selectOne('t', { a: 'b' }, ['a']));
    expect(err.sqlstate).toBeUndefined();
    expect(err.status).toBe(500);
  });

  it('copes with a non-JSON error body and never copies it', async () => {
    const { db } = makeDb(() => json(`<html>boom ${KEY}</html>`, 502));
    const err = await thrown(db.selectOne('t', { a: 'b' }, ['a']));
    expect(err.status).toBe(502);
    expect(err.sqlstate).toBeUndefined();
    expect(everythingAbout(err)).not.toContain('boom');
    expect(everythingAbout(err)).not.toContain(KEY);
  });

  it('turns a thrown fetch error into a network DbError without its message or cause', async () => {
    const { db } = makeDb(() => {
      throw new Error(`connect failed for ${URL_BASE}/rest/v1/t?id=eq.secret apikey=${KEY}`);
    });
    const err = await thrown(db.selectOne('t', { a: 'b' }, ['a']));
    expect(err.reason).toBe('network');
    expect(err.status).toBeUndefined();
    expect(err.cause).toBeUndefined();
    const all = everythingAbout(err);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain('id=eq.secret');
    expect(all).not.toContain('connect failed');
  });

  it('never puts the request URL query or key in an error', async () => {
    const { db } = makeDb(() => json({ code: '23505' }, 409));
    const err = await thrown(db.selectOne('t', { a: 'needle-value-123' }, ['a']));
    expect(everythingAbout(err)).not.toContain('needle-value-123');
  });
});

describe('timeouts', () => {
  it('honours timeoutMs and reports reason timeout', async () => {
    const { db } = makeDb(hang, { timeoutMs: 30 });
    const started = Date.now();
    const err = await thrown(db.selectOne('t', { a: 'b' }, ['a']));
    expect(err.reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('honours timeoutMs for rpc', async () => {
    const { db } = makeDb(hang, { timeoutMs: 30 });
    expect((await thrown(db.rpc('some_function', {}))).reason).toBe('timeout');
  });

  it('also honours a timeout while the body is still being read', async () => {
    const f = (call: Call): Response => {
      const signal = call.init.signal as AbortSignal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener('abort', () =>
            controller.error(new DOMException('a', 'AbortError')),
          );
        },
      });
      return new Response(stream, { status: 200 });
    };
    const { db } = makeDb(f, { timeoutMs: 30 });
    expect((await thrown(db.selectOne('t', { a: 'b' }, ['a']))).reason).toBe('timeout');
  });

  it('honours a caller signal as well (reported as network, not timeout)', async () => {
    const { db } = makeDb(hang, { timeoutMs: 60_000 });
    const ac = new AbortController();
    const p = db.selectOne('t', { a: 'b' }, ['a'], ac.signal);
    ac.abort();
    expect((await thrown(p)).reason).toBe('network');
  });
});

describe('ping', () => {
  it('is true on a 2xx and reads at most one cheap row', async () => {
    const { db, calls } = makeDb(() => json([{ id: 'x' }]));
    expect(await db.ping(new AbortController().signal)).toBe(true);
    expect(calls[0]?.url).toContain('limit=1');
    expect(calls[0]?.url).toContain('select=id');
  });

  it('is false on an HTTP error', async () => {
    const { db } = makeDb(() => json({ code: '42501' }, 401));
    expect(await db.ping(new AbortController().signal)).toBe(false);
  });

  it('is false, and does not throw, when fetch throws', async () => {
    const { db } = makeDb(() => {
      throw new Error('down');
    });
    await expect(db.ping(new AbortController().signal)).resolves.toBe(false);
  });

  it('is false for an already aborted signal and for a timeout', async () => {
    const { db } = makeDb(hang, { timeoutMs: 30 });
    expect(await db.ping(new AbortController().signal)).toBe(false);
    const ac = new AbortController();
    ac.abort();
    expect(await db.ping(ac.signal)).toBe(false);
  });
});

describe('rpc', () => {
  it('posts JSON args to the function path and returns the parsed body', async () => {
    const { db, calls } = makeDb(() => json({ ok: true }));
    const out = await db.rpc<{ ok: boolean }>('some_function', { p_a: 'x', p_b: 2 });
    expect(out).toEqual({ ok: true });
    expect(calls[0]?.url).toBe(`${URL_BASE}/rest/v1/rpc/some_function`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ p_a: 'x', p_b: 2 });
    expect((calls[0]?.init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
  });

  it.each(['', 'Some', 'a/b', 'a?b', 'a.b', '../x', 'a b', 'f1'])(
    'rejects the function name %j',
    async (name) => {
      const { db, calls } = makeDb(() => json({}));
      await expect(db.rpc(name, {})).rejects.toThrow(TypeError);
      expect(calls).toHaveLength(0);
    },
  );

  it('treats an empty 2xx body as null', async () => {
    const { db } = makeDb(() => new Response(null, { status: 204 }));
    expect(await db.rpc('some_function', {})).toBeNull();
  });
});
