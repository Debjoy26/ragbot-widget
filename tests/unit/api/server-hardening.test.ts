import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Duplex } from 'node:stream';
import {
  AppError,
  clientErrorHandler,
  MAX_RETRY_AFTER_SECONDS,
  toAppError,
} from '../../../api/src/lib/errors.ts';
import { DbError } from '../../../api/src/lib/supabase.ts';
import { REDACT_PATHS } from '../../../api/src/lib/logger.ts';
import { READY_CACHE_MS } from '../../../api/src/routes/health.ts';
import { buildServer } from '../../../api/src/server.ts';
import { appWithCapture, fakeDb, testConfig } from './helpers.ts';

// P4-D1: framework errors, error handler fallbacks, DB error classes, headers, client IP,
// readiness and redaction. The database probe is a labelled FAKE.

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

describe('framework errors (A-3, B-3)', () => {
  it('/%zz gets the envelope, x-request-id and nosniff through inject', async () => {
    const res = await server().inject({ method: 'GET', url: '/%zz' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      code: 'INVALID_REQUEST',
      request_id: res.headers['x-request-id'],
    });
    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.body).not.toContain('%zz');
  });

  it('applies CORS for an allowed origin on a framework error too', async () => {
    const res = await server().inject({
      method: 'GET',
      url: '/%zz',
      headers: { origin: ORIGIN },
    });
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['vary']).toContain('Origin');
  });

  it('logs the bad URL as a warning without the error message', async () => {
    const { app: a, capture } = appWithCapture(testConfig());
    app = a;
    await a.inject({ method: 'GET', url: '/%zz?token=secret-q-1' });
    expect(capture.text).not.toContain('secret-q-1');
    expect(capture.text).not.toContain('is not a valid url component');
  });
});

