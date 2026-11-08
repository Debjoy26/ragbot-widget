import { VECTOR_DIMENSIONS, type EmbeddingConfig, type EmbeddingProvider } from '@ragbot/shared';
import { describe, expect, it } from 'vitest';
import { buildHandlers } from '../../../worker/src/handlers.ts';
import type { WorkerConfig } from '../../../worker/src/lib/config.ts';

// P6-INDEX: the handler registry. Labelled fakes only; nothing here calls a provider.

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

function config(embedding: EmbeddingConfig): WorkerConfig {
  return { ai: { embedding } } as unknown as WorkerConfig;
}

const fakeProvider: EmbeddingProvider = {
  provider: 'openai_compatible',
  model: 'fake-embed-model',
  dimensions: VECTOR_DIMENSIONS,
  embed: () => Promise.reject(new Error('the fake provider must not be called here')),
};

describe('buildHandlers', () => {
  it('registers exactly index_document and cleanup', () => {
    const handlers = buildHandlers(config(embeddingConfig()), { embeddings: fakeProvider });
    expect(Object.keys(handlers).sort()).toEqual(['cleanup', 'index_document']);
    expect(handlers.index_document).toBeTypeOf('function');
    expect(handlers.cleanup).toBeTypeOf('function');
  });

  it('builds the adapter from the worker AI config when none is injected', () => {
    const handlers = buildHandlers(config(embeddingConfig()));
    expect(Object.keys(handlers).sort()).toEqual(['cleanup', 'index_document']);
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

  it('does not require an adapter config when a provider is injected', () => {
    expect(() =>
      buildHandlers({ ai: undefined } as unknown as WorkerConfig, { embeddings: fakeProvider }),
    ).not.toThrow();
  });
});
