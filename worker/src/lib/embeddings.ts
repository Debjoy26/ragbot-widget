// Embedding adapters (P6-INDEX): Gemini batchEmbedContents, OpenAI and openai_compatible
// /v1/embeddings. Implements the shared `EmbeddingProvider` interface; Anthropic has no
// embeddings API and is refused at creation.
//
// Rules (TECH_SPECS section 8, ADR 0014):
//  * Every vector must be exactly VECTOR_DIMENSIONS long, finite, and in input order. A provider
//    that returns anything else raises a permanent ProviderError: nothing is padded or truncated.
//  * Failures map onto the shared ProviderError kinds: HTTP 429 -> rate_limited; 408, 5xx, network
//    errors, timeouts and unparseable bodies -> transient; 401/403 -> auth; 402 -> billing; any
//    other 4xx and a wrong response shape -> permanent.
//  * `billed`: every ProviderError raised after the provider answered 2xx (oversized or unreadable
//    body, bad JSON, wrong shape, vector bounds, wrong dimensions) carries `billed: true`, whatever
//    its kind: the request was accepted and is charged. Errors before or instead of a 2xx (network,
//    timeout, any non-2xx status) are `billed: false`. The caller's spend accounting relies on it.
//  * The API key travels in a header only (never a URL). Error messages are fixed strings: they
//    carry no URL, no request text, no upstream body and no key.
//  * A caller abort (lease lost, shutdown) is rethrown as an AbortError, not a ProviderError.
//  * Every request has a bounded timeout.
import {
  assertEmbeddingShape,
  ProviderError,
  VECTOR_DIMENSIONS,
  type EmbeddingConfig,
  type EmbeddingProvider,
  type EmbeddingResult,
  type EmbedOptions,
  type ProviderErrorKind,
} from '@ragbot/shared';

export const EMBEDDING_REQUEST_TIMEOUT_MS = 60_000;
/** batchEmbedContents accepts at most 100 requests per call; larger inputs are split. */
export const GEMINI_MAX_BATCH = 100;
/** write_document_chunks accepts at most this many chunks per call, so no batch is larger. */
export const MAX_WRITE_BATCH = 200;

/**
 * The most inputs one indexing batch may hold for `provider`. A batch is meant to be ONE provider
 * request, so a failure after the request was sent cannot hide a part that was already paid for:
 * Gemini's batchEmbedContents takes at most 100, the others are bound by MAX_WRITE_BATCH.
 */
export function maxEmbeddingBatchSize(provider: EmbeddingConfig['provider']): number {
  return provider === 'gemini' ? GEMINI_MAX_BATCH : MAX_WRITE_BATCH;
}
/** A response larger than this many bytes is refused (200 vectors of 1536 numbers is about 6 MB of JSON). */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/**
 * No vector component may exceed this in absolute value. Real embeddings sit within about +-1 (a
 * few models are unnormalised but stay far below this); the bound is far under the float4 limit
 * (3.4e38) so a hostile or broken provider cannot push the database into an overflow.
 */
export const MAX_VECTOR_COMPONENT_ABS = 1e6;
const GEMINI_HOST = 'https://generativelanguage.googleapis.com';
const OPENAI_HOST = 'https://api.openai.com';
const MAX_RETRY_AFTER_SECONDS = 3600;

export interface CreateEmbeddingProviderOptions {
  /** Injected for tests only. */
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout. Defaults to EMBEDDING_REQUEST_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

interface Endpoint {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('embedding request aborted');
  err.name = 'AbortError';
  return err;
}

export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'rate_limited';
  if (status === 408 || status >= 500) return 'transient';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  return 'permanent';
}

function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(seconds));
}

/**
 * Reads a response body as UTF-8 text, never holding more than MAX_RESPONSE_BYTES: a declared
 * content-length over the cap is refused before reading, and a stream that passes the cap is
 * cancelled. Throws ProviderError('permanent', billed) for an oversized body: it only runs after a
 * 2xx response.
 */
async function readCappedText(res: Response): Promise<string> {
  const declared = res.headers.get('content-length');
  const tooLarge = (): ProviderError =>
    new ProviderError('permanent', 'embedding response is too large', { billed: true });
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const body = res.body;
  if (body === null) throw new Error('no response body');
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(parts));
}

