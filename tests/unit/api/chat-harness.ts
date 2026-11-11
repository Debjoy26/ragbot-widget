import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import { sseEventSchema, type SseEvent } from '@ragbot/shared';
import { AppError } from '../../../api/src/lib/errors.ts';
import { buildLoggerOptions } from '../../../api/src/lib/logger.ts';
import { DbError, type Db } from '../../../api/src/lib/supabase.ts';
import { registerChatRoutes } from '../../../api/src/routes/chat.ts';
import { registerConversationRoutes } from '../../../api/src/routes/conversations.ts';
import { createVisitorAuth } from '../../../api/src/services/auth.ts';
import { createChatService } from '../../../api/src/services/chat.ts';
import { createConversations } from '../../../api/src/services/conversations.ts';
import { createLlm } from '../../../api/src/services/llm.ts';
import { createModerator } from '../../../api/src/services/moderation.ts';
import { createRetrieval } from '../../../api/src/services/retrieval.ts';
import type { Limits } from '../../../api/src/services/limits.ts';
import type { BeginRunResult, Runs } from '../../../api/src/services/runs.ts';
import {
  FakeChatProvider,
  FakeEmbeddingProvider,
  FakeModerationProvider,
  type FakeChatScript,
  type FakeModerationAction,
} from '../../helpers/fake-ai.ts';
import { FAKE_VISITOR_SECRET, LogCapture, buildTestServer, testConfig } from './helpers.ts';

// Harness for the P7 chat unit tests. Everything behind the routes is a labelled FAKE: the database
// answers from a script and records each call, limits and runs are stubs, and the providers are the
// scripted fakes of tests/helpers/fake-ai.ts. No network. A mocked database cannot satisfy the
// integration gate; the real-database checks are in tests/integration (Opus).

export const BOT = randomUUID();
export const SESSION = randomUUID();
export const RUN = randomUUID();
export const RESERVATION = randomUUID();
export const CONVERSATION = randomUUID();
export const USER_MESSAGE = randomUUID();
export const CHUNK_A = randomUUID();
export const CHUNK_B = randomUUID();
export const VERSION_A = randomUUID();
export const KEY = randomUUID();

export const ANSWER_HEADER = 'EVIDENCE: SUFFICIENT\n';

export interface Rpc {
  name: string;
  args: Record<string, unknown>;
}

export function chunkRow(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chunk_id: id,
    document_id: randomUUID(),
    document_version_id: VERSION_A,
    document_title: 'Pricing guide',
    chunk_index: 0,
    content: 'The standard plan costs ten dollars per month.',
    page_number: 3,
    section: 'Plans',
    metadata: {},
    similarity: 0.9,
    ...extra,
  };
}

export function defaultContext(
  over: {
    bot?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    contact?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    bot: {
      id: BOT,
      slug: 'dev-bot',
      enabled: true,
      display_name: 'Acme',
      identity_prompt: 'You help visitors of Acme.',
      tone: 'friendly',
      scope: 'Acme products and prices',
      allowed_languages: ['en'],
      embedding_model: 'fake-embedding-model',
      embedding_dimensions: 1536,
      settings_version: 1,
      corpus_version: 1,
      ...over.bot,
    },
    settings: { feature_flags: {}, handoff_policy: {}, ...over.settings },
    contact: {
      supported_languages: ['en', 'hi'],
      escalation_label: 'Contact us',
      escalation_messages: { en: 'Please contact our team.', hi: 'Hindi contact message.' },
      email: 'help@acme.example',
      phone: '+14155550100',
      whatsapp_url: null,
      page_url: 'https://acme.example/contact',
      business_hours: { 'mon-fri': '09:00-17:00' },
      timezone: 'Asia/Kolkata',
      ...over.contact,
    },
  };
}

