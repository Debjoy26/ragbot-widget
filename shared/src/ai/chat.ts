// Streaming chat adapters (P7): Gemini streamGenerateContent, OpenAI and openai_compatible
// /v1/chat/completions, Anthropic /v1/messages. Implements the shared `ChatProvider` interface.
//
// Rules (TECH_SPECS section 8, ADR 0014, ARCHITECTURE section 5), mirroring the embedding adapter:
//  * No sampling parameters (no temperature, top_p, top_k): adapters send only the model, the
//    system prompt, the messages and the output-token cap.
//  * Failures map onto the shared ProviderError kinds: HTTP 429 -> rate_limited; 408, 5xx, network
//    errors, timeouts, truncated or garbled streams -> transient; 401/403 -> auth; 402 -> billing;
//    any other 4xx and a refused or safety-blocked reply -> permanent.
//  * `billed`: every ProviderError raised after the provider answered 2xx carries `billed: true`,
//    whatever its kind (an error event inside the stream, a truncated stream, a safety stop, an
//    oversized stream). Errors before a 2xx (network, timeout, any non-2xx status) are
//    `billed: false`.
//  * An error event inside a stream is `transient` once text has been emitted (the caller keeps
//    the partial answer and offers a retry; it never silently switches provider after tokens). Before
//    any text it is classified from the event when the event says how, otherwise `transient`.
//  * A safety block, a content-filter stop, or a refusal is `permanent` and `billed: true`. It is
//    raised before any text of that chunk is released, and also when it arrives after earlier
//    text: a reply cut short by a filter is never reported as complete.
//  * A stream that ends without the provider's own completion signal (a finish reason,
//    `[DONE]`, `message_stop`) is a transient, billed error. That includes a stream with no events.
//  * The key travels in a header only. Error messages are fixed strings: no URL, no key, no prompt
//    text, no upstream body, and no `cause`.
//  * A caller abort (signal) cancels the upstream body and is rethrown as an AbortError.
//  * Bounded: one timeout covers the request and the whole stream; the streamed bytes are capped.
//  * Usage: from the provider when it reports it. When it does not (some openai_compatible
//    servers ignore `include_usage`) it is estimated at one token per 3 characters, which
//    over-counts English on purpose: spend accounting should not under-count. `inputTokens`
//    includes cached input; `cachedInputTokens`, when reported, is the part of it served from cache.
//  * `ChatUsage.truncated` is true when the provider stopped at its output-token limit (Gemini
//    `MAX_TOKENS`, OpenAI-style `finish_reason: length`, Anthropic `stop_reason: max_tokens`); the
//    stream still completes normally, the caller decides what a cut-short reply means. Otherwise
//    the field is absent.
//  * openai_compatible: `stream_options.include_usage` is always sent. A server that refuses it
//    answers 400, which is permanent and never retried (P7-D1: a compatibility resend made a
//    genuine 400 cost an extra call and broke the "never retry a 400" rule). Such a server cannot
//    be used until a config option exists; a server that accepts it but reports no usage is
//    covered by the estimate.
import {
  ProviderError,
  type ChatProvider,
  type ChatStream,
  type ChatStreamRequest,
  type ChatUsage,
  type ProviderConfig,
  type ProviderErrorKind,
} from '../providers.js';
import { kindForStatus } from './embeddings.js';
import {
  abortError,
  isRecord,
  openAiStyleUrl,
  openRequest,
  resolveTimeoutMs,
  type AiRequestOptions,
  type HttpEndpoint,
} from './http.js';

export type ChatProviderOptions = AiRequestOptions;

/** Default for the whole request, headers and stream. The API bounds the request again with its own deadline. */
export const CHAT_REQUEST_TIMEOUT_MS = 120_000;
/** More streamed bytes than this are refused (a capped reply is a few tens of KB). */
export const MAX_CHAT_STREAM_BYTES = 8 * 1024 * 1024;

const GEMINI_HOST = 'https://generativelanguage.googleapis.com';
const OPENAI_HOST = 'https://api.openai.com';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ESTIMATE_CHARS_PER_TOKEN = 3;