/**
 * Throws a permanent, billed ProviderError when any component is not finite or is beyond the bound.
 * Only ever called on a response the provider already returned, so the request was billed.
 */
export function assertVectorBounds(vectors: readonly (readonly number[])[]): void {
  for (const v of vectors) {
    for (const n of v) {
      if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > MAX_VECTOR_COMPONENT_ABS) {
        throw new ProviderError('permanent', 'embedding provider returned an invalid vector', {
          billed: true,
        });
      }
    }
  }
}

/** A ProviderError marked billed (same kind, message and retry-after); anything else unchanged. */
function markBilled(err: unknown): unknown {
  if (err instanceof ProviderError && !err.billed) {
    return new ProviderError(err.kind, err.message, {
      billed: true,
      ...(err.retryAfterSeconds === null ? {} : { retryAfterSeconds: err.retryAfterSeconds }),
    });
  }
  return err;
}

/**
 * Runs `check` on a response the provider already returned (2xx) and marks any ProviderError it
 * raises as billed, keeping the kind and message. Other errors pass through unchanged.
 */
function whenBilled(check: () => void): void {
  try {
    check();
  } catch (err) {
    throw markBilled(err);
  }
}

/** POSTs JSON and returns the parsed body. Throws only ProviderError or an abort error. */
async function postJson(
  fetchImpl: typeof fetch,
  endpoint: Endpoint,
  body: unknown,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<unknown> {
  const callerAborted = (): boolean => callerSignal?.aborted === true;
  if (callerSignal !== undefined && callerAborted()) throw abortError(callerSignal);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout]);

  let res: Response;
  try {
    res = await fetchImpl(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...endpoint.headers },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });
  } catch {
    // Not the error's message or cause: either can name the host or echo request details.
    if (callerSignal !== undefined && callerAborted()) throw abortError(callerSignal);
    if (timeout.aborted) throw new ProviderError('transient', 'embedding request timed out');
    throw new ProviderError('transient', 'embedding request failed (network)');
  }

  if (!res.ok) {
    const kind = kindForStatus(res.status);
    const retryAfterSeconds = parseRetryAfter(res);
    // Drain without reading the body into an error.
    await res.body?.cancel().catch(() => undefined);
    throw new ProviderError(kind, `embedding provider returned HTTP ${String(res.status)}`, {
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }

  let text: string;
  try {
    text = await readCappedText(res);
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (callerSignal !== undefined && callerAborted()) throw abortError(callerSignal);
    // The provider answered 2xx: whatever goes wrong from here on, the request was billed.
    if (timeout.aborted) {
      throw new ProviderError('transient', 'embedding request timed out', { billed: true });
    }
    throw new ProviderError('transient', 'embedding response could not be read', { billed: true });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError('transient', 'embedding response is not valid JSON', { billed: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only used on a body the provider returned with 2xx, so it is billed. */
function wrongShape(): ProviderError {
  return new ProviderError('permanent', 'embedding provider returned an unexpected response', {
    billed: true,
  });
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) throw wrongShape();
  return value as number[];
}

// ---------------------------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------------------------

function createGemini(
  config: EmbeddingConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): EmbeddingProvider {
  const modelId = config.model.replace(/^models\//, '');
  const url = `${GEMINI_HOST}/v1beta/models/${encodeURIComponent(modelId)}:batchEmbedContents`;
  const endpoint: Endpoint = { url, headers: { 'x-goog-api-key': config.apiKey } };

  async function embedGroup(
    texts: readonly string[],
    options: EmbedOptions,
  ): Promise<readonly number[][]> {
    const taskType = options.taskType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
    const body = {
      requests: texts.map((text) => ({
        model: `models/${modelId}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: VECTOR_DIMENSIONS,
      })),
    };
    const json = await postJson(fetchImpl, endpoint, body, timeoutMs, options.signal);
    if (!isRecord(json) || !Array.isArray(json['embeddings'])) throw wrongShape();
    const embeddings: unknown[] = json['embeddings'];
    return embeddings.map((e) => {
      if (!isRecord(e)) throw wrongShape();
      return numberArray(e['values']);
    });
  }

  return {
    provider: 'gemini',
    model: config.model,
    dimensions: VECTOR_DIMENSIONS,
    async embed(texts, options): Promise<EmbeddingResult> {
      if (texts.length === 0) return { vectors: [], inputTokens: 0 };
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += GEMINI_MAX_BATCH) {
        const group = texts.slice(i, i + GEMINI_MAX_BATCH);
        // Once an earlier group was answered it was billed, so a later group's failure of any kind
        // (even a 5xx or a network error) leaves the call as a whole billed.
        const earlierAnswered = i > 0;
        try {
          const part = await embedGroup(group, options);
          whenBilled(() => {
            assertEmbeddingShape(part, group.length);
            assertVectorBounds(part);
          });
          vectors.push(...part);
        } catch (err) {
          throw earlierAnswered ? markBilled(err) : err;
        }
      }
      whenBilled(() => {
        assertEmbeddingShape(vectors, texts.length);
      });
      // Gemini's batch endpoint reports no usage: the caller estimates.
      return { vectors, inputTokens: null };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// OpenAI and OpenAI-compatible
// ---------------------------------------------------------------------------------------------

function embeddingsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return /\/v1$/.test(trimmed) ? `${trimmed}/embeddings` : `${trimmed}/v1/embeddings`;
}

function createOpenAiStyle(
  config: EmbeddingConfig,
  base: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): EmbeddingProvider {
  const endpoint: Endpoint = {
    url: embeddingsUrl(base),
    headers: { authorization: `Bearer ${config.apiKey}` },
  };
  return {
    provider: config.provider,
    model: config.model,
    dimensions: VECTOR_DIMENSIONS,
    async embed(texts, options): Promise<EmbeddingResult> {
      if (texts.length === 0) return { vectors: [], inputTokens: 0 };
      const body = {
        model: config.model,
        input: texts,
        dimensions: VECTOR_DIMENSIONS,
        encoding_format: 'float',
      };
      const json = await postJson(fetchImpl, endpoint, body, timeoutMs, options.signal);
      if (!isRecord(json) || !Array.isArray(json['data'])) throw wrongShape();
      const data: unknown[] = json['data'];
      if (data.length !== texts.length) throw wrongShape();

      // Order by the provider's `index`; it must be exactly 0..n-1 with no gaps or repeats.
      const vectors: number[][] = new Array<number[]>(texts.length);
      for (const item of data) {
        if (!isRecord(item)) throw wrongShape();
        const index = item['index'];
        if (
          typeof index !== 'number' ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= texts.length ||
          vectors[index] !== undefined
        ) {
          throw wrongShape();
        }
        vectors[index] = numberArray(item['embedding']);
      }
      whenBilled(() => {
        assertEmbeddingShape(vectors, texts.length);
        assertVectorBounds(vectors);
      });

      let inputTokens: number | null = null;
      const usage = json['usage'];
      if (isRecord(usage)) {
        const used = usage['prompt_tokens'] ?? usage['total_tokens'];
        if (typeof used === 'number' && Number.isInteger(used) && used >= 0) inputTokens = used;
      }
      return { vectors, inputTokens };
    },
  };
}

/**
 * Builds the embedding provider for `cfg`. Throws a plain Error (no key in the message) for a
 * provider without embeddings (anthropic) or a dimension other than VECTOR_DIMENSIONS.
 */
export function createEmbeddingProvider(
  cfg: EmbeddingConfig,
  opts: CreateEmbeddingProviderOptions = {},
): EmbeddingProvider {
  if (cfg.dimensions !== VECTOR_DIMENSIONS) {
    throw new Error(`embedding dimensions must be ${String(VECTOR_DIMENSIONS)}`);
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? EMBEDDING_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('embedding timeout must be a positive integer');
  }
  switch (cfg.provider) {
    case 'gemini':
      return createGemini(cfg, fetchImpl, timeoutMs);
    case 'openai':
      return createOpenAiStyle(cfg, OPENAI_HOST, fetchImpl, timeoutMs);
    case 'openai_compatible':
      if (cfg.baseUrl === null) throw new Error('openai_compatible embedding needs a base URL');
      return createOpenAiStyle(cfg, cfg.baseUrl, fetchImpl, timeoutMs);
    case 'anthropic':
      throw new Error('anthropic has no embeddings API');
  }
}
