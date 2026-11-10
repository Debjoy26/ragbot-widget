// Shared HTTP helpers for the chat and moderation adapters (P7). The embedding adapter keeps its own
// copies on purpose: its behaviour is frozen by P6 tests.
//
// Rules, identical to the embedding adapter:
//  * The API key travels in a header only. `redirect: 'error'`.
//  * Error messages are fixed strings: no URL, no key, no request text, no upstream body, and no
//    `cause` (a cause can carry any of those).
//  * A caller abort is rethrown as an AbortError, never as a ProviderError.
//  * `billed: true` on every ProviderError raised after a 2xx; `billed: false` before it.
//  * Status mapping: 429 rate_limited; 408, 5xx and network errors transient; 401 and 403 auth;
//    402 billing; any other 4xx permanent.
import { ProviderError } from '../providers.js';
import { kindForStatus } from './embeddings.js';

/** Options common to every adapter built in this module. */
export interface AiRequestOptions {
  /** Injected for tests only. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /**
   * Upper bound for one request, headers and body (and for a stream, the whole stream), in
   * milliseconds. A positive integer.
   */
  readonly requestTimeoutMs?: number;
}

export interface HttpEndpoint {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface OpenedRequest {
  readonly res: Response;
  /** Fires when the timeout elapses. */
  readonly timeout: AbortSignal;
  /** Caller signal combined with the timeout. */
  readonly signal: AbortSignal;
}

const MAX_RETRY_AFTER_SECONDS = 3600;

/** A function, so TypeScript does not narrow `signal.aborted` after an earlier check. */
function wasAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** A fresh AbortError: it never carries the caller's abort reason (which could be any value). */
export function abortError(label: string): Error {
  return new DOMException(`${label} request aborted`, 'AbortError');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates a timeout option; returns it or `fallback` when unset. Throws a plain Error. */
export function resolveTimeoutMs(value: number | undefined, fallback: number): number {
  const timeoutMs = value ?? fallback;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('request timeout must be a positive integer');
  }
  return timeoutMs;
}

/** Joins a configured base URL and an OpenAI-style path, tolerating a base that ends in /v1. */
export function openAiStyleUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return /\/v1$/.test(trimmed) ? `${trimmed}/${path}` : `${trimmed}/v1/${path}`;
}

function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(seconds));
}

/**
 * POSTs JSON and returns the response once the status line is known to be 2xx. Throws only
 * ProviderError (billed false: nothing was accepted) or an AbortError.
 */
export async function openRequest(
  fetchImpl: typeof fetch,
  endpoint: HttpEndpoint,
  body: unknown,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  label: string,
): Promise<OpenedRequest> {
  if (callerSignal?.aborted === true) throw abortError(label);
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
    if (wasAborted(callerSignal)) throw abortError(label);
    if (timeout.aborted) throw new ProviderError('transient', `${label} request timed out`);
    throw new ProviderError('transient', `${label} request failed (network)`);
  }

  if (!res.ok) {
    const kind = kindForStatus(res.status);
    const retryAfterSeconds = parseRetryAfter(res);
    // Drain without reading the body into an error.
    await res.body?.cancel().catch(() => undefined);
    throw new ProviderError(kind, `${label} provider returned HTTP ${String(res.status)}`, {
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  return { res, timeout, signal };
}

/**
 * Reads a 2xx response body as UTF-8 text, never holding more than `maxBytes`. Every failure is a
 * billed ProviderError (the provider answered 2xx) or an AbortError.
 */
export async function readCappedText(
  opened: OpenedRequest,
  maxBytes: number,
  callerSignal: AbortSignal | undefined,
  label: string,
): Promise<string> {
  const { res, timeout } = opened;
  const tooLarge = (): ProviderError =>
    new ProviderError('permanent', `${label} response is too large`, { billed: true });
  const declared = res.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const body = res.body;
  if (body === null) {
    throw new ProviderError('transient', `${label} response has no body`, { billed: true });
  }
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      parts.push(value);
    }
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (wasAborted(callerSignal)) throw abortError(label);
    if (timeout.aborted) {
      throw new ProviderError('transient', `${label} request timed out`, { billed: true });
    }
    throw new ProviderError('transient', `${label} response could not be read`, { billed: true });
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(parts));
}

/** POSTs JSON and parses a bounded JSON response. Throws only ProviderError or an AbortError. */
export async function postJson(
  fetchImpl: typeof fetch,
  endpoint: HttpEndpoint,
  body: unknown,
  timeoutMs: number,
  maxBytes: number,
  callerSignal: AbortSignal | undefined,
  label: string,
): Promise<unknown> {
  const opened = await openRequest(fetchImpl, endpoint, body, timeoutMs, callerSignal, label);
  const text = await readCappedText(opened, maxBytes, callerSignal, label);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError('transient', `${label} response is not valid JSON`, { billed: true });
  }
}
