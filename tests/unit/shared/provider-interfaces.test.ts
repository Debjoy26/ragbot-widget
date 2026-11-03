import { describe, expect, it } from 'vitest';
import {
  PROVIDER_ERROR_KINDS,
  ProviderError,
  VECTOR_DIMENSIONS,
  assertEmbeddingShape,
  isRetryableErrorKind,
  type ChatProvider,
  type EmbeddingProvider,
  type ModerationProvider,
} from '@ragbot/shared';

describe('ProviderError.isRetryable', () => {
  it.each([
    ['transient', true],
    ['rate_limited', true],
    ['auth', false],
    ['billing', false],
    ['permanent', false],
  ] as const)('%s -> %s', (kind, retryable) => {
    expect(new ProviderError(kind, 'x').isRetryable()).toBe(retryable);
    expect(isRetryableErrorKind(kind)).toBe(retryable);
  });

  it('covers every kind in the truth table', () => {
    expect([...PROVIDER_ERROR_KINDS]).toEqual([
      'transient',
      'rate_limited',
      'auth',
      'billing',
      'permanent',
    ]);
  });

  it('keeps kind, retry hint and cause, and is an Error', () => {
    const cause = new Error('inner');
    const e = new ProviderError('rate_limited', 'slow down', { retryAfterSeconds: 12, cause });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ProviderError');
    expect(e.kind).toBe('rate_limited');
    expect(e.retryAfterSeconds).toBe(12);
    expect(e.cause).toBe(cause);
    expect(new ProviderError('auth', 'x').retryAfterSeconds).toBeNull();
  });
});

describe('provider interfaces (fakes only)', () => {
  const vec = () => new Array<number>(VECTOR_DIMENSIONS).fill(0.1);

  it('lets a fake chat provider stream chunks and return usage', async () => {
    const fake: ChatProvider = {
      provider: 'gemini',
      model: 'fake-model',
      async *stream(request) {
        for (const text of ['Hel', 'lo']) {
          if (request.signal?.aborted) throw new ProviderError('transient', 'aborted');
          yield { text };
        }
        return { inputTokens: 10, outputTokens: 2 };
      },
    };
    const stream = fake.stream({ system: 's', messages: [], maxOutputTokens: 10 });
    let out = '';
    let next = await stream.next();
    while (!next.done) {
      out += next.value.text;
      next = await stream.next();
    }
    expect(out).toBe('Hello');
    expect(next.value).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  it('lets fake embedding/moderation providers satisfy the interfaces', async () => {
    const embed: EmbeddingProvider = {
      provider: 'gemini',
      model: 'fake-embed',
      dimensions: VECTOR_DIMENSIONS,
      embed: async (texts) => ({ vectors: texts.map(vec), inputTokens: texts.length }),
    };
    const moderation: ModerationProvider = {
      provider: 'openai',
      model: 'fake-mod',
      moderate: async () => ({ verdict: 'allow', categories: [], usage: null }),
    };
    const { vectors, inputTokens } = await embed.embed(['a', 'b'], { taskType: 'document' });
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(1536);
    expect(inputTokens).toBe(2);
    expect((await moderation.moderate('hi')).verdict).toBe('allow');
  });

  it('assertEmbeddingShape rejects wrong counts, dimensions and non-finite values', () => {
    expect(() => assertEmbeddingShape([vec()], 1)).not.toThrow();
    expect(() => assertEmbeddingShape([vec()], 2)).toThrow(ProviderError);
    expect(() => assertEmbeddingShape([[0.1, 0.2]], 1)).toThrow(ProviderError);
    const nan = vec();
    nan[3] = Number.NaN;
    expect(() => assertEmbeddingShape([nan], 1)).toThrow(ProviderError);
  });
});
