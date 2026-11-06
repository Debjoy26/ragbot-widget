import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../api/src/lib/supabase.ts';
import {
  createVisitorAuth,
  requireVisitor,
  VisitorAuthError,
  type VisitorAuth,
} from '../../api/src/services/auth.ts';
import { getLocalPrivilegedKey, getLocalStack, keyHeaders } from './helpers/local-stack.ts';

// P4-T2: visitor authentication against the LOCAL stack, with real visitor_sessions rows created
// through the service key and a real Fastify instance. No mocks. Needs `npm run db:start` with
// migrations applied. The signing secret below is a labelled test-only value. Rows are created for
// two private test bots (unique slugs) and removed afterwards; the seed is not used.

const RUN = randomUUID().slice(0, 8);
const SECRET = randomBytes(32).toString('hex');
const TTL = 900;

let apiUrl: string;
let key: string;
let db: Db;
let auth: VisitorAuth;
let app: FastifyInstance;
let deadApp: FastifyInstance;
let botA: string;
let botB: string;
const botIds: string[] = [];

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
  // Status only in the message: a response body or key must never reach test output.
  if (res.status >= 300)
    throw new Error(`service call ${method} ${path.split('?')[0]} -> ${String(res.status)}`);
  const text = await res.text();
  return text.length === 0 ? null : (JSON.parse(text) as unknown);
}

async function createBot(suffix: string): Promise<string> {
  const rows = (await svc('POST', '/rest/v1/bot_profiles', {
    slug: `t4-${RUN}-${suffix}`,
    identity_prompt: 'T4 TEST PLACEHOLDER',
    allowed_languages: ['en'],
    embedding_model: 'gemini-embedding-001',
    embedding_dimensions: 1536,
  })) as { id: string }[];
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('bot was not created');
  botIds.push(id);
  return id;
}

async function createSession(
  botId: string,
  over: { expires_at?: string; token_version?: number } = {},
): Promise<string> {
  const rows = (await svc('POST', '/rest/v1/visitor_sessions', {
    bot_id: botId,
    expires_at: over.expires_at ?? new Date(Date.now() + 3600_000).toISOString(),
    ...(over.token_version === undefined ? {} : { token_version: over.token_version }),
  })) as { id: string }[];
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('session was not created');
  return id;
}

const patchSession = (id: string, patch: Record<string, unknown>) =>
  svc('PATCH', `/rest/v1/visitor_sessions?id=eq.${id}`, patch);

function tokenFor(botId: string, sessionId: string, version = 1): string {
  return auth.issueToken({ bot_id: botId, session_id: sessionId, token_version: version }).token;
}

function get(authorization: string | undefined, server: FastifyInstance = app) {
  return server.inject({
    method: 'GET',
    url: '/t/whoami',
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  });
}

function buildApp(a: VisitorAuth): FastifyInstance {
  const server = Fastify({ logger: false });
  server.setErrorHandler((err, _req, reply) => {
    if (err instanceof VisitorAuthError) {
      void reply.code(err.statusCode).send({ code: err.code });
      return;
    }
    void reply.code(500).send({ code: 'INTERNAL' });
  });
  // Test-only routes.
  server.get('/t/whoami', { preHandler: requireVisitor(a) }, (req) => ({ ...req.visitor }));
  server.get(
    '/t/bot-a',
    {
      preHandler: async (req) => {
        const header = req.headers.authorization ?? '';
        req.visitor = await a.authenticate(header.replace(/^Bearer /i, ''), botA);
      },
    },
    (req) => ({ ...req.visitor }),
  );
  return server;
}

beforeAll(async () => {
  apiUrl = getLocalStack().apiUrl;
  key = getLocalPrivilegedKey();
  db = createDb({ url: apiUrl, secretKey: key, timeoutMs: 5000 });
  auth = createVisitorAuth({ secret: SECRET, ttlSeconds: TTL, db });
  app = buildApp(auth);
  await app.ready();

  // A second app whose database is unreachable (nothing listens on port 1).
  const deadDb = createDb({ url: 'http://127.0.0.1:1', secretKey: key, timeoutMs: 2000 });
  deadApp = buildApp(createVisitorAuth({ secret: SECRET, ttlSeconds: TTL, db: deadDb }));
  await deadApp.ready();

  botA = await createBot('a');
  botB = await createBot('b');
}, 60_000);

