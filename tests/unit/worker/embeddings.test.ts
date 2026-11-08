import { randomBytes } from 'node:crypto';
import {
  isRetryableErrorKind,
  ProviderError,
  VECTOR_DIMENSIONS,
  type EmbeddingConfig,
  type ProviderKind,
} from '@ragbot/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createEmbeddingProvider,
  GEMINI_MAX_BATCH,
  kindForStatus,
} from '../../../worker/src/lib/embeddings.ts';

// P6-INDEX: embedding adapters against a labelled FAKE fetch. No network, no real provider.

const FAKE_KEY = `fake-key-${randomBytes(8).toString('hex')}`;
const SENTINEL_BODY = `upstream-body-${randomBytes(6).toString('hex')}`;
const SENTINEL_TEXT = `input-text-${randomBytes(6).toString('hex')}`;

function config(provider: ProviderKind, over: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    role: 'embedding',
    provider,
    model: 'fake-embed-model',
    apiKey: FAKE_KEY,
    baseUrl: provider === 'openai_compatible' ? 'http://127.0.0.1:9999' : null,
    dimensions: VECTOR_DIMENSIONS,
    ...over,
  };
}

function vec(seed = 0): number[] {
  return Array.from({ length: VECTOR_DIMENSIONS }, (_, i) => ((i + seed) % 5) / 10);
}

interface Seen {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (seen: Seen, n: number) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    const s: Seen = {
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    seen.push(s);
    return Promise.resolve(respond(s, seen.length));
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function geminiBody(n: number): unknown {
  return { embeddings: Array.from({ length: n }, (_, i) => ({ values: vec(i) })) };
}

function openAiBody(n: number, usage: unknown = { prompt_tokens: 7, total_tokens: 7 }): unknown {
  return {
    data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: vec(i) })),
    usage,
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
}

function expectNoLeak(err: unknown): void {
  const text = err instanceof Error ? `${err.message} ${String(err.cause)} ${err.stack}` : '';
  expect(text).not.toContain(FAKE_KEY);
  expect(text).not.toContain(SENTINEL_BODY);
  expect(text).not.toContain(SENTINEL_TEXT);
  expect(text).not.toContain('127.0.0.1');
  expect(text).not.toContain('generativelanguage');
}

describe('createEmbeddingProvider: creation', () => {
  it('refuses anthropic (no embeddings API)', () => {
    expect(() => createEmbeddingProvider(config('anthropic'))).toThrow(/anthropic/);
  });

  it('refuses a dimension other than 1536', () => {
    expect(() => createEmbeddingProvider(config('openai', { dimensions: 768 }))).toThrow(/1536/);
  });

  it('refuses openai_compatible without a base URL', () => {
    expect(() => createEmbeddingProvider(config('openai_compatible', { baseUrl: null }))).toThrow();
  });

  it('refuses a non-positive timeout', () => {
    expect(() => createEmbeddingProvider(config('openai'), { timeoutMs: 0 })).toThrow();
  });

  it.each(['gemini', 'openai', 'openai_compatible'] as const)(
    '%s reports provider, model and 1536 dimensions',
    (kind) => {
      const p = createEmbeddingProvider(config(kind), {
        fetchImpl: fakeFetch(() => json({})).fetchImpl,
      });
      expect(p).toMatchObject({ provider: kind, model: 'fake-embed-model', dimensions: 1536 });
    },
  );
});

