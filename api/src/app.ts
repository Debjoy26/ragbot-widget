import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { buildAiProviders } from './lib/ai.js';
import { loadConfig, type AppConfig } from './lib/config.js';
import { createDb, type Db } from './lib/supabase.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { buildServer } from './server.js';
import { createVisitorAuth, type VisitorAuth } from './services/auth.js';
import { createChatService } from './services/chat.js';
import { createConversations } from './services/conversations.js';
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
  const conversations = createConversations({ db });
  const chat = createChatService({
    config,
    conversations,
    limits,
    runs,
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
    embedding: ai.embedding,
    hasFallback: ai.chatFallback !== null,
  });
  registerChatRoutes(app, { auth, limits, runs, chat });
  registerConversationRoutes(app, { auth, conversations, pageSize: config.historyPageSize });
  return { app, config, db, auth, limits, runs, turnstile };
}
