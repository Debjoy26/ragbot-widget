import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fakeTokensFor, fakeVectorFor } from './fake-embeddings.ts';

// LABELLED FAKE (P7-E2E). A loopback HTTP server that speaks the OpenAI-style API:
//   POST .../chat/completions   streamed chat, scripted per request
//   POST .../embeddings         deterministic 1536-dimension unit vectors (see fake-embeddings.ts)
// The built API is configured with `openai_compatible` and `*_BASE_URL=http://127.0.0.1:<port>`.
//
// A chat request whose system prompt is the content-safety classifier prompt is a MODERATION call:
// the server answers ALLOW or BLOCK from a rule over the text between the classifier markers. Every
// other chat request takes the next script from the queue. No provider is ever called, and nothing
// here satisfies an evaluation gate. Every request is recorded (count and parsed body) so a test can
// assert what the API sent and whether it aborted an upstream call.
//
// A server with an empty script queue answers 500 and counts the request as `unscripted`, so a test
// that forgot to script a call fails loudly instead of passing on a default.

const CLASSIFIER_PREFIX = 'You are a content-safety classifier';
const MARKER_OPEN = '<<<MESSAGE_TO_CLASSIFY>>>\n';
const MARKER_CLOSE = '\n<<<END_MESSAGE_TO_CLASSIFY>>>';

export type FakeKind = 'chat' | 'moderation' | 'embedding';

export interface ChatScript {
  /** A non-2xx status: the request fails with this status and a small JSON error. */
  readonly status?: number;
  /** Sent as `Retry-After` with a failing status. */
  readonly retryAfterSeconds?: number;
  /** Delay before the response headers are written (a slow or stuck provider). */
  readonly startDelayMs?: number;
  /** Text pieces, each one `delta.content` event. */
  readonly pieces?: readonly string[];
  /** Delay before each piece. */
  readonly pieceDelayMs?: number;
  /**
   * Wait this long after the last piece before ending the stream. A `drop` straight after a write can
   * discard the unsent bytes, so a test that needs the client to have SEEN the pieces sets this.
   */
  readonly endDelayMs?: number;
  /**
   * After the pieces: `complete` (default) finishes with a finish reason, usage and [DONE]; `drop`
   * destroys the connection (a truncated stream); `hang` keeps it open until the client leaves;
   * `error_event` sends an error event and ends.
   */
  readonly end?: 'complete' | 'drop' | 'hang' | 'error_event';
  readonly finishReason?: 'stop' | 'length' | 'content_filter';
  /** Reported usage; `null` leaves usage out (the adapter then estimates). Default: 800 in, text/4 out. */
  readonly usage?: { readonly promptTokens: number; readonly completionTokens: number } | null;
}

export type ModerationStep = 'ALLOW' | 'BLOCK' | { readonly status: number };

export interface RecordedRequest {
  readonly index: number;
  readonly kind: FakeKind;
  /** Parsed JSON body (synthetic test text only). */
  readonly body: unknown;
  readonly receivedAt: number;
  readonly keyOk: boolean;
  /** True once the client closed the connection before the response had ended. */
  aborted: boolean;
  /** When the last scripted byte was written (or the response ended). */
  endedAt: number | null;
  /** Wall-clock time the first piece of text was written. */
  firstPieceAt: number | null;
}

export interface FakeLlmServerOptions {
  /** Bearer keys the server accepts; any other key is a 401. */
  readonly acceptedKeys: readonly string[];
  /** The model name reported by the embeddings endpoint. */
  readonly embeddingModel: string;
  readonly label: string;
}

export interface FakeLlmServer {
  readonly label: string;
  /** `http://127.0.0.1:<port>` with no path. */
  readonly baseUrl: string;
  readonly requests: readonly RecordedRequest[];
  /** Number of recorded requests of this kind. */
  count(kind: FakeKind): number;
  of(kind: FakeKind): RecordedRequest[];
  /** Requests answered 500 because no script was queued. Must stay 0. */
  unscripted(): number;
  authFailures(): number;

