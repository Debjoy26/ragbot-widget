import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ProviderError,
  VECTOR_DIMENSIONS,
  type EmbeddingProvider,
  type EmbeddingResult,
  type EmbedOptions,
} from '@ragbot/shared';

// FAKE embeddings for the P6 ingestion tests. LABELLED FAKE: no provider is ever called. Two front ends
// share one backend:
//  * FakeEmbeddingProvider  - an in-process `EmbeddingProvider` for runtime tests.
//  * startFakeEmbeddingsServer - a loopback HTTP server that speaks the OpenAI `/embeddings` shape, for
//    tests that run the real worker process (`EMBEDDING_PROVIDER=openai_compatible`).
// Both return deterministic 1536-length unit vectors, count calls, and can be told to fail transiently,
// permanently or with 429, to fail only from a given call on, or to hold one call until released.

export type FakeFailure = 'transient' | 'rate_limited' | 'permanent';

export class FakeBackendFailure extends Error {
  override readonly name = 'FakeBackendFailure';
  readonly kind: FakeFailure;
  constructor(kind: FakeFailure) {
    super(`fake embedding backend failure (${kind})`);
    this.kind = kind;
  }
}

/** A deterministic unit vector of VECTOR_DIMENSIONS numbers for a text (same text, same vector). */
export function fakeVectorFor(text: string): number[] {
  const seed = createHash('sha256').update(text).digest();
  let a = seed.readUInt32LE(0) | 1;
  let b = seed.readUInt32LE(4) | 1;
  let c = seed.readUInt32LE(8) | 1;
  let d = seed.readUInt32LE(12) | 1;
  const next = (): number => {
    // sfc32
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  const v = new Array<number>(VECTOR_DIMENSIONS);
  let norm = 0;
  for (let i = 0; i < VECTOR_DIMENSIONS; i++) {
    const x = next() * 2 - 1;
    v[i] = x;
    norm += x * x;
  }
  const scale = 1 / Math.sqrt(norm);
  return v.map((x) => x * scale);
}

/** Fake billable tokens: one per four characters, at least one per input. */
export function fakeTokensFor(texts: readonly string[]): number {
  return texts.reduce((sum, t) => sum + Math.max(1, Math.ceil(t.length / 4)), 0);
}

export interface Hold {
  /** Resolves when the held call has arrived. */
  readonly reached: Promise<void>;
  /** Lets the held call (and any later matching call) continue. */
  release(): void;
}

interface PendingHold {
  match: (callNumber: number, texts: readonly string[]) => boolean;
  armed: boolean;
  arrive: () => void;
  gate: Promise<void>;
  open: () => void;
}

/** The shared behaviour and counters. */
export class FakeEmbeddingBackend {
  /** Calls that arrived, whether they succeeded or not. */
  calls = 0;
  /** Calls that returned vectors. */
  completedCalls = 0;
  /** Inputs seen across all calls (count only; texts are not kept). */
  inputsSeen = 0;
  /** Input tokens reported across the calls that succeeded. */
  tokensReported = 0;
  /** Sizes of the calls that arrived, in order. */
  readonly batchSizes: number[] = [];

  private failureQueue: FakeFailure[] = [];
  private failAlwaysKind: FakeFailure | null = null;
  private failFromCall: { from: number; kind: FakeFailure } | null = null;
  private readonly holds: PendingHold[] = [];
  /** Extra latency per call, milliseconds. */
  delayMs = 0;

  constructor(readonly model: string) {}

  /** The next `count` calls fail with `kind`. */
  failNext(kind: FakeFailure, count = 1): void {
    for (let i = 0; i < count; i++) this.failureQueue.push(kind);
  }

  /** Every call fails with `kind` until `stopFailing()`. */
  failAlways(kind: FakeFailure): void {
    this.failAlwaysKind = kind;
  }

  /** Calls number `n` (1-based, counting all calls) and later fail with `kind`. */
  failFrom(n: number, kind: FakeFailure): void {
    this.failFromCall = { from: n, kind };
  }

  /** Calls after the first `n` calls fail with `kind` (same as failFrom(n + 1, kind)). */
  failAfter(n: number, kind: FakeFailure): void {
    this.failFrom(n + 1, kind);
  }

  stopFailing(): void {
    this.failureQueue = [];
    this.failAlwaysKind = null;
    this.failFromCall = null;
  }

  /** Holds call number `n` (1-based) until released. */
  holdCall(n: number): Hold {
    return this.addHold((callNumber) => callNumber === n);
  }

  /** Holds the first call whose input texts satisfy `pred` until released. */
  holdWhen(pred: (texts: readonly string[]) => boolean): Hold {
    return this.addHold((_n, texts) => pred(texts));
  }

  /** Releases every hold, armed or not. Safe to call more than once. */
  releaseAll(): void {
    for (const h of this.holds) h.open();
  }

  private addHold(match: PendingHold['match']): Hold {
    let arrive!: () => void;
    let open!: () => void;
    const reached = new Promise<void>((r) => {
      arrive = r;
    });
    const gate = new Promise<void>((r) => {
      open = r;
    });
    this.holds.push({ match, armed: true, arrive, gate, open });
    const hold = this.holds[this.holds.length - 1];
    return { reached, release: () => hold?.open() };
  }

  private failureFor(callNumber: number): FakeFailure | null {
    const queued = this.failureQueue.shift();
    if (queued !== undefined) return queued;
    if (this.failAlwaysKind !== null) return this.failAlwaysKind;
    if (this.failFromCall !== null && callNumber >= this.failFromCall.from) {
      return this.failFromCall.kind;
    }
    return null;
  }

  /**
   * One embedding call. Throws FakeBackendFailure when told to fail. If `signal` aborts while the call is
   * held or delayed, rejects with an AbortError (the caller went away).
   */
  async handle(texts: readonly string[], signal?: AbortSignal): Promise<EmbeddingResult> {
    this.calls += 1;
    const callNumber = this.calls;
    this.batchSizes.push(texts.length);
    this.inputsSeen += texts.length;

    for (const h of this.holds) {
      if (h.armed && h.match(callNumber, texts)) {
        h.armed = false;
        h.arrive();
        await raceAbort(h.gate, signal);
      }
    }
    if (this.delayMs > 0) await raceAbort(sleep(this.delayMs), signal);
    if (signal?.aborted === true) throw abortError();

    const failure = this.failureFor(callNumber);
    if (failure !== null) throw new FakeBackendFailure(failure);

    const inputTokens = fakeTokensFor(texts);
    this.completedCalls += 1;
    this.tokensReported += inputTokens;
    return { vectors: texts.map((t) => fakeVectorFor(t)), inputTokens };
  }
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function raceAbort(p: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return p;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error('rejected'));
      },
    );
  });
}

