// Handler registry for the worker process (P6-INDEX, P9-T2, P7.5-T13). Builds the
// embedding and analysis providers from the worker's AI config (or takes injected
// ones, for tests) and returns the job handlers. Warming (C8) registers only with
// an explicit validated WarmingConfig: absent/null keeps the worker on the three
// base handlers; present builds (or takes injected) chat/moderation adapters whose
// identities must equal the API's, reusing the worker's existing vendor keys —
// no separate warming keys exist by design. An unresolvable vendor key throws at
// startup (visible fail-closed, never silent no-op warming).
import type {
  ChatProvider,
  EmbeddingProvider,
  ModerationConfig,
  ModerationProvider,
  ProviderConfig,
  ProviderKind,
} from '@ragbot/shared';
import { createChatProvider, createModerationProvider } from '@ragbot/shared/ai';
import { createAnalyzeConversationHandler } from './jobs/analyze-conversation.js';
import { createCleanupHandler } from './jobs/cleanup.js';
import { createIndexDocumentHandler } from './jobs/index-document.js';
import { createWarmAnswerCacheHandler } from './jobs/warm-answer-cache.js';
import { createEmbeddingProvider } from './lib/embeddings.js';
import { ConfigError, type WorkerConfig } from './lib/config.js';
import type { WarmingConfig } from './lib/warming-config.js';
import type { JobHandlers } from './runtime.js';

export interface BuildHandlersDeps {
  /** Injected for tests only (a labelled fake). Production builds the adapter from `config.ai`. */
  readonly embeddings?: EmbeddingProvider;
  /** Injected for tests only (a labelled fake). Production builds the adapter from `config.ai`. */
  readonly analysis?: ChatProvider;
  /** Validated warming config (loadWarmingConfig). Absent/null = warming stays unregistered. */
  readonly warming?: WarmingConfig | null;
  /** Injected for tests only (a labelled fake). Production builds from `warming` identities. */
  readonly warmChat?: ChatProvider;
  /** Injected for tests only (a labelled fake). Production builds from `warming` identities. */
  readonly warmModeration?: ModerationProvider;
}

/** A vendor key the worker already holds (embedding or analysis role). No new key vars exist. */
function vendorKey(
  config: WorkerConfig,
  provider: ProviderKind,
  variable: string,
): { apiKey: string; baseUrl: string | null } {
  for (const role of [config.ai.embedding, config.ai.analysis]) {
    if (role.provider === provider) return { apiKey: role.apiKey, baseUrl: role.baseUrl };
  }
  throw new ConfigError(
    [variable],
    `Invalid warming configuration: ${variable} needs a worker key for that vendor`,
  );
}

export function buildHandlers(config: WorkerConfig, deps: BuildHandlersDeps = {}): JobHandlers {
  const embeddings = deps.embeddings ?? createEmbeddingProvider(config.ai.embedding);
  const analysis = deps.analysis ?? createChatProvider(config.ai.analysis);
  const handlers: JobHandlers = {
    index_document: createIndexDocumentHandler({ embeddings }),
    analyze_conversation: createAnalyzeConversationHandler({ chat: analysis }),
    cleanup: createCleanupHandler(),
  };
  const warming = deps.warming ?? null;
  if (warming === null) return handlers;
  const chatConfig: ProviderConfig = {
    role: 'chat_primary',
    provider: warming.chatProvider,
    model: warming.chatModel,
    ...vendorKey(config, warming.chatProvider, 'WARM_CHAT_PROVIDER'),
  };
  const warmChat = deps.warmChat ?? createChatProvider(chatConfig);
  const moderationConfig: ModerationConfig = {
    role: 'moderation',
    provider: warming.moderationProvider,
    model: warming.moderationModel,
    mode: warming.moderationMode,
    ...vendorKey(config, warming.moderationProvider, 'WARM_MODERATION_PROVIDER'),
  };
  const warmModeration = deps.warmModeration ?? createModerationProvider(moderationConfig);
  return {
    ...handlers,
    warm_answer_cache: createWarmAnswerCacheHandler({
      embedding: embeddings,
      chat: warmChat,
      moderation: warmModeration,
      config: warming,
    }),
  };
}