describe('gemini adapter', () => {
  it('posts batchEmbedContents with the key in a header only, dimensions 1536 and the right task type', async () => {
    const { fetchImpl, seen } = fakeFetch((s) =>
      json(geminiBody((s.body['requests'] as unknown[]).length)),
    );
    const p = createEmbeddingProvider(config('gemini'), { fetchImpl });
    const out = await p.embed(['alpha', 'beta'], { taskType: 'document' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/fake-embed-model:batchEmbedContents',
    );
    expect(seen[0]?.url).not.toContain(FAKE_KEY);
    expect((seen[0]?.init.headers as Record<string, string>)['x-goog-api-key']).toBe(FAKE_KEY);
    expect(seen[0]?.init.method).toBe('POST');
    expect(seen[0]?.init.redirect).toBe('error');
    expect(seen[0]?.body['requests']).toEqual([
      {
        model: 'models/fake-embed-model',
        content: { parts: [{ text: 'alpha' }] },
        taskType: 'RETRIEVAL_DOCUMENT',
        outputDimensionality: 1536,
      },
      {
        model: 'models/fake-embed-model',
        content: { parts: [{ text: 'beta' }] },
        taskType: 'RETRIEVAL_DOCUMENT',
        outputDimensionality: 1536,
      },
    ]);
    expect(out.vectors).toEqual([vec(0), vec(1)]);
    expect(out.inputTokens).toBeNull();
  });

  it('uses RETRIEVAL_QUERY for query embeddings and strips a models/ prefix from the model', async () => {
    const { fetchImpl, seen } = fakeFetch(() => json(geminiBody(1)));
    const p = createEmbeddingProvider(config('gemini', { model: 'models/gemini-embedding-001' }), {
      fetchImpl,
    });
    await p.embed(['q'], { taskType: 'query' });
    expect(seen[0]?.url).toContain('/models/gemini-embedding-001:batchEmbedContents');
    expect((seen[0]?.body['requests'] as { taskType: string }[])[0]?.taskType).toBe(
      'RETRIEVAL_QUERY',
    );
  });

  it('splits more than 100 inputs into several calls and keeps the order', async () => {
    const { fetchImpl, seen } = fakeFetch((s) =>
      json({
        embeddings: (s.body['requests'] as { content: { parts: { text: string }[] } }[]).map(
          (r) => ({ values: vec(Number(r.content.parts[0]?.text)) }),
        ),
      }),
    );
    const p = createEmbeddingProvider(config('gemini'), { fetchImpl });
    const texts = Array.from({ length: GEMINI_MAX_BATCH + 5 }, (_, i) => String(i));
    const out = await p.embed(texts, { taskType: 'document' });
    expect(seen).toHaveLength(2);
    expect(out.vectors).toHaveLength(texts.length);
    expect(out.vectors[0]).toEqual(vec(0));
    expect(out.vectors[104]).toEqual(vec(104));
  });

  it('rejects a wrong-length vector as permanent', async () => {
    const { fetchImpl } = fakeFetch(() => json({ embeddings: [{ values: [0.1, 0.2, 0.3] }] }));
    const p = createEmbeddingProvider(config('gemini'), { fetchImpl });
    const err = await failure(p.embed(['a'], { taskType: 'document' }));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('permanent');
  });

  it('rejects a wrong vector count as permanent', async () => {
    const { fetchImpl } = fakeFetch(() => json(geminiBody(1)));
    const p = createEmbeddingProvider(config('gemini'), { fetchImpl });
    const err = await failure(p.embed(['a', 'b'], { taskType: 'document' }));
    expect((err as ProviderError).kind).toBe('permanent');
  });

  it('rejects a response of the wrong shape as permanent', async () => {
    const { fetchImpl } = fakeFetch(() => json({ nope: true }));
    const p = createEmbeddingProvider(config('gemini'), { fetchImpl });
    expect(((await failure(p.embed(['a'], { taskType: 'document' }))) as ProviderError).kind).toBe(
      'permanent',
    );
  });

  it('rejects a vector with a non-numeric element as permanent', async () => {
    const bad = vec();
    (bad as unknown[])[5] = null;
    const { fetchImpl } = fakeFetch(() => json({ embeddings: [{ values: bad }] }));
    const p = createEmbeddingProvider(config('gemini'), { fetchImpl });
    expect(((await failure(p.embed(['a'], { taskType: 'document' }))) as ProviderError).kind).toBe(
      'permanent',
    );
  });

  it('returns nothing for no input without calling the provider', async () => {
    const { fetchImpl, seen } = fakeFetch(() => json({}));
    const p = createEmbeddingProvider(config('gemini'), { fetchImpl });
    expect((await p.embed([], { taskType: 'document' })).vectors).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});

describe('openai and openai_compatible adapters', () => {
  it('openai posts to /v1/embeddings with a bearer header, dimensions 1536 and the usage count', async () => {
    const { fetchImpl, seen } = fakeFetch((s) =>
      json(openAiBody((s.body['input'] as string[]).length)),
    );
    const p = createEmbeddingProvider(config('openai'), { fetchImpl });
    const out = await p.embed(['a', 'b', 'c'], { taskType: 'document' });
    expect(seen[0]?.url).toBe('https://api.openai.com/v1/embeddings');
    expect(seen[0]?.url).not.toContain(FAKE_KEY);
    expect((seen[0]?.init.headers as Record<string, string>)['authorization']).toBe(
      `Bearer ${FAKE_KEY}`,
    );
    expect(seen[0]?.body).toMatchObject({
      model: 'fake-embed-model',
      input: ['a', 'b', 'c'],
      dimensions: 1536,
    });
    expect(out.vectors).toEqual([vec(0), vec(1), vec(2)]);
    expect(out.inputTokens).toBe(7);
  });

  it('puts vectors back in input order using the provider index', async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({
        data: [
          { index: 2, embedding: vec(2) },
          { index: 0, embedding: vec(0) },
          { index: 1, embedding: vec(1) },
        ],
      }),
    );
    const p = createEmbeddingProvider(config('openai'), { fetchImpl });
    const out = await p.embed(['a', 'b', 'c'], { taskType: 'document' });
    expect(out.vectors).toEqual([vec(0), vec(1), vec(2)]);
    expect(out.inputTokens).toBeNull();
  });

  it.each([
    ['a duplicated index', [{ index: 0 }, { index: 0 }]],
    ['an out-of-range index', [{ index: 0 }, { index: 5 }]],
    ['a missing index field', [{ index: 0 }, {}]],
  ])('%s is permanent', async (_n, items) => {
    const { fetchImpl } = fakeFetch(() =>
      json({ data: items.map((i) => ({ ...i, embedding: vec() })) }),
    );
    const p = createEmbeddingProvider(config('openai'), { fetchImpl });
    const err = await failure(p.embed(['a', 'b'], { taskType: 'document' }));
    expect((err as ProviderError).kind).toBe('permanent');
  });

  it('rejects a wrong-length vector as permanent', async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ data: [{ index: 0, embedding: vec().slice(0, 1535) }] }),
    );
    const p = createEmbeddingProvider(config('openai'), { fetchImpl });
    const err = await failure(p.embed(['a'], { taskType: 'document' }));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('permanent');
  });

  it('rejects a longer-than-1536 vector as permanent', async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ data: [{ index: 0, embedding: [...vec(), 0.5] }] }),
    );
    const p = createEmbeddingProvider(config('openai_compatible'), { fetchImpl });
    expect(((await failure(p.embed(['a'], { taskType: 'document' }))) as ProviderError).kind).toBe(
      'permanent',
    );
  });

  it('rejects fewer vectors than inputs as permanent', async () => {
    const { fetchImpl } = fakeFetch(() => json(openAiBody(1)));
    const p = createEmbeddingProvider(config('openai'), { fetchImpl });
    expect(
      ((await failure(p.embed(['a', 'b'], { taskType: 'document' }))) as ProviderError).kind,
    ).toBe('permanent');
  });

  it('openai_compatible uses its base URL plus /v1/embeddings (http only on loopback)', async () => {
    const { fetchImpl, seen } = fakeFetch(() => json(openAiBody(1)));
    const p = createEmbeddingProvider(config('openai_compatible'), { fetchImpl });
    await p.embed(['a'], { taskType: 'document' });
    expect(seen[0]?.url).toBe('http://127.0.0.1:9999/v1/embeddings');
    expect((seen[0]?.init.headers as Record<string, string>)['authorization']).toBe(
      `Bearer ${FAKE_KEY}`,
    );
  });

  it('openai_compatible does not double the /v1 segment', async () => {
    const { fetchImpl, seen } = fakeFetch(() => json(openAiBody(1)));
    const p = createEmbeddingProvider(
      config('openai_compatible', { baseUrl: 'https://llm.example.test/v1' }),
      { fetchImpl },
    );
    await p.embed(['a'], { taskType: 'document' });
    expect(seen[0]?.url).toBe('https://llm.example.test/v1/embeddings');
  });
});

