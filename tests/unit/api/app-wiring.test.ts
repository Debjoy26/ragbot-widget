import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App } from '../../../api/src/app.ts';
import { TURNSTILE_SESSION_ACTION } from '../../../api/src/services/turnstile.ts';
import { validEnv } from './helpers.ts';

// createApp() wired end to end against a labelled FAKE fetch: no network. The fake plays the
// database REST API and Cloudflare's siteverify, and records the order of the calls.

const BOT = randomUUID();
const SESSION = randomUUID();
const CHALLENGE = 'TEST-ONLY-challenge-token-WIRING';

interface Call {
  url: string;
  body: string;
}

function install(opts: {
  policy: Record<string, unknown>;
  siteverify?: Record<string, unknown>;
  preflightAllowed?: boolean;
}) {
  const calls: Call[] = [];
  const respond = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, body });
    const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { status: 200 }));
    if (url.endsWith('/rpc/record_rate_limit_attempt')) {
      const allowed = !(opts.preflightAllowed === false && calls.length === 1);
      return json([
        {
          request_count: 1,
          allowed,
          window_start: new Date().toISOString(),
          window_expires_at: new Date(Date.now() + 30_000).toISOString(),
        },
      ]);
    }
    if (url.endsWith('/rpc/get_session_policy')) return json([opts.policy]);
    if (url.endsWith('/rpc/create_visitor_session')) {
      return json([
        {
          session_id: SESSION,
          token_version: 1,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        },
      ]);
    }
    if (url.includes('siteverify')) return json(opts.siteverify ?? {});
    return Promise.resolve(new Response('unexpected', { status: 500 }));
  };
  vi.stubGlobal('fetch', vi.fn(respond));
  return calls;
}

let built: App | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  await built?.app.close();
  built = undefined;
});

const POLICY = {
  bot_id: BOT,
  enabled: true,
  turnstile_required: true,
  session_limit: 10,
  session_window_seconds: 3600,
  bot_session_limit: 500,
  bot_session_window_seconds: 86_400,
};

const rpcName = (c: Call) => /\/rpc\/([a-z_]+)$/.exec(c.url)?.[1] ?? c.url;

function post(app: App, payload: unknown) {
  return app.app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

describe('createApp wiring (POST /v1/sessions)', () => {
  it('spends preflight, per-IP, per-bot, then asks Cloudflare, then creates the session', async () => {
    const calls = install({
      policy: POLICY,
      siteverify: {
        success: true,
        hostname: 'other.example.com',
        action: TURNSTILE_SESSION_ACTION,
      },
    });
    built = createApp(validEnv({ LOG_LEVEL: 'silent' }), false);
    const res = await post(built, { bot_slug: 'dev-bot', challenge_token: CHALLENGE });
    expect(res.statusCode).toBe(200);
    expect(calls.map(rpcName)).toEqual([
      'record_rate_limit_attempt',
      'get_session_policy',
      'record_rate_limit_attempt',
      'record_rate_limit_attempt',
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      'create_visitor_session',
    ]);
    // Preflight uses the configured limit and window; the aggregate uses the policy columns.
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(JSON.parse(calls[2]?.body ?? '{}')).toMatchObject({
      p_limit: 10,
      p_window_seconds: 3600,
    });
    expect(JSON.parse(calls[3]?.body ?? '{}')).toMatchObject({
      p_limit: 500,
      p_window_seconds: 86_400,
    });
    expect(new URLSearchParams(calls[4]?.body).get('action')).toBe('session_create');
  });

  it('a preflight refusal is 429 and nothing else is called', async () => {
    const calls = install({ policy: POLICY, preflightAllowed: false });
    built = createApp(validEnv({ LOG_LEVEL: 'silent' }), false);
    const res = await post(built, { bot_slug: 'dev-bot', challenge_token: CHALLENGE });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(calls.map(rpcName)).toEqual(['record_rate_limit_attempt']);
  });

  it('Cloudflare answering for a host outside ALLOWED_ORIGINS is refused (403), no session row', async () => {
    const calls = install({
      policy: POLICY,
      siteverify: { success: true, hostname: 'evil.example.net', action: 'session_create' },
    });
    built = createApp(validEnv({ LOG_LEVEL: 'silent' }), false);
    const res = await post(built, { bot_slug: 'dev-bot', challenge_token: CHALLENGE });
    expect(res.statusCode).toBe(403);
    expect(calls.map(rpcName)).not.toContain('create_visitor_session');
  });

  it('a disabled bot row with null columns is the same 403 as an unknown slug', async () => {
    install({
      policy: { bot_id: null, enabled: false, turnstile_required: null, session_limit: null },
    });
    built = createApp(validEnv({ LOG_LEVEL: 'silent' }), false);
    const res = await post(built, { bot_slug: 'dev-bot' });
    expect(res.statusCode).toBe(403);
    expect(Object.keys(res.json()).sort()).toEqual(['code', 'request_id']);
  });
});