describe('clientErrorHandler (A-3)', () => {
  class FakeSocket extends Duplex {
    written = '';
    override _read(): void {}
    override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
      this.written += chunk.toString('latin1');
      cb();
    }
  }
  const errorOf = (code: string) =>
    Object.assign(new Error('parser said: GET /secret-path garbage'), { code });

  type Handler = (this: unknown, err: Error & { code?: string }, socket: Duplex) => void;

  /** Runs the handler and waits for the socket to close (it closes after the response flushes). */
  async function run(
    code: string,
    setup: (socket: FakeSocket) => void = () => undefined,
    log?: { warn: (fields: object, msg: string) => void },
  ): Promise<{ text: string; socket: FakeSocket }> {
    const socket = new FakeSocket();
    socket.on('error', () => undefined);
    setup(socket);
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    (clientErrorHandler as Handler).call(
      log === undefined ? undefined : { log },
      errorOf(code),
      socket,
    );
    await closed;
    return { text: socket.written, socket };
  }

  it.each([
    ['HPE_INVALID_METHOD', 400],
    ['HPE_HEADER_OVERFLOW', 431],
    ['ERR_HTTP_REQUEST_TIMEOUT', 408],
    ['SOMETHING_ELSE', 400],
  ])('answers %s with %i, a static envelope and closes', async (code, status) => {
    const { text, socket } = await run(code);
    expect(text.startsWith(`HTTP/1.1 ${String(status)} `)).toBe(true);
    const body = JSON.parse(text.slice(text.indexOf('\r\n\r\n') + 4)) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(['code', 'request_id']);
    expect(body['code']).toBe('INVALID_REQUEST');
    expect(body['request_id']).toMatch(UUID);
    expect(text).toContain(`X-Request-Id: ${String(body['request_id'])}`);
    expect(text).toContain('X-Content-Type-Options: nosniff');
    expect(text).toContain('Connection: close');
    expect(text).not.toContain('secret-path');
    expect(text).not.toContain('parser said');
    expect(socket.destroyed).toBe(true);
  });

  it('writes nothing for a reset connection and destroys the socket', async () => {
    const { text, socket } = await run('ECONNRESET');
    expect(text).toBe('');
    expect(socket.destroyed).toBe(true);
  });

  it('writes nothing, and only destroys, when bytes were already sent on the socket', async () => {
    const { text, socket } = await run('HPE_INVALID_METHOD', (s) => {
      Object.defineProperty(s, 'bytesWritten', { value: 17 });
    });
    expect(text).toBe('');
    expect(socket.destroyed).toBe(true);
  });

  it('writes nothing to a socket that is no longer writable, and destroys it', async () => {
    const { text, socket } = await run('HPE_INVALID_METHOD', (s) => {
      Object.defineProperty(s, 'writable', { value: false });
    });
    expect(text).toBe('');
    expect(socket.destroyed).toBe(true);
  });

  it('does nothing at all to a socket that is already destroyed', () => {
    const socket = new FakeSocket();
    socket.on('error', () => undefined);
    socket.destroy();
    const end = vi.spyOn(socket, 'end');
    const warn = vi.fn();
    (clientErrorHandler as Handler).call({ log: { warn } }, errorOf('HPE_INVALID_METHOD'), socket);
    expect(end).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('sends the response with end() and does not destroy before it has flushed', () => {
    const socket = new FakeSocket();
    socket.on('error', () => undefined);
    const end = vi.spyOn(socket, 'end');
    const destroy = vi.spyOn(socket, 'destroy');
    (clientErrorHandler as Handler).call(undefined, errorOf('HPE_INVALID_METHOD'), socket);
    expect(end).toHaveBeenCalledTimes(1);
    expect(String(end.mock.calls[0]?.[0])).toMatch(/^HTTP\/1\.1 400 /);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('logs the error code only: no message, no client input', async () => {
    const warn = vi.fn();
    await run('HPE_INVALID_METHOD', undefined, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toEqual({ client_error_code: 'HPE_INVALID_METHOD' });
    expect(JSON.stringify([fields, msg])).not.toMatch(/secret-path|parser said/);
  });

  it('does not log a code that does not look like an error code', async () => {
    const warn = vi.fn();
    const socket = new FakeSocket();
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    const err = Object.assign(new Error('x'), { code: 'GET /secret-path HTTP/1.1' });
    (clientErrorHandler as Handler).call({ log: { warn } }, err, socket);
    await closed;
    expect(warn).toHaveBeenCalledWith({ client_error_code: 'unknown' }, 'client error');
  });

  it('still closes the socket when logging throws', async () => {
    const { socket } = await run('HPE_INVALID_METHOD', undefined, {
      warn: () => {
        throw new Error('log sink down');
      },
    });
    expect(socket.destroyed).toBe(true);
  });
});

describe('retry hint clamp (A-4)', () => {
  it.each([
    [7, 7],
    [0, 0],
    [2.2, 3],
    [-5, 0],
    [Number.POSITIVE_INFINITY, MAX_RETRY_AFTER_SECONDS],
    [1e12, MAX_RETRY_AFTER_SECONDS],
    [Number.NEGATIVE_INFINITY, 0],
  ])('AppError clamps retryAfterSeconds %s to %s', (input, expected) => {
    expect(new AppError('RATE_LIMITED', { retryAfterSeconds: input }).retryAfterSeconds).toBe(
      expected,
    );
  });

  it('drops NaN and keeps undefined', () => {
    expect(
      new AppError('RATE_LIMITED', { retryAfterSeconds: Number.NaN }).retryAfterSeconds,
    ).toBeUndefined();
    expect(new AppError('RATE_LIMITED').retryAfterSeconds).toBeUndefined();
  });

  it('answers a hostile hint with a valid envelope and header', async () => {
    const a = server();
    a.get('/hint', async () => {
      throw new AppError('RATE_LIMITED', { retryAfterSeconds: Number.POSITIVE_INFINITY });
    });
    const res = await a.inject({ method: 'GET', url: '/hint' });
    expect(res.statusCode).toBe(429);
    expect(res.json().retry_after_seconds).toBe(MAX_RETRY_AFTER_SECONDS);
    expect(res.headers['retry-after']).toBe(String(MAX_RETRY_AFTER_SECONDS));
  });
});

describe('error handler never falls through to the default (A-4)', () => {
  it('sends a static envelope when sending the normal one throws (invalid HTTP status)', async () => {
    const a = server();
    a.get('/bad-status', async () => {
      throw new AppError('INTERNAL_ERROR', { httpStatus: 1000 });
    });
    const res = await a.inject({ method: 'GET', url: '/bad-status' });
    expect(res.statusCode).toBe(500);
    expect(Object.keys(res.json()).sort()).toEqual(['code', 'request_id']);
    expect(res.json().code).toBe('INTERNAL_ERROR');
    expect(res.json().request_id).toMatch(UUID);
    expect(res.body).not.toMatch(/statusCode|message|error"/);
  });

  it('sends a static envelope when classifying the error itself throws', async () => {
    const a = server();
    a.get('/hostile', async () => {
      throw Object.defineProperty({}, 'statusCode', {
        get() {
          throw new Error('secret-from-getter');
        },
      });
    });
    const res = await a.inject({ method: 'GET', url: '/hostile' });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('INTERNAL_ERROR');
    expect(res.body).not.toContain('secret-from-getter');
  });
});

describe('database error classes (B-2, B-12)', () => {
  it.each([
    ['RB001', 'BUDGET_EXCEEDED', 'db:budget_exceeded'],
    ['RB004', 'INVALID_REQUEST', 'db:request_conflict'],
    ['42501', 'INTERNAL_ERROR', 'db:permission_denied'],
    ['22023', 'INTERNAL_ERROR', 'db:invalid_argument'],
    ['RB030', 'INTERNAL_ERROR', 'db:conflict'],
    ['RB033', 'INTERNAL_ERROR', 'db:forbidden'],
    ['RB036', 'INTERNAL_ERROR', 'db:policy_missing'],
  ])('DbError with SQLSTATE %s maps to %s and keeps %s', (sqlstate, code, internal) => {
    const mapped = toAppError(new DbError('http', 400, sqlstate));
    expect(mapped.code).toBe(code);
    expect(mapped.internalName).toBe(internal);
  });

  it.each([
    ['RB001', 'BUDGET_EXCEEDED'],
    ['RB004', 'INVALID_REQUEST'],
    ['42501', 'INTERNAL_ERROR'],
    ['22023', 'INTERNAL_ERROR'],
    ['RB030', 'INTERNAL_ERROR'],
    ['RB033', 'INTERNAL_ERROR'],
    ['RB036', 'INTERNAL_ERROR'],
  ])('an error object with code %s maps to %s (mapDbError path)', (sqlstate, code) => {
    expect(toAppError(Object.assign(new Error('x'), { code: sqlstate })).code).toBe(code);
  });

  it('keeps an outage or timeout as PROVIDER_UNAVAILABLE', () => {
    expect(toAppError(new DbError('timeout')).code).toBe('PROVIDER_UNAVAILABLE');
    expect(toAppError(new DbError('network')).code).toBe('PROVIDER_UNAVAILABLE');
    expect(toAppError(new DbError('http', 502)).code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('logs the database HTTP status and the internal name, never the message', async () => {
    const { app: a, capture } = appWithCapture(testConfig());
    app = a;
    a.get('/db', async () => {
      throw new DbError('http', 401, '42501');
    });
    const res = await a.inject({ method: 'GET', url: '/db' });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('INTERNAL_ERROR');
    const record = capture.records.find((r) => r['msg'] === 'request failed');
    expect(record?.['db_status']).toBe(401);
    expect(record?.['internal']).toBe('db:permission_denied');
    expect(record?.['status']).toBe(500);
  });
});

describe('response headers (A-9)', () => {
  it('sends HSTS and a closed CSP on success, 404 and errors', async () => {
    const a = server();
    for (const res of [
      await a.inject({ method: 'GET', url: '/health/live' }),
      await a.inject({ method: 'GET', url: '/nope' }),
      await a.inject({ method: 'GET', url: '/%zz' }),
    ]) {
      expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
    }
  });

  it('preflight Vary names Origin and both Access-Control-Request headers', async () => {
    const res = await server().inject({
      method: 'OPTIONS',
      url: '/v1/chat',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });
    const vary = String(res.headers['vary'])
      .split(',')
      .map((s) => s.trim().toLowerCase());
    expect(vary).toEqual(
      expect.arrayContaining([
        'origin',
        'access-control-request-method',
        'access-control-request-headers',
      ]),
    );
  });

  it('a later reply.header("vary") cannot drop Origin', async () => {
    const a = server();
    a.get('/v', async (_req, reply) => {
      void reply.header('vary', 'Accept-Encoding');
      return { ok: true };
    });
    const res = await a.inject({ method: 'GET', url: '/v', headers: { origin: ORIGIN } });
    const vary = String(res.headers['vary'])
      .split(',')
      .map((s) => s.trim());
    expect(vary).toContain('Origin');
    expect(vary).toContain('Accept-Encoding');
    expect(vary.filter((v) => v === 'Origin')).toHaveLength(1);
  });
});

describe('request.clientIp (B-4)', () => {
  function ipOf(env: Record<string, string>, xff: string, remoteAddress = '10.0.0.5') {
    const a = server(env);
    a.get('/ip', async (req) => ({ ip: req.clientIp }));
    return a.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress,
      headers: { 'x-forwarded-for': xff },
    });
  }

  it('hops = 0: a spoofed X-Forwarded-For is ignored', async () => {
    const res = await ipOf({ TRUSTED_PROXY_HOPS: '0' }, '6.6.6.6, 7.7.7.7');
    expect(res.json()).toEqual({ ip: '10.0.0.5' });
  });

  it('hops = 1: takes the entry the trusted proxy appended, not the spoofed one on the left', async () => {
    const res = await ipOf({ TRUSTED_PROXY_HOPS: '1' }, '6.6.6.6, 203.0.113.7');
    expect(res.json()).toEqual({ ip: '203.0.113.7' });
  });

  it('hops = 2 with a chain too short falls back to the socket address', async () => {
    const res = await ipOf({ TRUSTED_PROXY_HOPS: '2' }, '203.0.113.7');
    expect(res.json()).toEqual({ ip: '10.0.0.5' });
  });

  it('a garbage entry falls back to the socket address', async () => {
    const res = await ipOf({ TRUSTED_PROXY_HOPS: '1' }, 'not-an-ip');
    expect(res.json()).toEqual({ ip: '10.0.0.5' });
  });

  it('is computed per request', async () => {
    const a = server({ TRUSTED_PROXY_HOPS: '1' });
    a.get('/ip', async (req) => ({ ip: req.clientIp }));
    const one = await a.inject({
      method: 'GET',
      url: '/ip',
      headers: { 'x-forwarded-for': '1.1.1.1' },
    });
    const two = await a.inject({
      method: 'GET',
      url: '/ip',
      headers: { 'x-forwarded-for': '2.2.2.2' },
    });
    expect(one.json().ip).toBe('1.1.1.1');
    expect(two.json().ip).toBe('2.2.2.2');
  });
});

describe('readiness: single flight, short cache, draining (A-8, B-7)', () => {
  function counted(delayMs = 20, result = true) {
    const state = { calls: 0 };
    const db = fakeDb(async () => {
      state.calls += 1;
      await new Promise((r) => setTimeout(r, delayMs));
      return result;
    });
    return { state, db };
  }
  function ready(db: ReturnType<typeof fakeDb>, clock: { t: number }) {
    app = buildServer({
      config: testConfig({ LOG_LEVEL: 'silent', READY_TIMEOUT_MS: '500' }),
      db,
      now: () => clock.t,
    });
    return app;
  }

  it('shares one probe between concurrent requests', async () => {
    const { state, db } = counted();
    const a = ready(db, { t: 0 });
    const all = await Promise.all(
      Array.from({ length: 25 }, () => a.inject({ method: 'GET', url: '/health/ready' })),
    );
    expect(all.every((r) => r.statusCode === 200)).toBe(true);
    expect(state.calls).toBe(1);
  });

  it('serves the cached result inside the window and probes again after it', async () => {
    const { state, db } = counted(1);
    const clock = { t: 1000 };
    const a = ready(db, clock);
    await a.inject({ method: 'GET', url: '/health/ready' });
    clock.t += READY_CACHE_MS - 1;
    await a.inject({ method: 'GET', url: '/health/ready' });
    expect(state.calls).toBe(1);
    clock.t += 2;
    await a.inject({ method: 'GET', url: '/health/ready' });
    expect(state.calls).toBe(2);
  });

  it('caches a failure as well, so a broken database is not hammered', async () => {
    const { state, db } = counted(1, false);
    const a = ready(db, { t: 0 });
    for (let i = 0; i < 5; i += 1) {
      const res = await a.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
    }
    expect(state.calls).toBe(1);
  });

  it('uses a monotonic clock: a backward wall-clock step does not extend the cache', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
      const { state, db } = counted(1);
      // No injected clock: the default is the one under test.
      app = buildServer({
        config: testConfig({ LOG_LEVEL: 'silent', READY_TIMEOUT_MS: '500' }),
        db,
      });
      await app.inject({ method: 'GET', url: '/health/ready' });
      expect(state.calls).toBe(1);
      // The wall clock jumps back an hour; the monotonic clock then advances past the window.
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z').getTime() - 3_600_000);
      await vi.advanceTimersByTimeAsync(READY_CACHE_MS + 1);
      await app.inject({ method: 'GET', url: '/health/ready' });
      expect(state.calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a 2 second window', () => {
    expect(READY_CACHE_MS).toBe(2000);
  });

  it('answers 503 at once after beginDrain(), without a database call', async () => {
    const { state, db } = counted();
    const a = ready(db, { t: 0 });
    a.beginDrain();
    const res = await a.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('{"status":"unavailable"}');
    expect(state.calls).toBe(0);
    // Liveness is unaffected: the process is still alive while it drains.
    expect((await a.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  });

  it('a draining server that was ready a moment ago is 503 too (cache does not hide it)', async () => {
    const { db } = counted(1);
    const a = ready(db, { t: 0 });
    expect((await a.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    a.beginDrain();
    expect((await a.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503);
  });
});

describe('log redaction list (A-2)', () => {
  const names = [
    'text',
    'question',
    'body',
    'prompt',
    'history',
    'chunks',
    'accessToken',
    'access_token',
    'refresh_token',
    'apiKey',
    'Authorization',
    'Cookie',
    'Token',
    'Secret',
    'Password',
    'Email',
    'Message',
    'Content',
    'ApiKey',
    'AccessToken',
  ];

  it.each(names)('redacts %s at the top level and nested', async (name) => {
    const { app: a, capture } = appWithCapture(testConfig());
    app = a;
    a.log.info({ [name]: 'leak-marker-top' }, 'top');
    a.log.info({ x: { y: { [name]: 'leak-marker-deep' } } }, 'deep');
    expect(capture.text).not.toContain('leak-marker-top');
    expect(capture.text).not.toContain('leak-marker-deep');
    expect(capture.text).toContain('[Redacted]');
  });

  it.each([
    'x-visitor-token',
    'x-turnstile-token',
    'idempotency-key',
    'X-Visitor-Token',
    'Authorization',
  ])('redacts the %s header, top level and under headers', async (header) => {
    const { app: a, capture } = appWithCapture(testConfig());
    app = a;
    a.log.info({ [header]: 'leak-marker-h1' }, 'flat');
    a.log.info({ headers: { [header]: 'leak-marker-h2' } }, 'headers');
    a.log.info({ req: { headers: { [header]: 'leak-marker-h3' } } }, 'nested');
    expect(capture.text).not.toContain('leak-marker-h');
  });

  it('keeps ids, counts and codes visible', async () => {
    const { app: a, capture } = appWithCapture(testConfig());
    app = a;
    a.log.info({ bot_id: 'bot-1', chunk_count: 3, error_code: 'RATE_LIMITED' }, 'ok');
    expect(capture.text).toContain('bot-1');
    expect(capture.text).toContain('"chunk_count":3');
    expect(capture.text).toContain('RATE_LIMITED');
  });

  it('exports a frozen list', () => {
    expect(Object.isFrozen(REDACT_PATHS)).toBe(true);
  });
});

describe('draining (B-1)', () => {
  it("answers other routes with the envelope and closes the connection, not Fastify's default body", async () => {
    const a = server();
    a.get('/work', async () => ({ ok: true }));
    a.beginDrain();
    const res = await a.inject({ method: 'GET', url: '/work' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      code: 'PROVIDER_UNAVAILABLE',
      request_id: res.headers['x-request-id'],
    });
    expect(res.headers['connection']).toBe('close');
    expect(res.body).not.toContain('Service Unavailable');
  });

  it('keeps answering the health routes while draining', async () => {
    const a = server();
    a.beginDrain();
    expect((await a.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503);
  });

  it('beginDrain is idempotent', async () => {
    const a = server();
    a.beginDrain();
    a.beginDrain();
    expect((await a.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503);
  });
});
