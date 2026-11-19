import { VECTOR_DIMENSIONS, type EmbeddingConfig, type EmbeddingProvider } from '@ragbot/shared';
import type { ChatProvider, ModerationProvider, ProviderConfig } from '@ragbot/shared';
import { describe, expect, it } from 'vitest';
import { buildHandlers } from '../../../worker/src/handlers.ts';
import type { WorkerConfig } from '../../../worker/src/lib/config.ts';
import { ConfigError } from '../../../worker/src/lib/config.ts';
import type { WarmingConfig } from '../../../worker/src/lib/warming-config.ts';

// P6-INDEX + P9-T2: the handler registry. Labelled fakes only; nothing here calls a provider.

function embeddingConfig(over: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    role: 'embedding',
    provider: 'openai_compatible',
    model: 'fake-embed-model',
    apiKey: `fake-key-${Math.random().toString(16).slice(2)}`,
    baseUrl: 'http://127.0.0.1:9',
    dimensions: VECTOR_DIMENSIONS,
    ...over,
  };
}

function analysisConfig(): ProviderConfig {
  return {
    role: 'analysis',
    provider: 'openai_compatible',
    model: 'fake-analysis-model',
    apiKey: `fake-key-${Math.random().toString(16).slice(2)}`,
    baseUrl: 'http://127.0.0.1:9',
  };
}

function config(embedding: EmbeddingConfig): WorkerConfig {
  return { ai: { embedding, analysis: analysisConfig() } } as unknown as WorkerConfig;
}

const fakeProvider: EmbeddingProvider = {
  provider: 'openai_compatible',
  model: 'fake-embed-model',
  dimensions: VECTOR_DIMENSIONS,
  embed: () => Promise.reject(new Error('the fake provider must not be called here')),
};

const fakeChat: ChatProvider = {
  provider: 'openai_compatible',
  model: 'fake-analysis-model',
  stream: () => {
    throw new Error('the fake provider must not be called here');
  },
};

describe('buildHandlers', () => {
  it('registers exactly index_document, analyze_conversation and cleanup', () => {
    const handlers = buildHandlers(config(embeddingConfig()), {
      embeddings: fakeProvider,
      analysis: fakeChat,
    });
    expect(Object.keys(handlers).sort()).toEqual([
      'analyze_conversation',
      'cleanup',
      'index_document',
    ]);
    expect(handlers.index_document).toBeTypeOf('function');
    expect(handlers.analyze_conversation).toBeTypeOf('function');
    expect(handlers.cleanup).toBeTypeOf('function');
  });

  it('builds the adapters from the worker AI config when none is injected', () => {
    const handlers = buildHandlers(config(embeddingConfig()));
    expect(Object.keys(handlers).sort()).toEqual([
      'analyze_conversation',
      'cleanup',
      'index_document',
    ]);
  });

  it.each(['gemini', 'openai'] as const)('builds a %s adapter from config', (provider) => {
    const handlers = buildHandlers(config(embeddingConfig({ provider, baseUrl: null })));
    expect(handlers.index_document).toBeTypeOf('function');
  });

  it('fails closed when the configured provider has no embeddings API', () => {
    expect(() =>
      buildHandlers(config(embeddingConfig({ provider: 'anthropic', baseUrl: null }))),
    ).toThrow();
  });

  it('fails closed on a dimension other than 1536', () => {
    expect(() => buildHandlers(config(embeddingConfig({ dimensions: 768 })))).toThrow();
  });

  it('does not require an adapter config when providers are injected', () => {
    expect(() =>
      buildHandlers({ ai: undefined } as unknown as WorkerConfig, {
        embeddings: fakeProvider,
        analysis: fakeChat,
      }),
    ).not.toThrow();
  });
});

function warmingConfig(over: Partial<WarmingConfig> = {}): WarmingConfig {
  return {
    ai: undefined as never,
    chatProvider: 'openai_compatible',
    chatModel: 'fake-warm-chat',
    moderationProvider: 'openai_compatible',
    moderationModel: 'fake-warm-mod',
    contextMaxTokens: 4000,
    maxOutputTokens: 256,
    maxOutputChars: 2000,
    topK: 5,
    minSimilarity: 0.5,
    deadlineMs: 10000,
    reserveTtlSeconds: 300,
    moderationMaxChars: 4000,
    embeddingPricePerMillionTokens: 0.1,
    chatPrice: { inputPerMillion: 0.1, outputPerMillion: 0.4 },
    moderationPrice: { inputPerMillion: 0.1, outputPerMillion: 0.8 },
    chatModelKey: 'openai_compatible/fake-warm-chat',
    moderationModelKey: 'openai_compatible/fake-warm-mod/llm_classifier',
    moderationMode: 'llm_classifier',
    ...over,
  };
}

const fakeWarmChat: ChatProvider = {
  provider: 'openai_compatible',
  model: 'fake-warm-chat',
  stream: () => {
    throw new Error('the fake provider must not be called here');
  },
};

const fakeWarmModeration: ModerationProvider = {
  provider: 'openai_compatible',
  model: 'fake-warm-mod',
  moderate: () => Promise.reject(new Error('the fake provider must not be called here')),
};

describe('buildHandlers warming (T13)', () => {
  it('leaves warming unregistered without a warming config', () => {
    for (const warming of [undefined, null] as const) {
      const handlers = buildHandlers(config(embeddingConfig()), {
        embeddings: fakeProvider,
        analysis: fakeChat,
        ...(warming === undefined ? {} : { warming }),
      });
      expect(Object.keys(handlers).sort()).toEqual([
        'analyze_conversation',
        'cleanup',
        'index_document',
      ]);
      expect('warm_answer_cache' in handlers).toBe(false);
    }
  });

  it('registers the real warm handler with injected labelled fakes', () => {
    const handlers = buildHandlers(config(embeddingConfig()), {
      embeddings: fakeProvider,
      analysis: fakeChat,
      warming: warmingConfig(),
      warmChat: fakeWarmChat,
      warmModeration: fakeWarmModeration,
    });
    expect(Object.keys(handlers).sort()).toEqual([
      'analyze_conversation',
      'cleanup',
      'index_document',
      'warm_answer_cache',
    ]);
    expect(handlers.warm_answer_cache).toBeTypeOf('function');
  });

  it('builds warming adapters from the worker vendor keys when none is injected', () => {
    const handlers = buildHandlers(config(embeddingConfig()), {
      warming: warmingConfig(),
      warmChat: fakeWarmChat,
      warmModeration: fakeWarmModeration,
    });
    expect(handlers.warm_answer_cache).toBeTypeOf('function');
  });

  it('builds real warming adapters without calling any provider', () => {
    const handlers = buildHandlers(config(embeddingConfig()), {
      warming: warmingConfig(),
    });
    expect(handlers.warm_answer_cache).toBeTypeOf('function');
  });

  it('fails closed when the warming chat vendor has no worker key', () => {
    let caught: unknown;
    try {
      buildHandlers(config(embeddingConfig()), {
        warming: warmingConfig({ chatProvider: 'gemini', chatModelKey: 'gemini/fake' }),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).variables).toContain('WARM_CHAT_PROVIDER');
  });

  it('fails closed when endpoint moderation has no openai key', () => {
    let caught: unknown;
    try {
      buildHandlers(config(embeddingConfig()), {
        warming: warmingConfig({
          moderationProvider: 'openai',
          moderationModel: 'omni-moderation-latest',
          moderationMode: 'endpoint',
          moderationModelKey: 'openai/omni-moderation-latest/endpoint',
        }),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).variables).toContain('WARM_MODERATION_PROVIDER');
  });
});
