// Real local DB scheduling/fencing; all transcript fields are synthetic.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createDb, type Db } from '../../worker/src/lib/db.ts';
import { getLocalStack, getLocalPrivilegedKey, keyHeaders } from './helpers/local-stack.ts';

const bot = randomUUID();
const worker = `schedule-${randomUUID()}`;
const jobs: string[] = [];
let url = '';
let key = '';
let db: Db;
async function svc(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    signal: AbortSignal.timeout(10_000),
    headers: {
      ...keyHeaders(key),
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`local schedule fixture failed: ${response.status}`);
  const text = await response.text();
  return text ? (JSON.parse(text) as unknown) : null;
}
async function enqueue(conversation: string, delay = 0) {
  const id = await db.rpc<string>('queue_analysis_job', {
    p_bot_id: bot,
    p_conversation_id: conversation,
    p_debounce_seconds: delay,
  });
  if (!jobs.includes(id)) jobs.push(id);
  return id;
}
async function newWork() {
  const conversation = randomUUID();
  await svc('POST', 'conversations', { id: conversation, bot_id: bot });
  await addMessage(conversation);
  return { conversation, id: await enqueue(conversation) };
}
async function addMessage(conversation: string) {
  await svc('POST', 'messages', {
    conversation_id: conversation,
    role: 'user',
    status: 'complete',
    content: `FAKE turn ${randomUUID()}`,
  });
}
async function claim(id: string, generation = 1, owner = worker) {
  await svc('PATCH', `jobs?id=eq.${id}`, {
    state: 'running',
    attempts: generation,
    locked_by: owner,
    locked_until: new Date(Date.now() + 600_000).toISOString(),
  });
}
const fence = (id: string, generation = 1, owner = worker) => ({
  p_job_id: id,
  p_worker: owner,
  p_generation: generation,
});
async function context(id: string, generation = 1, owner = worker) {
  return db.rpc<{ messages: unknown[] }>('get_analysis_job_context', fence(id, generation, owner));
}
async function complete(id: string, owner = worker) {
  await db.rpc('complete_job', { p_job_id: id, p_worker: owner });
}
async function row(id: string) {
  const rows = (await svc(
    'GET',
    `jobs?id=eq.${id}&select=state,attempts,analysis_generation,available_at,locked_by,completed_at`,
  )) as Record<string, unknown>[];
  return rows[0]!;
}
beforeAll(async () => {
  url = getLocalStack().apiUrl;
  key = getLocalPrivilegedKey();
  db = createDb({ url, secretKey: key, timeoutMs: 10_000 });
  await svc('POST', 'bot_profiles', {
    id: bot,
    slug: `schedule-${bot}`,
    identity_prompt: 'FAKE identity',
    tone: 'neutral',
    scope: 'FAKE scope',
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
}, 240_000);
afterEach(async () => {
  for (const id of jobs.splice(0)) await svc('DELETE', `jobs?id=eq.${id}`);
  if (url && key) await svc('DELETE', `conversations?bot_id=eq.${bot}`);
}, 30_000);
afterAll(async () => {
  if (url && key) await svc('DELETE', `bot_profiles?id=eq.${bot}`);
}, 30_000);

it('queues successor work for messages committed after the context snapshot', async () => {
  const { id, conversation } = await newWork();
  await claim(id);
  expect((await context(id)).messages).toHaveLength(1);
  await addMessage(conversation);
  expect(await enqueue(conversation)).toBe(id);
  await complete(id);
  expect(await row(id)).toMatchObject({
    state: 'queued',
    attempts: 0,
    locked_by: null,
    completed_at: null,
  });
  await claim(id);
  expect((await context(id, 2)).messages).toHaveLength(2);
  await complete(id);
  expect((await row(id))['state']).toBe('succeeded');
});

it('coalesces several newer requests and preserves the latest debounce deadline', async () => {
  const { id, conversation } = await newWork();
  await claim(id);
  await context(id);
  await enqueue(conversation, 3);
  await enqueue(conversation, 30);
  const deadline = (await row(id))['available_at'];
  await complete(id);
  expect(await row(id)).toMatchObject({ state: 'queued', attempts: 0, available_at: deadline });
  const live = (await svc(
    'GET',
    `jobs?dedupe_key=eq.analyze_conversation:${conversation}&state=in.(queued,running)&select=id`,
  )) as unknown[];
  expect(live).toHaveLength(1);
});

it('a reclaimed generation covers newer requests without a redundant successor', async () => {
  const { id, conversation } = await newWork();
  await claim(id);
  await context(id);
  await addMessage(conversation);
  await enqueue(conversation);
  const nextWorker = `${worker}-next`;
  await claim(id, 2, nextWorker);
  expect((await context(id, 2, nextWorker)).messages).toHaveLength(2);
  await expect(context(id)).rejects.toMatchObject({ sqlstate: 'RB013' });
  await complete(id, nextWorker);
  expect((await row(id))['state']).toBe('succeeded');
});

it('an exhausted failure only schedules successor work if newer requests exist', async () => {
  const first = await newWork();
  await svc('PATCH', `jobs?id=eq.${first.id}`, { max_attempts: 1 });
  await claim(first.id);
  await context(first.id);
  await db.rpc('fail_job', { p_job_id: first.id, p_worker: worker, p_error: 'fake_failure' });
  expect((await row(first.id))['state']).toBe('failed');
  const second = await newWork();
  await svc('PATCH', `jobs?id=eq.${second.id}`, { max_attempts: 1 });
  await claim(second.id);
  await context(second.id);
  await enqueue(second.conversation);
  await db.rpc('fail_job', { p_job_id: second.id, p_worker: worker, p_error: 'fake_failure' });
  expect(await row(second.id)).toMatchObject({ state: 'queued', attempts: 0 });
});

it('enqueue after completion and enqueue racing completion both leave exactly one live job', async () => {
  for (const concurrent of [false, true]) {
    const { id, conversation } = await newWork();
    await claim(id);
    await context(id);
    await addMessage(conversation);
    if (concurrent) await Promise.all([complete(id), enqueue(conversation)]);
    else {
      await complete(id);
      await enqueue(conversation);
    }
    const live = (await svc(
      'GET',
      `jobs?dedupe_key=eq.analyze_conversation:${conversation}&state=in.(queued,running)&select=id`,
    )) as unknown[];
    expect(live).toHaveLength(1);
  }
});

it('a deleted conversation does not create successor work', async () => {
  const { id, conversation } = await newWork();
  await claim(id);
  await context(id);
  await enqueue(conversation);
  await svc('DELETE', `conversations?id=eq.${conversation}`);
  await complete(id);
  expect((await row(id))['state']).toBe('succeeded');
});

it('actual claim expiry recovers newer work but dead-letters covered exhausted work', async () => {
  const { id, conversation } = await newWork();
  await svc('PATCH', `jobs?id=eq.${id}`, { max_attempts: 1 });
  const claimJobs = () =>
    db.rpc<{ id: string; analysis_generation: number }[]>('claim_jobs', {
      p_worker: worker,
      p_limit: 100,
      p_lease_seconds: 60,
      p_types: ['analyze_conversation'],
    });
  expect((await claimJobs()).some((item) => item.id === id)).toBe(true);
  await context(id);
  await addMessage(conversation);
  await enqueue(conversation);
  await svc('PATCH', `jobs?id=eq.${id}`, { locked_until: new Date(0).toISOString() });
  expect((await claimJobs()).find((item) => item.id === id)?.analysis_generation).toBe(2);
  expect((await context(id, 2)).messages).toHaveLength(2);
  await svc('PATCH', `jobs?id=eq.${id}`, { locked_until: new Date(0).toISOString() });
  expect((await claimJobs()).some((item) => item.id === id)).toBe(false);
  expect((await row(id))['state']).toBe('failed');
});

it('newer requests are retained even if the earlier generation never obtained context', async () => {
  const { id, conversation } = await newWork();
  await claim(id);
  await enqueue(conversation);
  await complete(id);
  expect(await row(id)).toMatchObject({ state: 'queued', attempts: 0 });
});

it('unrelated job types retain their existing terminal behavior', async () => {
  const id = randomUUID();
  jobs.push(id);
  await svc('POST', 'jobs', {
    id,
    type: 'cleanup',
    payload: {},
    state: 'running',
    attempts: 1,
    max_attempts: 1,
    locked_by: worker,
    locked_until: new Date(Date.now() + 60_000).toISOString(),
  });
  await complete(id);
  expect(await row(id)).toMatchObject({ state: 'succeeded', attempts: 1 });
});

it('late usage after successor claim stays attached to the original reservation', async () => {
  const { id, conversation } = await newWork();
  await claim(id);
  await context(id);
  const reserve = (generation: number) =>
    db.rpc<string>('reserve_analysis_budget', {
      ...fence(id, generation),
      p_amount: 0.1,
      p_ttl_seconds: 600,
    });
  const first = await reserve(1);
  await enqueue(conversation);
  await complete(id);
  await claim(id);
  await context(id, 2);
  const second = await reserve(2);
  expect(second === first).toBe(false);
  const usage = (generation: number, reservation: string, cost: number) =>
    db.rpc('record_analysis_usage', {
      p_job_id: id,
      p_generation: generation,
      p_reservation_id: reservation,
      p_provider: 'gemini',
      p_model: 'fake-analysis',
      p_input_tokens: 10,
      p_output_tokens: 2,
      p_estimated_cost: cost,
      p_latency_ms: 1,
    });
  await usage(1, first, 0.02);
  await usage(2, second, 0.03);
  await db.rpc('settle_analysis_budget', {
    ...fence(id, 2),
    p_reservation_id: second,
    p_actual: 0.03,
  });
  const reservations = (await svc(
    'GET',
    `budget_reservations?job_id=eq.${id}&select=id,amount,state`,
  )) as { id: string; amount: number; state: string }[];
  expect(reservations).toHaveLength(2);
  expect(reservations.every((entry) => entry.state === 'settled')).toBe(true);
  // Unknown prior spend retains its conservative floor (018); late reporting
  // may increase that floor, never erase it. Recorded usage is still exact.
  expect(Number(reservations.find((entry) => entry.id === first)?.amount)).toBe(0.1);
  expect(Number(reservations.find((entry) => entry.id === second)?.amount)).toBe(0.03);
  expect(reservations.reduce((sum, entry) => sum + Number(entry.amount), 0)).toBeCloseTo(0.13);
  const recorded = (await svc(
    'GET',
    `usage_events?job_id=eq.${id}&select=budget_reservation_id,estimated_cost`,
  )) as { budget_reservation_id: string; estimated_cost: number }[];
  expect(recorded).toHaveLength(2);
  expect(
    Number(recorded.find((entry) => entry.budget_reservation_id === first)?.estimated_cost),
  ).toBe(0.02);
  expect(
    Number(recorded.find((entry) => entry.budget_reservation_id === second)?.estimated_cost),
  ).toBe(0.03);
});