afterAll(async () => {
  await app?.close();
  await deadApp?.close();
  // Deleting the bots cascades to their visitor_sessions rows.
  for (const id of botIds) await svc('DELETE', `/rest/v1/bot_profiles?id=eq.${id}`);
}, 60_000);

describe('visitor auth against the local stack', () => {
  it('lets a valid token through and exposes the visitor on the request', async () => {
    const session = await createSession(botA);
    const res = await get(`Bearer ${tokenFor(botA, session)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ bot_id: botA, session_id: session, token_version: 1 });
  });

  it('accepts a lower-case scheme', async () => {
    const session = await createSession(botA);
    expect((await get(`bearer ${tokenFor(botA, session)}`)).statusCode).toBe(200);
  });

  it('refuses a missing or malformed Authorization header with 401 UNAUTHORIZED', async () => {
    const session = await createSession(botA);
    const token = tokenFor(botA, session);
    for (const header of [undefined, '', 'Bearer', `Basic ${token}`, `Bearer  ${token}`, token]) {
      const res = await get(header);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ code: 'UNAUTHORIZED' });
    }
  });

  it('refuses a forged token (another secret) for a real session with 401', async () => {
    const session = await createSession(botA);
    const forger = createVisitorAuth({
      secret: randomBytes(32).toString('hex'),
      ttlSeconds: TTL,
      db,
    });
    const forged = forger.issueToken({ bot_id: botA, session_id: session, token_version: 1 }).token;
    const res = await get(`Bearer ${forged}`);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'UNAUTHORIZED' });
  });

  it('refuses a tampered payload (swapped bot) with 401', async () => {
    const session = await createSession(botA);
    const [v, , sig] = tokenFor(botA, session).split('.') as [string, string, string];
    const other = tokenFor(botB, session).split('.')[1] as string;
    const res = await get(`Bearer ${v}.${other}.${sig}`);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'UNAUTHORIZED' });
  });

  it('refuses an expired token with 401 SESSION_EXPIRED', async () => {
    const session = await createSession(botA);
    const past = createVisitorAuth({
      secret: SECRET,
      ttlSeconds: TTL,
      db,
      now: () => Date.now() - 2 * 3600_000,
    });
    const token = past.issueToken({ bot_id: botA, session_id: session, token_version: 1 }).token;
    const res = await get(`Bearer ${token}`);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'SESSION_EXPIRED' });
  });

  it('refuses a live token whose session row has expired, with 401 SESSION_EXPIRED', async () => {
    const session = await createSession(botA, {
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const res = await get(`Bearer ${tokenFor(botA, session)}`);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'SESSION_EXPIRED' });
  });

  it('refuses a token naming a bot that does not own the session', async () => {
    const sessionOfB = await createSession(botB);
    const res = await get(`Bearer ${tokenFor(botA, sessionOfB)}`);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'UNAUTHORIZED' });
  });

  it('refuses a valid token of another bot when a route expects bot A (403 FORBIDDEN)', async () => {
    const sessionA = await createSession(botA);
    const sessionB = await createSession(botB);
    const ok = await app.inject({
      method: 'GET',
      url: '/t/bot-a',
      headers: { authorization: `Bearer ${tokenFor(botA, sessionA)}` },
    });
    expect(ok.statusCode).toBe(200);
    const res = await app.inject({
      method: 'GET',
      url: '/t/bot-a',
      headers: { authorization: `Bearer ${tokenFor(botB, sessionB)}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: 'FORBIDDEN' });
  });

  it('refuses a revoked session at once, with a still-valid token', async () => {
    const session = await createSession(botA);
    const token = tokenFor(botA, session);
    expect((await get(`Bearer ${token}`)).statusCode).toBe(200);
    await patchSession(session, { revoked_at: new Date().toISOString() });
    const res = await get(`Bearer ${token}`);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'UNAUTHORIZED' });
  });

  it('refuses a token once token_version has been bumped', async () => {
    const session = await createSession(botA);
    const token = tokenFor(botA, session, 1);
    expect((await get(`Bearer ${token}`)).statusCode).toBe(200);
    await patchSession(session, { token_version: 2 });
    const res = await get(`Bearer ${token}`);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'UNAUTHORIZED' });
    // A token minted for the new version passes.
    expect((await get(`Bearer ${tokenFor(botA, session, 2)}`)).statusCode).toBe(200);
  });

  it('refuses a token whose session row was deleted', async () => {
    const session = await createSession(botA);
    const token = tokenFor(botA, session);
    expect((await get(`Bearer ${token}`)).statusCode).toBe(200);
    await svc('DELETE', `/rest/v1/visitor_sessions?id=eq.${session}`);
    const res = await get(`Bearer ${token}`);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'UNAUTHORIZED' });
  });

  it('fails closed with 503 PROVIDER_UNAVAILABLE when the database is unreachable', async () => {
    const session = await createSession(botA);
    const res = await get(`Bearer ${tokenFor(botA, session)}`, deadApp);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('never echoes the token or secret in any refusal body', async () => {
    const token = tokenFor(botA, randomUUID());
    const res = await get(`Bearer ${token}`);
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(token);
    expect(res.body).not.toContain(SECRET);
  });
});

