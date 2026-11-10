// FAKE test helpers for the P7 chat and moderation adapters: a scripted `fetch` that returns crafted
// SSE bodies. No network, no real provider. Keys, prompts and upstream bodies here are labelled
// random sentinels, so a leak into an error message or cause is detectable.
import { randomBytes } from 'node:crypto';
import type {
  ChatStream,
  ChatUsage,
  ModerationConfig,
  ProviderConfig,
  ProviderKind,
} from '../../../shared/src/providers.ts';

export const FAKE_KEY = `fake-key-${randomBytes(8).toString('hex')}`;
export const SENTINEL_PROMPT = `prompt-text-${randomBytes(6).toString('hex')}`;
export const SENTINEL_BODY = `upstream-body-${randomBytes(6).toString('hex')}`;
export const FAKE_BASE_HOST = 'compat.fake-host.invalid';

export function config(kind: ProviderKind, over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    role: 'chat_primary',
    provider: kind,
    model: 'fake-chat-model',
    apiKey: FAKE_KEY,
    baseUrl: kind === 'openai_compatible' ? `https://${FAKE_BASE_HOST}/v1` : null,
    ...over,
  };
}

export function moderationConfig(
  kind: ProviderKind,
  mode: ModerationConfig['mode'],
  over: Partial<ModerationConfig> = {},
): ModerationConfig {
  return { ...config(kind), role: 'moderation', mode, ...over };
}

export interface Seen {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export function fakeFetch(respond: (seen: Seen, n: number) => Response | Promise<Response>): {
  fetch: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    const s: Seen = {
      url: String(url),
      init: init ?? {},
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    seen.push(s);
    return Promise.resolve(respond(s, seen.length));
  }) as typeof fetch;
  return { fetch: impl, seen };
}

/** A fetch that never answers; it rejects with an AbortError once its signal fires. */
export function hangingFetch(): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = ((_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  }) as typeof fetch;
  return { fetch: impl, calls: () => calls };
}

export interface BodyProbe {
  cancelled: boolean;
}

export interface BodyOptions {
  /** After the last chunk, never close: the stream hangs until it is cancelled. */
  hang?: boolean;
  /** After the last chunk, error the stream with this error. */
  fail?: Error;
  probe?: BodyProbe;
}

/** A byte stream that delivers one chunk per pull. Strings are encoded as UTF-8. */
export function bodyOf(
  chunks: readonly (string | Uint8Array)[],
  options: BodyOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[i];
      if (next !== undefined) {
        i += 1;
        controller.enqueue(typeof next === 'string' ? encoder.encode(next) : next);
        return undefined;
      }
      if (options.fail !== undefined) {
        controller.error(options.fail);
        return undefined;
      }
      if (options.hang === true) return new Promise<void>(() => undefined);
      controller.close();
      return undefined;
    },
    cancel() {
      if (options.probe !== undefined) options.probe.cancelled = true;
    },
  });
}

export function sseResponse(
  chunks: readonly (string | Uint8Array)[],
  options: BodyOptions & { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(bodyOf(chunks, options), {
    status: options.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...options.headers },
  });
}

/** Splits `text` into UTF-8 byte pieces of `size`, which can cut a multi-byte character in two. */
export function bytePieces(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

export interface Ev {
  event?: string;
  data: string;
}

export function render(events: readonly Ev[], eol = '\n'): string {
  return events
    .map(
      (e) => `${e.event === undefined ? '' : `event: ${e.event}${eol}`}data: ${e.data}${eol}${eol}`,
    )
    .join('');
}

export async function collect(stream: ChatStream): Promise<{ texts: string[]; usage: ChatUsage }> {
  const texts: string[] = [];
  for (;;) {
    const step = await stream.next();
    if (step.done === true) return { texts, usage: step.value };
    texts.push(step.value.text);
  }
}

/** Runs the stream to its end and returns what was thrown (or fails the test if nothing was). */
export async function collectError(
  stream: ChatStream,
): Promise<{ error: unknown; texts: string[] }> {
  const texts: string[] = [];
  try {
    for (;;) {
      const step = await stream.next();
      if (step.done === true) break;
      texts.push(step.value.text);
    }
  } catch (error) {
    return { error, texts };
  }
  throw new Error('expected the stream to throw');
}

/** Everything an error exposes: message, name, stack, cause, own JSON. */
export function exposed(error: unknown): string {
  const e = error as Error & { cause?: unknown };
  return [e.message, e.name, e.stack ?? '', String(e.cause ?? ''), JSON.stringify(e)].join('\n');
}

/** All object keys in a JSON-like value, recursively. */
export function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) allKeys(v, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allKeys(v, out);
    }
  }
  return out;
}

export const SAMPLING_KEY = /temperature|top_?p|top_?k|frequency|presence|seed|penalty/i;

// ---------------------------------------------------------------------------------------------
// Per-provider wire fixtures (a well-formed reply, a truncated one, an error event)
// ---------------------------------------------------------------------------------------------

export interface Flavour {
  name: ProviderKind;
  config: (over?: Partial<ProviderConfig>) => ProviderConfig;
  expectedUrl: string;
  keyHeader: string;
  /** Complete reply: text pieces, a finish signal and usage. */
  reply: (texts: readonly string[], usage?: { in: number; out: number }) => Ev[];
  /** The same reply cut off before any finish signal. */
  truncated: (texts: readonly string[]) => Ev[];
  /** A well-formed reply with no usage anywhere. */
  noUsage: (texts: readonly string[]) => Ev[];
  /** An error event as the provider sends it inside a stream. */
  errorEvent: (kind: 'rate_limited' | 'auth' | 'billing' | 'permanent' | 'unknown') => Ev;
  /** A stop that the provider's filter caused, as the final event of a reply that has `texts`. */
  blockedStop: (texts: readonly string[]) => Ev[];
  roles: { user: string; assistant: string };
}

