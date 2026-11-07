import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, type App } from '../../api/src/app.ts';
import { loadConfig } from '../../api/src/lib/config.ts';
import { buildLoggerOptions } from '../../api/src/lib/logger.ts';
import { rateKey } from '../../api/src/lib/rate-key.ts';
import { createDb } from '../../api/src/lib/supabase.ts';
import { createVisitorAuth } from '../../api/src/services/auth.ts';
import { createLimits } from '../../api/src/services/limits.ts';
import { createRuns } from '../../api/src/services/runs.ts';
import { FAKE_RATE_KEY, buildTestServer, validEnv } from '../unit/api/helpers.ts';
import { getLocalPrivilegedKey, getLocalStack, keyHeaders } from './helpers/local-stack.ts';

// P5-B: POST /v1/sessions over the real app against the LOCAL stack (needs migration 011, which adds
// get_session_policy and create_visitor_session; until it is applied these tests fail). Test bots are
// private (unique slugs, own client_settings) and removed afterwards; the seed is not used. Each test
// uses its own client address (X-Forwarded-For, TRUSTED_PROXY_HOPS=1), so counters never overlap.
// The only fake is the Turnstile verifier in the "Turnstile" block, labelled where it is built.

const RUN = randomUUID().slice(0, 8);
const LOGS: string[] = [];

let apiUrl: string;
let key: string;
let real: App;
const botIds: string[] = [];
const usedKeys: string[] = [];
let ipCounter = 0;
/** A fresh documentation-range address per call (TEST-NET-2), unique within this run. */
const nextIp = (): string => `198.51.100.${String(++ipCounter)}`;

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
  // Status only: a response body or key must never reach test output.
  if (res.status >= 300)
    throw new Error(`service call ${method} ${path.split('?')[0]} -> ${String(res.status)}`);
  const text = await res.text();
  return text.length === 0 ? null : (JSON.parse(text) as unknown);
}

interface BotOptions {
  enabled?: boolean;
  limit?: number;
  windowSeconds?: number;
  /** Per-bot aggregate (rate_policy.session_create_per_bot). */
  botLimit?: number;
  botWindowSeconds?: number;
  flags?: Record<string, unknown>;
}

async function createBot(
  suffix: string,
  o: BotOptions = {},
): Promise<{ id: string; slug: string }> {
  const slug = `t5s-${RUN}-${suffix}`;
  const rows = (await svc('POST', '/rest/v1/bot_profiles', {
    slug,
    identity_prompt: 'T5 TEST PLACEHOLDER',
    allowed_languages: ['en'],
    embedding_model: 'gemini-embedding-001',
    embedding_dimensions: 1536,
    enabled: o.enabled ?? true,
  })) as { id: string }[];
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('bot was not created');
  botIds.push(id);
  await svc('POST', '/rest/v1/client_settings', {
    bot_id: id,
    allowed_origins: ['http://localhost:3000'],
    rate_policy: {
      session_create_per_ip: { limit: o.limit ?? 100, window_seconds: o.windowSeconds ?? 3600 },
      session_create_per_bot: {
        limit: o.botLimit ?? 10_000,
        window_seconds: o.botWindowSeconds ?? 3600,
      },
      message_per_session: { limit: 20, window_seconds: 600 },
      message_per_ip: { limit: 60, window_seconds: 3600 },
      concurrent_requests_per_session: 1,
    },
    budget_policy: { daily_cap_usd: 5 },
    retention_policy: { conversation_days: 90, usage_months: 13 },
    upload_policy: {
      max_bytes: 20971520,
      max_pages: 300,
      index_max_attempts: 3,
      cleanup_max_attempts: 3,
      quotas: {
        register: { limit: 200, window_seconds: 3600 },
        upload: { limit: 200, window_seconds: 3600 },
        reindex: { limit: 200, window_seconds: 3600 },
        write: { limit: 200, window_seconds: 3600 },
      },
    },
    handoff_policy: {},
    cache_policy: {},
    feature_flags: o.flags ?? { turnstile_required: false },
  });
  return { id, slug };
}

const post = (app: FastifyInstance, ip: string, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    payload: JSON.stringify(payload),
  });

function baseEnv(extra: Record<string, string | undefined> = {}) {
  return validEnv({
    SUPABASE_URL: apiUrl,
    SUPABASE_SECRET_KEY: key,
    TRUSTED_PROXY_HOPS: '1',
    // Every test uses its own address, so the preflight (30 per 600 s per address) never trips here
    // except in the test that exercises it on purpose.
    ...extra,
    READY_TIMEOUT_MS: '3000',
    DB_TIMEOUT_MS: '5000',
  });
}

