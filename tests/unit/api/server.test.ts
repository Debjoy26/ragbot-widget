import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../../api/src/lib/errors.ts';
import { buildServer } from '../../../api/src/server.ts';
import { appWithCapture, fakeDb, testConfig } from './helpers.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ORIGIN = 'https://client.example.com';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function server(overrides: Record<string, string | undefined> = {}) {
  app = buildServer({ config: testConfig({ LOG_LEVEL: 'silent', ...overrides }), db: fakeDb() });
  return app;
}

describe('security headers', () => {
  it('sets nosniff, no-store and no-referrer on success, 404 and errors', async () => {
    const a = server();
    a.post('/echo', async (req) => req.body);
    for (const res of [
      await a.inject({ method: 'GET', url: '/health/live' }),
      await a.inject({ method: 'GET', url: '/nope' }),
      await a.inject({
        method: 'POST',
        url: '/echo',
        headers: { 'content-type': 'application/json' },
        payload: '{bad',
      }),
    ]) {
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    }
  });
});

describe('request id', () => {
  it('generates a UUID, returns it in x-request-id and in the error envelope', async () => {
    const a = server();
    const ok = await a.inject({ method: 'GET', url: '/health/live' });
    expect(ok.headers['x-request-id']).toMatch(UUID);
    const missing = await a.inject({ method: 'GET', url: '/nope' });
    expect(missing.json().request_id).toBe(missing.headers['x-request-id']);
  });

  it('ignores a client-supplied request id', async () => {
    const a = server();
    for (const header of ['x-request-id', 'request-id']) {
      const res = await a.inject({
        method: 'GET',
        url: '/health/live',
        headers: { [header]: 'attacker-chosen-id' },
      });
      expect(res.headers['x-request-id']).toMatch(UUID);
      expect(res.headers['x-request-id']).not.toBe('attacker-chosen-id');
    }
  });

  it('issues a different id per request', async () => {
    const a = server();
    const one = await a.inject({ method: 'GET', url: '/health/live' });
    const two = await a.inject({ method: 'GET', url: '/health/live' });
    expect(one.headers['x-request-id']).not.toBe(two.headers['x-request-id']);
  });
});