  /** Scripts for the next chat (non-moderation) requests, consumed in order. */
  queueChat(...scripts: ChatScript[]): void;
  /** Rule that decides moderation text; default blocks text containing `BLOCKME`. */
  setModerationRule(rule: (text: string) => 'ALLOW' | 'BLOCK'): void;
  /** Overrides the rule for the next moderation calls, consumed in order. */
  queueModeration(...steps: ModerationStep[]): void;
  /** Questions whose embedding equals the vector of `topic` (chunks use `vectorFor(topic)`). */
  embedAs(text: string, topic: string): void;
  /** Fail the next embedding calls with this status. */
  failEmbeddings(status: number, count?: number): void;
  /** The vector a chunk about `topic` must carry to match a question embedded as that topic. */
  vectorFor(topic: string): number[];

  /** Resolves when `predicate` holds for the recorded requests, or throws after `timeoutMs`. */
  waitFor(label: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  reset(): void;
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify(body));
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The text a classifier call was asked to judge (between the classifier markers). */
function classifierText(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body['messages'])) return null;
  const messages: unknown[] = body['messages'];
  const system = messages[0];
  if (!isRecord(system) || typeof system['content'] !== 'string') return null;
  if (!system['content'].startsWith(CLASSIFIER_PREFIX)) return null;
  const user = messages[1];
  const content = isRecord(user) && typeof user['content'] === 'string' ? user['content'] : '';
  const start = content.indexOf(MARKER_OPEN);
  const end = content.lastIndexOf(MARKER_CLOSE);
  if (start === -1 || end === -1 || end < start) return '';
  return content.slice(start + MARKER_OPEN.length, end);
}

const DEFAULT_RULE = (text: string): 'ALLOW' | 'BLOCK' =>
  text.includes('BLOCKME') ? 'BLOCK' : 'ALLOW';