beforeAll(async () => {
  ({ apiUrl } = getLocalStack());
  key = getLocalPrivilegedKey();
  real = createApp(baseEnv(), {
    ...buildLoggerOptions('info'),
    stream: new Writable({
      write(chunk: Buffer, _enc, done) {
        LOGS.push(chunk.toString());
        done();
      },
    }),
  });
}, 60_000);

afterAll(async () => {
  await real?.app.close();
  // Best effort: the counters expire on their own, deleting them just keeps the table tidy.
  for (const k of usedKeys) {
    await svc('DELETE', `/rest/v1/rate_limit_buckets?key_hash=eq.${k}`).catch(() => undefined);
  }
  // Deleting the bots cascades to client_settings and visitor_sessions.
  for (const id of botIds) await svc('DELETE', `/rest/v1/bot_profiles?id=eq.${id}`);
}, 60_000);

/** Remember the bucket a session-create call used, so afterAll can remove it. */
function track(botId: string, ip: string): void {
  usedKeys.push(
    rateKey(FAKE_RATE_KEY, 'session_create_ip', [botId, ip]),
    rateKey(FAKE_RATE_KEY, 'session_create_bot', [botId]),
  );
}

/** The preflight bucket of an address, for cleanup. */
function trackPreflight(ip: string): void {
  usedKeys.push(rateKey(FAKE_RATE_KEY, 'session_preflight', [ip]));
}

