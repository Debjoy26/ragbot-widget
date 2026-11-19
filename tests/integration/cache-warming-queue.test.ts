// Actual LOCAL queue, context and claim fences. Synthetic fixtures, no providers.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb, type Db } from '../../worker/src/lib/db.ts';
import { getLocalStack, getLocalPrivilegedKey, keyHeaders } from './helpers/local-stack.ts';
const bots = {
  corpus: randomUUID(),
  disabled: randomUUID(),
  fence: randomUUID(),
  dedupe: randomUUID(),
  settings: randomUUID(),
  superseded: randomUUID(),
  expired: randomUUID(),
  questions: randomUUID(),
};
const warmPolicy = { warm_enabled: true, warm_max_attempts: 3, c7: true };
const worker = `warm-${randomUUID()}`;
let url = '';
let key = '';
let db: Db;
async function svc(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: {
      ...keyHeaders(key),
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw Error(`local warm fixture failed: ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function jobs(botId: string) {
  return (await svc(
    'GET',
    `jobs?type=eq.warm_answer_cache&payload->>bot_id=eq.${botId}&order=created_at.asc`,
  )) as { id: string; payload: Record<string, unknown>; state: string; warm_generation: number }[];
}
interface BotState {
  enabled: boolean;
  corpus_version: number;
  settings_version: number;
}
async function botState(botId: string): Promise<BotState> {
  const rows = (await svc(
    'GET',
    `bot_profiles?id=eq.${botId}&select=enabled,corpus_version,settings_version`,
  )) as BotState[];
  expect(rows).toHaveLength(1);
  return rows[0]!;
}
async function createBotFixture(botId: string, enabled: boolean) {
  await svc('POST', 'bot_profiles', {
    id: botId,
    slug: `warm-${botId}`,
    enabled,
    identity_prompt: 'FAKE identity',
    tone: 'neutral',
    scope: 'FAKE scope',
    allowed_languages: ['en'],
    embedding_model: 'fake',
    embedding_dimensions: 1536,
  });
  await svc('POST', 'client_settings', {
    bot_id: botId,
    allowed_origins: [],
    rate_policy: {},
    budget_policy: { daily_cap_usd: 1 },
    retention_policy: { conversation_days: 90, usage_months: 13 },
    upload_policy: {},
    handoff_policy: {},
    cache_policy: warmPolicy,
    feature_flags: {},
  });
  await svc('POST', 'public_bot_config', {
    bot_id: botId,
    bot_slug: `warm-${botId}`,
    display_name: 'FAKE warm bot',
    greeting: 'FAKE greeting',
    suggested_questions: ['FAKE question'],
    primary_color: '#3155D9',
    position: 'bottom-right',
    supported_languages: ['en'],
    escalation_label: 'Contact',
    escalation_messages: { en: 'FAKE help' },
    contact_email: 'help@example.com',
  });
}
async function enqueue(botId: string): Promise<string> {
  const id = await db.rpc<string>('queue_warm_job', { p_bot_id: botId });
  expect(typeof id).toBe('string');
  return id;
}
async function claim(id: string) {
  await svc('PATCH', `jobs?id=eq.${id}`, {
    state: 'running',
    attempts: 1,
    locked_by: worker,
    locked_until: new Date(Date.now() + 600000).toISOString(),
  });
}
beforeAll(async () => {
  url = getLocalStack().apiUrl;
  key = getLocalPrivilegedKey();
  db = createDb({ url, secretKey: key, timeoutMs: 10000 });
  for (const [name, id] of Object.entries(bots)) {
    await createBotFixture(id, name !== 'disabled');
  }
}, 240000);
afterAll(async () => {
  if (url && key) {
    for (const botId of Object.values(bots)) {
      await svc('DELETE', `jobs?type=eq.warm_answer_cache&payload->>bot_id=eq.${botId}`);
      await svc('DELETE', `bot_profiles?id=eq.${botId}`);
    }
  }
}, 30000);

it('queues versioned warming automatically after a corpus change', async () => {
  const bot = bots.corpus;
  const before = await botState(bot);
  expect(before.enabled).toBe(true);
  const settings = (await svc('GET', `client_settings?bot_id=eq.${bot}&select=cache_policy`)) as {
    cache_policy: Record<string, unknown>;
  }[];
  expect(settings).toHaveLength(1);
  expect(settings[0]?.cache_policy).toMatchObject({
    warm_enabled: true,
    warm_max_attempts: 3,
    c7: true,
  });
  const nextCorpus = before.corpus_version + 1;
  await svc('PATCH', `bot_profiles?id=eq.${bot}`, { corpus_version: nextCorpus });
  const after = await botState(bot);
  expect(after.enabled).toBe(true);
  expect(after.corpus_version).toBe(nextCorpus);
  const queued = await jobs(bot);
  expect(queued).toHaveLength(1);
  expect(queued[0]?.payload).toMatchObject({
    bot_id: bot,
    corpus_version: after.corpus_version,
    settings_version: after.settings_version,
  });
  expect(queued[0]?.state).toBe('queued');
});

it('does not queue warming for a disabled bot with an otherwise enabled policy', async () => {
  const disabledBot = bots.disabled;
  const before = await botState(disabledBot);
  expect(before.enabled).toBe(false);
  expect(await jobs(disabledBot)).toHaveLength(0);
  const nextCorpus = before.corpus_version + 1;
  await svc('PATCH', `bot_profiles?id=eq.${disabledBot}`, { corpus_version: nextCorpus });
  expect(await botState(disabledBot)).toMatchObject({
    enabled: false,
    corpus_version: nextCorpus,
  });
  expect(await jobs(disabledBot)).toHaveLength(0);
});

it('fences context and preserves each generation across refundable attempts', async () => {
  const bot = bots.fence;
  const id = await enqueue(bot);
  await claim(id);
  const first = (await jobs(bot))[0]!;
  expect(first.warm_generation).toBe(1);
  const args = { p_job_id: id, p_worker: worker, p_generation: 1 };
  expect(await db.rpc('get_warm_job_context', args)).toMatchObject({
    state: 'ready',
    questions: ['FAKE question'],
  });
  await expect(
    db.rpc('get_warm_job_context', { ...args, p_worker: 'wrong' }),
  ).rejects.toMatchObject({ sqlstate: 'RB013' });
  await svc('PATCH', `jobs?id=eq.${id}`, {
    state: 'queued',
    attempts: 0,
    locked_by: null,
    locked_until: null,
  });
  await claim(id);
  expect((await jobs(bot))[0]!.warm_generation).toBe(2);
  await expect(db.rpc('get_warm_job_context', args)).rejects.toMatchObject({ sqlstate: 'RB013' });
});

it('deduplicates the same versions even after terminal completion', async () => {
  const id = await enqueue(bots.dedupe);
  expect(await enqueue(bots.dedupe)).toBe(id);
  await claim(id);
  await db.rpc('complete_job', { p_job_id: id, p_worker: worker });
  expect(await enqueue(bots.dedupe)).toBe(id);
  const rows = await jobs(bots.dedupe);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe('succeeded');
});

it('queues the actual derived settings version through the service API', async () => {
  const before = await botState(bots.settings);
  await svc('PATCH', `bot_profiles?id=eq.${bots.settings}`, { tone: 'FAKE updated tone' });
  const after = await botState(bots.settings);
  expect(after.settings_version).toBeGreaterThan(before.settings_version);
  const rows = await jobs(bots.settings);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.payload).toMatchObject({
    bot_id: bots.settings,
    corpus_version: after.corpus_version,
    settings_version: after.settings_version,
  });
});

it('supersedes old context when a newer corpus is queued', async () => {
  const id = await enqueue(bots.superseded);
  await claim(id);
  const before = await botState(bots.superseded);
  await svc('PATCH', `bot_profiles?id=eq.${bots.superseded}`, {
    corpus_version: before.corpus_version + 1,
  });
  expect(
    await db.rpc('get_warm_job_context', {
      p_job_id: id,
      p_worker: worker,
      p_generation: 1,
    }),
  ).toEqual({ state: 'superseded' });
  const rows = await jobs(bots.superseded);
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.id !== id)?.payload).toMatchObject({
    bot_id: bots.superseded,
    corpus_version: before.corpus_version + 1,
  });
});

it('rejects context reads after the lease expires', async () => {
  const id = await enqueue(bots.expired);
  await claim(id);
  await svc('PATCH', `jobs?id=eq.${id}`, {
    locked_until: new Date(Date.now() - 1000).toISOString(),
  });
  await expect(
    db.rpc('get_warm_job_context', {
      p_job_id: id,
      p_worker: worker,
      p_generation: 1,
    }),
  ).rejects.toMatchObject({ sqlstate: 'RB013' });
});

it('loads public questions, operator FAQs and default-language cache identity', async () => {
  await svc('PATCH', `client_settings?bot_id=eq.${bots.questions}`, {
    cache_policy: { ...warmPolicy, warm_questions: ['FAKE FAQ'] },
  });
  const id = await enqueue(bots.questions);
  await claim(id);
  expect(
    await db.rpc('get_warm_job_context', {
      p_job_id: id,
      p_worker: worker,
      p_generation: 1,
    }),
  ).toMatchObject({
    state: 'ready',
    questions: ['FAKE question', 'FAKE FAQ'],
    languages: ['', 'en'],
  });
});
