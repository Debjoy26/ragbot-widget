import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createEmbeddingProvider } from '@ragbot/shared/ai';
import {
  API_ENTRY,
  ChatHarness,
  deltaText,
  eventsOf,
  postChat,
  waitUntil,
  type ApiHandle,
  type ChatBot,
  type ChatResult,
} from '../../integration/helpers/chat-fixtures.ts';

// P11 live-provider eval harness (primary provider only). Everything runs against the LOCAL
// Supabase stack with the BUILT API; only the AI calls are real (paid-tier Gemini, owner-confirmed
// 2026-11-24). No client data: corpus and questions are synthetic Acme fixtures.
// The suite is fail-closed: without EVAL_LIVE=1 every case skips and nothing is spent.

// P11 finding 2026-11-24: `gemini-2.5-flash-lite` is retired for new keys (HTTP 404:
// "no longer available to new users"). The eval runs the live successor
// `gemini-3.5-flash-lite`; repo defaults (ADR 0014) are untouched pending owner decision.
export const GEMINI_CHAT_MODEL = 'gemini-3.5-flash-lite';
export const GEMINI_EMBED_MODEL = 'gemini-embedding-001';

/** Non-enumerable spend state is unnecessary here; values are synthetic-test economics. */
export interface SpendTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export class EvalConfigError extends Error {
  override readonly name = 'EvalConfigError';
}

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function readDotEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new EvalConfigError(`eval needs ${path} (repo-local config, never committed)`);
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const cut = trimmed.indexOf('=');
    if (cut === -1) continue;
    out[trimmed.slice(0, cut).trim()] = trimmed.slice(cut + 1).trim();
  }
  return out;
}

/** Real provider key from the repo-local api/.env. Names the variable, never its value. */
export function readGeminiKey(): string {
  const env = readDotEnv(`${REPO_ROOT}api/.env`);
  const key = env['GEMINI_API_KEY'];
  if (key === undefined || key === '' || (key.includes('<') && key.includes('>'))) {
    throw new EvalConfigError('GEMINI_API_KEY is not set in api/.env');
  }
  return key;
}

export function liveEnabled(): boolean {
  return process.env['EVAL_LIVE'] === '1';
}

export function maxUsd(): number {
  const raw = process.env['EVAL_MAX_USD'] ?? '5';
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new EvalConfigError('EVAL_MAX_USD must be > 0');
  return value;
}

export interface EvalQuestion {
  readonly id: string;
  readonly message: string;
  readonly language?: string;
}