export interface Options {
  env?: Record<string, string | undefined>;
  context?: ReturnType<typeof defaultContext>;
  chunks?: Record<string, unknown>[];
  history?: Record<string, unknown>[];
  prior?: number;
  chat?: FakeChatScript[];
  fallback?: FakeChatScript[];
  moderation?: (text: string, i: number) => FakeModerationAction;
  moderationUsage?: { inputTokens: number; outputTokens: number } | null;
  /** A hanging moderation call reports its abort this many ms late (a slow cancellation). */
  moderationAbortDelayMs?: number;
  embeddingModel?: string;
  embeddingFail?: Error;
  /** Extra FakeEmbeddingProvider options (delay, hang, failTimes, ...). */
  embeddingOptions?: ConstructorParameters<typeof FakeEmbeddingProvider>[0];
  /** Errors thrown by a database function, by name (once per call number, `n` is 0-based). */
  dbFail?: Record<string, (n: number, args: Record<string, unknown>) => Error | undefined>;
  begin?: () => Promise<BeginRunResult>;
  consume?: () => Promise<void>;
  consumeHistory?: () => Promise<void>;
  settle?: (botId: string, reservationId: string, amount: number) => Promise<void>;
  release?: (botId: string, reservationId: string) => Promise<void>;
  reserve?: () => Promise<string>;
  markRunning?: () => Promise<boolean>;
  attempts?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  visitorBot?: string;
}

export function setup(options: Options = {}) {
  const config = testConfig({
    BODY_LIMIT_BYTES: '65536',
    LOG_LEVEL: 'info',
    ...(options.fallback === undefined
      ? {}
      : {
          CHAT_FALLBACK_PROVIDER: 'openai',
          CHAT_FALLBACK_MODEL: 'fake-fallback-model',
          OPENAI_API_KEY: 'k'.repeat(40),
          CHAT_FALLBACK_PRICE_INPUT_PER_MILLION: '0.2',
          CHAT_FALLBACK_PRICE_OUTPUT_PER_MILLION: '0.8',
        }),
    ...options.env,
  });
  const rpcs: Rpc[] = [];
  const counts = new Map<string, number>();
  const ctx = options.context ?? defaultContext();
  const db: Db = {
    ping: async () => true,
    selectOne: (async () => ({
      token_version: 1,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      revoked_at: null,
    })) as Db['selectOne'],
    rpc: (async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      const n = counts.get(name) ?? 0;
      counts.set(name, n + 1);
      const failure = options.dbFail?.[name]?.(n, args);
      if (failure !== undefined) throw failure;
      switch (name) {
        case 'get_chat_context':
          return { ...ctx, bot: { ...(ctx['bot'] as object), id: args['p_bot_id'] } };
        case 'start_chat_turn':
          return [
            {
              conversation_id: args['p_conversation_id'] ?? CONVERSATION,
              user_message_id: USER_MESSAGE,
              prior_no_knowledge: options.prior ?? 0,
            },
          ];
        case 'finish_chat_turn':
        case 'record_request_usage':
          return null;
        case 'match_document_chunks':
          return options.chunks ?? [chunkRow(CHUNK_A)];
        case 'get_conversation_history':
          return (options.history ?? []).slice(-Number(args['p_limit']));
        default:
          throw new Error(`fake db: unexpected rpc ${name}`);
      }
    }) as Db['rpc'],
  };

  const chatProvider = new FakeChatProvider(
    options.chat ?? [{ chunks: [`${ANSWER_HEADER}Plans start at ten dollars [[${CHUNK_A}]].`] }],
  );
  const fallbackProvider =
    options.fallback === undefined
      ? null
      : new FakeChatProvider(options.fallback, {
          provider: 'openai',
          model: 'fake-fallback-model',
        });
  const moderationProvider = new FakeModerationProvider(
    options.moderation,
    options.moderationUsage === undefined
      ? { inputTokens: 600, outputTokens: 2 }
      : options.moderationUsage,
    options.moderationAbortDelayMs === undefined
      ? {}
      : { abortDelayMs: options.moderationAbortDelayMs },
  );
  const embedding = new FakeEmbeddingProvider({
    model: options.embeddingModel ?? 'fake-embedding-model',
    ...(options.embeddingFail === undefined ? {} : { fail: options.embeddingFail }),
    ...options.embeddingOptions,
  });

  const limits = {
    loadMessagePolicy: vi.fn(async () => ({
      message_per_session: { limit: 10, window_seconds: 60 },
      message_per_ip: { limit: 10, window_seconds: 60 },
    })),
    consumeMessage: vi.fn(options.consume ?? (async () => undefined)),
    consumeHistory: vi.fn(options.consumeHistory ?? (async () => undefined)),
    reserve: vi.fn(options.reserve ?? (async () => RESERVATION)),
    settle: vi.fn(
      options.settle ??
        (async (_botId: string, _reservationId: string, _amount: number) => undefined),
    ),
    release: vi.fn(
      options.release ?? (async (_botId: string, _reservationId: string) => undefined),
    ),
  };
  const runs = {
    beginRun: vi.fn(
      options.begin ?? (async (): Promise<BeginRunResult> => ({ kind: 'new', runId: RUN })),
    ),
    markRunning: vi.fn(options.markRunning ?? (async () => true)),
    finishRun: vi.fn(async (_botId: string, _runId: string, _state: string) => true),
  };
  const conversations = createConversations({ db });
  const chat = createChatService({
    config,
    conversations,
    limits,
    runs,
    retrieval: createRetrieval({
      db,
      embedding,
      topK: config.retrievalTopK,
      minSimilarity: config.retrievalMinSimilarity,
    }),
    llm: createLlm({
      primary: { provider: chatProvider, price: config.chatPrice },
      fallback:
        fallbackProvider === null || config.chatFallbackPrice === null
          ? null
          : { provider: fallbackProvider, price: config.chatFallbackPrice },
      attempts: options.attempts ?? config.chatProviderAttempts,
      sleep: options.sleep ?? (async () => undefined),
    }),
    moderator: createModerator({
      provider: moderationProvider,
      mode: 'llm_classifier',
      price: config.moderationPrice,
    }),
    moderationMode: 'llm_classifier',
    embedding,
    // Retries of the input stage do not wait in unit tests.
    sleep: options.sleep ?? (async () => undefined),
  });
  const auth = createVisitorAuth({
    secret: FAKE_VISITOR_SECRET,
    ttlSeconds: config.visitorTokenTtlSeconds,
    db,
  });
  const capture = new LogCapture();
  const app = buildTestServer({
    config,
    db,
    auth,
    limits: limits as unknown as Limits,
    runs: runs as unknown as Runs,
    logger: { ...buildLoggerOptions('info'), stream: capture.stream },
  });
  registerChatRoutes(app, { auth, limits, runs, chat });
  registerConversationRoutes(app, {
    auth,
    limits,
    conversations,
    pageSize: config.historyPageSize,
  });
  const token = auth.issueToken({
    bot_id: options.visitorBot ?? BOT,
    session_id: SESSION,
    token_version: 1,
  }).token;
  apps.push(app);
  return {
    app,
    config,
    rpcs,
    db,
    token,
    auth,
    capture,
    limits,
    runs,
    chatProvider,
    fallbackProvider,
    moderationProvider,
    embedding,
    calls: (name: string): Rpc[] => rpcs.filter((r) => r.name === name),
  };
}

