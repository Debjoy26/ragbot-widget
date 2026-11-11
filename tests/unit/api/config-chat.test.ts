import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../api/src/lib/config.ts';
import { MIN_CHAT_CONTEXT_TOKENS } from '../../../api/src/lib/context-budget.ts';
import { validEnv } from './helpers.ts';

// The P7 chat settings: all required, no defaults, validated at startup (handover section 4).

const REQUIRED = [
  'RETRIEVAL_TOP_K',
  'RETRIEVAL_MIN_SIMILARITY',
  'CHAT_CONTEXT_MAX_TOKENS',
  'CHAT_HISTORY_MAX_MESSAGES',
  'CHAT_MAX_OUTPUT_TOKENS',
  'CHAT_MAX_OUTPUT_CHARS',
  'HISTORY_RATE_PER_SESSION_LIMIT',
  'HISTORY_RATE_WINDOW_SECONDS',
  'CHAT_PRICE_INPUT_PER_MILLION',
  'CHAT_PRICE_OUTPUT_PER_MILLION',
  'MODERATION_PRICE_INPUT_PER_MILLION',
  'MODERATION_PRICE_OUTPUT_PER_MILLION',
  'EMBEDDING_PRICE_PER_MILLION_TOKENS',
  'CHAT_RESERVATION_TTL_SECONDS',
  'CHAT_PROVIDER_ATTEMPTS',
  'HISTORY_PAGE_SIZE',
] as const;

function failure(overrides: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(validEnv(overrides));
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error('expected loadConfig to throw');
}

const FALLBACK = {
  CHAT_FALLBACK_PROVIDER: 'openai',
  CHAT_FALLBACK_MODEL: 'fake-fallback-model',
  OPENAI_API_KEY: 'k'.repeat(40),
};

