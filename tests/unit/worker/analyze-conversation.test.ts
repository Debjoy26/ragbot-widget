import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '@ragbot/shared';
import { createAnalyzeConversationHandler } from '../../../worker/src/jobs/analyze-conversation.ts';
import type { WorkerConfig } from '../../../worker/src/lib/config.ts';
import { DbError, type Db } from '../../../worker/src/lib/db.ts';
import { createLogger } from '../../../worker/src/lib/logger.ts';
import type { JobContext } from '../../../worker/src/runtime.ts';
import { FakeChatProvider, type FakeChatScript } from '../../helpers/fake-ai.ts';

// P9-T2: the analyze_conversation handler against a labelled FAKE database and
// a scripted FAKE chat provider. No network. Message content never reaches logs.

const BOT_ID = randomUUID();
const CONVERSATION_ID = randomUUID();
const JOB_ID = randomUUID();

const ANALYSIS_JSON =
  '{"summary": "Visitor asked about pricing and was answered.", "sentiment": "neutral", "intent": "pricing question"}';

function contextRpc(messages: unknown[] = []) {
  return {
    bot: {
      identity_prompt: 'You help visitors.',
      tone: 'friendly',
      scope: 'Acme products',
      allowed_languages: ['en'],
    },
    messages,
  };
}

const message = (role: string, content: string) => ({ role, content });

interface Rig {
  calls: { name: string; args: Record<string, unknown> }[];
  logs: string[];
  responders: Record<string, (args: Record<string, unknown>, n: number) => unknown>;
  controller: AbortController;
  ctx: JobContext;
  provider: FakeChatProvider;
}