describe('db.ping against the local stack', () => {
  it('is true for the running stack', async () => {
    expect(await db.ping(AbortSignal.timeout(5000))).toBe(true);
  });

  it('is false for a dead URL', async () => {
    const dead = createDb({ url: 'http://127.0.0.1:1', secretKey: key, timeoutMs: 2000 });
    expect(await dead.ping(AbortSignal.timeout(5000))).toBe(false);
  });

  it('is false for a wrong key', async () => {
    const wrong = createDb({ url: apiUrl, secretKey: 'TEST-ONLY-wrong-key', timeoutMs: 3000 });
    expect(await wrong.ping(AbortSignal.timeout(5000))).toBe(false);
  });
});

describe('selectOne against the local stack', () => {
  it('finds a real row, returns null for none, and treats an injection-shaped id as no match', async () => {
    const session = await createSession(botA);
    type Row = { token_version: number; revoked_at: string | null };
    const row = await db.selectOne<Row>('visitor_sessions', { id: session, bot_id: botA }, [
      'token_version',
      'revoked_at',
    ]);
    expect(row).toEqual({ token_version: 1, revoked_at: null });
    expect(
      await db.selectOne('visitor_sessions', { id: session, bot_id: botB }, ['token_version']),
    ).toBeNull();
    await expect(
      db.selectOne('visitor_sessions', { id: `${session}&bot_id=neq.${botB}` }, ['token_version']),
    ).rejects.toMatchObject({ name: 'DbError', status: 400 });
  });

  it('refuses a filter that matches more than one real row instead of returning the first (P4-D1)', async () => {
    const bot = await createBot('multi');
    await createSession(bot);
    await createSession(bot);
    await expect(db.selectOne('visitor_sessions', { bot_id: bot }, ['id'])).rejects.toMatchObject({
      name: 'DbError',
      reason: 'invalid_response',
    });
  });
});

describe('secret rotation against the local stack (P4-D1)', () => {
  it('authenticates a session with a token signed by the previous secret, never issued with it', async () => {
    const OLD = 'TEST-ONLY-retired-secret-0123456789-abcdefg';
    const session = await createSession(botA);
    const retired = createVisitorAuth({ secret: OLD, ttlSeconds: TTL, db });
    const rotated = createVisitorAuth({ secret: SECRET, previousSecret: OLD, ttlSeconds: TTL, db });
    const oldToken = retired.issueToken({
      bot_id: botA,
      session_id: session,
      token_version: 1,
    }).token;
    expect((await rotated.authenticate(oldToken)).session_id).toBe(session);
    // Without the previous secret the same token is refused.
    await expect(auth.authenticate(oldToken)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    // A token the rotated instance issues is verifiable by the current secret alone.
    const fresh = rotated.issueToken({ bot_id: botA, session_id: session, token_version: 1 }).token;
    expect((await auth.authenticate(fresh)).session_id).toBe(session);
  });
});
