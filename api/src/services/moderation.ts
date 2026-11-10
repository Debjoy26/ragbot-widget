// Moderation of visitor input and model output (PRD W-09, ADR 0004). P7.
//
// One `Moderator` wraps the configured moderation provider. Every call is reported to the usage
// sink (one `usage_events` row per provider call, failed ones included). A provider failure is a
// `ModerationFailure`, and callers fail CLOSED: text that could not be checked is not released and
// not generated from. `endpoint` mode is free (the provider reports no usage); `llm_classifier`
// mode is billed as a chat call and is priced from the usage it reports, or estimated when a
// billed call fails.
//
// The text being moderated is never logged and never put in an error.

import { ProviderError, type ModerationProvider, type ProviderErrorKind } from '@ragbot/shared';
import { CLASSIFIER_MAX_OUTPUT_TOKENS, CLASSIFIER_SYSTEM_PROMPT } from '@ragbot/shared/ai';
import type { TokenPrice } from '../lib/config.js';
import type { UsageEntry, UsageSink } from './conversations.js';
import { costUsd, worstCaseTokens } from './llm.js';

/**
 * Fixed part of an llm_classifier call at 1 char = 1 token: the classifier's system prompt plus the
 * markers around the message (about 64 characters). Taken from the adapter, not guessed.
 */
export const MODERATION_PROMPT_OVERHEAD_TOKENS = CLASSIFIER_SYSTEM_PROMPT.length + 64;
/** The most a classifier call can produce: the adapter's real output cap. */
export const MODERATION_OUTPUT_TOKENS = CLASSIFIER_MAX_OUTPUT_TOKENS;

export type ModerationMode = 'endpoint' | 'llm_classifier';

export class ModerationFailure extends Error {
  override readonly name = 'ModerationFailure';
  readonly kind: ProviderErrorKind | 'unexpected';
  constructor(kind: ProviderErrorKind | 'unexpected') {
    super('moderation failed');
    this.kind = kind;
  }
}

export interface Moderator {
  /**
   * Resolves to the verdict. Throws ModerationFailure when the check could not be made, and
   * rethrows an abort. Records exactly one usage entry per call.
   */
  moderate(text: string, signal: AbortSignal, usage: UsageSink): Promise<'allow' | 'block'>;
}

export interface CreateModeratorOptions {
  readonly provider: ModerationProvider;
  readonly mode: ModerationMode;
  readonly price: TokenPrice;
  readonly now?: () => number;
}

/** What `calls` moderation calls over `chars` characters of text can cost at most. */
export function worstCaseModerationCost(
  chars: number,
  mode: ModerationMode,
  price: TokenPrice,
  calls = 1,
): number {
  if (mode === 'endpoint') return 0;
  return costUsd(
    {
      inputTokens: calls * MODERATION_PROMPT_OVERHEAD_TOKENS + worstCaseTokens(chars),
      outputTokens: calls * MODERATION_OUTPUT_TOKENS,
    },
    price,
  );
}

export function createModerator(options: CreateModeratorOptions): Moderator {
  const { provider, mode, price } = options;
  const now = options.now ?? Date.now;

  return {
    async moderate(text, signal, usage) {
      const started = now();
      const entry = (inputTokens: number, outputTokens: number): UsageEntry => ({
        provider: provider.provider,
        model: provider.model,
        operation: 'moderation',
        inputTokens,
        outputTokens,
        cost: mode === 'endpoint' ? 0 : costUsd({ inputTokens, outputTokens }, price),
        latencyMs: Math.max(0, now() - started),
      });
      try {
        const result = await provider.moderate(text, { signal });
        usage.record(
          result.usage === null
            ? entry(0, 0)
            : entry(result.usage.inputTokens, result.usage.outputTokens),
        );
        return result.verdict;
      } catch (err) {
        const billed = err instanceof ProviderError && err.billed;
        // A billed failure (2xx, then a bad body) was charged: count the estimate. A failure
        // before that, or an abort, costs nothing but still gets its row.
        usage.record(
          billed && mode === 'llm_classifier'
            ? entry(
                MODERATION_PROMPT_OVERHEAD_TOKENS + worstCaseTokens(text.length),
                MODERATION_OUTPUT_TOKENS,
              )
            : entry(0, 0),
        );
        if (signal.aborted) throw err;
        throw new ModerationFailure(err instanceof ProviderError ? err.kind : 'unexpected');
      }
    },
  };
}