export type Harness = ReturnType<typeof setup>;

const apps: FastifyInstance[] = [];
export async function closeApps(): Promise<void> {
  await Promise.all(apps.splice(0).map((a) => a.close()));
}

export function chatBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bot_slug: 'dev-bot',
    conversation_id: null,
    message: 'How much is the standard plan?',
    ...over,
  };
}

export function postChat(
  h: Harness,
  body: unknown = chatBody(),
  headers: Record<string, string | undefined> = {},
) {
  const merged: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${h.token}`,
    'idempotency-key': KEY,
  };
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  return h.app.inject({
    method: 'POST',
    url: '/v1/chat',
    headers: merged,
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Parses an SSE body into events, validating each against the shared schema. */
export function parseSse(payload: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const frame of payload.split('\n\n')) {
    if (frame.trim() === '' || frame.startsWith(':')) continue;
    const lines = frame.split('\n');
    const name = lines.find((l) => l.startsWith('event: '))?.slice(7);
    const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
    events.push(sseEventSchema.parse({ event: name, data: JSON.parse(data ?? 'null') }));
  }
  return events;
}

export const names = (events: SseEvent[]): string[] => events.map((e) => e.event);

export function deltaText(events: SseEvent[]): string {
  return events.map((e) => (e.event === 'delta' ? e.data.text : '')).join('');
}

export function eventOf<N extends SseEvent['event']>(
  events: SseEvent[],
  name: N,
): Extract<SseEvent, { event: N }> {
  const found = events.find((e) => e.event === name);
  if (found === undefined) throw new Error(`no ${name} event`);
  return found as Extract<SseEvent, { event: N }>;
}

export const dbError = (sqlstate: string): DbError => new DbError('http', 400, sqlstate);
export { AppError };
