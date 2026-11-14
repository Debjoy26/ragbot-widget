import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { entrySchemaRegistry } from '@ragbot/shared';
import { buildAiProviders } from './lib/ai.js';
import { loadConfig, type AppConfig } from './lib/config.js';
import { createDb, type Db } from './lib/supabase.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerEntriesRoutes } from './routes/entries.js';
import { buildServer } from './server.js';
import { createVisitorAuth, type VisitorAuth } from './services/auth.js';
import {
  createAnswerL2,
  createEmbeddingL2,
  createModerationL2,
  createRetrievalL2,
} from './services/cache-l2.js';
import { createAnswerCache } from './services/answer-cache.js';
import { createAnalysisQueue } from './services/analysis-queue.js';
import { createChatService } from './services/chat.js';
import { createConfigCache } from './services/config-cache.js';
import { createConversations, type ChatContext } from './services/conversations.js';
import { createEmbeddingCache } from './services/embedding-cache.js';
import { createModerationCache } from './services/moderation-cache.js';
import { createRetrievalCache } from './services/retrieval-cache.js';
import { createLimits, type Limits } from './services/limits.js';
import { createLlm } from './services/llm.js';
import { createModerator } from './services/moderation.js';
import { createRetrieval } from './services/retrieval.js';
import { createRuns, type Runs } from './services/runs.js';
import { createTurnstileVerifier, type TurnstileVerifier } from './services/turnstile.js';

export interface App {
  readonly app: FastifyInstance;
  readonly config: AppConfig;
  readonly db: Db;
  readonly auth: VisitorAuth;
  readonly limits: Limits;
  readonly runs: Runs;
  readonly turnstile: TurnstileVerifier;
}

/** Wires the real dependencies. Throws on invalid configuration; never listens. */
export function createApp(
  env: Record<string, string | undefined>,
  logger?: FastifyServerOptions['logger'],
): App {
  const config = loadConfig(env);
  const db = createDb({
    url: config.supabaseUrl,
    secretKey: config.supabaseSecretKey,
    timeoutMs: config.dbTimeoutMs,
  });
  const auth = createVisitorAuth({
    secret: config.visitorTokenSecret,
    previousSecret: config.visitorTokenSecretPrevious,
    ttlSeconds: config.visitorTokenTtlSeconds,
    db,
  });
  const limits = createLimits({
    db,
    rateKeySecret: config.rateLimitKeySecret,
    sessionPreflight: {
      limit: config.sessionPreflightPerIpLimit,
      window_seconds: config.sessionPreflightWindowSeconds,
    },
    history: config.historyRate,
  });
  const runs = createRuns({ db });
  const turnstile = createTurnstileVerifier({
    secret: config.turnstileSecretKey,
    timeoutMs: config.turnstileTimeoutMs,
    // The widget runs on an allowed origin, so Cloudflare must report one of these hosts.
    allowedHostnames: config.allowedOrigins.map((origin) => new URL(origin).hostname),
  });
  const deps = { config, db, auth, limits, runs, turnstile };
  const app = buildServer(logger === undefined ? deps : { ...deps, logger });

  // Chat and history (P7). Registered here, on the instance buildServer returns, before it listens.
  const ai = buildAiProviders(config);
  // P7.5 caches: L1 in-process + L2 Postgres (015 RPCs). Kill switches in client_settings.cache_policy.
  const configCache = createConfigCache<ChatContext>();
  const embeddingCache = createEmbeddingCache({ l2: createEmbeddingL2(db) });
  const moderationCache = createModerationCache({ l2: createModerationL2(db) });
  const retrievalCache = createRetrievalCache({ l2: createRetrievalL2(db) });
  const answerCache = createAnswerCache({ l2: createAnswerL2(db) });
  const conversations = createConversations({ db, configCache });
  // P7-D2: the answer-cache key must pin the real chat model, so a model
  // change invalidates cached answers (invariant §4.15).
  const chatModelKey =
    ai.chatFallback === null
      ? `${ai.chatPrimary.provider}/${ai.chatPrimary.model}`
      : `${ai.chatPrimary.provider}/${ai.chatPrimary.model}|${ai.chatFallback.provider}/${ai.chatFallback.model}`;
  const chat = createChatService({
    config,
    conversations,
    limits,
    runs,
    db,
    chatModelKey,
    queueAnalysis: createAnalysisQueue({ db }),
    configCache,
    embeddingCache,
    moderationCache,
    retrievalCache,
    answerCache,
    retrieval: createRetrieval({
      db,
      embedding: ai.embedding,
      topK: config.retrievalTopK,
      minSimilarity: config.retrievalMinSimilarity,
    }),
    llm: createLlm({
      primary: { provider: ai.chatPrimary, price: config.chatPrice },
      fallback:
        ai.chatFallback === null || config.chatFallbackPrice === null
          ? null
          : { provider: ai.chatFallback, price: config.chatFallbackPrice },
      attempts: config.chatProviderAttempts,
    }),
    moderator: createModerator({
      provider: ai.moderation,
      mode: config.ai.moderation.mode,
      price: config.moderationPrice,
    }),
    moderationMode: config.ai.moderation.mode,
    moderationModelKey: `${ai.moderation.provider}/${ai.moderation.model}/${config.ai.moderation.mode}`,
    embedding: ai.embedding,
  });
  registerChatRoutes(app, { auth, limits, runs, chat });
  registerConversationRoutes(app, {
    auth,
    limits,
    conversations,
    pageSize: config.historyPageSize,
  });
  // Entries (P9-T1). The shared registry is empty until client forms are
  // explicitly registered: unknown schema_keys are refused (fail closed).
  registerEntriesRoutes(app, { auth, db, registry: entrySchemaRegistry });
  return { app, config, db, auth, limits, runs, turnstile };
}