/** One parsed server-sent event. */
export interface SseEvent {
  readonly event: string | undefined;
  readonly data: string;
}

// ---------------------------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------------------------

/**
 * Incremental SSE parser over a byte stream. Handles lines split across chunks (including a CRLF
 * split between two chunks), LF, CRLF and lone CR line ends, comment lines (`:`), a leading BOM,
 * and multi-line `data`. Fields other than `data` and `event` are ignored. A final event with no
 * closing blank line is still delivered. More than `maxBytes` in total throws a permanent, billed
 * ProviderError and cancels the stream.
 */
export async function* parseSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number = MAX_CHAT_STREAM_BYTES,
): AsyncGenerator<SseEvent, void, void> {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buf = '';
  let total = 0;
  let first = true;
  let dataLines: string[] = [];
  let eventName: string | undefined;

  const line = (text: string): SseEvent | undefined => {
    if (text === '') {
      const ev =
        dataLines.length === 0 ? undefined : { event: eventName, data: dataLines.join('\n') };
      dataLines = [];
      eventName = undefined;
      return ev;
    }
    if (text.startsWith(':')) return undefined;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
    return undefined;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderError('permanent', 'chat response is too large', { billed: true });
    }
    buf += decoder.decode(value, { stream: true });
    if (first && buf.length > 0) {
      if (buf.startsWith('﻿')) buf = buf.slice(1);
      first = false;
    }
    let start = 0;
    for (;;) {
      let i = start;
      while (i < buf.length && buf[i] !== '\n' && buf[i] !== '\r') i++;
      if (i >= buf.length) break; // incomplete line: wait for more bytes
      if (buf[i] === '\r' && i === buf.length - 1) break; // may be the first half of a CRLF
      const ev = line(buf.slice(start, i));
      start = buf[i] === '\r' && buf[i + 1] === '\n' ? i + 2 : i + 1;
      if (ev !== undefined) yield ev;
    }
    buf = buf.slice(start);
  }

  buf += decoder.decode();
  // Whatever is left is a final line without a terminator, then the end of the stream.
  const tail = buf.replace(/[\r\n]+$/, '');
  if (tail !== '') {
    const ev = line(tail);
    if (ev !== undefined) yield ev;
  }
  const last = line('');
  if (last !== undefined) yield last;
}

// ---------------------------------------------------------------------------------------------
// Decoders: one per wire format
// ---------------------------------------------------------------------------------------------

interface UsageParts {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

interface Decoder {
  /** Text to release for this event ('' for none). Throws a billed ProviderError on a bad event. */
  push(event: SseEvent, sawText: boolean): string;
  /** The provider said the stream is over: stop reading. */
  readonly done: boolean;
  /** The provider's own completion signal was seen. */
  readonly complete: boolean;
  usage(): UsageParts;
  /** The provider stopped at its output-token limit. */
  truncated(): boolean;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function garbled(): ProviderError {
  return new ProviderError('transient', 'chat stream contained invalid data', { billed: true });
}

function blocked(): ProviderError {
  return new ProviderError('permanent', 'chat response was blocked by the provider', {
    billed: true,
  });
}

/** Kind for an error event: after text always transient, otherwise `kind` (already classified). */
function streamError(kind: ProviderErrorKind, sawText: boolean): ProviderError {
  return new ProviderError(sawText ? 'transient' : kind, 'chat provider reported a stream error', {
    billed: true,
  });
}

function kindForErrorWords(...words: unknown[]): ProviderErrorKind {
  const text = words
    .filter((w): w is string => typeof w === 'string')
    .join(' ')
    .toLowerCase();
  if (/rate_limit|resource_exhausted|too_many/.test(text)) return 'rate_limited';
  if (/insufficient_quota|billing|payment/.test(text)) return 'billing';
  if (/authentication|permission|invalid_api_key|unauthenticated|unauthorized/.test(text)) {
    return 'auth';
  }
  if (/invalid_request|invalid_argument|not_found|too_large|failed_precondition/.test(text)) {
    return 'permanent';
  }
  return 'transient';
}

function kindForErrorObject(error: Record<string, unknown>): ProviderErrorKind {
  const code = error['code'];
  if (typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599) {
    return kindForStatus(code);
  }
  return kindForErrorWords(error['type'], error['status'], error['code']);
}

function parseData(data: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw garbled();
  }
  if (!isRecord(parsed)) throw garbled();
  return parsed;
}

const GEMINI_BLOCKING_FINISH = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
]);