describe('chat settings in loadConfig', () => {
  it('reads every value', () => {
    const c = loadConfig(validEnv());
    expect(c).toMatchObject({
      retrievalTopK: 5,
      retrievalMinSimilarity: 0.55,
      chatContextMaxTokens: 6000,
      chatHistoryMaxMessages: 6,
      chatMaxOutputTokens: 800,
      chatMaxOutputChars: 8000,
      historyRate: { limit: 60, window_seconds: 60 },
      chatReservationTtlSeconds: 120,
      chatProviderAttempts: 2,
      historyPageSize: 20,
      chatPrice: { inputPerMillion: 0.1, outputPerMillion: 0.4 },
      moderationPrice: { inputPerMillion: 0.1, outputPerMillion: 0.4 },
      embeddingPricePerMillionTokens: 0.15,
      chatFallbackPrice: null,
    });
    expect(Object.isFrozen(c.chatPrice)).toBe(true);
  });

  it.each(REQUIRED)(
    '%s is required: missing, empty or blank is refused, naming only the variable',
    (name) => {
      for (const value of [undefined, '', '   ']) {
        const err = failure({ [name]: value });
        expect(err.variables).toContain(name);
        expect(err.message).toContain(name);
      }
    },
  );

  it.each([
    ['RETRIEVAL_TOP_K', ['0', '51', '-1', '1.5', 'abc', '5 ']],
    ['RETRIEVAL_MIN_SIMILARITY', ['-0.1', '1.1', 'abc', '1e-1', '.5', '0,5']],
    ['CHAT_HISTORY_MAX_MESSAGES', ['-1', '51', 'x']],
    ['CHAT_PROVIDER_ATTEMPTS', ['0', '4', '1.5']],
    ['HISTORY_PAGE_SIZE', ['0', '101']],
    ['CHAT_RESERVATION_TTL_SECONDS', ['0', '86401']],
    ['CHAT_MAX_OUTPUT_TOKENS', ['0', '-5']],
    ['CHAT_CONTEXT_MAX_TOKENS', ['0', '255', 'many']],
    ['CHAT_MAX_OUTPUT_CHARS', ['0', '99', '-1', 'many']],
    ['HISTORY_RATE_PER_SESSION_LIMIT', ['0', '-1', '1.5', 'many']],
    ['HISTORY_RATE_WINDOW_SECONDS', ['0', '86401', 'many']],
    ['CHAT_PRICE_INPUT_PER_MILLION', ['-1', 'free', '1e3', '100001']],
    // Prices must be greater than zero (P7-D1 fix 5): a free price makes the budget meaningless.
    ['CHAT_PRICE_INPUT_PER_MILLION', ['0', '0.0']],
    ['CHAT_PRICE_OUTPUT_PER_MILLION', ['0']],
    ['MODERATION_PRICE_INPUT_PER_MILLION', ['0']],
    ['MODERATION_PRICE_OUTPUT_PER_MILLION', ['0']],
    ['EMBEDDING_PRICE_PER_MILLION_TOKENS', ['0']],
    ['EMBEDDING_PRICE_PER_MILLION_TOKENS', ['-0.1', '<usd-per-million-tokens>']],
  ])('%s refuses out-of-range and malformed values', (name, values) => {
    for (const value of values) {
      if (value === '5 ' && name === 'RETRIEVAL_TOP_K') continue; // surrounding space is trimmed
      expect(failure({ [name]: value }).variables, `${name}=${value}`).toContain(name);
    }
  });

  it('accepts the bounds', () => {
    const c = loadConfig(
      validEnv({
        RETRIEVAL_TOP_K: '50',
        RETRIEVAL_MIN_SIMILARITY: '0',
        CHAT_HISTORY_MAX_MESSAGES: '0',
        CHAT_PROVIDER_ATTEMPTS: '3',
        HISTORY_PAGE_SIZE: '100',
        CHAT_PRICE_INPUT_PER_MILLION: '0.000000001',
        CHAT_CONTEXT_MAX_TOKENS: String(MIN_CHAT_CONTEXT_TOKENS),
      }),
    );
    expect(c.retrievalTopK).toBe(50);
    expect(c.retrievalMinSimilarity).toBe(0);
    expect(c.chatHistoryMaxMessages).toBe(0);
    expect(c.chatPrice.inputPerMillion).toBe(0.000000001);
    expect(c.chatContextMaxTokens).toBe(MIN_CHAT_CONTEXT_TOKENS);
    expect(loadConfig(validEnv({ RETRIEVAL_MIN_SIMILARITY: '1' })).retrievalMinSimilarity).toBe(1);
  });

  it('a reservation must outlive the request deadline by 30 seconds (P7-D1 fix 5)', () => {
    const err = failure({ CHAT_DEADLINE_MS: '90001', CHAT_RESERVATION_TTL_SECONDS: '120' });
    expect(err.variables).toEqual(['CHAT_RESERVATION_TTL_SECONDS', 'CHAT_DEADLINE_MS']);
    // The old rule (TTL longer than the deadline) is no longer enough.
    expect(
      failure({ CHAT_DEADLINE_MS: '119999', CHAT_RESERVATION_TTL_SECONDS: '120' }).variables,
    ).toContain('CHAT_RESERVATION_TTL_SECONDS');
    // Exactly deadline + 30 s is allowed.
    expect(
      loadConfig(validEnv({ CHAT_DEADLINE_MS: '90000', CHAT_RESERVATION_TTL_SECONDS: '120' })),
    ).toBeTruthy();
  });

  it('fallback prices must be greater than zero too', () => {
    const base = {
      ...FALLBACK,
      CHAT_FALLBACK_PRICE_INPUT_PER_MILLION: '0.2',
      CHAT_FALLBACK_PRICE_OUTPUT_PER_MILLION: '0.8',
    };
    expect(failure({ ...base, CHAT_FALLBACK_PRICE_INPUT_PER_MILLION: '0' }).variables).toContain(
      'CHAT_FALLBACK_PRICE_INPUT_PER_MILLION',
    );
    expect(failure({ ...base, CHAT_FALLBACK_PRICE_OUTPUT_PER_MILLION: '0' }).variables).toContain(
      'CHAT_FALLBACK_PRICE_OUTPUT_PER_MILLION',
    );
  });

  it('the reservation TTL must be at least CHAT_DEADLINE_MS + 30 s, for any deadline', () => {
    for (const [deadline, ttl, ok] of [
      ['30000', '60', true],
      ['30000', '59', false],
      ['1', '31', true],
      ['1', '30', false],
    ] as const) {
      const env = { CHAT_DEADLINE_MS: deadline, CHAT_RESERVATION_TTL_SECONDS: ttl };
      if (ok) expect(loadConfig(validEnv(env))).toBeTruthy();
      else expect(failure(env).variables).toContain('CHAT_RESERVATION_TTL_SECONDS');
    }
  });

  it('fallback prices are required exactly when a fallback is configured', () => {
    const missing = failure({ ...FALLBACK });
    expect(missing.variables).toEqual([
      'CHAT_FALLBACK_PRICE_INPUT_PER_MILLION',
      'CHAT_FALLBACK_PRICE_OUTPUT_PER_MILLION',
    ]);
    expect(
      failure({ ...FALLBACK, CHAT_FALLBACK_PRICE_INPUT_PER_MILLION: '0.2' }).variables,
    ).toEqual(['CHAT_FALLBACK_PRICE_OUTPUT_PER_MILLION']);
    const ok = loadConfig(
      validEnv({
        ...FALLBACK,
        CHAT_FALLBACK_PRICE_INPUT_PER_MILLION: '0.2',
        CHAT_FALLBACK_PRICE_OUTPUT_PER_MILLION: '0.8',
      }),
    );
    expect(ok.chatFallbackPrice).toEqual({ inputPerMillion: 0.2, outputPerMillion: 0.8 });
    // A price with no fallback provider is a mistake, not something to ignore.
    const stray = failure({ CHAT_FALLBACK_PRICE_INPUT_PER_MILLION: '0.2' });
    expect(stray.variables).toContain('CHAT_FALLBACK_PRICE_INPUT_PER_MILLION');
  });

  it('error messages never contain a value', () => {
    const err = failure({ RETRIEVAL_TOP_K: '99999-SECRET-LOOKING' });
    expect(err.message).not.toContain('99999-SECRET-LOOKING');
  });
});
