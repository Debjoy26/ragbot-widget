// FAKE AI providers for tests (P7). In-memory, scripted, no network. Everything here is labelled
// FAKE on purpose: a fake provider never satisfies a real acceptance gate (CLAUDE.md), and the
// evaluation set of P11 must run against real providers.
//
// They depend only on the shared provider interfaces, so the API unit tests and the end-to-end
// tests use the same fakes:
//  * FakeChatProvider      scripted text chunks, failure before or after N chunks, per-chunk delay,
//                          hanging until aborted, and abort recording.
//  * FakeModerationProvider a verdict function over the text, or a failure; records calls.
//  * FakeEmbeddingProvider  a constant unit-ish vector, scripted failure, records calls.
// Recorded calls hold the text they were given so a test can assert on it; that is why these are
// for tests only and never imported by the API.

import {
  ProviderError,
  VECTOR_DIMENSIONS,
  type ChatProvider,
  type ChatStream,
  type ChatStreamRequest,
  type ChatUsage,
  type EmbeddingProvider,
  type EmbeddingResult,
  type EmbedOptions,
  type ModerationProvider,
  type ModerationResult,
  type ProviderKind,
} from '@ragbot/shared';

function abortError(): Error {
  const err = new Error('FAKE aborted');
  err.name = 'AbortError';
  return err;
}

/** Waits `ms`, or throws AbortError as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface FakeChatScript {
  /** Text chunks to stream, in order. */
  readonly chunks?: readonly string[];
  /** Throw this before the first chunk (the request failed before any token). */
  readonly failBefore?: Error;
  /** Throw `failAfter.error` after `failAfter.chunks` chunks were yielded. */
  readonly failAfter?: { readonly chunks: number; readonly error: Error };
  /** Pause before every chunk (abortable). */
  readonly chunkDelayMs?: number;
  /** Never yield: wait until the signal aborts (a stuck provider). */
  readonly hang?: boolean;
  /** Final usage; defaults to a simple estimate. */
  readonly usage?: ChatUsage;
}

export class FakeChatProvider implements ChatProvider {
  readonly provider: ProviderKind;
  readonly model: string;
  /** Every request received, in order (the system prompt and messages are kept for assertions). */
  readonly requests: ChatStreamRequest[] = [];
  /** Number of calls that ended because the signal aborted. */
  abortedCalls = 0;
  readonly #scripts: readonly FakeChatScript[];

  /** Call n uses script n; the last script repeats for later calls. */
  constructor(
    scripts: readonly FakeChatScript[],
    identity: { provider?: ProviderKind; model?: string } = {},
  ) {
    if (scripts.length === 0) throw new Error('FakeChatProvider needs at least one script');
    this.#scripts = scripts;
    this.provider = identity.provider ?? 'gemini';
    this.model = identity.model ?? 'fake-chat-model';
  }

  get calls(): number {
    return this.requests.length;
  }

  stream(request: ChatStreamRequest): ChatStream {
    const index = this.requests.length;
    this.requests.push(request);
    const script = this.#scripts[Math.min(index, this.#scripts.length - 1)] as FakeChatScript;
    return this.#run(request, script);
  }

  async *#run(request: ChatStreamRequest, script: FakeChatScript): ChatStream {
    const signal = request.signal;
    try {
      if (script.failBefore !== undefined) throw script.failBefore;
      if (script.hang === true) await pause(2 ** 31 - 1, signal);
      const chunks = script.chunks ?? [];
      let chars = 0;
      for (let i = 0; i < chunks.length; i += 1) {
        if (script.failAfter !== undefined && i === script.failAfter.chunks) {
          throw script.failAfter.error;
        }
        if (script.chunkDelayMs !== undefined) await pause(script.chunkDelayMs, signal);
        else if (signal?.aborted === true) throw abortError();
        const text = chunks[i] as string;
        chars += text.length;
        yield { text };
      }
      if (script.failAfter !== undefined && script.failAfter.chunks >= chunks.length) {
        throw script.failAfter.error;
      }
      return script.usage ?? { inputTokens: 100, outputTokens: Math.ceil(chars / 3) };
    } catch (err) {
      if (signal?.aborted === true) this.abortedCalls += 1;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

/** What a fake moderation call does: a verdict, or a thrown failure. */
export type FakeModerationAction = 'allow' | 'block' | Error;

export class FakeModerationProvider implements ModerationProvider {
  readonly provider: ProviderKind;
  readonly model: string;
  /** The text of every call, in order. */
  readonly texts: string[] = [];
  readonly #decide: (text: string, callIndex: number) => FakeModerationAction;
  readonly #usage: ChatUsage | null;

  /**
   * @param decide  verdict (or failure) for a call
   * @param usage   what each call reports: null mimics the free endpoint mode
   */
  constructor(
    decide: (text: string, callIndex: number) => FakeModerationAction = () => 'allow',
    usage: ChatUsage | null = { inputTokens: 600, outputTokens: 2 },
    identity: { provider?: ProviderKind; model?: string } = {},
  ) {
    this.#decide = decide;
    this.#usage = usage;
    this.provider = identity.provider ?? 'gemini';
    this.model = identity.model ?? 'fake-moderation-model';
  }

  get calls(): number {
    return this.texts.length;
  }

  async moderate(
    text: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ModerationResult> {
    const index = this.texts.length;
    this.texts.push(text);
    if (options?.signal?.aborted === true) throw abortError();
    const action = this.#decide(text, index);
    if (action instanceof Error) throw action;
    return {
      verdict: action,
      categories: action === 'block' ? ['fake_block'] : [],
      usage: this.#usage,
    };
  }
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly dimensions = VECTOR_DIMENSIONS;
  readonly texts: string[] = [];
  readonly taskTypes: string[] = [];
  readonly #fail: Error | undefined;
  readonly #inputTokens: number | null;
  readonly #delayMs: number;

  constructor(
    options: {
      model?: string;
      provider?: ProviderKind;
      fail?: Error;
      inputTokens?: number | null;
      delayMs?: number;
    } = {},
  ) {
    this.provider = options.provider ?? 'gemini';
    this.model = options.model ?? 'fake-embedding-model';
    this.#fail = options.fail;
    this.#inputTokens = options.inputTokens === undefined ? 8 : options.inputTokens;
    this.#delayMs = options.delayMs ?? 0;
  }

  get calls(): number {
    return this.texts.length;
  }

  async embed(texts: readonly string[], options: EmbedOptions): Promise<EmbeddingResult> {
    this.texts.push(...texts);
    this.taskTypes.push(options.taskType);
    if (this.#delayMs > 0) await pause(this.#delayMs, options.signal);
    else if (options.signal?.aborted === true) throw abortError();
    if (this.#fail !== undefined) throw this.#fail;
    return {
      vectors: texts.map(() => new Array<number>(VECTOR_DIMENSIONS).fill(0.01)),
      inputTokens: this.#inputTokens,
    };
  }
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/** A ProviderError with a fixed message, as the real adapters raise. */
export function fakeProviderError(
  kind: ConstructorParameters<typeof ProviderError>[0],
  options: { billed?: boolean; retryAfterSeconds?: number } = {},
): ProviderError {
  return new ProviderError(kind, 'FAKE provider failure', options);
}
