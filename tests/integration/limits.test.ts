import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../api/src/lib/errors.ts';
import { rateKey } from '../../api/src/lib/rate-key.ts';
import { createDb, DbError, type Db } from '../../api/src/lib/supabase.ts';
import { createLimits, type Limits } from '../../api/src/services/limits.ts';
import { createRuns, requestHash, type Runs } from '../../api/src/services/runs.ts';
import { getLocalPrivilegedKey, getLocalStack, keyHeaders } from './helpers/local-stack.ts';

// P5-B: limits, budget reservations and request runs against the LOCAL stack (needs migration 011:
// set_request_run_state, get_request_run, get_rate_policy). No mocks. Test bots are private (unique
// slugs, own client_settings) and removed afterwards; the seed is not used. The rate-limit secret
// is a random per-run test value.

const RUN = randomUUID().slice(0, 8);
const rateKeyMaterial = randomBytes(32).toString('hex');

let apiUrl: string;
let key: string;
let db: Db;
let limits: Limits;
let runs: Runs;
const botIds: string[] = [];
const bucketKeys: string[] = [];
let ipCounter = 0;
const nextIp = (): string => `198.51.100.${String(100 + ++ipCounter)}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  if (res.status >= 300)
    throw new Error(`service call ${method} ${path.split('?')[0]} -> ${String(res.status)}`);
  const text = await res.text();
  return text.length === 0 ? null : (JSON.parse(text) as unknown);
}

interface BotOptions {
  capUsd?: number;
  concurrent?: number;
  enabled?: boolean;
  messagePerSession?: number;
  messagePerIp?: number;
}

async function createBot(suffix: string, o: BotOptions = {}): Promise<string> {
  const rows = (await svc('POST', '/rest/v1/bot_profiles', {
    slug: `t5l-${RUN}-${suffix}`,
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
      session_create_per_ip: { limit: 100, window_seconds: 3600 },
      message_per_session: { limit: o.messagePerSession ?? 20, window_seconds: 3600 },
      message_per_ip: { limit: o.messagePerIp ?? 60, window_seconds: 3600 },
      concurrent_requests_per_session: o.concurrent ?? 1,
    },
    budget_policy: { daily_cap_usd: o.capUsd ?? 5 },
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
    feature_flags: { turnstile_required: false },
  });
  return id;
}

async function createSession(
  botId: string,
): Promise<{ bot_id: string; session_id: string; token_version: number }> {
  const rows = (await svc('POST', '/rest/v1/visitor_sessions', {
    bot_id: botId,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  })) as { id: string }[];
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('session was not created');
  return { bot_id: botId, session_id: id, token_version: 1 };
}

async function runState(runId: string): Promise<string | undefined> {
  const rows = (await svc('GET', `/rest/v1/request_runs?id=eq.${runId}&select=state`)) as {
    state: string;
  }[];
  return rows[0]?.state;
}

async function reservations(
  botId: string,
): Promise<{ id: string; request_id: string; amount: number; state: string }[]> {
  return (await svc(
    'GET',
    `/rest/v1/budget_reservations?bot_id=eq.${botId}&select=id,request_id,amount,state`,
  )) as { id: string; request_id: string; amount: number; state: string }[];
}

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a failure');
}

/** Begins a fresh run (new key) for a visitor and returns its id. */
async function newRun(visitor: Awaited<ReturnType<typeof createSession>>): Promise<string> {
  const out = await runs.beginRun(visitor, randomUUID(), requestHash({ n: randomUUID() }));
  if (out.kind !== 'new') throw new Error('expected a new run');
  return out.runId;
}

beforeAll(async () => {
  ({ apiUrl } = getLocalStack());
  key = getLocalPrivilegedKey();
  db = createDb({ url: apiUrl, secretKey: key, timeoutMs: 8000 });
  limits = createLimits({ db, rateKeySecret: rateKeyMaterial });
  runs = createRuns({ db });
}, 60_000);

afterAll(async () => {
  if (key === undefined) return;
  for (const k of bucketKeys) {
    await svc('DELETE', `/rest/v1/rate_limit_buckets?key_hash=eq.${k}`).catch(() => undefined);
  }
  // Deleting the bots cascades to client_settings, sessions, runs and reservations.
  for (const id of botIds) await svc('DELETE', `/rest/v1/bot_profiles?id=eq.${id}`);
}, 60_000);

describe('rate-limit window rollover', () => {
  it('refuses inside the window with a retry-after, then allows again after it rolls over', async () => {
    const bot = await createBot('window');
    const ip = nextIp();
    bucketKeys.push(rateKey(rateKeyMaterial, 'session_create_ip', [bot, ip]));
    const policy = { session_limit: 1, session_window_seconds: 2 };

    // Start just after a 2-second boundary so both calls land in one window.
    await sleep(2000 - (Date.now() % 2000) + 60);
    await limits.consumeSessionCreate(bot, ip, policy);
    const err = (await failure(limits.consumeSessionCreate(bot, ip, policy))) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(2);

    // Past the end of the window the counter starts again.
    await sleep(2000 - (Date.now() % 2000) + 60);
    await limits.consumeSessionCreate(bot, ip, policy);
  }, 15_000);

  it('a different address or a different bot has its own counter', async () => {
    const botA = await createBot('win-a');
    const botB = await createBot('win-b');
    const ip = nextIp();
    const policy = { session_limit: 1, session_window_seconds: 3600 };
    for (const [b, a] of [
      [botA, ip],
      [botB, ip],
      [botA, nextIp()],
    ] as const) {
      bucketKeys.push(rateKey(rateKeyMaterial, 'session_create_ip', [b, a]));
      await limits.consumeSessionCreate(b, a, policy);
    }
    await expect(limits.consumeSessionCreate(botA, ip, policy)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });
});

describe('message limits', () => {
  it('checks the session first, then the IP bucket, from get_rate_policy', async () => {
    const bot = await createBot('msg', { messagePerSession: 2, messagePerIp: 3 });
    const a = await createSession(bot);
    const b = await createSession(bot);
    const c = await createSession(bot);
    const ip = nextIp();
    bucketKeys.push(
      rateKey(rateKeyMaterial, 'message_session', [bot, a.session_id]),
      rateKey(rateKeyMaterial, 'message_session', [bot, b.session_id]),
      rateKey(rateKeyMaterial, 'message_session', [bot, c.session_id]),
      rateKey(rateKeyMaterial, 'message_ip', [bot, ip]),
    );
    const policy = await limits.loadMessagePolicy(bot);
    expect(policy.message_per_session.limit).toBe(2);

    await limits.consumeMessage(a, ip, policy); // session a 1, ip 1
    await limits.consumeMessage(a, ip, policy); // session a 2, ip 2
    // Third message of session a: refused by the session, so the IP counter is not spent.
    await expect(limits.consumeMessage(a, ip, policy)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    await limits.consumeMessage(b, ip, policy); // ip 3
    // The IP bucket is now full: a new session from the same address is refused.
    const err = (await failure(limits.consumeMessage(c, ip, policy))) as AppError;
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('a bot without a usable rate policy fails closed', async () => {
    const bot = await createBot('msg-bad');
    await svc('PATCH', `/rest/v1/client_settings?bot_id=eq.${bot}`, {
      rate_policy: { concurrent_requests_per_session: 1 },
    });
    const err = (await failure(limits.loadMessagePolicy(bot))) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('INTERNAL_ERROR');
  });

  it('a disabled bot has no rate policy (RB039)', async () => {
    const bot = await createBot('msg-off', { enabled: false });
    const err = await failure(limits.loadMessagePolicy(bot));
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).sqlstate).toBe('RB039');
  });
});

describe('budget reservations', () => {
  it('N concurrent reservations against a small cap never exceed it in total', async () => {
    const cap = 1;
    const amount = 0.3;
    const bot = await createBot('race', { capUsd: cap });
    const n = 12;
    const ids = await Promise.all(
      Array.from({ length: n }, async () => newRun(await createSession(bot))),
    );
    const results = await Promise.allSettled(ids.map((id) => limits.reserve(bot, id, amount, 300)));

    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    // 0.3 x 3 = 0.9 fits under 1.0; a fourth would not.
    expect(ok).toHaveLength(3);
    expect(refused).toHaveLength(n - 3);
    for (const r of refused) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(DbError);
      expect(((r as PromiseRejectedResult).reason as DbError).sqlstate).toBe('RB001');
    }
    const rows = await reservations(bot);
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    expect(rows).toHaveLength(3);
    expect(total).toBeLessThanOrEqual(cap + 1e-9);
  }, 60_000);

  it('a duplicate idempotency key cannot reserve twice', async () => {
    const bot = await createBot('dup', { capUsd: 5 });
    const visitor = await createSession(bot);
    const idemKey = randomUUID();
    const hash = requestHash({ message: 'same' });

    const first = await runs.beginRun(visitor, idemKey, hash);
    expect(first.kind).toBe('new');
    const runId = first.kind === 'new' ? first.runId : '';

    // The retry arrives while the first request is still running: 409, not a second run.
    const dup = (await failure(runs.beginRun(visitor, idemKey, hash))) as AppError;
    expect(dup).toBeInstanceOf(AppError);
    expect(dup.code).toBe('INVALID_REQUEST');
    expect(dup.httpStatus).toBe(409);

    // Reserving twice for the same run returns the same reservation and spends once.
    const r1 = await limits.reserve(bot, runId, 1, 300);
    const r2 = await limits.reserve(bot, runId, 1, 300);
    expect(r2).toBe(r1);
    const rows = await reservations(bot);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.amount)).toBe(1);

    // After the run finishes, the same key replays the stored outcome and starts nothing new.
    expect(await runs.finishRun(bot, runId, 'succeeded')).toBe(true);
    const replay = await runs.beginRun(visitor, idemKey, hash);
    expect(replay).toEqual({
      kind: 'replay',
      response: {
        request_id: runId,
        run_state: 'succeeded',
        conversation_id: null,
        message_id: null,
        status: null,
      },
    });
    expect(await reservations(bot)).toHaveLength(1);
  });

  it('concurrent starts with one key make exactly one run and one reservation', async () => {
    const bot = await createBot('dup-race', { capUsd: 5, concurrent: 5 });
    const visitor = await createSession(bot);
    const idemKey = randomUUID();
    const hash = requestHash({ message: 'race' });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => runs.beginRun(visitor, idemKey, hash)),
    );
    const fresh = results.filter((r) => r.status === 'fulfilled' && r.value.kind === 'new');
    expect(fresh).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect((r.reason as AppError).httpStatus).toBe(409);
    }
    const rows = (await svc(
      'GET',
      `/rest/v1/request_runs?bot_id=eq.${bot}&select=id`,
    )) as unknown[];
    expect(rows).toHaveLength(1);
  }, 30_000);

  it('settle moves a reservation to its actual amount and cannot be repeated', async () => {
    const bot = await createBot('settle');
    const runId = await newRun(await createSession(bot));
    const reservation = await limits.reserve(bot, runId, 1, 300);
    await limits.settle(bot, reservation, 0.25);
    const rows = await reservations(bot);
    expect(rows[0]).toMatchObject({ state: 'settled', amount: 0.25 });
    const again = await failure(limits.settle(bot, reservation, 0.25));
    expect((again as DbError).sqlstate).toBe('RB003');
    const rel = await failure(limits.release(bot, reservation));
    expect((rel as DbError).sqlstate).toBe('RB003');
  });

  it('release frees the reserved amount for the next request', async () => {
    const bot = await createBot('release', { capUsd: 1 });
    const a = await newRun(await createSession(bot));
    const b = await newRun(await createSession(bot));
    const res = await limits.reserve(bot, a, 0.8, 300);
    const over = await failure(limits.reserve(bot, b, 0.8, 300));
    expect((over as DbError).sqlstate).toBe('RB001');
    await limits.release(bot, res);
    await limits.reserve(bot, b, 0.8, 300);
  });

  it('a disabled bot cannot reserve (RB039)', async () => {
    const bot = await createBot('reserve-off', { capUsd: 5 });
    const runId = await newRun(await createSession(bot));
    await svc('PATCH', `/rest/v1/bot_profiles?id=eq.${bot}`, { enabled: false });
    const err = await failure(limits.reserve(bot, runId, 0.1, 60));
    expect((err as DbError).sqlstate).toBe('RB039');
  });
});

describe('request runs', () => {
  it('the same key with a different body is refused as INVALID_REQUEST 400', async () => {
    const bot = await createBot('mismatch');
    const visitor = await createSession(bot);
    const idemKey = randomUUID();
    await runs.beginRun(visitor, idemKey, requestHash({ message: 'one' }));
    const err = (await failure(
      runs.beginRun(visitor, idemKey, requestHash({ message: 'two' })),
    )) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('INVALID_REQUEST');
    expect(err.httpStatus).toBe(400);
  });

  it('a second request in the same session is RATE_LIMITED (429) while one is active', async () => {
    const bot = await createBot('concurrent', { concurrent: 1 });
    const visitor = await createSession(bot);
    await runs.beginRun(visitor, randomUUID(), requestHash({ n: 1 }));
    const err = (await failure(
      runs.beginRun(visitor, randomUUID(), requestHash({ n: 2 })),
    )) as AppError;
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.httpStatus).toBe(429);
  });

  it('a stale token version or another bot is refused by the database as UNAUTHORIZED', async () => {
    const bot = await createBot('stale');
    const other = await createBot('stale-other');
    const visitor = await createSession(bot);
    const idemKey = randomUUID();
    const hash = requestHash({ n: 1 });
    const stale = await failure(runs.beginRun({ ...visitor, token_version: 2 }, idemKey, hash));
    expect((stale as AppError).code).toBe('UNAUTHORIZED');
    const foreign = await failure(runs.beginRun({ ...visitor, bot_id: other }, idemKey, hash));
    expect((foreign as AppError).code).toBe('UNAUTHORIZED');
  });

  it('set_request_run_state is conditional', async () => {
    const bot = await createBot('state');
    const other = await createBot('state-other');
    const runId = await newRun(await createSession(bot));
    expect(await runState(runId)).toBe('reserved');

    // Another bot cannot move it.
    expect(await runs.markRunning(other, runId)).toBe(false);
    expect(await runState(runId)).toBe('reserved');

    expect(await runs.markRunning(bot, runId)).toBe(true);
    expect(await runState(runId)).toBe('running');
    // Already running: no change, false.
    expect(await runs.markRunning(bot, runId)).toBe(false);

    expect(await runs.finishRun(bot, runId, 'failed')).toBe(true);
    expect(await runState(runId)).toBe('failed');
    // A finished run never changes again, whatever is asked.
    expect(await runs.finishRun(bot, runId, 'succeeded')).toBe(false);
    expect(await runs.markRunning(bot, runId)).toBe(false);
    expect(await runState(runId)).toBe('failed');
  });

  it('two finishers race: exactly one wins', async () => {
    const bot = await createBot('state-race');
    const runId = await newRun(await createSession(bot));
    const results = await Promise.all([
      runs.finishRun(bot, runId, 'succeeded'),
      runs.finishRun(bot, runId, 'failed'),
      runs.finishRun(bot, runId, 'partial'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(['succeeded', 'failed', 'partial']).toContain(await runState(runId));
  });

  it('a disabled bot cannot start a run (RB039)', async () => {
    const bot = await createBot('run-off');
    const visitor = await createSession(bot);
    await svc('PATCH', `/rest/v1/bot_profiles?id=eq.${bot}`, { enabled: false });
    const err = await failure(runs.beginRun(visitor, randomUUID(), requestHash({ n: 1 })));
    expect((err as DbError).sqlstate).toBe('RB039');
  });
});
