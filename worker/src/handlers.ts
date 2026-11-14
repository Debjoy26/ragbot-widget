// Handler registry for the worker process (P6-INDEX, P9-T2). Builds the embedding and
// analysis providers from the worker's AI config (or takes injected ones, for tests) and
// returns the job handlers.
import type { ChatProvider, EmbeddingProvider } from '@ragbot/shared';
import { createChatProvider } from '@ragbot/shared/ai';
import { createAnalyzeConversationHandler } from './jobs/analyze-conversation.js';
import { createCleanupHandler } from './jobs/cleanup.js';
import { createIndexDocumentHandler } from './jobs/index-document.js';
import { createEmbeddingProvider } from './lib/embeddings.js';
import type { WorkerConfig } from './lib/config.js';
import type { JobHandlers } from './runtime.js';

export interface BuildHandlersDeps {
  /** Injected for tests only (a labelled fake). Production builds the adapter from `config.ai`. */
  readonly embeddings?: EmbeddingProvider;
  /** Injected for tests only (a labelled fake). Production builds the adapter from `config.ai`. */
  readonly analysis?: ChatProvider;
}

export function buildHandlers(config: WorkerConfig, deps: BuildHandlersDeps = {}): JobHandlers {
  const embeddings = deps.embeddings ?? createEmbeddingProvider(config.ai.embedding);
  const analysis = deps.analysis ?? createChatProvider(config.ai.analysis);
  return {
    index_document: createIndexDocumentHandler({ embeddings }),
    analyze_conversation: createAnalyzeConversationHandler({ chat: analysis }),
    cleanup: createCleanupHandler(),
  };
}
