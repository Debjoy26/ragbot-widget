import { describe, expect, it } from 'vitest';
import {
  CHAT_REQUEST_TIMEOUT_MS,
  createChatProvider,
  MAX_CHAT_STREAM_BYTES,
} from '../../../shared/src/ai/index.ts';
import {
  isRetryableErrorKind,
  ProviderError,
  type ChatStreamRequest,
  type ProviderErrorKind,
} from '../../../shared/src/providers.ts';
import {
  allKeys,
  bodyOf,
  bytePieces,
  collect,
  collectError,
  config,
  exposed,
  FAKE_BASE_HOST,
  FAKE_KEY,
  fakeFetch,
  FLAVOURS,
  hangingFetch,
  render,
  SAMPLING_KEY,
  SENTINEL_BODY,
  SENTINEL_PROMPT,
  sseResponse,
  type BodyProbe,
  type Flavour,
} from './helpers.ts';

// P7-AI: streaming chat adapters against a labelled FAKE fetch. No network, no real provider.

const SYSTEM = `system-prompt-${SENTINEL_PROMPT}`;

function request(over: Partial<ChatStreamRequest> = {}): ChatStreamRequest {
  return {
    system: SYSTEM,
    messages: [
      { role: 'user', content: `first question ${SENTINEL_PROMPT}` },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ],
    maxOutputTokens: 321,
    ...over,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError' && !(error instanceof ProviderError);
}

function expectProviderError(
  error: unknown,
  kind: ProviderErrorKind,
  billed: boolean,
): ProviderError {
  expect(error).toBeInstanceOf(ProviderError);
  const err = error as ProviderError;
  expect(err.kind).toBe(kind);
  expect(err.billed).toBe(billed);
  return err;
}

/** Nothing sensitive in what an error exposes. */
function expectClean(error: unknown): void {
  const text = exposed(error);
  for (const secret of [
    FAKE_KEY,
    SENTINEL_PROMPT,
    SENTINEL_BODY,
    FAKE_BASE_HOST,
    'https://',
    'googleapis',
    'api.openai.com',
    'api.anthropic.com',
  ]) {
    expect(text).not.toContain(secret);
  }
  expect((error as Error).cause).toBeUndefined();
}

describe('createChatProvider construction', () => {
  it('reports provider and model', () => {
    for (const f of FLAVOURS) {
      const p = createChatProvider(f.config(), { fetch: fakeFetch(() => new Response()).fetch });
      expect(p.provider).toBe(f.name);
      expect(p.model).toBe('fake-chat-model');
    }
  });

  it('refuses openai_compatible without a base URL', () => {
    expect(() => createChatProvider(config('openai_compatible', { baseUrl: null }))).toThrow(
      'base URL',
    );
  });

  it('refuses a non-positive or fractional timeout and accepts a sane one', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => createChatProvider(config('gemini'), { requestTimeoutMs: bad })).toThrow();
    }
    expect(() => createChatProvider(config('gemini'), { requestTimeoutMs: 5 })).not.toThrow();
    expect(CHAT_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('refuses a bad request synchronously and sends nothing', () => {
    const { fetch, seen } = fakeFetch(() => sseResponse([]));
    const p = createChatProvider(config('gemini'), { fetch });
    expect(() => p.stream(request({ maxOutputTokens: 0 }))).toThrow(RangeError);
    expect(() => p.stream(request({ maxOutputTokens: 1.5 }))).toThrow(RangeError);
    expect(() => p.stream(request({ messages: [] }))).toThrow(RangeError);
    expect(seen).toHaveLength(0);
  });

  it('sends nothing until the stream is read', async () => {
    const { fetch, seen } = fakeFetch(() => sseResponse([]));
    createChatProvider(config('gemini'), { fetch }).stream(request());
    await Promise.resolve();
    expect(seen).toHaveLength(0);
  });
});

describe.each(FLAVOURS)('chat stream, $name', (f: Flavour) => {
  function provider(
    respond: Parameters<typeof fakeFetch>[0],
    requestTimeoutMs?: number,
  ): { p: ReturnType<typeof createChatProvider>; seen: ReturnType<typeof fakeFetch>['seen'] } {
    const { fetch, seen } = fakeFetch(respond);
    const p = createChatProvider(f.config(), {
      fetch,
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    });
    return { p, seen };
  }

  const reply = (): string => render(f.reply(['Hel', 'lo ', 'wörld'], { in: 11, out: 7 }));

  describe('success', () => {
    it('streams text in order and returns the reported usage', async () => {
      const { p } = provider(() => sseResponse([reply()]));
      const out = await collect(p.stream(request()));
      expect(out.texts.join('')).toBe('Hello wörld');
      expect(out.texts).toEqual(['Hel', 'lo ', 'wörld']);
      expect(out.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    });

    it('yields chunks as they arrive, before the stream has ended', async () => {
      const events = f.reply(['one', 'two'], { in: 1, out: 1 });
      const head = render(events.slice(0, events.length - 2));
      const { p } = provider(() => sseResponse([head], { hang: true }));
      const stream = p.stream(request());
      const first = await stream.next();
      expect(first.done).toBe(false);
      await stream.return({ inputTokens: 0, outputTokens: 0 });
    });

    it('survives chunks split mid-line, mid-JSON and mid-character', async () => {
      for (const size of [1, 2, 3, 7, 13]) {
        const { p } = provider(() => sseResponse(bytePieces(reply(), size)));
        const out = await collect(p.stream(request()));
        expect(out.texts.join('')).toBe('Hello wörld');
        expect(out.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
      }
    });

    it('reads CRLF line ends, including a CRLF split between two chunks', async () => {
      const crlf = render(f.reply(['a', 'b'], { in: 2, out: 3 }), '\r\n');
      for (const body of [[crlf], bytePieces(crlf, 1), bytePieces(crlf, 5)]) {
        const { p } = provider(() => sseResponse(body));
        const out = await collect(p.stream(request()));
        expect(out.texts.join('')).toBe('ab');
        expect(out.usage).toEqual({ inputTokens: 2, outputTokens: 3 });
      }
    });

    it('ignores comment lines and keep-alives', async () => {
      const body = `: keep-alive\n\n${reply().replace(/\n\n/g, '\n\n: ping comment\n')}`;
      const { p } = provider(() => sseResponse([body]));
      const out = await collect(p.stream(request()));
      expect(out.texts.join('')).toBe('Hello wörld');
    });

    it('delivers a final event that has no closing blank line', async () => {
      const { p } = provider(() => sseResponse([reply().replace(/\n+$/, '')]));
      const out = await collect(p.stream(request()));
      expect(out.texts.join('')).toBe('Hello wörld');
      expect(out.usage.outputTokens).toBe(7);
    });

    it('accepts a well-formed reply that has no text at all', async () => {
      const { p } = provider(() => sseResponse([render(f.reply([], { in: 4, out: 0 }))]));
      const out = await collect(p.stream(request()));
      expect(out.texts).toEqual([]);
      expect(out.usage.inputTokens).toBe(4);
    });

    it('estimates usage, at 1 token per 3 characters, when the provider reports none', async () => {
      const { p } = provider(() => sseResponse([render(f.noUsage(['abcdefghi']))]));
      const req = request();
      const out = await collect(p.stream(req));
      const inputChars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
      expect(out.usage).toEqual({
        inputTokens: Math.ceil(inputChars / 3),
        outputTokens: 3,
      });
    });
  });

  describe('request', () => {
    it('posts to the expected URL with the key in a header, never in the URL', async () => {
      const { p, seen } = provider(() => sseResponse([reply()]));
      await collect(p.stream(request()));
      expect(seen).toHaveLength(1);
      const s = seen[0];
      expect(s?.url).toBe(f.expectedUrl);
      expect(s?.url).not.toContain(FAKE_KEY);
      expect(s?.init.method).toBe('POST');
      expect(s?.init.redirect).toBe('error');
      expect(s?.init.signal).toBeInstanceOf(AbortSignal);
      expect(s?.headers[f.keyHeader]).toContain(FAKE_KEY);
      expect(s?.headers['content-type']).toBe('application/json');
    });

    it('sends no sampling parameters anywhere in the body', async () => {
      const { p, seen } = provider(() => sseResponse([reply()]));
      await collect(p.stream(request()));
      const keys = allKeys(seen[0]?.body);
      expect(keys.filter((k) => SAMPLING_KEY.test(k))).toEqual([]);
    });

    it('puts the system prompt and the messages in the provider-specific places', async () => {
      const { p, seen } = provider(() => sseResponse([reply()]));
      await collect(p.stream(request()));
      const body = seen[0]?.body as Record<string, unknown>;
      const text = JSON.stringify(body);
      // The system prompt is sent exactly once.
      expect(text.split(SYSTEM)).toHaveLength(2);
      if (f.name === 'gemini') {
        expect(body['systemInstruction']).toEqual({ parts: [{ text: SYSTEM }] });
        expect(body['generationConfig']).toEqual({ maxOutputTokens: 321 });
        const contents = body['contents'] as { role: string; parts: { text: string }[] }[];
        expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
        expect(contents[1]?.parts).toEqual([{ text: 'first answer' }]);
        expect(body).not.toHaveProperty('model');
      } else if (f.name === 'anthropic') {
        expect(body['system']).toBe(SYSTEM);
        expect(body['max_tokens']).toBe(321);
        expect(body['stream']).toBe(true);
        expect(body['model']).toBe('fake-chat-model');
        const messages = body['messages'] as { role: string; content: string }[];
        expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        expect(messages[2]?.content).toBe('second question');
        expect(seen[0]?.headers['anthropic-version']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      } else {
        const messages = body['messages'] as { role: string; content: string }[];
        expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
        expect(messages[0]?.content).toBe(SYSTEM);
        expect(body['stream']).toBe(true);
        expect(body['stream_options']).toEqual({ include_usage: true });
        expect(body['model']).toBe('fake-chat-model');
        if (f.name === 'openai') {
          expect(body['max_completion_tokens']).toBe(321);
          expect(body).not.toHaveProperty('max_tokens');
        } else {
          expect(body['max_tokens']).toBe(321);
          expect(body).not.toHaveProperty('max_completion_tokens');
        }
      }
    });
  });

  describe('HTTP errors (before any 2xx: not billed)', () => {
    const table: [number, ProviderErrorKind][] = [
      [400, 'permanent'],
      [401, 'auth'],
      [402, 'billing'],
      [403, 'auth'],
      [404, 'permanent'],
      [408, 'transient'],
      [413, 'permanent'],
      [422, 'permanent'],
      [429, 'rate_limited'],
      [500, 'transient'],
      [502, 'transient'],
      [503, 'transient'],
      [529, 'transient'],
    ];
    it.each(table)('status %i is %s, not billed, and leaks nothing', async (status, kind) => {
      const { p } = provider(
        () =>
          new Response(`{"error":"${SENTINEL_BODY}"}`, { status, headers: { 'retry-after': '7' } }),
      );
      const { error } = await collectError(p.stream(request()));
      const err = expectProviderError(error, kind, false);
      expect(err.message).toBe(`chat provider returned HTTP ${String(status)}`);
      expect(err.retryAfterSeconds).toBe(7);
      expect(err.isRetryable()).toBe(isRetryableErrorKind(kind));
      expectClean(error);
    });

    it('ignores an invalid Retry-After and caps a huge one', async () => {
      for (const [raw, expected] of [
        ['abc', null],
        ['-4', null],
        ['999999', 3600],
      ] as const) {
        const { p } = provider(
          () => new Response('x', { status: 429, headers: { 'retry-after': raw } }),
        );
        const { error } = await collectError(p.stream(request()));
        expect(expectProviderError(error, 'rate_limited', false).retryAfterSeconds).toBe(expected);
      }
    });

    it('drains the error body without reading it into the error', async () => {
      const probe: BodyProbe = { cancelled: false };
      const { p } = provider(
        () => new Response(bodyOf([SENTINEL_BODY], { probe, hang: true }), { status: 500 }),
      );
      const { error } = await collectError(p.stream(request()));
      expectProviderError(error, 'transient', false);
      expect(probe.cancelled).toBe(true);
    });

    it('a network failure is transient, not billed, and exposes neither message nor cause', async () => {
      const { p } = provider(() => {
        throw new TypeError(`fetch failed ${FAKE_KEY} ${f.expectedUrl} ${SENTINEL_PROMPT}`, {
          cause: new Error(FAKE_KEY),
        });
      });
      const { error } = await collectError(p.stream(request()));
      const err = expectProviderError(error, 'transient', false);
      expect(err.message).toBe('chat request failed (network)');
      expectClean(error);
    });
  });

  describe('errors after a 2xx are billed', () => {
    it('an empty stream is transient and billed', async () => {
      const { p } = provider(() => sseResponse([]));
      const { error, texts } = await collectError(p.stream(request()));
      expectProviderError(error, 'transient', true);
      expect(texts).toEqual([]);
    });

    it('a response with no body is transient and billed', async () => {
      const { p } = provider(() => new Response(null, { status: 200 }));
      const { error } = await collectError(p.stream(request()));
      expectProviderError(error, 'transient', true);
    });

    it('a stream cut off after text, with no finish signal, is transient and billed', async () => {
      const { p } = provider(() => sseResponse([render(f.truncated(['partial ', 'answer']))]));
      const { error, texts } = await collectError(p.stream(request()));
      const err = expectProviderError(error, 'transient', true);
      expect(err.message).toBe('chat stream ended unexpectedly');
      expect(texts.join('')).toBe('partial answer');
    });

    it('a body that errors mid-stream is transient and billed, with no cause', async () => {
      const { p } = provider(() =>
        sseResponse([render(f.truncated(['partial']))], {
          fail: new Error(`socket reset ${FAKE_KEY} ${f.expectedUrl}`),
        }),
      );
      const { error, texts } = await collectError(p.stream(request()));
      const err = expectProviderError(error, 'transient', true);
      expect(err.message).toBe('chat response could not be read');
      expect(texts.join('')).toBe('partial');
      expectClean(error);
    });

    it('an error event after text is transient and billed, whatever it says', async () => {
      for (const kind of ['rate_limited', 'auth', 'billing', 'permanent', 'unknown'] as const) {
        const body = render([...f.truncated(['some text']), f.errorEvent(kind)]);
        const { p } = provider(() => sseResponse([body]));
        const { error, texts } = await collectError(p.stream(request()));
        const err = expectProviderError(error, 'transient', true);
        expect(err.message).toBe('chat provider reported a stream error');
        expect(texts.join('')).toBe('some text');
        expectClean(error);
      }
    });

    it('an error event before any text is classified from the event and billed', async () => {
      const expected: Record<string, ProviderErrorKind> = {
        rate_limited: 'rate_limited',
        auth: 'auth',
        billing: 'billing',
        permanent: 'permanent',
        unknown: 'transient',
      };
      for (const [kind, want] of Object.entries(expected)) {
        const body = render([f.errorEvent(kind as 'auth')]);
        const { p } = provider(() => sseResponse([body]));
        const { error } = await collectError(p.stream(request()));
        expectProviderError(error, want, true);
        expectClean(error);
      }
    });

    it('invalid JSON in an event is transient and billed', async () => {
      const { p } = provider(() => sseResponse([`data: {not json ${SENTINEL_BODY}\n\n`]));
      const { error } = await collectError(p.stream(request()));
      expectProviderError(error, 'transient', true);
      expectClean(error);
    });

    it('a JSON event that is not an object is transient and billed', async () => {
      const { p } = provider(() => sseResponse(['data: [1,2]\n\n']));
      const { error } = await collectError(p.stream(request()));
      expectProviderError(error, 'transient', true);
    });

    it('a stream larger than the cap is refused, cancelled, permanent and billed', async () => {
      const probe: BodyProbe = { cancelled: false };
      const filler = new Uint8Array(1024 * 1024).fill(0x61); // 1 MiB of "a": no newline, one endless line
      const chunks = Array.from(
        { length: MAX_CHAT_STREAM_BYTES / filler.length + 1 },
        () => filler,
      );
      const { p } = provider(() => sseResponse(chunks, { probe, hang: true }));
      const { error } = await collectError(p.stream(request()));
      const err = expectProviderError(error, 'permanent', true);
      expect(err.message).toBe('chat response is too large');
      expect(probe.cancelled).toBe(true);
    });

    it('a stream exactly at the cap is not refused for size', async () => {
      // Pad a valid reply with comment lines up to the cap.
      const text = reply();
      const pad = `: ${'x'.repeat(MAX_CHAT_STREAM_BYTES - new TextEncoder().encode(text).length - 4)}\n\n`;
      const total = new TextEncoder().encode(pad + text).length;
      expect(total).toBe(MAX_CHAT_STREAM_BYTES);
      const { p } = provider(() => sseResponse([pad, text]));
      const out = await collect(p.stream(request()));
      expect(out.texts.join('')).toBe('Hello wörld');
    });
  });

  describe('abort and timeout', () => {
    it('an abort before the call sends nothing and throws an AbortError', async () => {
      const { p, seen } = provider(() => sseResponse([reply()]));
      const controller = new AbortController();
      controller.abort(new Error(`custom reason ${FAKE_KEY}`));
      const { error } = await collectError(p.stream(request({ signal: controller.signal })));
      expect(isAbortError(error)).toBe(true);
      expect(exposed(error)).not.toContain(FAKE_KEY);
      expect(seen).toHaveLength(0);
    });

    it('an abort while waiting for the response throws an AbortError', async () => {
      const hang = hangingFetch();
      const p = createChatProvider(f.config(), { fetch: hang.fetch });
      const controller = new AbortController();
      const pending = collectError(p.stream(request({ signal: controller.signal })));
      await new Promise((r) => setTimeout(r, 5));
      controller.abort();
      const { error } = await pending;
      expect(isAbortError(error)).toBe(true);
    });

    it('an abort during the stream cancels the body and throws an AbortError', async () => {
      const probe: BodyProbe = { cancelled: false };
      const head = render(f.truncated(['first piece']));
      const { p } = provider(() => sseResponse([head], { hang: true, probe }));
      const controller = new AbortController();
      const stream = p.stream(request({ signal: controller.signal }));
      const first = await stream.next();
      expect(first.done).toBe(false);
      expect(first.value).toEqual({ text: 'first piece' });
      const next = stream.next();
      controller.abort();
      const error = await next.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isAbortError(error)).toBe(true);
      expect(probe.cancelled).toBe(true);
    });

    it('a consumer that stops early cancels the body', async () => {
      const probe: BodyProbe = { cancelled: false };
      const head = render(f.truncated(['first piece']));
      const { p } = provider(() => sseResponse([head], { hang: true, probe }));
      const stream = p.stream(request());
      await stream.next();
      await stream.return({ inputTokens: 0, outputTokens: 0 });
      expect(probe.cancelled).toBe(true);
    });

    it('a timeout before the response is transient and not billed', async () => {
      const hang = hangingFetch();
      const p = createChatProvider(f.config(), { fetch: hang.fetch, requestTimeoutMs: 25 });
      const { error } = await collectError(p.stream(request()));
      const err = expectProviderError(error, 'transient', false);
      expect(err.message).toBe('chat request timed out');
    });

    it('a timeout during the stream is transient and billed, and cancels the body', async () => {
      const probe: BodyProbe = { cancelled: false };
      const head = render(f.truncated(['first piece']));
      const { p } = provider(() => sseResponse([head], { hang: true, probe }), 60);
      const { error, texts } = await collectError(p.stream(request()));
      const err = expectProviderError(error, 'transient', true);
      expect(err.message).toBe('chat request timed out');
      expect(texts).toEqual(['first piece']);
      expect(probe.cancelled).toBe(true);
    });
  });

  describe('no leaks', () => {
    it('error messages and causes never contain the key, URL, prompt or upstream body', async () => {
      const scenarios: Parameters<typeof fakeFetch>[0][] = [
        () => new Response(SENTINEL_BODY, { status: 500 }),
        () => new Response(SENTINEL_BODY, { status: 401 }),
        () => new Response(SENTINEL_BODY, { status: 400 }),
        () => sseResponse([`data: ${SENTINEL_BODY}\n\n`]),
        () => sseResponse([render([f.errorEvent('unknown')])]),
        () => sseResponse([render(f.truncated([SENTINEL_BODY]))]),
        () => {
          throw new Error(`${FAKE_KEY} ${SENTINEL_PROMPT}`);
        },
      ];
      for (const respond of scenarios) {
        const { p } = provider(respond);
        const { error } = await collectError(p.stream(request()));
        expect(error).toBeInstanceOf(ProviderError);
        expectClean(error);
      }
    });
  });
});

describe('Gemini specifics', () => {
  const f = FLAVOURS.find((x) => x.name === 'gemini') as Flavour;
  const make = (body: string[]): ReturnType<typeof createChatProvider> => {
    return createChatProvider(f.config(), { fetch: fakeFetch(() => sseResponse(body)).fetch });
  };
  const ev = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

  it.each(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'])(
    'finish reason %s before any text is permanent and billed',
    async (finishReason) => {
      const p = make([ev({ candidates: [{ finishReason }] })]);
      const { error, texts } = await collectError(p.stream(request()));
      expectProviderError(error, 'permanent', true);
      expect(texts).toEqual([]);
      expectClean(error);
    },
  );

  it('a prompt block (promptFeedback.blockReason) is permanent and billed', async () => {
    const p = make([ev({ promptFeedback: { blockReason: 'SAFETY' } })]);
    const { error } = await collectError(p.stream(request()));
    expectProviderError(error, 'permanent', true);
  });

  it('an unspecified block reason is not a block', async () => {
    const p = make([
      ev({ promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' } }),
      ev({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
    ]);
    const out = await collect(p.stream(request()));
    expect(out.texts).toEqual(['ok']);
  });

  it('a safety stop after earlier text is still an error, and its own text is dropped', async () => {
    const p = make([
      ev({ candidates: [{ content: { parts: [{ text: 'early ' }] } }] }),
      ev({ candidates: [{ content: { parts: [{ text: 'unsafe' }] }, finishReason: 'SAFETY' }] }),
    ]);
    const { error, texts } = await collectError(p.stream(request()));
    expectProviderError(error, 'permanent', true);
    expect(texts).toEqual(['early ']);
  });

  it('other finish reasons (MAX_TOKENS) end the reply normally', async () => {
    const p = make([
      ev({
        candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 321 },
      }),
    ]);
    const out = await collect(p.stream(request()));
    expect(out.texts).toEqual(['cut']);
    expect(out.usage).toEqual({ inputTokens: 5, outputTokens: 321 });
  });

  it('skips thought parts, counts thinking tokens as output and reports cached input', async () => {
    const p = make([
      ev({
        candidates: [
          {
            content: { parts: [{ text: 'secret thoughts', thought: true }, { text: 'answer' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 10,
          thoughtsTokenCount: 5,
          cachedContentTokenCount: 40,
        },
      }),
    ]);
    const out = await collect(p.stream(request()));
    expect(out.texts).toEqual(['answer']);
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 15, cachedInputTokens: 40 });
  });

  it('uses the last cumulative usageMetadata', async () => {
    const p = make([
      ev({
        candidates: [{ content: { parts: [{ text: 'a' }] } }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 1 },
      }),
      ev({
        candidates: [{ content: { parts: [{ text: 'b' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 },
      }),
    ]);
    const out = await collect(p.stream(request()));
    expect(out.usage).toEqual({ inputTokens: 9, outputTokens: 2 });
  });

  it('strips a models/ prefix from the model and encodes the rest in the path', async () => {
    const { fetch, seen } = fakeFetch(() =>
      sseResponse([render(f.reply(['x'], { in: 1, out: 1 }))]),
    );
    const p = createChatProvider(f.config({ model: 'models/gemini-2.5-flash-lite' }), { fetch });
    await collect(p.stream(request()));
    expect(seen[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:streamGenerateContent?alt=sse',
    );
  });
});

describe('OpenAI and openai_compatible specifics', () => {
  const ev = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
  const delta = (content: string): string => ev({ choices: [{ delta: { content } }] });

  function make(
    kind: 'openai' | 'openai_compatible',
    body: string[],
    over: Partial<ReturnType<typeof config>> = {},
  ): { p: ReturnType<typeof createChatProvider>; seen: ReturnType<typeof fakeFetch>['seen'] } {
    const { fetch, seen } = fakeFetch(() => sseResponse(body));
    return { p: createChatProvider(config(kind, over), { fetch }), seen };
  }

  it('finish_reason content_filter is permanent and billed, before or after text', async () => {
    for (const body of [
      [ev({ choices: [{ delta: {}, finish_reason: 'content_filter' }] })],
      [
        delta('early'),
        ev({ choices: [{ delta: { content: 'x' }, finish_reason: 'content_filter' }] }),
      ],
    ]) {
      const { p } = make('openai', body);
      const { error, texts } = await collectError(p.stream(request()));
      expectProviderError(error, 'permanent', true);
      expect(texts.join('')).not.toContain('x');
    }
  });

  it('a delta refusal is permanent and billed', async () => {
    const { p } = make('openai', [ev({ choices: [{ delta: { refusal: 'I cannot help' } }] })]);
    const { error, texts } = await collectError(p.stream(request()));
    expectProviderError(error, 'permanent', true);
    expect(texts).toEqual([]);
    expect(exposed(error)).not.toContain('cannot help');
  });

  it('accepts a stream that ends after finish_reason without [DONE]', async () => {
    const { p } = make('openai_compatible', [
      delta('hi'),
      ev({ choices: [{ delta: {}, finish_reason: 'length' }] }),
      ev({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
    ]);
    const out = await collect(p.stream(request()));
    expect(out.texts).toEqual(['hi']);
    expect(out.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  it('rejects a stream with text but no finish_reason and no [DONE]', async () => {
    const { p } = make('openai_compatible', [delta('hi')]);
    const { error } = await collectError(p.stream(request()));
    expectProviderError(error, 'transient', true);
  });

  it('stops reading at [DONE] and ignores whatever follows', async () => {
    const { p } = make('openai', [
      delta('hi'),
      ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
      delta('late'),
    ]);
    const out = await collect(p.stream(request()));
    expect(out.texts).toEqual(['hi']);
  });

  it('reads cached tokens from prompt_tokens_details and ignores null usage and empty choices', async () => {
    const { p } = make('openai', [
      ev({ choices: [{ delta: { content: 'a' } }], usage: null }),
      ev({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: null }),
      ev({
        choices: [],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 30 },
        },
      }),
      'data: [DONE]\n\n',
    ]);
    const out = await collect(p.stream(request()));
    expect(out.usage).toEqual({ inputTokens: 50, outputTokens: 4, cachedInputTokens: 30 });
  });

  it('ignores a usage value that is not a non-negative integer and estimates instead', async () => {
    const { p } = make('openai', [
      delta('abc'),
      ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ev({ choices: [], usage: { prompt_tokens: -5, completion_tokens: 'many' } }),
      'data: [DONE]\n\n',
    ]);
    const req = request();
    const out = await collect(p.stream(req));
    const inputChars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
    expect(out.usage).toEqual({ inputTokens: Math.ceil(inputChars / 3), outputTokens: 1 });
  });

  it('builds the compatible URL from the base with or without /v1 and trailing slashes', async () => {
    for (const [base, expected] of [
      ['https://compat.fake-host.invalid', 'https://compat.fake-host.invalid/v1/chat/completions'],
      ['https://compat.fake-host.invalid/', 'https://compat.fake-host.invalid/v1/chat/completions'],
      [
        'https://compat.fake-host.invalid/v1',
        'https://compat.fake-host.invalid/v1/chat/completions',
      ],
      [
        'https://compat.fake-host.invalid/v1/',
        'https://compat.fake-host.invalid/v1/chat/completions',
      ],
      ['http://127.0.0.1:11434/api', 'http://127.0.0.1:11434/api/v1/chat/completions'],
    ] as const) {
      const { p, seen } = make(
        'openai_compatible',
        [delta('x'), ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'],
        { baseUrl: base },
      );
      await collect(p.stream(request()));
      expect(seen[0]?.url).toBe(expected);
    }
  });

  it('openai ignores any configured base URL and always uses the OpenAI host', async () => {
    const { p, seen } = make(
      'openai',
      [delta('x'), ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'],
      { baseUrl: 'https://evil.invalid' },
    );
    await collect(p.stream(request()));
    expect(seen[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
  });
});

describe('Anthropic specifics', () => {
  const ev = (type: string, o: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
  const start = (usage: Record<string, number>): string =>
    ev('message_start', { message: { usage } });
  const text = (t: string): string =>
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } });
  const stop = (reason: string, usage?: Record<string, number>): string =>
    ev('message_delta', {
      delta: { stop_reason: reason },
      ...(usage === undefined ? {} : { usage }),
    }) + ev('message_stop', {});

  function make(body: string[]): ReturnType<typeof createChatProvider> {
    return createChatProvider(config('anthropic'), {
      fetch: fakeFetch(() => sseResponse(body)).fetch,
    });
  }

  it('a refusal stop reason before any text is permanent and billed', async () => {
    const p = make([
      start({ input_tokens: 5, output_tokens: 1 }),
      stop('refusal', { output_tokens: 0 }),
    ]);
    const { error, texts } = await collectError(p.stream(request()));
    expectProviderError(error, 'permanent', true);
    expect(texts).toEqual([]);
    expectClean(error);
  });

  it('a refusal after earlier text is still an error', async () => {
    const p = make([
      start({ input_tokens: 5 }),
      text('partial'),
      stop('refusal', { output_tokens: 2 }),
    ]);
    const { error, texts } = await collectError(p.stream(request()));
    expectProviderError(error, 'permanent', true);
    expect(texts).toEqual(['partial']);
  });

  it('other stop reasons (max_tokens, end_turn, stop_sequence) end normally', async () => {
    for (const reason of ['max_tokens', 'end_turn', 'stop_sequence']) {
      const p = make([start({ input_tokens: 5 }), text('ok'), stop(reason, { output_tokens: 2 })]);
      const out = await collect(p.stream(request()));
      expect(out.texts).toEqual(['ok']);
    }
  });

  it('adds cache reads and writes to the input and reports cache reads as cached', async () => {
    const p = make([
      start({
        input_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 70,
        output_tokens: 1,
      }),
      text('ok'),
      stop('end_turn', { output_tokens: 9 }),
    ]);
    const out = await collect(p.stream(request()));
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 9, cachedInputTokens: 70 });
  });

  it('the message_delta output count replaces the message_start one', async () => {
    const p = make([
      start({ input_tokens: 4, output_tokens: 1 }),
      text('a'),
      stop('end_turn', { output_tokens: 6 }),
    ]);
    const out = await collect(p.stream(request()));
    expect(out.usage).toEqual({ inputTokens: 4, outputTokens: 6 });
  });

  it('ignores thinking and tool-input deltas and unknown event types', async () => {
    const p = make([
      start({ input_tokens: 1 }),
      ev('content_block_delta', { delta: { type: 'thinking_delta', thinking: 'private' } }),
      ev('content_block_delta', { delta: { type: 'input_json_delta', partial_json: '{}' } }),
      ev('future_event', { x: 1 }),
      text('visible'),
      stop('end_turn', { output_tokens: 1 }),
    ]);
    const out = await collect(p.stream(request()));
    expect(out.texts).toEqual(['visible']);
  });

  it('stops at message_stop and ignores whatever follows', async () => {
    const p = make([
      start({ input_tokens: 1 }),
      text('a'),
      stop('end_turn', { output_tokens: 1 }),
      text('late'),
    ]);
    const out = await collect(p.stream(request()));
    expect(out.texts).toEqual(['a']);
  });

  it('sends the key and version as headers and the system prompt as a string', async () => {
    const { fetch, seen } = fakeFetch(() =>
      sseResponse([start({ input_tokens: 1 }), text('a'), stop('end_turn')]),
    );
    const p = createChatProvider(config('anthropic'), { fetch });
    await collect(p.stream(request()));
    expect(seen[0]?.headers['x-api-key']).toBe(FAKE_KEY);
    expect(seen[0]?.headers).not.toHaveProperty('authorization');
    expect(typeof seen[0]?.body['system']).toBe('string');
  });
});