/** LABELLED FAKE `EmbeddingProvider` for in-process runtime tests. */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'openai_compatible' as const;
  readonly model: string;
  readonly dimensions = VECTOR_DIMENSIONS;
  readonly isFake = true as const;

  constructor(readonly backend: FakeEmbeddingBackend) {
    this.model = backend.model;
  }

  async embed(texts: readonly string[], options: EmbedOptions): Promise<EmbeddingResult> {
    try {
      return await this.backend.handle(texts, options.signal);
    } catch (e) {
      if (e instanceof FakeBackendFailure) {
        if (e.kind === 'transient') throw new ProviderError('transient', 'fake transient failure');
        if (e.kind === 'rate_limited') {
          throw new ProviderError('rate_limited', 'fake rate limit', { retryAfterSeconds: 1 });
        }
        throw new ProviderError('permanent', 'fake permanent failure');
      }
      throw e;
    }
  }
}

export interface FakeEmbeddingsServer {
  readonly backend: FakeEmbeddingBackend;
  /** `http://127.0.0.1:<port>` with no path. */
  readonly baseUrl: string;
  /** Requests rejected for a missing or wrong bearer key. */
  readonly authFailures: () => number;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
) {
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify(body));
}

/**
 * LABELLED FAKE OpenAI-shaped embeddings server on 127.0.0.1 (random port). Accepts POST on any path that
 * ends in `/embeddings`, requires `Authorization: Bearer <expectedKey>`.
 */
export async function startFakeEmbeddingsServer(options: {
  backend: FakeEmbeddingBackend;
  expectedKey: string;
}): Promise<FakeEmbeddingsServer> {
  const { backend, expectedKey } = options;
  let authFailures = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (req.method !== 'POST' || !path.endsWith('/embeddings')) {
          sendJson(res, 404, { error: { message: 'not found' } });
          return;
        }
        if (req.headers['authorization'] !== `Bearer ${expectedKey}`) {
          authFailures += 1;
          sendJson(res, 401, { error: { message: 'bad key' } });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readBody(req));
        } catch {
          sendJson(res, 400, { error: { message: 'bad json' } });
          return;
        }
        const input = (parsed as { input?: unknown } | null)?.input;
        const texts =
          typeof input === 'string'
            ? [input]
            : Array.isArray(input) && input.every((x) => typeof x === 'string')
              ? (input as string[])
              : null;
        if (texts === null || texts.length === 0) {
          sendJson(res, 400, { error: { message: 'bad input' } });
          return;
        }
        const aborted = new AbortController();
        res.on('close', () => {
          if (!res.writableEnded) aborted.abort();
        });
        try {
          const result = await backend.handle(texts, aborted.signal);
          sendJson(res, 200, {
            object: 'list',
            model: backend.model,
            data: result.vectors.map((embedding, index) => ({
              object: 'embedding',
              index,
              embedding,
            })),
            usage: {
              prompt_tokens: result.inputTokens ?? 0,
              total_tokens: result.inputTokens ?? 0,
            },
          });
        } catch (e) {
          if (e instanceof FakeBackendFailure) {
            if (e.kind === 'transient') {
              sendJson(res, 500, { error: { message: 'fake upstream error' } });
            } else if (e.kind === 'rate_limited') {
              sendJson(res, 429, { error: { message: 'fake rate limit' } }, { 'retry-after': '1' });
            } else {
              sendJson(res, 400, { error: { message: 'fake bad request' } });
            }
          }
          // An abort (the client went away) needs no answer.
        }
      } catch {
        if (!res.headersSent) sendJson(res, 500, { error: { message: 'fake server error' } });
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    backend,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    authFailures: () => authFailures,
    close: () =>
      new Promise<void>((resolve) => {
        backend.releaseAll();
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
