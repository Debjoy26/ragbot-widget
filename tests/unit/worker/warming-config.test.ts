import { describe, expect, it } from 'vitest';
import type { WorkerAiConfig } from '../../../shared/src/providers.ts';
import { ConfigError } from '../../../worker/src/lib/config.ts';
import { loadWarmingConfig } from '../../../worker/src/lib/warming-config.ts';

// Fake identities generated inline; nothing touches the network or real env.
function fakeAi(): WorkerAiConfig {
  const ai: WorkerAiConfig = {
    embedding: {
      role: 'embedding',
      provider: 'gemini',
      model: 'gemini-embedding-001',
      apiKey: 'fake-embed-key',
      baseUrl: null,
      dimensions: 1536,
    },
    analysis: {
      role: 'analysis',
      provider: 'gemini',
      model: 'gemini-2.5-flash-lite',
      apiKey: 'fake-analysis-key',
      baseUrl: null,
    },
  };
  // Mirror production: loadWorkerConfig hides keys as non-enumerable.
  for (const role of [ai.embedding, ai.analysis] as const) {
    Object.defineProperty(role, 'apiKey', {
      value: role.apiKey,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return ai;
}

function validEnv(): Record<string, string> {
  return {
    WARM_ENABLED: 'true',
    WARM_CONTEXT_MAX_TOKENS: '8000',
    WARM_MAX_OUTPUT_TOKENS: '1000',
    WARM_MAX_OUTPUT_CHARS: '4000',
    WARM_TOP_K: '5',
    WARM_MIN_SIMILARITY: '0.3',
    WARM_DEADLINE_MS: '30000',
    WARM_RESERVE_TTL_SECONDS: '300',
    WARM_MODERATION_MAX_CHARS: '2000',
    WARM_EMBEDDING_PRICE_PER_MILLION_TOKENS: '0.15',
    WARM_CHAT_PRICE_INPUT_PER_MILLION: '0.5',
    WARM_CHAT_PRICE_OUTPUT_PER_MILLION: '1.5',
    WARM_MODERATION_PRICE_INPUT_PER_MILLION: '0.2',
    WARM_MODERATION_PRICE_OUTPUT_PER_MILLION: '0.8',
    WARM_CHAT_PROVIDER: 'gemini',
    WARM_CHAT_MODEL: 'gemini-2.5-flash-lite',
    WARM_MODERATION_PROVIDER: 'openai',
    WARM_MODERATION_MODEL: 'omni-moderation-latest',
    WARM_MODERATION_MODE: 'endpoint',
  };
}

function refusal(env: Record<string, string | undefined>): ConfigError {
  try {
    loadWarmingConfig(env, fakeAi());
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected loadWarmingConfig to throw');
}

describe('loadWarmingConfig: default-off', () => {
  it('returns null when the flag is missing or false, ignoring other vars', () => {
    const ai = fakeAi();
    expect(loadWarmingConfig({}, ai)).toBeNull();
    expect(loadWarmingConfig({ WARM_ENABLED: 'false' }, ai)).toBeNull();
    expect(loadWarmingConfig({ WARM_TOP_K: 'garbage', WARM_CHAT_PROVIDER: 'nope' }, ai)).toBeNull();
  });

  it('fails closed on a garbage flag value', () => {
    expect(refusal({ WARM_ENABLED: 'yes' }).variables).toEqual(['WARM_ENABLED']);
  });
});

describe('loadWarmingConfig: enabled validation', () => {
  it('accepts a complete environment with exact API-matching model keys', () => {
    const ai = fakeAi();
    const cfg = loadWarmingConfig(validEnv(), ai);
    expect(cfg).not.toBeNull();
    expect(cfg?.chatModelKey).toBe('gemini/gemini-2.5-flash-lite');
    expect(cfg?.moderationModelKey).toBe('openai/omni-moderation-latest/endpoint');
    expect(cfg?.moderationMode).toBe('endpoint');
    expect(cfg).toMatchObject({
      contextMaxTokens: 8000,
      maxOutputTokens: 1000,
      maxOutputChars: 4000,
      topK: 5,
      minSimilarity: 0.3,
      deadlineMs: 30_000,
      reserveTtlSeconds: 300,
      moderationMaxChars: 2000,
      embeddingPricePerMillionTokens: 0.15,
    });
    expect(cfg?.chatPrice).toEqual({ inputPerMillion: 0.5, outputPerMillion: 1.5 });
    expect(cfg?.moderationPrice).toEqual({ inputPerMillion: 0.2, outputPerMillion: 0.8 });
    expect(cfg?.ai).toBe(ai);
  });

  it('builds the fallback model key exactly like the API', () => {
    const cfg = loadWarmingConfig(
      {
        ...validEnv(),
        WARM_CHAT_FALLBACK_PROVIDER: 'openai',
        WARM_CHAT_FALLBACK_MODEL: 'gpt-4o-mini',
      },
      fakeAi(),
    );
    expect(cfg?.chatModelKey).toBe('gemini/gemini-2.5-flash-lite|openai/gpt-4o-mini');
  });

  it('rejects a half-configured fallback pair', () => {
    expect(refusal({ ...validEnv(), WARM_CHAT_FALLBACK_PROVIDER: 'openai' }).variables).toEqual([
      'WARM_CHAT_FALLBACK_PROVIDER',
      'WARM_CHAT_FALLBACK_MODEL',
    ]);
  });

  it('rejects unknown providers, bad models and bad modes by name', () => {
    expect(refusal({ ...validEnv(), WARM_CHAT_PROVIDER: 'gemni' }).variables).toEqual([
      'WARM_CHAT_PROVIDER',
    ]);
    expect(refusal({ ...validEnv(), WARM_CHAT_MODEL: 'bad model!' }).variables).toEqual([
      'WARM_CHAT_MODEL',
    ]);
    expect(refusal({ ...validEnv(), WARM_MODERATION_MODE: 'auto' }).variables).toEqual([
      'WARM_MODERATION_MODE',
    ]);
  });

  it('rejects out-of-range limits and zero prices', () => {
    expect(refusal({ ...validEnv(), WARM_TOP_K: '0' }).variables).toEqual(['WARM_TOP_K']);
    expect(refusal({ ...validEnv(), WARM_TOP_K: '51' }).variables).toEqual(['WARM_TOP_K']);
    expect(refusal({ ...validEnv(), WARM_MIN_SIMILARITY: '2' }).variables).toEqual([
      'WARM_MIN_SIMILARITY',
    ]);
    expect(refusal({ ...validEnv(), WARM_CHAT_PRICE_INPUT_PER_MILLION: '0' }).variables).toEqual([
      'WARM_CHAT_PRICE_INPUT_PER_MILLION',
    ]);
    expect(
      refusal({ ...validEnv(), WARM_EMBEDDING_PRICE_PER_MILLION_TOKENS: '-1' }).variables,
    ).toEqual(['WARM_EMBEDDING_PRICE_PER_MILLION_TOKENS']);
  });

  it('rejects a reservation TTL that cannot outlive the deadline', () => {
    expect(
      refusal({ ...validEnv(), WARM_DEADLINE_MS: '300000', WARM_RESERVE_TTL_SECONDS: '60' })
        .variables,
    ).toEqual(['WARM_RESERVE_TTL_SECONDS', 'WARM_DEADLINE_MS']);
  });

  it('names missing variables, never values', () => {
    const err = refusal({ WARM_ENABLED: 'true' });
    expect(err.variables).toContain('WARM_CHAT_PROVIDER');
    expect(err.variables).toContain('WARM_TOP_K');
    expect(JSON.stringify(err.variables)).not.toContain('fake-');
  });

  it('returns a frozen config and keeps keys out of JSON', () => {
    const cfg = loadWarmingConfig(validEnv(), fakeAi());
    expect(cfg).not.toBeNull();
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg?.chatPrice)).toBe(true);
    expect(Object.isFrozen(cfg?.moderationPrice)).toBe(true);
    const dumped = JSON.stringify(cfg);
    expect(dumped).not.toContain('fake-embed-key');
    expect(dumped).not.toContain('fake-analysis-key');
  });
});