describe.each(['gemini', 'openai', 'openai_compatible'] as const)('%s error mapping', (kind) => {
  const run = (status: number, headers: Record<string, string> = {}): Promise<unknown> => {
    const { fetchImpl } = fakeFetch(
      () => new Response(`{"error":"${SENTINEL_BODY}"}`, { status, headers }),
    );
    const p = createEmbeddingProvider(config(kind), { fetchImpl });
    return failure(p.embed([SENTINEL_TEXT], { taskType: 'document' }));
  };

  it.each([
    [429, 'rate_limited'],
    [500, 'transient'],
    [502, 'transient'],
    [503, 'transient'],
    [408, 'transient'],
    [401, 'auth'],
    [403, 'auth'],
    [402, 'billing'],
    [400, 'permanent'],
    [404, 'permanent'],
    [422, 'permanent'],
  ] as const)(
    'HTTP %i maps to %s without leaking the key, text or body',
    async (status, expected) => {
      const err = await run(status);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe(expected);
      expect((err as ProviderError).isRetryable()).toBe(isRetryableErrorKind(expected));
      expectNoLeak(err);
    },
  );

  it('reads Retry-After (seconds, capped) on a 429', async () => {
    expect(((await run(429, { 'retry-after': '17' })) as ProviderError).retryAfterSeconds).toBe(17);
    expect(((await run(429, { 'retry-after': '999999' })) as ProviderError).retryAfterSeconds).toBe(
      3600,
    );
    expect(
      ((await run(429, { 'retry-after': 'soon' })) as ProviderError).retryAfterSeconds,
    ).toBeNull();
  });

  it('maps a network error to transient without leaking its message', async () => {
    const fetchImpl = (() =>
      Promise.reject(
        new TypeError(`connect ECONNREFUSED 127.0.0.1 ${FAKE_KEY} ${SENTINEL_TEXT}`),
      )) as typeof fetch;
    const p = createEmbeddingProvider(config(kind), { fetchImpl });
    const err = await failure(p.embed(['a'], { taskType: 'document' }));
    expect((err as ProviderError).kind).toBe('transient');
    expectNoLeak(err);
  });

  it('maps a malformed JSON 200 to transient', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('<html>gateway</html>', { status: 200 }));
    const p = createEmbeddingProvider(config(kind), { fetchImpl });
    expect(((await failure(p.embed(['a'], { taskType: 'document' }))) as ProviderError).kind).toBe(
      'transient',
    );
  });

  it('times out as transient when the provider never answers', async () => {
    const fetchImpl = ((_u: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as unknown as typeof fetch;
    const p = createEmbeddingProvider(config(kind), { fetchImpl, timeoutMs: 25 });
    const err = await failure(p.embed(['a'], { taskType: 'document' }));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('transient');
  });

  it('surfaces a caller abort as an AbortError, not a provider error', async () => {
    const controller = new AbortController();
    const fetchImpl = ((_u: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as unknown as typeof fetch;
    const p = createEmbeddingProvider(config(kind), { fetchImpl });
    const pending = failure(p.embed(['a'], { taskType: 'document', signal: controller.signal }));
    controller.abort();
    const err = await pending;
    expect(err).not.toBeInstanceOf(ProviderError);
    expect((err as Error).name).toBe('AbortError');
  });

  it('does not call fetch when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(() => Promise.resolve(json({})));
    const p = createEmbeddingProvider(config(kind), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await failure(p.embed(['a'], { taskType: 'document', signal: controller.signal }));
    expect(err).not.toBeInstanceOf(ProviderError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('kindForStatus', () => {
  it('classifies the boundaries', () => {
    expect(kindForStatus(499)).toBe('permanent');
    expect(kindForStatus(500)).toBe('transient');
    expect(kindForStatus(599)).toBe('transient');
    expect(kindForStatus(429)).toBe('rate_limited');
  });
});
