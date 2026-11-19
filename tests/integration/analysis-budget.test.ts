import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAnalyzeConversationHandler } from '../../worker/src/jobs/analyze-conversation.ts';
import { createDb, type Db } from '../../worker/src/lib/db.ts';
import type { WorkerConfig } from '../../worker/src/lib/config.ts';
import { silentLogger } from '../../worker/src/lib/logger.ts';
import { FakeChatProvider } from '../helpers/fake-ai.ts';
import { getLocalStack, getLocalPrivilegedKey, keyHeaders } from './helpers/local-stack.ts';

// Real LOCAL PostgREST/database; only the AI provider is a labelled fake.
const bot = randomUUID();
const conversation = randomUUID();
const owner = `analysis-${randomUUID()}`;
const jobs: string[] = [];
let url: string;
let key: string;
let db: Db;
async function svc(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    signal: AbortSignal.timeout(10_000),
    method,
    headers: {
      ...keyHeaders(key),
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`local test setup failed: ${response.status}`);
  const text = await response.text();
  return text ? (JSON.parse(text) as unknown) : null;
}
async function job(target = conversation): Promise<string> {
  const id = randomUUID();
  jobs.push(id);
  await svc('POST', 'jobs', {
    id,
    type: 'analyze_conversation',
    dedupe_key: `test-${id}`,
    payload: { bot_id: bot, conversation_id: target },
    max_attempts: 5,
    state: 'running',
    attempts: 1,
    analysis_generation: 1,
    locked_by: owner,
    locked_until: new Date(Date.now() + 600_000).toISOString(),
  });
  return id;
}
const fence = (id: string, attempt = 1, worker = owner) => ({
  p_job_id: id,
  p_worker: worker,
  p_generation: attempt,
});
async function reserve(id: string, amount = 0.1, attempt = 1): Promise<string> {
  return db.rpc<string>('reserve_analysis_budget', {
    ...fence(id, attempt),
    p_amount: amount,
    p_ttl_seconds: 3600,
  });
}
async function usage(id: string, reservation: string, cost: number, attempt = 1): Promise<void> {
  await db.rpc('record_analysis_usage', {
    p_job_id: id,
    p_generation: attempt,
    p_reservation_id: reservation,
    p_provider: 'gemini',
    p_model: 'fake-analysis',
    p_input_tokens: 100,
    p_output_tokens: 20,
    p_estimated_cost: cost,
    p_latency_ms: 1,
  });
}
async function row(id: string): Promise<{ amount: number; state: string }> {
  const rows = (await svc('GET', `budget_reservations?id=eq.${id}&select=amount,state`)) as {
    amount: number;
    state: string;
  }[];
  return rows[0]!;
}
beforeAll(async () => {
  url = getLocalStack().apiUrl;
  key = getLocalPrivilegedKey();
  db = createDb({ url, secretKey: key, timeoutMs: 10_000 });
  await svc('POST', 'bot_profiles', {
    id: bot,
    slug: `analysis-${bot}`,
    identity_prompt: 'FAKE test identity',
    tone: 'neutral',
    scope: 'FAKE test scope',
    allowed_languages: ['en'],
    embedding_model: 'fake',
    embedding_dimensions: 1536,
  });
  await svc('POST', 'client_settings', {
    bot_id: bot,
    allowed_origins: [],
    rate_policy: {},
    budget_policy: { daily_cap_usd: 10 },
    retention_policy: { conversation_days: 90, usage_months: 13 },
    upload_policy: {},
    handoff_policy: {},
    cache_policy: {},
    feature_flags: {},
  });
  await svc('POST', 'conversations', { id: conversation, bot_id: bot });
  await svc('POST', 'messages', {
    conversation_id: conversation,
    role: 'user',
    content: 'FAKE evaluation input',
    status: 'complete',
  });
}, 240_000);
afterAll(async () => {
  if (!url || !key) return;
  for (const id of jobs) await svc('DELETE', `jobs?id=eq.${id}`);
  await svc('DELETE', `bot_profiles?id=eq.${bot}`);
}, 30_000);

