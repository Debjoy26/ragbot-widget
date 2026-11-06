import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../../api/src/app.ts';
import { DbError } from '../../api/src/lib/supabase.ts';
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
  app.app.get('/t/db-down', async () => {
    throw new DbError('timeout');
  });
  return app.app;
}

beforeAll(async () => {
  ({ apiUrl } = getLocalStack());
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
    expect((await get('/t/db-mapped')).json().code).toBe('FORBIDDEN');
    const policy = await get('/t/db-policy');
    expect(policy.statusCode).toBe(500);
    expect(policy.json().code).toBe('INTERNAL_ERROR');
    const down = await get('/t/db-down');
    expect(down.statusCode).toBe(503);
    expect(down.json().code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('never writes a token or key to the logs', () => {
    const log = lines.join('');
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(key);
    expect(log).not.toContain('v1.AAAA.BBBB');
    expect(log).not.toContain('Bearer');
  });
});
