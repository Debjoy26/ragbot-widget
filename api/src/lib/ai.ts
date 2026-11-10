// Builds the AI providers from configuration (ADR 0014). This is the ONLY API module that imports
// the provider adapters, so a change in their factories touches one file. Server-side only.
//
// Each request to a provider is bounded by CHAT_DEADLINE_MS as well, so one stuck connection cannot
// outlive the whole answer. Keys travel inside the adapters; this module never logs or returns them.

import {
  createChatProvider,
  createEmbeddingProvider,
  createModerationProvider,
} from '@ragbot/shared/ai';
import type { ChatProvider, EmbeddingProvider, ModerationProvider } from '@ragbot/shared';
import type { AppConfig } from './config.js';

export interface AiProviders {
  readonly chatPrimary: ChatProvider;
  /** Null when no fallback is configured. */
  readonly chatFallback: ChatProvider | null;
  readonly embedding: EmbeddingProvider;
  readonly moderation: ModerationProvider;
}

export function buildAiProviders(config: AppConfig): AiProviders {
  const requestTimeoutMs = config.chatDeadlineMs;
  const { ai } = config;
  return {
    chatPrimary: createChatProvider(ai.chatPrimary, { requestTimeoutMs }),
    chatFallback:
      ai.chatFallback === null ? null : createChatProvider(ai.chatFallback, { requestTimeoutMs }),
    embedding: createEmbeddingProvider(ai.embedding, { timeoutMs: requestTimeoutMs }),
    moderation: createModerationProvider(ai.moderation, { requestTimeoutMs }),
  };
}