it('runs the real analysis RPC lifecycle and persists versioned output and usage', async () => {
  const id = await job();
  const provider = new FakeChatProvider([
    {
      chunks: [
        JSON.stringify({ summary: 'FAKE summary', sentiment: 'neutral', intent: 'FAKE intent' }),
      ],
      usage: { inputTokens: 400, outputTokens: 40 },
    },
  ]);
  await createAnalyzeConversationHandler({ chat: provider })(
    {
      id,
      type: 'analyze_conversation',
      payload: { bot_id: bot, conversation_id: conversation },
      attempts: 1,
      maxAttempts: 5,
      analysisGeneration: 1,
    },
    {
      db,
      config: {
        analysisPriceInputPerMillionTokens: 0.1,
        analysisPriceOutputPerMillionTokens: 0.4,
      } as WorkerConfig,
      storage: {} as never,
      workerId: owner,
      signal: new AbortController().signal,
      heartbeat: async () => {},
      log: silentLogger,
    },
  );
  expect(provider.calls).toBe(1);
  const output = (await svc(
    'GET',
    `conversation_analysis?conversation_id=eq.${conversation}&select=status,analysis_version`,
  )) as Record<string, unknown>[];
  expect(output[0]).toMatchObject({ status: 'complete', analysis_version: 'rag-analysis-v1' });
  const reservations = (await svc(
    'GET',
    `budget_reservations?job_id=eq.${id}&select=state,amount`,
  )) as Record<string, unknown>[];
  expect(reservations).toHaveLength(1);
  expect(reservations[0]?.state).toBe('settled');
  const events = (await svc(
    'GET',
    `usage_events?job_id=eq.${id}&select=operation,output_tokens`,
  )) as Record<string, unknown>[];
  expect(events).toEqual([{ operation: 'analysis', output_tokens: 40 }]);
}, 30_000);

it('refuses stale workers, exceeded cap and duplicate spend', async () => {
  const id = await job();
  await expect(
    db.rpc('reserve_analysis_budget', {
      ...fence(id, 1, 'other'),
      p_amount: 0.1,
      p_ttl_seconds: 3600,
    }),
  ).rejects.toMatchObject({ sqlstate: 'RB013' });
  await expect(reserve(id, 100)).rejects.toMatchObject({ sqlstate: 'RB001' });
  const reservation = await reserve(id);
  expect(await reserve(id)).toBe(reservation);
  await usage(id, reservation, 0.02);
  await usage(id, reservation, 0.02);
  await db.rpc('settle_analysis_budget', {
    ...fence(id),
    p_reservation_id: reservation,
    p_actual: 0.02,
  });
  expect(await row(reservation)).toMatchObject({ state: 'settled', amount: 0.02 });
  const events = (await svc(
    'GET',
    `usage_events?budget_reservation_id=eq.${reservation}&select=id`,
  )) as unknown[];
  expect(events).toHaveLength(1);
  await expect(reserve(id)).rejects.toMatchObject({ sqlstate: 'RB003' });
});

it('keeps retry and delayed stale-attempt usage in the original reservation', async () => {
  const id = await job();
  const first = await reserve(id);
  await svc('PATCH', `jobs?id=eq.${id}`, { attempts: 2 });
  const second = await reserve(id, 0.1, 2);
  expect((await row(first)).amount).toBe(0.1); // unknown spend fails closed
  await usage(id, first, 0.2);
  expect((await row(first)).amount).toBe(0.2);
  await expect(
    db.rpc('settle_analysis_budget', { ...fence(id), p_reservation_id: first, p_actual: 0 }),
  ).rejects.toMatchObject({ sqlstate: 'RB013' });
  await expect(
    db.rpc('save_analysis_job_result', {
      ...fence(id),
      p_summary: 'FAKE stale',
      p_sentiment: 'neutral',
      p_intent: 'FAKE',
      p_analysis_version: 'test',
    }),
  ).rejects.toMatchObject({ sqlstate: 'RB013' });
  await expect(db.rpc('fail_analysis_job', fence(id))).rejects.toMatchObject({ sqlstate: 'RB013' });
  await usage(id, second, 0.03, 2);
  await svc('PATCH', `jobs?id=eq.${id}`, { state: 'failed', locked_by: null, locked_until: null });
  await db.rpc('settle_orphaned_analysis_reservations', { p_batch: 100 });
  expect(await row(second)).toMatchObject({ state: 'settled', amount: 0.03 });
});

it('index orphan sweep does not zero an analysis reservation', async () => {
  const id = await job();
  const reservation = await reserve(id);
  await svc('PATCH', `jobs?id=eq.${id}`, { state: 'failed', locked_by: null, locked_until: null });
  await db.rpc('settle_orphaned_index_reservations', { p_batch: 100 });
  expect(await row(reservation)).toMatchObject({ state: 'reserved', amount: 0.1 });
  await db.rpc('settle_orphaned_analysis_reservations', { p_batch: 100 });
  expect(await row(reservation)).toMatchObject({ state: 'settled', amount: 0.1 });
});

