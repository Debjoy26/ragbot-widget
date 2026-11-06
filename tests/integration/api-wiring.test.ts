import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../../api/src/app.ts';
import { createDb, DbError } from '../../api/src/lib/supabase.ts';
import { buildLoggerOptions } from '../../api/src/lib/logger.ts';
import { requireVisitor, VisitorAuthError } from '../../api/src/services/auth.ts';
import { validEnv } from '../unit/api/helpers.ts';
import { getLocalPrivilegedKey, getLocalStack, keyHeaders } from './helpers/local-stack.ts';

// The real app from createApp(): real config, real database client, real error handler, against the
// LOCAL stack. This is where the server and auth halves meet, so error mapping is proven end to end.

const RUN = randomUUID().slice(0, 8);
const lines: string[] = [];
let apiUrl: string;
let key: string;
let real: App;
let dead: App;
let botId: string;
let anonKey: string;
/** Real tokens sent through logged paths; the last test proves none reached the log. */
const sentTokens: string[] = [];

function capture(): Writable {
  return new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString());
      done();
    },
  });
}

async function svc(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      ...keyHeaders(key),
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status >= 300) throw new Error(`service call -> ${String(res.status)}`);
  const text = await res.text();
  return text.length === 0 ? null : (JSON.parse(text) as unknown);
}

async function session(expiresAt: string): Promise<string> {
  const rows = (await svc('POST', '/rest/v1/visitor_sessions', {
    bot_id: botId,
    expires_at: expiresAt,
  })) as { id: string }[];
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('no session');
  return id;
}

function guarded(app: App): FastifyInstance {
  app.app.get('/t/guarded', { preHandler: requireVisitor(app.auth) }, async (req) => ({
    bot: req.visitor?.bot_id,
  }));
  app.app.get('/t/auth-error', async () => {
    throw new VisitorAuthError('FORBIDDEN');
  });
  app.app.get('/t/db-mapped', async () => {
    throw new DbError('http', 400, 'RB033');
  });
  app.app.get('/t/db-policy', async () => {
    throw new DbError('http', 400, 'RB036');
  });
  // A handler that logs the whole request, the way a careless later route might.
  app.app.get('/t/log-request', async (req) => {
    req.log.info({ headers: req.headers, authorization: req.headers.authorization }, 'saw request');
    return { ok: true };
  });
  // Real database calls whose real PostgREST errors propagate untouched to the error handler.
  app.app.get('/t/rpc-invalid', async () => {
    return app.db.rpc('claim_jobs', { p_worker: 'p4-d1-test', p_limit: 0, p_lease_seconds: 60 });
  });
  const anonDb = createDb({ url: apiUrl, secretKey: anonKey, timeoutMs: 3000 });
  app.app.get('/t/rpc-denied', async () => {
    return anonDb.rpc('claim_jobs', { p_worker: 'p4-d1-test', p_limit: 1, p_lease_seconds: 60 });
  });
  app.app.get('/t/db-down', async () => {
    throw new DbError('timeout');
  });
  return app.app;
}

beforeAll(async () => {
  ({ apiUrl, anonKey } = getLocalStack());
  key = getLocalPrivilegedKey();
  const env = validEnv({
    SUPABASE_URL: apiUrl,
    SUPABASE_SECRET_KEY: key,
    READY_TIMEOUT_MS: '3000',
  });
  real = createApp(env, { ...buildLoggerOptions('info'), stream: capture() });
  dead = createApp({ ...env, SUPABASE_URL: 'http://127.0.0.1:9', READY_TIMEOUT_MS: '500' }, false);
  guarded(real);
  guarded(dead);
  const rows = (await svc('POST', '/rest/v1/bot_profiles', {
    slug: `t4w-${RUN}`,
    identity_prompt: 'P4 WIRING TEST PLACEHOLDER',
    allowed_languages: ['en'],
    embedding_model: 'gemini-embedding-001',
    embedding_dimensions: 1536,
  })) as { id: string }[];
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('no bot');
  botId = id;
});

afterAll(async () => {
  await real.app.close();
  await dead.app.close();
  await svc('DELETE', `/rest/v1/bot_profiles?id=eq.${botId}`);
});