const chunkEvent = (model: string, content: string): string =>
  `data: ${JSON.stringify({
    id: 'fake-chat',
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;

export async function startFakeLlmServer(options: FakeLlmServerOptions): Promise<FakeLlmServer> {
  const accepted = new Set(options.acceptedKeys);
  const requests: RecordedRequest[] = [];
  let chatQueue: ChatScript[] = [];
  let moderationQueue: ModerationStep[] = [];
  let moderationRule = DEFAULT_RULE;
  let topics = new Map<string, string>();
  let embedFailures: number[] = [];
  let unscripted = 0;
  let authFailures = 0;
  const open = new Set<ServerResponse>();

  async function chat(
    res: ServerResponse,
    record: RecordedRequest,
    script: ChatScript,
  ): Promise<void> {
    const model = isRecord(record.body) ? String(record.body['model'] ?? 'fake') : 'fake';
    if (script.startDelayMs !== undefined && script.startDelayMs > 0) {
      await sleep(script.startDelayMs);
      if (res.destroyed) return;
    }
    if (script.status !== undefined && script.status >= 300) {
      const extra: Record<string, string> =
        script.retryAfterSeconds === undefined
          ? {}
          : { 'retry-after': String(script.retryAfterSeconds) };
      sendJson(res, script.status, { error: { message: 'FAKE-UPSTREAM-ERROR-BODY' } }, extra);
      record.endedAt = Date.now();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    let written = '';
    for (const piece of script.pieces ?? []) {
      if (script.pieceDelayMs !== undefined && script.pieceDelayMs > 0) {
        await sleep(script.pieceDelayMs);
      }
      if (res.destroyed || res.writableEnded) return;
      res.write(chunkEvent(model, piece));
      record.firstPieceAt ??= Date.now();
      written += piece;
    }
    record.endedAt = Date.now();
    if (script.endDelayMs !== undefined && script.endDelayMs > 0) {
      await sleep(script.endDelayMs);
      if (res.destroyed) return;
    }
    const end = script.end ?? 'complete';
    if (end === 'hang') return; // until the client leaves; the 'close' handler records the abort
    if (end === 'drop') {
      res.destroy();
      return;
    }
    if (end === 'error_event') {
      res.write(
        `data: ${JSON.stringify({ error: { message: 'FAKE-STREAM-ERROR', type: 'server_error' } })}\n\n`,
      );
      res.end();
      return;
    }
    res.write(
      `data: ${JSON.stringify({
        id: 'fake-chat',
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: {}, finish_reason: script.finishReason ?? 'stop' }],
      })}\n\n`,
    );
    const usage =
      script.usage === undefined
        ? { promptTokens: 800, completionTokens: Math.ceil(written.length / 4) + 1 }
        : script.usage;
    if (usage !== null) {
      res.write(
        `data: ${JSON.stringify({
          id: 'fake-chat',
          object: 'chat.completion.chunk',
          model,
          choices: [],
          usage: {
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.promptTokens + usage.completionTokens,
          },
        })}\n\n`,
      );
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (req.method !== 'POST') {
          sendJson(res, 404, { error: { message: 'not found' } });
          return;
        }
        const isChat = path.endsWith('/chat/completions');
        const isEmbedding = path.endsWith('/embeddings');
        if (!isChat && !isEmbedding) {
          sendJson(res, 404, { error: { message: 'not found' } });
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          sendJson(res, 400, { error: { message: 'bad json' } });
          return;
        }
        const auth = req.headers['authorization'];
        const keyOk = typeof auth === 'string' && accepted.has(auth.replace(/^Bearer /, ''));
        const judged = isChat ? classifierText(body) : null;
        const kind: FakeKind = isEmbedding ? 'embedding' : judged !== null ? 'moderation' : 'chat';
        const record: RecordedRequest = {
          index: requests.length,
          kind,
          body,
          receivedAt: Date.now(),
          keyOk,
          aborted: false,
          endedAt: null,
          firstPieceAt: null,
        };
        requests.push(record);
        open.add(res);
        res.on('close', () => {
          open.delete(res);
          if (!res.writableEnded) record.aborted = true;
          record.endedAt ??= Date.now();
        });

        if (!keyOk) {
          authFailures += 1;
          sendJson(res, 401, { error: { message: 'bad key' } });
          return;
        }

        if (kind === 'embedding') {
          const failure = embedFailures.shift();
          if (failure !== undefined) {
            sendJson(res, failure, { error: { message: 'FAKE-UPSTREAM-ERROR-BODY' } });
            return;
          }
          const input = isRecord(body) ? body['input'] : undefined;
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
          const tokens = fakeTokensFor(texts);
          sendJson(res, 200, {
            object: 'list',
            model: options.embeddingModel,
            data: texts.map((t, index) => ({
              object: 'embedding',
              index,
              embedding: fakeVectorFor(topics.get(t) ?? t),
            })),
            usage: { prompt_tokens: tokens, total_tokens: tokens },
          });
          record.endedAt = Date.now();
          return;
        }

        if (kind === 'moderation') {
          const step = moderationQueue.shift() ?? moderationRule(judged ?? '');
          if (typeof step === 'object') {
            sendJson(res, step.status, { error: { message: 'FAKE-UPSTREAM-ERROR-BODY' } });
            return;
          }
          await chat(res, record, {
            pieces: [step],
            usage: {
              promptTokens: 200 + Math.ceil((judged ?? '').length / 4),
              completionTokens: 1,
            },
          });
          return;
        }

        const script = chatQueue.shift();
        if (script === undefined) {
          unscripted += 1;
          sendJson(res, 500, { error: { message: 'no script queued' } });
          return;
        }
        await chat(res, record, script);
      } catch {
        if (!res.headersSent) sendJson(res, 500, { error: { message: 'fake server error' } });
        else res.destroy();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    label: options.label,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    requests,
    count: (kind) => requests.filter((r) => r.kind === kind).length,
    of: (kind) => requests.filter((r) => r.kind === kind),
    unscripted: () => unscripted,
    authFailures: () => authFailures,
    queueChat: (...scripts) => {
      chatQueue.push(...scripts);
    },
    setModerationRule: (rule) => {
      moderationRule = rule;
    },
    queueModeration: (...steps) => {
      moderationQueue.push(...steps);
    },
    embedAs: (text, topic) => {
      topics.set(text, topic);
    },
    failEmbeddings: (status, count = 1) => {
      for (let i = 0; i < count; i++) embedFailures.push(status);
    },
    vectorFor: (topic) => fakeVectorFor(topic),
    waitFor: async (label, predicate, timeoutMs = 10_000) => {
      const end = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() >= end) throw new Error(`timed out waiting for: ${label}`);
        await sleep(25);
      }
    },
    reset: () => {
      requests.length = 0;
      chatQueue = [];
      moderationQueue = [];
      moderationRule = DEFAULT_RULE;
      topics = new Map();
      embedFailures = [];
      unscripted = 0;
      authFailures = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of open) res.destroy();
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