describe('CORS', () => {
  it('allows an exact configured origin, with Vary and no credentials', async () => {
    const res = await server().inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: ORIGIN },
    });
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['vary']).toContain('Origin');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it.each([
    'https://evil.example.com',
    'https://client.example.com.evil.com',
    'http://client.example.com',
    'https://CLIENT.example.com',
    'https://client.example.com/',
    'null',
    '*',
  ])('gives an unknown origin (%s) no CORS headers', async (origin) => {
    const res = await server().inject({ method: 'GET', url: '/health/live', headers: { origin } });
    expect(res.statusCode).toBe(200);
    const corsHeaders = Object.keys(res.headers).filter((h) => h.startsWith('access-control-'));
    expect(corsHeaders).toEqual([]);
    expect(res.headers['vary']).toContain('Origin');
  });

  it('sends no CORS headers when there is no Origin header', async () => {
    const res = await server().inject({ method: 'GET', url: '/health/live' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers an allowed preflight with 204 and the fixed method/header lists', async () => {
    const res = await server().inject({
      method: 'OPTIONS',
      url: '/v1/chat',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-methods']).toBe('GET, POST');
    expect(res.headers['access-control-allow-headers']).toBe(
      'authorization, content-type, idempotency-key',
    );
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers['vary']).toContain('Origin');
  });

  it('answers a preflight from an unknown origin without any CORS headers', async () => {
    const res = await server().inject({
      method: 'OPTIONS',
      url: '/v1/chat',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(204);
    expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
  });
});

describe('error handler', () => {
  it('maps a validation failure to INVALID_REQUEST 400', async () => {
    const a = server();
    a.post('/v', { schema: { body: { type: 'object', required: ['x'] } } }, async () => ({}));
    const res = await a.inject({
      method: 'POST',
      url: '/v',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.json()).sort()).toEqual(['code', 'request_id']);
    expect(res.json().code).toBe('INVALID_REQUEST');
  });

  it('maps malformed JSON, an empty JSON body and a wrong content type to INVALID_REQUEST', async () => {
    const a = server();
    a.post('/echo', async (req) => req.body);
    const bad = await a.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":',
    });
    const empty = await a.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    const plain = await a.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });
    const form = await a.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1',
    });
    for (const res of [bad, empty, plain, form]) {
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_REQUEST');
      expect(Object.keys(res.json()).sort()).toEqual(['code', 'request_id']);
    }
  });

  it('maps an oversized body to INVALID_REQUEST with status 413', async () => {
    const a = server({ BODY_LIMIT_BYTES: '64' });
    a.post('/echo', async (req) => req.body);
    const res = await a.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ filler: 'x'.repeat(200) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe('INVALID_REQUEST');
    expect(Object.keys(res.json()).sort()).toEqual(['code', 'request_id']);
  });

  it('accepts a body at the limit', async () => {
    const a = server({ BODY_LIMIT_BYTES: '64' });
    a.post('/echo', async (req) => req.body);
    const res = await a.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ a: 1 }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('answers an unknown route with the envelope, 404', async () => {
    const res = await server().inject({ method: 'GET', url: '/nope?token=abc' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      code: 'INVALID_REQUEST',
      request_id: res.headers['x-request-id'],
    });
  });

  it('turns an unknown error into a generic 500 and leaks nothing', async () => {
    const secretish = 'sk-live-ABCDEF0123456789-secret https://upstream.example/body?key=hunter2';
    const { app: a, capture } = appWithCapture(testConfig());
    app = a;
    a.get('/boom', async () => {
      throw new Error(secretish);
    });
    const res = await a.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(Object.keys(res.json()).sort()).toEqual(['code', 'request_id']);
    expect(res.body).not.toMatch(/sk-live|hunter2|upstream|stack|Error/);
    expect(JSON.stringify(res.headers)).not.toContain('sk-live');
    expect(capture.text).not.toContain('sk-live');
    expect(capture.text).not.toContain('hunter2');
    expect(capture.text).not.toContain('"stack"');
  });

  it('does not leak a thrown non-Error value', async () => {
    const a = server();
    a.get('/boom', async () => {
      throw { secret: 'leaky-value', message: 'leaky-message' };
    });
    const res = await a.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('leaky');
  });

  it('maps an AppError to its code and status, with retry hint', async () => {
    const a = server();
    a.get('/limited', async () => {
      throw new AppError('RATE_LIMITED', { retryAfterSeconds: 7 });
    });
    const res = await a.inject({ method: 'GET', url: '/limited' });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({
      code: 'RATE_LIMITED',
      request_id: res.headers['x-request-id'],
      retry_after_seconds: 7,
    });
    expect(res.headers['retry-after']).toBe('7');
  });

  it.each([
    ['RB001', 'BUDGET_EXCEEDED', 429, 'budget_exceeded'],
    ['RB034', 'RATE_LIMITED', 429, 'quota_exceeded'],
    ['RB033', 'FORBIDDEN', 403, 'forbidden'],
    ['42501', 'FORBIDDEN', 403, 'permission_denied'],
    ['22023', 'INVALID_REQUEST', 400, 'invalid_argument'],
    ['RB011', 'INDEXING_FAILED', 500, 'activation_failed'],
  ])('maps DB error %s to %s and logs the internal name', async (sqlstate, code, status, name) => {
    const { app: a, capture } = appWithCapture(testConfig());
    app = a;
    a.get('/db', async () => {
      throw Object.assign(new Error('relation "secret_table" does not exist'), { code: sqlstate });
    });
    const res = await a.inject({ method: 'GET', url: '/db' });
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
    expect(res.body).not.toContain('secret_table');
    expect(capture.text).toContain(`db:${name}`);
    expect(capture.text).not.toContain('secret_table');
  });

  it('treats an unrecognised SQLSTATE as an unknown error', async () => {
    const a = server();
    a.get('/db', async () => {
      throw Object.assign(new Error('boom'), { code: '40001' });
    });
    const res = await a.inject({ method: 'GET', url: '/db' });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('INTERNAL_ERROR');
  });

  it('maps a handler timeout to PROVIDER_UNAVAILABLE', async () => {
    const a = server();
    a.get('/slow', async () => {
      throw Object.assign(new Error('x'), { code: 'FST_ERR_HANDLER_TIMEOUT', statusCode: 503 });
    });
    const res = await a.inject({ method: 'GET', url: '/slow' });
    expect(res.json().code).toBe('PROVIDER_UNAVAILABLE');
    expect(res.statusCode).toBe(503);
  });

  it('maps a request timeout (408) to INVALID_REQUEST with status 408', async () => {
    const a = server();
    a.get('/t', async () => {
      throw Object.assign(new Error('x'), { statusCode: 408 });
    });
    const res = await a.inject({ method: 'GET', url: '/t' });
    expect(res.statusCode).toBe(408);
    expect(res.json().code).toBe('INVALID_REQUEST');
  });
});

