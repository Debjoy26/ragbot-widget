// Cost estimate for one chat or classifier call (P7). Money is never taken from the provider's
// word: the API estimates from the usage it recorded and the prices from its own configuration
// (no defaults: a missing price is a startup error, not a zero).
import type { ChatUsage } from '../providers.js';

/** USD per one million tokens. */
export interface ModelPrice {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
}

function assertNonNegative(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number of at least 0`);
  }
}

/**
 * Estimated cost in USD, never negative, rounded to 6 decimals. `cachedInputTokens` is ignored on
 * purpose: every input token is priced at the full input rate, which can only over-estimate. Throws
 * a RangeError for a negative, non-finite or non-numeric token count or price.
 */
export function estimateCostUsd(usage: ChatUsage, price: ModelPrice): number {
  assertNonNegative(usage.inputTokens, 'inputTokens');
  assertNonNegative(usage.outputTokens, 'outputTokens');
  assertNonNegative(price.inputPerMillion, 'inputPerMillion');
  assertNonNegative(price.outputPerMillion, 'outputPerMillion');
  const cost =
    (usage.inputTokens * price.inputPerMillion + usage.outputTokens * price.outputPerMillion) /
    1_000_000;
  if (!Number.isFinite(cost)) throw new RangeError('estimated cost is not a finite number');
  return Math.round(cost * 1_000_000) / 1_000_000;
}