function makeRig(scripts: readonly FakeChatScript[], responders: Rig['responders'] = {}): Rig {
  const calls: Rig['calls'] = [];
  const logs: string[] = [];
  const counts: Record<string, number> = {};
  const defaults: Rig['responders'] = {
    get_analysis_context: () =>
      contextRpc([message('user', 'How much?'), message('assistant', 'Ten dollars.')]),
    reserve_index_budget: () => 'reservation-1',
    record_usage_event: () => null,
    settle_index_budget: () => null,
    release_index_budget: () => null,
    save_conversation_analysis: () => null,
    fail_conversation_analysis: () => null,
  };
  const all = { ...defaults, ...responders };
  const provider = new FakeChatProvider(scripts, {
    provider: 'gemini',
    model: 'fake-analysis-model',
  });
  const db: Db = {
    rpc: (name: string, args: Readonly<Record<string, unknown>>) => {
      calls.push({ name, args: { ...args } });
      counts[name] = (counts[name] ?? 0) + 1;
      const responder = all[name];
      if (responder === undefined) return Promise.reject(new Error(`unexpected rpc ${name}`));
      try {
        return Promise.resolve(responder(args, counts[name] ?? 0) as never);
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };
  const controller = new AbortController();
  const ctx: JobContext = {
    db,
    storage: {
      download: () => Promise.reject(new Error('not used')),
      remove: () => Promise.reject(new Error('not used')),
    },
    config: {
      analysisPriceInputPerMillionTokens: 0.1,
      analysisPriceOutputPerMillionTokens: 0.4,
    } as unknown as WorkerConfig,
    signal: controller.signal,
    workerId: 'w-test',
    heartbeat: () => Promise.resolve(),
    log: createLogger({
      level: 'debug',
      sink: (l) => {
        logs.push(l);
      },
    }),
  };
  return { calls, logs, responders: all, controller, ctx, provider };
}

const jobFor = (payload: Record<string, unknown>) => ({
  id: JOB_ID,
  type: 'analyze_conversation',
  payload,
  attempts: 1,
  maxAttempts: 5,
});

const run = (
  rig: Rig,
  payload: Record<string, unknown> = { bot_id: BOT_ID, conversation_id: CONVERSATION_ID },
) => createAnalyzeConversationHandler({ chat: rig.provider })(jobFor(payload), rig.ctx);

const calledWith = (rig: Rig, name: string) =>
  rig.calls.filter((c) => c.name === name).map((c) => c.args);

describe('analyze_conversation handler', () => {
  it('analyzes bounded recent messages and saves the result with usage settled', async () => {
    const rig = makeRig([
      { chunks: [ANALYSIS_JSON], usage: { inputTokens: 400, outputTokens: 40 } },
    ]);
    await run(rig);
    expect(rig.provider.calls).toBe(1);
    expect(calledWith(rig, 'save_conversation_analysis')).toHaveLength(1);
    expect(calledWith(rig, 'save_conversation_analysis')[0]).toMatchObject({
      p_conversation_id: CONVERSATION_ID,
      p_summary: 'Visitor asked about pricing and was answered.',
      p_sentiment: 'neutral',
      p_intent: 'pricing question',
    });
    expect(calledWith(rig, 'fail_conversation_analysis')).toHaveLength(0);
    const usage = calledWith(rig, 'record_usage_event');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      p_bot_id: BOT_ID,
      p_job_id: JOB_ID,
      p_operation: 'analysis',
      p_input_tokens: 400,
    });
    expect(Number(usage[0]?.['p_estimated_cost'])).toBeGreaterThan(0);
    expect(calledWith(rig, 'settle_index_budget')).toHaveLength(1);
    expect(calledWith(rig, 'settle_index_budget')[0]?.['p_reservation_id']).toBe('reservation-1');
    expect(calledWith(rig, 'release_index_budget')).toHaveLength(0);
    // Reservation happens before any provider call.
    const order = rig.calls.map((c) => c.name);
    expect(order.indexOf('reserve_index_budget')).toBeLessThan(
      order.indexOf('save_conversation_analysis'),
    );
  });

  it('bounds the prompt: at most 20 messages, each truncated', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      message(i % 2 === 0 ? 'user' : 'assistant', `message ${i} ` + 'x'.repeat(2000)),
    );
    const rig = makeRig([{ chunks: [ANALYSIS_JSON] }], {
      get_analysis_context: () => contextRpc(many),
    });
    await run(rig);
    const request = rig.provider.requests[0];
    expect(request).toBeDefined();
    const userContent = request?.messages.map((m) => m.content).join('\n') ?? '';
    expect(userContent).not.toContain('message 0 ');
    expect(userContent).toContain('message 29 ');
    for (const line of userContent.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(600);
    }
  });

  it('returns quietly on an invalid payload and touches nothing', async () => {
    const rig = makeRig([{ chunks: [ANALYSIS_JSON] }]);
    await run(rig, { bot_id: BOT_ID });
    expect(rig.calls).toHaveLength(0);
    expect(rig.provider.calls).toBe(0);
  });

  it('returns quietly when the conversation is gone (RB037)', async () => {
    const rig = makeRig([{ chunks: [ANALYSIS_JSON] }], {
      get_analysis_context: () => {
        throw new DbError('http', 404, 'RB037');
      },
    });
    await run(rig);
    expect(rig.provider.calls).toBe(0);
    expect(calledWith(rig, 'save_conversation_analysis')).toHaveLength(0);
  });

  it('returns quietly when the conversation vanishes before save (RB037 on save)', async () => {
    const rig = makeRig([{ chunks: [ANALYSIS_JSON] }], {
      save_conversation_analysis: () => {
        throw new DbError('http', 404, 'RB037');
      },
    });
    await run(rig);
    expect(calledWith(rig, 'save_conversation_analysis')).toHaveLength(1);
    expect(calledWith(rig, 'fail_conversation_analysis')).toHaveLength(0);
    // The spend is real (provider was called), so usage stays and the
    // reservation settles instead of retrying a deleted conversation.
    expect(calledWith(rig, 'record_usage_event')).toHaveLength(1);
    expect(calledWith(rig, 'settle_index_budget')).toHaveLength(1);
    expect(calledWith(rig, 'release_index_budget')).toHaveLength(0);
  });

  it('returns quietly when there is nothing to analyze', async () => {
    const rig = makeRig([{ chunks: [ANALYSIS_JSON] }], {
      get_analysis_context: () => contextRpc([]),
    });
    await run(rig);
    expect(rig.provider.calls).toBe(0);
    expect(calledWith(rig, 'save_conversation_analysis')).toHaveLength(0);
  });

  it('throws on a transient provider failure so the runtime retries (usage still recorded)', async () => {
    const transient = new ProviderError('transient', 'upstream 503');
    const rig = makeRig([{ failBefore: transient }]);
    await expect(run(rig)).rejects.toThrow();
    // The failed attempt counts its estimate and settles it, like the index batches.
    expect(calledWith(rig, 'record_usage_event')).toHaveLength(1);
    expect(calledWith(rig, 'settle_index_budget')).toHaveLength(1);
    expect(calledWith(rig, 'save_conversation_analysis')).toHaveLength(0);
    expect(calledWith(rig, 'fail_conversation_analysis')).toHaveLength(0);
  });

  it('fails the row and returns on a billing error (never billed, reservation released)', async () => {
    const billing = new ProviderError('billing', 'payment required');
    const rig = makeRig([{ failBefore: billing }]);
    await run(rig);
    expect(calledWith(rig, 'record_usage_event')).toHaveLength(0);
    expect(calledWith(rig, 'release_index_budget')).toHaveLength(1);
    expect(calledWith(rig, 'settle_index_budget')).toHaveLength(0);
    expect(calledWith(rig, 'fail_conversation_analysis')).toHaveLength(1);
    expect(calledWith(rig, 'fail_conversation_analysis')[0]).toMatchObject({
      p_conversation_id: CONVERSATION_ID,
    });
  });

  it('fails the row and returns on unusable model output (billed, so usage is settled)', async () => {
    const rig = makeRig([
      { chunks: ['not json at all'], usage: { inputTokens: 400, outputTokens: 10 } },
    ]);
    await run(rig);
    expect(calledWith(rig, 'record_usage_event')).toHaveLength(1);
    expect(calledWith(rig, 'settle_index_budget')).toHaveLength(1);
    expect(calledWith(rig, 'save_conversation_analysis')).toHaveLength(0);
    expect(calledWith(rig, 'fail_conversation_analysis')).toHaveLength(1);
  });

  it('fails the row and returns when the daily cap is reached (RB001)', async () => {
    const rig = makeRig([{ chunks: [ANALYSIS_JSON] }], {
      reserve_index_budget: () => {
        throw new DbError('http', 402, 'RB001');
      },
    });
    await run(rig);
    expect(rig.provider.calls).toBe(0);
    expect(calledWith(rig, 'fail_conversation_analysis')).toHaveLength(1);
    expect(calledWith(rig, 'settle_index_budget')).toHaveLength(0);
    expect(calledWith(rig, 'release_index_budget')).toHaveLength(0);
  });

  it('never logs message content or the summary', async () => {
    const rig = makeRig([{ chunks: [ANALYSIS_JSON] }], {
      get_analysis_context: () => contextRpc([message('user', 'supersecret phrase for logs')]),
    });
    await run(rig);
    expect(rig.logs.join('\n')).not.toContain('supersecret phrase for logs');
    expect(rig.logs.join('\n')).not.toContain('Visitor asked about pricing');
  });
});