describe('logging and redaction', () => {
  it('never logs the Authorization header, token, message text, or the query string', async () => {
    const { app: a, capture } = appWithCapture(testConfig(), fakeDb(), 'debug');
    app = a;
    a.post('/echo', async (req) => {
      req.log.info({ body: req.body, headers: req.headers }, 'handler saw request');
      return { ok: true };
    });
    const bearer = 'Bearer fake-visitor-token-AAAA.BBBB.CCCC';
    const res = await a.inject({
      method: 'POST',
      url: '/echo?token=query-secret-123&x=1',
      headers: {
        authorization: bearer,
        cookie: 'session=cookie-secret-456',
        'x-api-key': 'api-key-secret-789',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        token: 'body-token-secret',
        message: 'private chat message text',
        nested: { deep: { email: 'visitor@example.com', password: 'pw-secret' } },
      }),
    });
    expect(res.statusCode).toBe(200);
    const text = capture.text;
    for (const leaked of [
      'fake-visitor-token',
      'cookie-secret-456',
      'api-key-secret-789',
      'body-token-secret',
      'private chat message text',
      'visitor@example.com',
      'pw-secret',
      'query-secret-123',
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain('[Redacted]'); // the handler's own log line was redacted, not dropped
    expect(text).toContain('handler saw request');
  });

  it('redacts sensitive keys nested up to four levels deep', async () => {
    const { app: a, capture } = appWithCapture(testConfig());
    app = a;
    a.log.info(
      {
        a: { b: { c: { token: 'deep-token-secret', headers: { authorization: 'x-deep-auth' } } } },
      },
      'deep',
    );
    a.log.info({ 'set-cookie': 'top-level-cookie', 'x-api-key': 'top-level-key' }, 'top');
    expect(capture.text).not.toContain('deep-token-secret');
    expect(capture.text).not.toContain('x-deep-auth');
    expect(capture.text).not.toContain('top-level-cookie');
    expect(capture.text).not.toContain('top-level-key');
  });

  it('logs request method, path without query, status and duration only', async () => {
    const { app: a, capture } = appWithCapture(testConfig());
    app = a;
    await a.inject({
      method: 'GET',
      url: '/health/live?secret=abc',
      headers: { authorization: 'Bearer should-not-appear', 'user-agent': 'agent-marker' },
      remoteAddress: '203.0.113.9',
    });
    const completed = capture.records.find((r) => r['msg'] === 'request completed');
    expect(completed).toBeDefined();
    const incoming = capture.records.find((r) => r['msg'] === 'incoming request');
    expect(incoming?.['req']).toEqual({ method: 'GET', path: '/health/live' });
    expect(completed?.['res']).toEqual({ statusCode: 200 });
    expect(typeof completed?.['responseTime']).toBe('number');
    expect(typeof completed?.['reqId']).toBe('string');
    expect(capture.text).not.toContain('should-not-appear');
    expect(capture.text).not.toContain('agent-marker');
    expect(capture.text).not.toContain('203.0.113.9');
    expect(capture.text).not.toContain('secret=abc');
  });

  it('logs only the class and code of an error, never its message', async () => {
    const { app: a, capture } = appWithCapture(testConfig());
    app = a;
    a.get('/boom', async () => {
      throw new Error('message-with-secret-xyz');
    });
    await a.inject({ method: 'GET', url: '/boom' });
    expect(capture.text).not.toContain('message-with-secret-xyz');
  });
});

describe('health', () => {
  it('/health/live answers 200 {"status":"ok"}', async () => {
    const res = await server().inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"status":"ok"}');
    expect(res.headers['content-type']).toContain('application/json');
  });

  function ready(ping: (s: AbortSignal) => Promise<boolean>) {
    app = buildServer({
      config: testConfig({ LOG_LEVEL: 'silent', READY_TIMEOUT_MS: '100' }),
      db: fakeDb(ping),
    });
    return app.inject({ method: 'GET', url: '/health/ready' });
  }

  it('/health/ready is 200 when the ping succeeds', async () => {
    const res = await ready(async () => true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"status":"ok"}');
  });

  it('/health/ready is 503 when the ping returns false', async () => {
    const res = await ready(async () => false);
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('{"status":"unavailable"}');
  });

  it('/health/ready is 503 with no detail when the ping throws', async () => {
    const res = await ready(async () => {
      throw new Error('connect ECONNREFUSED db.internal.example:5432 password=hunter2');
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('{"status":"unavailable"}');
  });

  it('/health/ready is 503 when the ping throws synchronously', async () => {
    const res = await ready(() => {
      throw new Error('sync failure');
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('{"status":"unavailable"}');
  });

  it('/health/ready is bounded and aborts a hanging ping', async () => {
    let signal: AbortSignal | undefined;
    const started = Date.now();
    const res = await ready((s) => {
      signal = s;
      return new Promise<boolean>(() => undefined); // never settles
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('{"status":"unavailable"}');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signal?.aborted).toBe(true);
  });

  it('/health/ready does not abort a ping that succeeded in time', async () => {
    let signal: AbortSignal | undefined;
    const res = await ready(async (s) => {
      signal = s;
      return true;
    });
    expect(res.statusCode).toBe(200);
    expect(signal?.aborted).toBe(false);
  });
});