function geminiDecoder(): Decoder {
  let complete = false;
  let truncated = false;
  const usage: UsageParts = {};
  return {
    done: false,
    get complete(): boolean {
      return complete;
    },
    usage: () => usage,
    truncated: () => truncated,
    push(event, sawText): string {
      if (event.data.trim() === '') return '';
      const json = parseData(event.data);
      const error = json['error'];
      if (isRecord(error)) throw streamError(kindForErrorObject(error), sawText);

      const feedback = json['promptFeedback'];
      if (isRecord(feedback)) {
        const reason = feedback['blockReason'];
        if (typeof reason === 'string' && reason !== '' && reason !== 'BLOCK_REASON_UNSPECIFIED') {
          throw blocked();
        }
      }

      const meta = json['usageMetadata'];
      if (isRecord(meta)) {
        const prompt = nonNegativeInt(meta['promptTokenCount']);
        const candidates = nonNegativeInt(meta['candidatesTokenCount']);
        const thoughts = nonNegativeInt(meta['thoughtsTokenCount']);
        const cached = nonNegativeInt(meta['cachedContentTokenCount']);
        if (prompt !== undefined) usage.inputTokens = prompt;
        // Thinking tokens are billed as output.
        if (candidates !== undefined || thoughts !== undefined) {
          usage.outputTokens = (candidates ?? 0) + (thoughts ?? 0);
        }
        if (cached !== undefined) usage.cachedInputTokens = cached;
      }

      const candidatesList = json['candidates'];
      if (!Array.isArray(candidatesList) || candidatesList.length === 0) return '';
      const candidate: unknown = candidatesList[0];
      if (!isRecord(candidate)) throw garbled();
      const finish = candidate['finishReason'];
      if (typeof finish === 'string' && finish !== '' && finish !== 'FINISH_REASON_UNSPECIFIED') {
        if (GEMINI_BLOCKING_FINISH.has(finish)) throw blocked();
        if (finish === 'MAX_TOKENS') truncated = true;
        complete = true;
      }
      const content = candidate['content'];
      if (!isRecord(content) || !Array.isArray(content['parts'])) return '';
      const parts: unknown[] = content['parts'];
      let text = '';
      for (const part of parts) {
        if (!isRecord(part) || part['thought'] === true) continue;
        const t = part['text'];
        if (typeof t === 'string') text += t;
      }
      return text;
    },
  };
}

function openAiDecoder(): Decoder {
  let done = false;
  let finished = false;
  let truncated = false;
  const usage: UsageParts = {};
  return {
    get done(): boolean {
      return done;
    },
    get complete(): boolean {
      return done || finished;
    },
    usage: () => usage,
    truncated: () => truncated,
    push(event, sawText): string {
      const data = event.data.trim();
      if (data === '') return '';
      if (data === '[DONE]') {
        done = true;
        return '';
      }
      const json = parseData(data);
      const error = json['error'];
      if (isRecord(error)) throw streamError(kindForErrorObject(error), sawText);

      const u = json['usage'];
      if (isRecord(u)) {
        const prompt = nonNegativeInt(u['prompt_tokens']);
        const completion = nonNegativeInt(u['completion_tokens']);
        if (prompt !== undefined) usage.inputTokens = prompt;
        if (completion !== undefined) usage.outputTokens = completion;
        const details = u['prompt_tokens_details'];
        if (isRecord(details)) {
          const cached = nonNegativeInt(details['cached_tokens']);
          if (cached !== undefined) usage.cachedInputTokens = cached;
        }
      }

      const choices = json['choices'];
      if (!Array.isArray(choices) || choices.length === 0) return '';
      const choice: unknown = choices[0];
      if (!isRecord(choice)) throw garbled();
      const finish = choice['finish_reason'];
      if (typeof finish === 'string' && finish !== '') {
        if (finish === 'content_filter') throw blocked();
        if (finish === 'length') truncated = true;
        finished = true;
      }
      const delta = choice['delta'];
      if (!isRecord(delta)) return '';
      const refusal = delta['refusal'];
      if (typeof refusal === 'string' && refusal !== '') throw blocked();
      const content = delta['content'];
      return typeof content === 'string' ? content : '';
    },
  };
}