export interface EvalAnswer extends SpendTotals {
  readonly result: ChatResult;
  readonly text: string;
  readonly doneStatus: string | null;
  readonly handoff: {
    readonly reason: string;
    readonly message: string;
    readonly email: string | null;
  } | null;
  readonly sourceChunkIds: readonly string[];
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * Boots the built API with an explicit env (no fake-provider base URLs anywhere).
 * Mirrors the chat-fixtures boot; the handle only exposes what the eval uses.
 */
async function startEvalApi(env: Record<string, string>): Promise<ApiHandle> {
  if (!existsSync(API_ENTRY)) throw new Error('api/dist/main.js not found: run `npm run build`');
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [API_ENTRY], {
    cwd: REPO_ROOT,
    env: { PATH: process.env['PATH'] ?? '', ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.stdout?.on('data', (d: Buffer) => {
    out += d.toString('utf8');
  });
  child.stderr?.on('data', (d: Buffer) => {
    out += d.toString('utf8');
  });
  const closed = new Promise<void>((resolve) => {
    child.on('close', (code, signal) => {
      exit = { code, signal };
      resolve();
    });
  });
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  try {
    await waitUntil(
      'eval API to answer /health/live',
      async () => {
        if (exit !== undefined) {
          throw new Error(`eval API exited during start-up. Output:\n${out}`);
        }
        try {
          const res = await fetch(`${baseUrl}/health/live`, { signal: AbortSignal.timeout(2000) });
          await res.arrayBuffer();
          return res.status === 200;
        } catch {
          return false;
        }
      },
      20_000,
      100,
    );
  } catch (e) {
    child.kill('SIGKILL');
    throw new Error(`eval API failed to start. Output:\n${out}`, { cause: e });
  }
  return {
    name: 'eval-live',
    port,
    baseUrl,
    output: () => out,
    exited: () => exit,
    stop: async () => {
      if (exit === undefined) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
        await closed;
        clearTimeout(timer);
      }
    },
  };
}

/** Live eval driver: real Gemini through the real built API on the local stack. */
export class EvalHarness {
  private readonly apis: ApiHandle[] = [];
  private constructor(
    readonly h: ChatHarness,
    readonly api: ApiHandle,
    readonly bot: ChatBot,
    readonly corpusChunkIds: readonly string[],
    private spent: SpendTotals,
    private readonly cap: number,
  ) {
    this.apis.push(api);
  }

  static async create(corpus: {
    readonly title: string;
    readonly chunks: readonly { readonly content: string; readonly page?: number }[];
  }): Promise<EvalHarness> {
    const key = readGeminiKey();
    const h = await ChatHarness.create();
    // Explicit env: every required variable, local stack, real Gemini, NO fallback,
    // and no *_BASE_URL keys (the loader refuses them for non-compatible providers).
    // Real unit economics (ADR 0020: 3.5-flash-lite $0.30/$2.50) so usage_events
    // mirror production spend.
    const api = await startEvalApi({
      SUPABASE_URL: h.stack.apiUrl,
      SUPABASE_SECRET_KEY: h.serviceKey,
      VISITOR_TOKEN_SECRET: randomBytes(32).toString('hex'),
      TURNSTILE_SECRET_KEY: `fake-turnstile-${randomBytes(12).toString('hex')}`,
      RATE_LIMIT_KEY_SECRET: randomBytes(32).toString('hex'),
      ALLOWED_ORIGINS: 'https://e2e-allowed.example.com',
      LOG_LEVEL: 'info',
      TRUSTED_PROXY_HOPS: '1',
      BODY_LIMIT_BYTES: '65536',
      REQUEST_TIMEOUT_MS: '10000',
      CONNECTION_TIMEOUT_MS: '20000',
      READY_TIMEOUT_MS: '3000',
      DB_TIMEOUT_MS: '5000',
      VISITOR_TOKEN_TTL_SECONDS: '900',
      SESSION_PREFLIGHT_PER_IP_LIMIT: '1000',
      SESSION_PREFLIGHT_WINDOW_SECONDS: '3600',
      TURNSTILE_TIMEOUT_MS: '3000',
      CHAT_DEADLINE_MS: '30000',
      PROVIDER_MAX_ATTEMPTS: '2',
      RETRIEVAL_TOP_K: '5',
      RETRIEVAL_MIN_SIMILARITY: '0.3',
      CHAT_CONTEXT_MAX_TOKENS: '6000',
      CHAT_HISTORY_MAX_MESSAGES: '6',
      CHAT_MAX_OUTPUT_TOKENS: '800',
      CHAT_MAX_OUTPUT_CHARS: '6000',
      CHAT_PROVIDER_ATTEMPTS: '2',
      CHAT_RESERVATION_TTL_SECONDS: '120',
      HISTORY_PAGE_SIZE: '4',
      HISTORY_RATE_PER_SESSION_LIMIT: '1000',
      HISTORY_RATE_WINDOW_SECONDS: '600',
      CHAT_PRICE_INPUT_PER_MILLION: '0.30',
      CHAT_PRICE_OUTPUT_PER_MILLION: '2.50',
      MODERATION_PRICE_INPUT_PER_MILLION: '0.30',
      MODERATION_PRICE_OUTPUT_PER_MILLION: '2.50',
      EMBEDDING_PRICE_PER_MILLION_TOKENS: '0.15',
      CHAT_PRIMARY_PROVIDER: 'gemini',
      CHAT_PRIMARY_MODEL: GEMINI_CHAT_MODEL,
      CHAT_PRIMARY_API_KEY: key,
      EMBEDDING_PROVIDER: 'gemini',
      EMBEDDING_MODEL: GEMINI_EMBED_MODEL,
      EMBEDDING_DIMENSIONS: '1536',
      EMBEDDING_API_KEY: key,
      MODERATION_PROVIDER: 'gemini',
      MODERATION_MODEL: GEMINI_CHAT_MODEL,
      MODERATION_MODE: 'llm_classifier',
      MODERATION_API_KEY: key,
    });
    const bot = await h.createBot({
      embeddingModel: GEMINI_EMBED_MODEL,
      supportedLanguages: ['en', 'es', 'fr'],
      dailyCap: 50,
    });
    const embedder = createEmbeddingProvider({
      role: 'embedding',
      provider: 'gemini',
      model: GEMINI_EMBED_MODEL,
      apiKey: key,
      baseUrl: null,
      dimensions: 1536,
    });
    // One document per corpus entry would be truer to ingestion, but the eval judges
    // retrieval+answer quality, not the worker: a single version keeps chunk IDs stable.
    const docId = randomUUID();
    const versionId = randomUUID();
    await h.rest.post('documents', {
      id: docId,
      bot_id: bot.id,
      title: corpus.title,
      status: 'ready',
      disclosure_policy: 'public_answer',
    });
    await h.rest.post('document_versions', {
      id: versionId,
      document_id: docId,
      version_number: 1,
      storage_path: `${bot.id}/${docId}/${versionId}/eval.txt`,
      media_type: 'text/plain',
      extraction_method: 'plain_text',
      embedding_model: GEMINI_EMBED_MODEL,
      status: 'ready',
    });
    await h.rest.patch(`documents?id=eq.${docId}`, { active_version_id: versionId });
    const texts = corpus.chunks.map((c) => c.content);
    const embedded = await embedder.embed(texts, { taskType: 'document' });
    if (embedded.vectors.length !== texts.length) throw new Error('embedding count mismatch');
    const ids: string[] = [];
    const rows = embedded.vectors.map((vector, index) => {
      const id = randomUUID();
      ids.push(id);
      const chunk = corpus.chunks[index];
      if (chunk === undefined) throw new Error('chunk missing');
      return {
        id,
        document_version_id: versionId,
        chunk_index: index,
        content: chunk.content,
        token_count: Math.ceil(chunk.content.length / 4),
        page_number: chunk.page ?? null,
        section: null,
        embedding: `[${vector.join(',')}]`,
      };
    });
    await h.rest.post('document_chunks', rows);
    return new EvalHarness(
      h,
      api,
      bot,
      ids,
      { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
      maxUsd(),
    );
  }

  /** One visitor turn: session + chat + usage tally. Throws EvalConfigError past the spend cap. */
  async ask(q: EvalQuestion): Promise<EvalAnswer> {
    if (this.spent.usd >= this.cap) {
      throw new EvalConfigError(`eval spend cap reached (${this.cap} USD); stopping`);
    }
    const session = await this.bot.session(this.api);
    const result = await postChat(
      this.api,
      session.token,
      {
        bot_slug: this.bot.slug,
        conversation_id: null,
        message: q.message,
        ...(q.language === undefined ? {} : { preferred_language: q.language }),
      },
      { key: randomUUID() },
    );
    const text = deltaText(result);
    const done = eventsOf(result, 'done')[0];
    const doneStatus =
      done === undefined ? null : String((done.data as { status?: unknown })['status'] ?? '');
    const handoffEvt = eventsOf(result, 'handoff')[0];
    const handoff =
      handoffEvt === undefined
        ? null
        : {
            reason: String((handoffEvt.data as { reason?: unknown })['reason'] ?? ''),
            message: String((handoffEvt.data as { message?: unknown })['message'] ?? ''),
            email: (() => {
              const contact = (handoffEvt.data as { contact?: unknown })['contact'];
              const email = (contact as { email?: unknown } | null | undefined)?.email;
              return typeof email === 'string' ? email : null;
            })(),
          };
    const sourceEvts = eventsOf(result, 'sources');
    const sourceChunkIds = sourceEvts.flatMap((e) => {
      const sources = (e.data as { sources?: unknown })['sources'];
      if (!Array.isArray(sources)) return [];
      return sources.flatMap((s) => {
        const id = (s as { chunk_id?: unknown })['chunk_id'];
        return typeof id === 'string' ? [id] : [];
      });
    });
    // Spend from the ledger the API wrote (same authority production uses).
    const meta = eventsOf(result, 'meta')[0];
    let calls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let usd = 0;
    if (meta !== undefined) {
      const requestId = String((meta.data as { request_id?: unknown })['request_id'] ?? '');
      const rows = await this.bot.usage(requestId);
      for (const row of rows) {
        calls += 1;
        inputTokens += row.input_tokens;
        outputTokens += row.output_tokens;
        usd += Number(row.estimated_cost);
      }
    }
    this.spent = {
      calls: this.spent.calls + calls,
      inputTokens: this.spent.inputTokens + inputTokens,
      outputTokens: this.spent.outputTokens + outputTokens,
      usd: Math.round((this.spent.usd + usd) * 1e8) / 1e8,
    };
    return {
      result,
      text,
      doneStatus,
      handoff,
      sourceChunkIds,
      calls,
      inputTokens,
      outputTokens,
      usd,
    };
  }

  totals(): SpendTotals {
    return this.spent;
  }

  async close(): Promise<void> {
    for (const a of this.apis) await a.stop().catch(() => undefined);
    await this.h.close();
  }
}