describe('POST /v1/sessions against the local stack', () => {
  it('creates a session for a test bot and the token authenticates', async () => {
    const bot = await createBot('ok');
    const ip = nextIp();
    track(bot.id, ip);
    const res = await post(real.app, ip, { bot_slug: bot.slug });
    expect(res.statusCode).toBe(200);
    const out = res.json<{ token: string; expires_at: string }>();
    expect(Object.keys(out).sort()).toEqual(['expires_at', 'token']);
    expect(Date.parse(out.expires_at)).toBeGreaterThan(Date.now());
    expect(Date.parse(out.expires_at)).toBeLessThanOrEqual(Date.now() + 900_000 + 2000);

    const visitor = await real.auth.authenticate(out.token, bot.id);
    expect(visitor.bot_id).toBe(bot.id);
    expect(visitor.token_version).toBe(1);

    const rows = (await svc(
      'GET',
      `/rest/v1/visitor_sessions?id=eq.${visitor.session_id}&select=bot_id,token_version,revoked_at`,
    )) as { bot_id: string; token_version: number; revoked_at: string | null }[];
    expect(rows).toEqual([{ bot_id: bot.id, token_version: 1, revoked_at: null }]);
  });

  it('two calls make two different sessions', async () => {
    const bot = await createBot('two');
    const ip = nextIp();
    track(bot.id, ip);
    const a = (await post(real.app, ip, { bot_slug: bot.slug })).json<{ token: string }>();
    const b = (await post(real.app, ip, { bot_slug: bot.slug })).json<{ token: string }>();
    const va = await real.auth.authenticate(a.token);
    const vb = await real.auth.authenticate(b.token);
    expect(va.session_id).not.toBe(vb.session_id);
  });

  it('a disabled bot is 403 FORBIDDEN and creates no session', async () => {
    const bot = await createBot('off', { enabled: false });
    const res = await post(real.app, nextIp(), { bot_slug: bot.slug });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('FORBIDDEN');
    const rows = (await svc(
      'GET',
      `/rest/v1/visitor_sessions?bot_id=eq.${bot.id}&select=id`,
    )) as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('an unknown slug is 403 with the same body as a disabled bot', async () => {
    const off = await createBot('off2', { enabled: false });
    const disabled = await post(real.app, nextIp(), { bot_slug: off.slug });
    const unknown = await post(real.app, nextIp(), { bot_slug: `t5s-${RUN}-does-not-exist` });
    expect(unknown.statusCode).toBe(403);
    const a = disabled.json<Record<string, unknown>>();
    const b = unknown.json<Record<string, unknown>>();
    delete a['request_id'];
    delete b['request_id'];
    expect(b).toEqual(a);
    expect(b).toEqual({ code: 'FORBIDDEN' });
  });

  it('a strict-body violation is 400 INVALID_REQUEST', async () => {
    const bot = await createBot('strict');
    const res = await post(real.app, nextIp(), { bot_slug: bot.slug, extra: true });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('INVALID_REQUEST');
  });

  it('a bot with no usable settings fails closed as 500 INTERNAL_ERROR, not as an open door', async () => {
    const bot = await createBot('nopolicy');
    await svc('PATCH', `/rest/v1/client_settings?bot_id=eq.${bot.id}`, { rate_policy: {} });
    const res = await post(real.app, nextIp(), { bot_slug: bot.slug });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ code: string }>().code).toBe('INTERNAL_ERROR');
  });

  it('the session-create limit refuses the (limit+1)th call with retry-after', async () => {
    const bot = await createBot('limit', { limit: 3, windowSeconds: 3600 });
    const ip = nextIp();
    track(bot.id, ip);
    for (let i = 0; i < 3; i += 1) {
      expect((await post(real.app, ip, { bot_slug: bot.slug })).statusCode).toBe(200);
    }
    const refused = await post(real.app, ip, { bot_slug: bot.slug });
    expect(refused.statusCode).toBe(429);
    const retry = Number(refused.headers['retry-after']);
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(3600);
    expect(refused.json()).toMatchObject({ code: 'RATE_LIMITED', retry_after_seconds: retry });
    // Still refused, and no extra session row was made.
    expect((await post(real.app, ip, { bot_slug: bot.slug })).statusCode).toBe(429);
    const rows = (await svc(
      'GET',
      `/rest/v1/visitor_sessions?bot_id=eq.${bot.id}&select=id`,
    )) as unknown[];
    expect(rows).toHaveLength(3);

    // Another address has its own counter.
    const other = nextIp();
    track(bot.id, other);
    expect((await post(real.app, other, { bot_slug: bot.slug })).statusCode).toBe(200);
  });

  it('addresses in one IPv6 /64 share a counter', async () => {
    const bot = await createBot('v6', { limit: 1, windowSeconds: 3600 });
    ipCounter += 1;
    const prefix = `2001:db8:${RUN.slice(0, 4)}:${String(ipCounter)}`;
    expect((await post(real.app, `${prefix}::1`, { bot_slug: bot.slug })).statusCode).toBe(200);
    expect(
      (await post(real.app, `${prefix}:aaaa:bbbb:cccc:dddd`, { bot_slug: bot.slug })).statusCode,
    ).toBe(429);
  });

  it('the per-bot aggregate limit refuses across addresses, with retry-after', async () => {
    const bot = await createBot('botagg', { botLimit: 2, botWindowSeconds: 3600 });
    for (let i = 0; i < 2; i += 1) {
      const ip = nextIp();
      track(bot.id, ip);
      expect((await post(real.app, ip, { bot_slug: bot.slug })).statusCode).toBe(200);
    }
    const refused = await post(real.app, nextIp(), { bot_slug: bot.slug });
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    const rows = (await svc(
      'GET',
      `/rest/v1/visitor_sessions?bot_id=eq.${bot.id}&select=id`,
    )) as unknown[];
    expect(rows).toHaveLength(2);
  });

  it('the preflight is per address across bots and refuses before any bot is looked up', async () => {
    const small = createApp(
      baseEnv({ SESSION_PREFLIGHT_PER_IP_LIMIT: '2', SESSION_PREFLIGHT_WINDOW_SECONDS: '3600' }),
      false,
    );
    try {
      const a = await createBot('pf-a');
      const b = await createBot('pf-b');
      const ip = nextIp();
      trackPreflight(ip);
      track(a.id, ip);
      track(b.id, ip);
      expect((await post(small.app, ip, { bot_slug: a.slug })).statusCode).toBe(200);
      // An unknown slug still spends the preflight: probing slugs is bounded.
      expect((await post(small.app, ip, { bot_slug: `t5s-${RUN}-nope` })).statusCode).toBe(403);
      const refused = await post(small.app, ip, { bot_slug: b.slug });
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      const rows = (await svc(
        'GET',
        `/rest/v1/visitor_sessions?bot_id=eq.${b.id}&select=id`,
      )) as unknown[];
      expect(rows).toHaveLength(0);
      // Another address is unaffected.
      const other = nextIp();
      trackPreflight(other);
      track(b.id, other);
      expect((await post(small.app, other, { bot_slug: b.slug })).statusCode).toBe(200);
    } finally {
      await small.app.close();
    }
  });

  it('never logs the bearer token, the challenge token or the slug', async () => {
    const bot = await createBot('logs');
    const res = await post(real.app, nextIp(), {
      bot_slug: bot.slug,
      challenge_token: 'TEST-ONLY-challenge-DDDD',
    });
    const token = res.json<{ token?: string }>().token ?? '';
    const text = LOGS.join('');
    expect(text.length).toBeGreaterThan(0);
    if (token !== '') expect(text).not.toContain(token);
    expect(text).not.toContain('TEST-ONLY-challenge-DDDD');
    expect(text).not.toContain(bot.slug);
    expect(text).not.toContain(key);
  });
});