function anthropicDecoder(): Decoder {
  let done = false;
  let truncated = false;
  const usage: UsageParts = {};

  const readUsage = (u: unknown): void => {
    if (!isRecord(u)) return;
    const input = nonNegativeInt(u['input_tokens']);
    const created = nonNegativeInt(u['cache_creation_input_tokens']);
    const read = nonNegativeInt(u['cache_read_input_tokens']);
    const output = nonNegativeInt(u['output_tokens']);
    // Anthropic's input_tokens excludes cache reads and writes; the total input includes both.
    if (input !== undefined || created !== undefined || read !== undefined) {
      usage.inputTokens = (input ?? 0) + (created ?? 0) + (read ?? 0);
    }
    if (read !== undefined) usage.cachedInputTokens = read;
    if (output !== undefined) usage.outputTokens = output;
  };

  return {
    get done(): boolean {
      return done;
    },
    get complete(): boolean {
      return done;
    },
    usage: () => usage,
    truncated: () => truncated,
    push(event, sawText): string {
      if (event.data.trim() === '') return '';
      const json = parseData(event.data);
      const type = typeof json['type'] === 'string' ? json['type'] : event.event;
      switch (type) {
        case 'message_start': {
          const message = json['message'];
          if (isRecord(message)) readUsage(message['usage']);
          return '';
        }
        case 'content_block_start': {
          const block = json['content_block'];
          if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
            return block['text'];
          }
          return '';
        }
        case 'content_block_delta': {
          const delta = json['delta'];
          if (
            isRecord(delta) &&
            delta['type'] === 'text_delta' &&
            typeof delta['text'] === 'string'
          ) {
            return delta['text'];
          }
          return '';
        }
        case 'message_delta': {
          readUsage(json['usage']);
          const delta = json['delta'];
          if (isRecord(delta) && delta['stop_reason'] === 'refusal') throw blocked();
          if (isRecord(delta) && delta['stop_reason'] === 'max_tokens') truncated = true;
          return '';
        }
        case 'message_stop':
          done = true;
          return '';
        case 'error': {
          const error = json['error'];
          throw streamError(isRecord(error) ? kindForErrorObject(error) : 'transient', sawText);
        }
        default:
          // ping, content_block_stop and event types added later.
          return '';
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Stream driver
// ---------------------------------------------------------------------------------------------

interface Deps {
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / ESTIMATE_CHARS_PER_TOKEN);
}

function finalUsage(
  parts: UsageParts,
  request: ChatStreamRequest,
  outputChars: number,
  truncated: boolean,
): ChatUsage {
  const inputChars =
    request.system.length + request.messages.reduce((n, m) => n + m.content.length, 0);
  const inputTokens = parts.inputTokens ?? estimateTokens(inputChars);
  const outputTokens = parts.outputTokens ?? estimateTokens(outputChars);
  return {
    inputTokens,
    outputTokens,
    ...(parts.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: Math.min(parts.cachedInputTokens, inputTokens) }),
    ...(truncated ? { truncated: true } : {}),
  };
}

async function* driveStream(
  deps: Deps,
  endpoint: HttpEndpoint,
  body: unknown,
  decoder: Decoder,
  request: ChatStreamRequest,
): ChatStream {
  const caller = request.signal;
  const { res, timeout, signal } = await openRequest(
    deps.fetchImpl,
    endpoint,
    body,
    deps.timeoutMs,
    caller,
    'chat',
  );
  if (res.body === null) {
    throw new ProviderError('transient', 'chat response has no body', { billed: true });
  }
  const reader = res.body.getReader();
  // Cancelling the reader on abort or timeout also ends a read that the runtime would not reject.
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  let sawText = false;
  let outputChars = 0;
  try {
    for await (const event of parseSse(reader)) {
      const text = decoder.push(event, sawText);
      if (text !== '') {
        sawText = true;
        outputChars += text.length;
        yield { text };
      }
      if (decoder.done) break;
    }
    if (caller?.aborted === true) throw abortError('chat');
    if (timeout.aborted) {
      throw new ProviderError('transient', 'chat request timed out', { billed: true });
    }
    if (!decoder.complete) {
      throw new ProviderError('transient', 'chat stream ended unexpectedly', { billed: true });
    }
  } catch (err) {
    if (caller?.aborted === true) throw abortError('chat');
    if (timeout.aborted) {
      throw new ProviderError('transient', 'chat request timed out', { billed: true });
    }
    if (err instanceof ProviderError) throw err;
    throw new ProviderError('transient', 'chat response could not be read', { billed: true });
  } finally {
    signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
  }
  return finalUsage(decoder.usage(), request, outputChars, decoder.truncated());
}

function checkRequest(request: ChatStreamRequest): void {
  if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) {
    throw new RangeError('maxOutputTokens must be a positive integer');
  }
  if (request.messages.length === 0) throw new RangeError('messages must not be empty');
}