const j = (o: unknown): string => JSON.stringify(o);

function gemini(): Flavour {
  const chunk = (text: string, extra: Record<string, unknown> = {}): Ev => ({
    data: j({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, ...extra }],
    }),
  });
  const reply = (texts: readonly string[], usage?: { in: number; out: number }): Ev[] => {
    const meta =
      usage === undefined
        ? {}
        : { usageMetadata: { promptTokenCount: usage.in, candidatesTokenCount: usage.out } };
    const events = texts.map((t) => chunk(t));
    events.push({
      data: j({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '' }] } }],
        ...meta,
      }),
    });
    return events;
  };
  return {
    name: 'gemini',
    config: (over) => config('gemini', over),
    expectedUrl:
      'https://generativelanguage.googleapis.com/v1beta/models/fake-chat-model:streamGenerateContent?alt=sse',
    keyHeader: 'x-goog-api-key',
    reply,
    truncated: (texts) => texts.map((t) => chunk(t)),
    noUsage: (texts) => reply(texts),
    errorEvent: (kind) => ({
      data: j({
        error: {
          code: { rate_limited: 429, auth: 401, billing: 402, permanent: 400, unknown: 0 }[kind],
          message: SENTINEL_BODY,
          status: 'FAKE',
        },
      }),
    }),
    blockedStop: (texts) => [
      ...texts.map((t) => chunk(t)),
      { data: j({ candidates: [{ finishReason: 'SAFETY' }] }) },
    ],
    roles: { user: 'user', assistant: 'model' },
  };
}

function openai(name: 'openai' | 'openai_compatible'): Flavour {
  const chunk = (text: string): Ev => ({
    data: j({ choices: [{ index: 0, delta: { content: text } }] }),
  });
  const reply = (texts: readonly string[], usage?: { in: number; out: number }): Ev[] => {
    const events = texts.map((t) => chunk(t));
    events.push({ data: j({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) });
    if (usage !== undefined) {
      events.push({
        data: j({
          choices: [],
          usage: { prompt_tokens: usage.in, completion_tokens: usage.out },
        }),
      });
    }
    events.push({ data: '[DONE]' });
    return events;
  };
  return {
    name,
    config: (over) => config(name, over),
    expectedUrl:
      name === 'openai'
        ? 'https://api.openai.com/v1/chat/completions'
        : `https://${FAKE_BASE_HOST}/v1/chat/completions`,
    keyHeader: 'authorization',
    reply,
    truncated: (texts) => texts.map((t) => chunk(t)),
    noUsage: (texts) => reply(texts),
    errorEvent: (kind) => ({
      data: j({
        error: {
          message: SENTINEL_BODY,
          type: {
            rate_limited: 'rate_limit_exceeded',
            auth: 'invalid_api_key',
            billing: 'insufficient_quota',
            permanent: 'invalid_request_error',
            unknown: 'server_error',
          }[kind],
        },
      }),
    }),
    blockedStop: (texts) => [
      ...texts.map((t) => chunk(t)),
      { data: j({ choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }) },
    ],
    roles: { user: 'user', assistant: 'assistant' },
  };
}

function anthropic(): Flavour {
  const delta = (text: string): Ev => ({
    event: 'content_block_delta',
    data: j({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
  });
  const start = (inTokens: number): Ev[] => [
    {
      event: 'message_start',
      data: j({
        type: 'message_start',
        message: {
          id: 'msg_fake',
          role: 'assistant',
          usage: { input_tokens: inTokens, output_tokens: 1 },
        },
      }),
    },
    {
      event: 'content_block_start',
      data: j({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    },
    { event: 'ping', data: j({ type: 'ping' }) },
  ];
  const end = (outTokens: number | undefined, stop = 'end_turn'): Ev[] => [
    { event: 'content_block_stop', data: j({ type: 'content_block_stop', index: 0 }) },
    {
      event: 'message_delta',
      data: j({
        type: 'message_delta',
        delta: { stop_reason: stop },
        ...(outTokens === undefined ? {} : { usage: { output_tokens: outTokens } }),
      }),
    },
    { event: 'message_stop', data: j({ type: 'message_stop' }) },
  ];
  return {
    name: 'anthropic',
    config: (over) => config('anthropic', over),
    expectedUrl: 'https://api.anthropic.com/v1/messages',
    keyHeader: 'x-api-key',
    reply: (texts, usage) => [...start(usage?.in ?? 0), ...texts.map(delta), ...end(usage?.out)],
    truncated: (texts) => [...start(5), ...texts.map(delta)],
    noUsage: (texts) => [
      { event: 'message_start', data: j({ type: 'message_start', message: { id: 'msg_fake' } }) },
      ...texts.map(delta),
      ...end(undefined),
    ],
    errorEvent: (kind) => ({
      event: 'error',
      data: j({
        type: 'error',
        error: {
          type: {
            rate_limited: 'rate_limit_error',
            auth: 'authentication_error',
            billing: 'billing_error',
            permanent: 'invalid_request_error',
            unknown: 'overloaded_error',
          }[kind],
          message: SENTINEL_BODY,
        },
      }),
    }),
    blockedStop: (texts) => [...start(5), ...texts.map(delta), ...end(3, 'refusal')],
    roles: { user: 'user', assistant: 'assistant' },
  };
}

export const FLAVOURS: readonly Flavour[] = [
  gemini(),
  openai('openai'),
  openai('openai_compatible'),
  anthropic(),
];