describe('POST /v1/sessions with Turnstile required', () => {
  // LABELLED FAKE: a stand-in verifier that accepts exactly one token. The real verifier is covered
  // by unit tests with an injected fetch; no Cloudflare call is ever made here.
  const GOOD = 'TEST-ONLY-good-challenge';
  let app: FastifyInstance;
  const verify = vi.fn(async (token: string) => token === GOOD);

  beforeAll(() => {
    const config = loadConfig(baseEnv());
    const db = createDb({ url: apiUrl, secretKey: key, timeoutMs: 5000 });
    const auth = createVisitorAuth({
      secret: config.visitorTokenSecret,
      ttlSeconds: config.visitorTokenTtlSeconds,
      db,
    });
    app = buildTestServer({
      config,
      db,
      auth,
      limits: createLimits({
        db,
        rateKeySecret: config.rateLimitKeySecret,
        sessionPreflight: {
          limit: config.sessionPreflightPerIpLimit,
          window_seconds: config.sessionPreflightWindowSeconds,
        },
      }),
      runs: createRuns({ db }),
      turnstile: { verify },
      logger: false,
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('a good challenge creates the session', async () => {
    const bot = await createBot('ts-ok', { flags: { turnstile_required: true } });
    const res = await post(app, nextIp(), { bot_slug: bot.slug, challenge_token: GOOD });
    expect(res.statusCode).toBe(200);
  });

  it('a missing or wrong challenge is 403 and creates no session', async () => {
    const bot = await createBot('ts-bad', { flags: { turnstile_required: true } });
    const missing = await post(app, nextIp(), { bot_slug: bot.slug });
    const wrong = await post(app, nextIp(), { bot_slug: bot.slug, challenge_token: 'nope' });
    expect(missing.statusCode).toBe(403);
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json<{ code: string }>().code).toBe('FORBIDDEN');
    const rows = (await svc(
      'GET',
      `/rest/v1/visitor_sessions?bot_id=eq.${bot.id}&select=id`,
    )) as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('a bot without the flag set still requires the challenge (fail closed)', async () => {
    const bot = await createBot('ts-default', { flags: {} });
    const res = await post(app, nextIp(), { bot_slug: bot.slug });
    expect(res.statusCode).toBe(403);
  });

  it('failed challenges never consume the bot aggregate; the (limit+1)th good request is refused', async () => {
    const bot = await createBot('ts-agg', {
      flags: { turnstile_required: true },
      botLimit: 2,
      botWindowSeconds: 3600,
    });
    const tracked = (): string => {
      const ip = nextIp();
      track(bot.id, ip);
      return ip;
    };
    expect((await post(app, tracked(), { bot_slug: bot.slug })).statusCode).toBe(403);
    for (let i = 0; i < 4; i += 1) {
      const res = await post(app, tracked(), { bot_slug: bot.slug, challenge_token: 'nope' });
      expect(res.statusCode).toBe(403);
    }
    for (let i = 0; i < 2; i += 1) {
      const res = await post(app, tracked(), { bot_slug: bot.slug, challenge_token: GOOD });
      expect(res.statusCode).toBe(200);
    }
    const refused = await post(app, tracked(), { bot_slug: bot.slug, challenge_token: GOOD });
    expect(refused.statusCode).toBe(429);
    const rows = (await svc(
      'GET',
      `/rest/v1/visitor_sessions?bot_id=eq.${bot.id}&select=id`,
    )) as unknown[];
    expect(rows).toHaveLength(2);
  });

  it('a bot with the flag off does not ask for it', async () => {
    const bot = await createBot('ts-off', { flags: { turnstile_required: false } });
    verify.mockClear();
    const res = await post(app, nextIp(), { bot_slug: bot.slug });
    expect(res.statusCode).toBe(200);
    expect(verify).not.toHaveBeenCalled();
  });
});