// ---------------------------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------------------------

function createGemini(config: ProviderConfig, deps: Deps): ChatProvider {
  const modelId = config.model.replace(/^models\//, '');
  const endpoint: HttpEndpoint = {
    url: `${GEMINI_HOST}/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`,
    headers: { 'x-goog-api-key': config.apiKey },
  };
  return {
    provider: 'gemini',
    model: config.model,
    stream(request): ChatStream {
      checkRequest(request);
      const body = {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: request.messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        generationConfig: { maxOutputTokens: request.maxOutputTokens },
      };
      return driveStream(deps, endpoint, body, geminiDecoder(), request);
    },
  };
}

function createOpenAiStyle(config: ProviderConfig, base: string, deps: Deps): ChatProvider {
  const endpoint: HttpEndpoint = {
    url: openAiStyleUrl(base, 'chat/completions'),
    headers: { authorization: `Bearer ${config.apiKey}` },
  };
  // OpenAI's newer models reject max_tokens; OpenAI-style servers elsewhere mostly only know it.
  const capField = config.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens';
  return {
    provider: config.provider,
    model: config.model,
    stream(request): ChatStream {
      checkRequest(request);
      const body = {
        model: config.model,
        messages: [{ role: 'system', content: request.system }, ...request.messages],
        [capField]: request.maxOutputTokens,
        stream: true,
        stream_options: { include_usage: true },
      };
      return driveStream(deps, endpoint, body, openAiDecoder(), request);
    },
  };
}

function createAnthropic(config: ProviderConfig, deps: Deps): ChatProvider {
  const endpoint: HttpEndpoint = {
    url: ANTHROPIC_URL,
    headers: { 'x-api-key': config.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
  };
  return {
    provider: 'anthropic',
    model: config.model,
    stream(request): ChatStream {
      checkRequest(request);
      const body = {
        model: config.model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: request.messages,
        stream: true,
      };
      return driveStream(deps, endpoint, body, anthropicDecoder(), request);
    },
  };
}

/**
 * Builds the streaming chat provider for `config`. Throws a plain Error (no key in the message)
 * for an openai_compatible config without a base URL or an invalid timeout.
 */
export function createChatProvider(
  config: ProviderConfig,
  options: ChatProviderOptions = {},
): ChatProvider {
  const deps: Deps = {
    fetchImpl: options.fetch ?? fetch,
    timeoutMs: resolveTimeoutMs(options.requestTimeoutMs, CHAT_REQUEST_TIMEOUT_MS),
  };
  switch (config.provider) {
    case 'gemini':
      return createGemini(config, deps);
    case 'openai':
      return createOpenAiStyle(config, OPENAI_HOST, deps);
    case 'openai_compatible':
      if (config.baseUrl === null) throw new Error('openai_compatible chat needs a base URL');
      return createOpenAiStyle(config, config.baseUrl, deps);
    case 'anthropic':
      return createAnthropic(config, deps);
  }
}