it('uses a fresh generation after shutdown handback even when the attempt is refunded', async () => {
  const id = await job();
  const first = await reserve(id);
  await usage(id, first, 0.02);
  await db.rpc('release_job_lease', { p_job_id: id, p_worker: owner });
  const claimed = await db.rpc<{ id: string; attempts: number; analysis_generation: number }[]>(
    'claim_jobs',
    {
      p_worker: owner,
      p_limit: 1,
      p_lease_seconds: 600,
      p_types: ['analyze_conversation'],
    },
  );
  expect(claimed[0]).toMatchObject({ id, attempts: 1, analysis_generation: 2 });
  const second = await reserve(id, 0.1, 2);
  expect(second).not.toBe(first);
  await usage(id, second, 0.03, 2);
  await db.rpc('settle_analysis_budget', {
    ...fence(id, 2),
    p_reservation_id: second,
    p_actual: 0.03,
  });
  expect((await row(first)).amount + (await row(second)).amount).toBeCloseTo(0.05);
  await expect(reserve(id)).rejects.toMatchObject({ sqlstate: 'RB013' });
});

it('serializes reservations competing for the last budget balance', async () => {
  const rows = (await svc('GET', `budget_reservations?bot_id=eq.${bot}&select=state,amount`)) as {
    state: string;
    amount: number;
  }[];
  const spent = rows
    .filter((r) => r.state !== 'released')
    .reduce((sum, r) => sum + Number(r.amount), 0);
  await svc('PATCH', `client_settings?bot_id=eq.${bot}`, {
    budget_policy: { daily_cap_usd: Number((spent + 0.15).toFixed(6)) },
  });
  try {
    const a = await job();
    const b = await job();
    const results = await Promise.allSettled([reserve(a), reserve(b)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const denied = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(denied.reason).toMatchObject({ sqlstate: 'RB001' });
  } finally {
    await svc('PATCH', `client_settings?bot_id=eq.${bot}`, {
      budget_policy: { daily_cap_usd: 10 },
    });
  }
});

it('rejects expired leases, foreign conversation ownership and missing budget policies', async () => {
  const id = await job();
  await svc('PATCH', `jobs?id=eq.${id}`, { locked_until: new Date(0).toISOString() });
  await expect(reserve(id)).rejects.toMatchObject({ sqlstate: 'RB013' });
  await svc('PATCH', `jobs?id=eq.${id}`, {
    locked_until: new Date(Date.now() + 600_000).toISOString(),
    payload: { bot_id: randomUUID(), conversation_id: conversation },
  });
  await expect(reserve(id)).rejects.toMatchObject({ sqlstate: 'RB037' });
  await svc('PATCH', `jobs?id=eq.${id}`, {
    payload: { bot_id: bot, conversation_id: conversation },
  });
  await svc('PATCH', `client_settings?bot_id=eq.${bot}`, { budget_policy: {} });
  try {
    await expect(reserve(id)).rejects.toMatchObject({ sqlstate: 'RB002' });
  } finally {
    await svc('PATCH', `client_settings?bot_id=eq.${bot}`, {
      budget_policy: { daily_cap_usd: 10 },
    });
  }
});

it('preserves spend when the conversation is deleted during generation', async () => {
  const target = randomUUID();
  await svc('POST', 'conversations', { id: target, bot_id: bot });
  await svc('POST', 'messages', {
    conversation_id: target,
    role: 'user',
    content: 'FAKE deletion scenario',
    status: 'complete',
  });
  const id = await job(target);
  const provider = {
    provider: 'gemini' as const,
    model: 'fake-deletion',
    async *stream() {
      await svc('DELETE', `conversations?id=eq.${target}`);
      yield {
        text: JSON.stringify({ summary: 'FAKE result', sentiment: 'neutral', intent: 'FAKE' }),
      };
      return { inputTokens: 100, outputTokens: 20 };
    },
  };
  await createAnalyzeConversationHandler({ chat: provider })(
    {
      id,
      type: 'analyze_conversation',
      payload: { bot_id: bot, conversation_id: target },
      attempts: 1,
      maxAttempts: 5,
      analysisGeneration: 1,
    },
    {
      db,
      config: {
        analysisPriceInputPerMillionTokens: 0.1,
        analysisPriceOutputPerMillionTokens: 0.4,
      } as WorkerConfig,
      storage: {} as never,
      workerId: owner,
      signal: new AbortController().signal,
      heartbeat: async () => {},
      log: silentLogger,
    },
  );
  await svc('PATCH', `jobs?id=eq.${id}`, {
    state: 'succeeded',
    locked_by: null,
    locked_until: null,
  });
  await db.rpc('settle_orphaned_analysis_reservations', { p_batch: 100 });
  const rows = (await svc('GET', `budget_reservations?job_id=eq.${id}&select=state,amount`)) as {
    state: string;
    amount: number;
  }[];
  expect(rows[0]).toMatchObject({ state: 'settled' });
  expect(Number(rows[0]?.amount)).toBeGreaterThan(0);
});