describe('the real app against the local stack', () => {
  it('is ready when the database answers, and 503 with no detail when it does not', async () => {
    const ok = await real.app.inject({ method: 'GET', url: '/health/ready' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ status: 'ok' });
    const bad = await dead.app.inject({ method: 'GET', url: '/health/ready' });
    expect(bad.statusCode).toBe(503);
    expect(bad.json()).toEqual({ status: 'unavailable' });
  });

  it('lets a valid visitor token through', async () => {
    const id = await session(new Date(Date.now() + 3600_000).toISOString());
    const { token } = real.auth.issueToken({ bot_id: botId, session_id: id, token_version: 1 });
    const res = await real.app.inject({
      method: 'GET',
      url: '/t/guarded',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ bot: botId });
  });

  it('answers a forged or missing token with UNAUTHORIZED, not INVALID_REQUEST', async () => {
    for (const authorization of ['Bearer v1.AAAA.BBBB', 'Basic abc', undefined]) {
      const res = await real.app.inject({
        method: 'GET',
        url: '/t/guarded',
        ...(authorization === undefined ? {} : { headers: { authorization } }),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('UNAUTHORIZED');
      expect(Object.keys(res.json()).sort()).toEqual(['code', 'request_id']);
    }
  });

  it('answers an expired session with SESSION_EXPIRED', async () => {
    const id = await session(new Date(Date.now() - 1000).toISOString());
    const { token } = real.auth.issueToken({ bot_id: botId, session_id: id, token_version: 1 });
    const res = await real.app.inject({
      method: 'GET',
      url: '/t/guarded',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('SESSION_EXPIRED');
  });

  it('fails closed with PROVIDER_UNAVAILABLE when the database is down', async () => {
    const { token } = dead.auth.issueToken({
      bot_id: randomUUID(),
      session_id: randomUUID(),
      token_version: 1,
    });
    const res = await dead.app.inject({
      method: 'GET',
      url: '/t/guarded',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('maps auth and database errors to stable codes', async () => {
    const get = (url: string) => real.app.inject({ method: 'GET', url });
    expect((await get('/t/auth-error')).statusCode).toBe(403);
    expect((await get('/t/auth-error')).json().code).toBe('FORBIDDEN');
    // RB033 is a server fault on a public route (P4-D1); only budget and request conflict map.
    expect((await get('/t/db-mapped')).json().code).toBe('INTERNAL_ERROR');
    const policy = await get('/t/db-policy');
    expect(policy.statusCode).toBe(500);
    expect(policy.json().code).toBe('INTERNAL_ERROR');
    const down = await get('/t/db-down');
    expect(down.statusCode).toBe(503);
    expect(down.json().code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('turns a real PostgREST argument error into DbError.sqlstate and an INTERNAL_ERROR envelope', async () => {
    // claim_jobs raises 22023 for p_limit = 0 before touching any row.
    let caught: unknown;
    try {
      await real.db.rpc('claim_jobs', { p_worker: 'p4-d1-test', p_limit: 0, p_lease_seconds: 60 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DbError);
    expect((caught as DbError).sqlstate).toBe('22023');
    expect((caught as DbError).status).toBe(400);

    const before = lines.length;
    const res = await real.app.inject({ method: 'GET', url: '/t/rpc-invalid' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      code: 'INTERNAL_ERROR',
      request_id: res.headers['x-request-id'],
    });
    const logged = lines.slice(before).join('');
    expect(logged).toContain('db:invalid_argument');
    expect(logged).toContain('"db_status":400');
    expect(logged).not.toContain('claim_jobs');
    expect(res.body).not.toContain('claim_jobs');
  });

  it('turns a real permission error (anon calling a service-only function) into 42501 and INTERNAL_ERROR', async () => {
    const anonDb = createDb({ url: apiUrl, secretKey: anonKey, timeoutMs: 3000 });
    let caught: unknown;
    try {
      await anonDb.rpc('claim_jobs', { p_worker: 'p4-d1-test', p_limit: 1, p_lease_seconds: 60 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DbError);
    expect((caught as DbError).sqlstate).toBe('42501');

    const before = lines.length;
    const res = await real.app.inject({ method: 'GET', url: '/t/rpc-denied' });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('INTERNAL_ERROR');
    const logged = lines.slice(before).join('');
    expect(logged).toContain('db:permission_denied');
    expect(logged).not.toContain(anonKey);
  });

  it('keeps a real bearer token out of the logs on success, failure and a careless handler', async () => {
    const id = await session(new Date(Date.now() + 3600_000).toISOString());
    const { token } = real.auth.issueToken({ bot_id: botId, session_id: id, token_version: 1 });
    const stale = real.auth.issueToken({ bot_id: botId, session_id: id, token_version: 99 }).token;
    sentTokens.push(token, stale);
    const before = lines.length;
    const headers = { authorization: `Bearer ${token}`, 'x-visitor-token': token };
    await real.app.inject({ method: 'GET', url: '/t/guarded', headers });
    await real.app.inject({ method: 'GET', url: '/t/log-request', headers });
    await real.app.inject({
      method: 'GET',
      url: `/t/guarded?token=${token}`,
      headers: { authorization: `Bearer ${stale}` },
    });
    const logged = lines.slice(before).join('');
    expect(logged).toContain('saw request');
    expect(logged).toContain('[Redacted]');
    expect(logged).toContain('request rejected'); // the failed authentication was logged
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(stale);
    expect(logged).not.toContain('Bearer');
  });

  it('never writes a token or key to the logs', () => {
    const log = lines.join('');
    expect(log.length).toBeGreaterThan(0);
    expect(sentTokens.length).toBeGreaterThan(0);
    expect(log).not.toContain(key);
    expect(log).not.toContain(anonKey);
    for (const t of sentTokens) expect(log).not.toContain(t);
    expect(log).not.toContain('v1.AAAA.BBBB');
    expect(log).not.toContain('Bearer');
  });
});
