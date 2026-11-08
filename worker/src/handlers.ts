// Handler registry for the worker process (P6-INDEX). Builds the embedding provider from the
// worker's AI config (or takes an injected one, for tests) and returns the job handlers.
import type { EmbeddingProvider } from '@ragbot/shared';
import { createCleanupHandler } from './jobs/cleanup.js';
import { createIndexDocumentHandler } from './jobs/index-document.js';
import { createEmbeddingProvider } from './lib/embeddings.js';
import type { WorkerConfig } from './lib/config.js';
import type { JobHandlers } from './runtime.js';

export interface BuildHandlersDeps {
  /** Injected for tests only (a labelled fake). Production builds the adapter from `config.ai`. */
  readonly embeddings?: EmbeddingProvider;
}

export function buildHandlers(config: WorkerConfig, deps: BuildHandlersDeps = {}): JobHandlers {
  const embeddings = deps.embeddings ?? createEmbeddingProvider(config.ai.embedding);
  return {
    index_document: createIndexDocumentHandler({ embeddings }),
    cleanup: createCleanupHandler(),
  };
}
