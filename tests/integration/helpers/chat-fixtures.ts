import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { readResponse, sqlstateOf } from './auth-session.ts';
import { startFakeLlmServer, type ChatScript, type FakeLlmServer } from './fake-llm-server.ts';
import {
  getLocalPrivilegedKey,
  getLocalStack,
  keyHeaders,
  type LocalStack,
} from './local-stack.ts';

// Fixtures for the P7 chat end-to-end tests (P7-E2E). Everything runs against the LOCAL stack:
//  * the BUILT API (`api/dist/main.js`) is started as a child process, with its output captured;
//  * chat, moderation and embeddings go to LABELLED FAKE loopback servers (fake-llm-server.ts);
//  * test data (bots, settings, contact config, documents and chunks) is inserted with the local
//    service key through PostgREST. The P6 worker is NOT used: chunk vectors are written directly
//    from the fake embedder, so retrieval is deterministic. Everything created is removed by close().
// Keys are generated per run. No key, token or message text is ever put in an error message.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const API_ENTRY = fileURLToPath(new URL('../../../api/dist/main.js', import.meta.url));

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitUntil<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs = 15_000,
  intervalMs = 50,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() >= end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------------------------------
// Privileged REST client (local stack only)
// ---------------------------------------------------------------------------------------------------

export class Rest {
  constructor(
    private readonly stack: LocalStack,
    private readonly key: string,
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.stack.apiUrl}/rest/v1/${path}`, {
      method,
      headers: {
        ...keyHeaders(this.key),
        'content-type': 'application/json',
        prefer: 'return=representation',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const r = await readResponse(res);
    if (r.status >= 300) {
      throw new Error(
        `service call ${method} ${path.split('?')[0] ?? ''} failed (HTTP ${String(r.status)}, SQLSTATE ${String(sqlstateOf(r))})`,
      );
    }
    return r.body;
  }

  get<T = Record<string, unknown>>(path: string): Promise<T[]> {
    return this.call('GET', path) as Promise<T[]>;
  }
  post(table: string, body: unknown): Promise<unknown> {
    return this.call('POST', table, body);
  }
  patch(path: string, body: unknown): Promise<unknown> {
    return this.call('PATCH', path, body);
  }
  delete(path: string): Promise<unknown> {
    return this.call('DELETE', path);
  }
}

// ---------------------------------------------------------------------------------------------------
// SSE client
// ---------------------------------------------------------------------------------------------------

export interface SseEvt {
  readonly event: string;
  readonly data: Record<string, unknown>;
  /** Wall-clock arrival time. */
  readonly at: number;
}

export interface ChatResult {
  readonly status: number;
  readonly headers: Headers;
  /** True when the response was an event stream. */
  readonly sse: boolean;
  readonly events: readonly SseEvt[];
  /** Parsed JSON body for a non-stream answer (or null). */
  readonly json: Record<string, unknown> | null;
  /** True when the caller's signal aborted the read. */
  readonly aborted: boolean;
  readonly startedAt: number;
  readonly endedAt: number;
}

export function parseSseBlock(block: string, at: number): SseEvt | null {
  let event = '';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data.push(line.slice(6));
  }
  if (event === '' || data.length === 0) return null; // a keep-alive comment
  return { event, data: JSON.parse(data.join('\n')) as Record<string, unknown>, at };
}

export interface PostChatOptions {
  /** Idempotency-Key; a fresh UUID when omitted. */
  readonly key?: string;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
  /** Called for each event as it arrives. */
  readonly onEvent?: (event: SseEvt) => void;
  /** Send the token without the Bearer scheme or not at all: pass `null` to send no Authorization. */
  readonly authorization?: string | null;
}

/** POST /v1/chat. Reads an event stream to its end (or until `signal` aborts). */
export async function postChat(
  api: ApiHandle,
  token: string | null,
  body: unknown,
  options: PostChatOptions = {},
): Promise<ChatResult> {
  const startedAt = Date.now();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'idempotency-key': options.key ?? randomUUID(),
    'x-forwarded-for': randomClientAddress(),
    ...options.headers,
  };
  if (options.authorization !== null) {
    const value = options.authorization ?? (token === null ? undefined : `Bearer ${token}`);
    if (value !== undefined) headers['authorization'] = value;
  }
  const events: SseEvt[] = [];
  let res: Response;
  try {
    res = await fetch(`${api.baseUrl}/v1/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (e) {
    if (options.signal?.aborted === true) {
      return {
        status: 0,
        headers: new Headers(),
        sse: false,
        events,
        json: null,
        aborted: true,
        startedAt,
        endedAt: Date.now(),
      };
    }
    throw e;
  }
  const sse = (res.headers.get('content-type') ?? '').startsWith('text/event-stream');
  if (!sse) {
    const r = await readResponse(res);
    return {
      status: res.status,
      headers: res.headers,
      sse: false,
      events,
      json: typeof r.body === 'object' ? (r.body as Record<string, unknown> | null) : null,
      aborted: false,
      startedAt,
      endedAt: Date.now(),
    };
  }
  let aborted = false;
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    if (res.body === null) throw new Error('no body');
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const cut = buffer.indexOf('\n\n');
        if (cut === -1) break;
        const evt = parseSseBlock(buffer.slice(0, cut), Date.now());
        buffer = buffer.slice(cut + 2);
        if (evt !== null) {
          events.push(evt);
          options.onEvent?.(evt);
        }
      }
    }
  } catch (e) {
    if (options.signal?.aborted !== true) throw e;
    aborted = true;
  }
  return {
    status: res.status,
    headers: res.headers,
    sse: true,
    events,
    json: null,
    aborted,
    startedAt,
    endedAt: Date.now(),
  };
}

export const names = (r: ChatResult): string[] => r.events.map((e) => e.event);
export const eventsOf = (r: ChatResult, name: string): SseEvt[] =>
  r.events.filter((e) => e.event === name);
export const deltaTexts = (r: ChatResult): string[] =>
  eventsOf(r, 'delta').map((e) => String(e.data['text']));
export const deltaText = (r: ChatResult): string => deltaTexts(r).join('');
export const metaOf = (
  r: ChatResult,
): { request_id: string; conversation_id: string; message_id: string } => {
  const meta = eventsOf(r, 'meta')[0];
  if (meta === undefined) throw new Error('no meta event');
  return meta.data as { request_id: string; conversation_id: string; message_id: string };
};

/** A random documentation-range IPv6 address: its own /64, so its own rate-limit bucket. */
export function randomClientAddress(): string {
  const g = (): string => randomBytes(2).toString('hex');
  return `2001:db8:${g()}:${g()}::1`;
}

// ---------------------------------------------------------------------------------------------------
// The built API as a child process
// ---------------------------------------------------------------------------------------------------

export interface ApiHandle {
  readonly name: string;
  readonly port: number;
  readonly baseUrl: string;
  /** Everything the process wrote to stdout and stderr. */
  output(): string;
  stop(): Promise<void>;
  exited(): { code: number | null; signal: NodeJS.Signals | null } | undefined;
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

async function startApiProcess(name: string, env: Record<string, string>): Promise<ApiHandle> {
  if (!existsSync(API_ENTRY)) throw new Error('api/dist/main.js not found: run `npm run build`');
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [API_ENTRY], {
    cwd: REPO_ROOT,
    env: { PATH: process.env['PATH'] ?? '', ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const collect = (d: Buffer): void => {
    out += d.toString('utf8');
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const closed = new Promise<void>((resolve) => {
    child.on('close', (code, signal) => {
      exit = { code, signal };
      resolve();
    });
  });
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  try {
    await waitUntil(
      `API "${name}" to answer /health/live`,
      async () => {
        if (exit !== undefined) throw new Error(`API "${name}" exited during start-up`);
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
    throw new Error(`API "${name}" failed to answer /health/live within 20s. Output:\n${out}`, {
      cause: e,
    });
  }
  return {
    name,
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

// ---------------------------------------------------------------------------------------------------
// Bots, documents and sessions
// ---------------------------------------------------------------------------------------------------

export interface ContactSpec {
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly whatsapp?: string | null;
  readonly page?: string | null;
  readonly hours?: Record<string, string> | null;
  readonly timezone?: string | null;
}

export interface BotSpec {
  /** Defaults to the harness embedding model (the API's). */
  readonly embeddingModel?: string;
  readonly dailyCap?: number;
  readonly handoffPolicy?: Record<string, unknown>;
  readonly flags?: Record<string, unknown>;
  readonly contact?: ContactSpec;
  readonly escalationMessages?: Record<string, string>;
  readonly supportedLanguages?: readonly string[];
  readonly enabled?: boolean;
}

export interface ChunkSpec {
  readonly content: string;
  /** Questions embedded as this topic (`embedAs`) match this chunk exactly. */
  readonly topic: string;
  readonly page?: number | null;
  readonly section?: string | null;
}

export interface Session {
  readonly token: string;
  readonly sessionId: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  request_id: string | null;
  reply_to_message_id: string | null;
  role: string;
  content: string;
  status: string;
  provider: string | null;
  model: string | null;
  handoff_reason: string | null;
  created_at: string;
}

export interface SourceRow {
  message_id: string;
  chunk_id: string | null;
  document_version_id: string | null;
  source_label: string;
  excerpt: string | null;
  page_number: number | null;
  section: string | null;
}

export interface UsageRow {
  request_id: string | null;
  provider: string | null;
  model: string | null;
  operation: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number | string;
  latency_ms: number | null;
}

export interface ReservationRow {
  id: string;
  request_id: string | null;
  amount: number | string;
  state: string;
}

export interface RunRow {
  id: string;
  visitor_session_id: string;
  state: string;
  finished_at: string | null;
}

export const DEFAULT_CONTACT = {
  email: 'help@acme-support.example',
  phone: '+14155550100',
  page: 'https://acme-support.example/contact',
} as const;

export const ESCALATION_EN = 'Please contact our team directly and we will gladly help you.';
export const ESCALATION_ES = 'Por favor contacte a nuestro equipo directamente.';

export interface ChunkRef {
  readonly id: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly spec: ChunkSpec;
}

export class ChatBot {
  readonly chunks: ChunkRef[] = [];

  constructor(
    readonly h: ChatHarness,
    readonly id: string,
    readonly slug: string,
    readonly spec: BotSpec,
  ) {}

  private get rest(): Rest {
    return this.h.rest;
  }

  /** Adds a ready, public-answer document whose chunks carry the fake vector of their topic. */
  async addDocument(title: string, chunks: readonly ChunkSpec[]): Promise<ChunkRef[]> {
    const docId = randomUUID();
    const versionId = randomUUID();
    await this.rest.post('documents', {
      id: docId,
      bot_id: this.id,
      title,
      status: 'ready',
      disclosure_policy: 'public_answer',
    });
    await this.rest.post('document_versions', {
      id: versionId,
      document_id: docId,
      version_number: 1,
      // {bot}/{document}/{version}/{file}: the shape the table's check requires.
      storage_path: `${this.id}/${docId}/${versionId}/e2e.txt`,
      media_type: 'text/plain',
      extraction_method: 'plain_text',
      embedding_model: this.spec.embeddingModel ?? this.h.embeddingModel,
      status: 'ready',
    });
    const doc = { id: docId };
    const version = { id: versionId };
    await this.rest.patch(`documents?id=eq.${doc.id}`, { active_version_id: version.id });
    const refs: ChunkRef[] = [];
    const rows = chunks.map((c, index) => {
      const id = randomUUID();
      refs.push({ id, documentId: doc.id, versionId: version.id, spec: c });
      return {
        id,
        document_version_id: version.id,
        chunk_index: index,
        content: c.content,
        token_count: Math.ceil(c.content.length / 4),
        page_number: c.page ?? null,
        section: c.section ?? null,
        embedding: `[${this.h.primary.vectorFor(c.topic).join(',')}]`,
      };
    });
    await this.rest.post('document_chunks', rows);
    this.chunks.push(...refs);
    return refs;
  }

  /** A visitor session through POST /v1/sessions on the given API. */
  async session(api: ApiHandle): Promise<Session> {
    const res = await fetch(`${api.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': randomClientAddress() },
      body: JSON.stringify({ bot_slug: this.slug }),
    });
    const r = await readResponse(res);
    const token = (r.body as { token?: unknown } | null)?.token;
    if (r.status !== 200 || typeof token !== 'string') {
      throw new Error(`could not create a visitor session (HTTP ${String(r.status)})`);
    }
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { session_id: string };
    return { token, sessionId: claims.session_id };
  }

  // --- reads ------------------------------------------------------------------------------------

  messages(conversationId: string): Promise<MessageRow[]> {
    return this.rest.get<MessageRow>(
      `messages?conversation_id=eq.${conversationId}&select=*&order=created_at.asc,id.asc`,
    );
  }
  async message(id: string): Promise<MessageRow | undefined> {
    return (await this.rest.get<MessageRow>(`messages?id=eq.${id}&select=*`))[0];
  }
  sources(messageId: string): Promise<SourceRow[]> {
    return this.rest.get<SourceRow>(
      `message_sources?message_id=eq.${messageId}&select=message_id,chunk_id,document_version_id,source_label,excerpt,page_number,section&order=id.asc`,
    );
  }
  usage(runId: string): Promise<UsageRow[]> {
    return this.rest.get<UsageRow>(
      `usage_events?request_id=eq.${runId}&select=request_id,provider,model,operation,input_tokens,output_tokens,estimated_cost,latency_ms&order=created_at.asc`,
    );
  }
  allUsage(): Promise<UsageRow[]> {
    return this.rest.get<UsageRow>(`usage_events?bot_id=eq.${this.id}&select=*`);
  }
  reservations(runId: string): Promise<ReservationRow[]> {
    return this.rest.get<ReservationRow>(
      `budget_reservations?request_id=eq.${runId}&select=id,request_id,amount,state`,
    );
  }
  allReservations(): Promise<ReservationRow[]> {
    return this.rest.get<ReservationRow>(`budget_reservations?bot_id=eq.${this.id}&select=*`);
  }
  async run(runId: string): Promise<RunRow | undefined> {
    return (
      await this.rest.get<RunRow>(
        `request_runs?id=eq.${runId}&select=id,visitor_session_id,state,finished_at`,
      )
    )[0];
  }
  runsOfSession(sessionId: string): Promise<RunRow[]> {
    return this.rest.get<RunRow>(
      `request_runs?visitor_session_id=eq.${sessionId}&select=id,visitor_session_id,state,finished_at`,
    );
  }
  async conversationCount(): Promise<number> {
    return (await this.rest.get(`conversations?bot_id=eq.${this.id}&select=id`)).length;
  }

  /** Waits until the run is no longer reserved or running and its reservation is closed. */
  async waitTerminal(runId: string, timeoutMs = 15_000): Promise<RunRow> {
    return waitUntil(
      `run ${runId} to reach a terminal state`,
      async () => {
        const run = await this.run(runId);
        if (run === undefined || run.state === 'reserved' || run.state === 'running') return null;
        const reservations = await this.reservations(runId);
        return reservations.every((r) => r.state !== 'reserved') ? run : null;
      },
      timeoutMs,
    );
  }

  // --- settings changes ---------------------------------------------------------------------------

  async setFlags(flags: Record<string, unknown>): Promise<void> {
    await this.rest.patch(`client_settings?bot_id=eq.${this.id}`, { feature_flags: flags });
  }
  async setDailyCap(usd: number): Promise<void> {
    await this.rest.patch(`client_settings?bot_id=eq.${this.id}`, {
      budget_policy: { daily_cap_usd: usd },
    });
  }
  async setContact(patch: Record<string, unknown>): Promise<void> {
    await this.rest.patch(`public_bot_config?bot_id=eq.${this.id}`, patch);
  }
  /** Inserts a `system` row into a conversation (it must never reach the model or the visitor). */
  async insertSystemMessage(conversationId: string, content: string): Promise<void> {
    await this.rest.post('messages', {
      conversation_id: conversationId,
      role: 'system',
      content,
      status: 'complete',
    });
  }

  async dispose(): Promise<void> {
    await this.rest.delete(`bot_profiles?id=eq.${this.id}`).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------

export interface ApiVariant {
  /** Configure a fallback chat provider (default true). */
  readonly fallback?: boolean;
  readonly env?: Record<string, string>;
}

export interface HarnessKeys {
  readonly chat: string;
  readonly fallback: string;
  readonly moderation: string;
  readonly embedding: string;
}

export class ChatHarness {
  readonly embeddingModel: string;
  readonly chatModel = 'fake-chat-primary';
  readonly fallbackModel = 'fake-chat-fallback';
  /** App secrets, generated per run (all different, at least 32 bytes). */
  readonly secrets = {
    visitorToken: randomBytes(32).toString('hex'),
    rateLimit: randomBytes(32).toString('hex'),
    turnstile: `fake-turnstile-${randomBytes(12).toString('hex')}`,
  };
  readonly rest: Rest;
  private readonly apis = new Map<string, ApiHandle>();
  private readonly bots: ChatBot[] = [];
  private botCounter = 0;

  private constructor(
    readonly stack: LocalStack,
    readonly serviceKey: string,
    readonly run: string,
    /** Per-run fake keys. None of these is a real credential. */
    readonly keys: HarnessKeys,
    readonly primary: FakeLlmServer,
    readonly fallbackServer: FakeLlmServer,
  ) {
    this.embeddingModel = `fake-embed-chat-${run}`;
    this.rest = new Rest(stack, serviceKey);
  }

  static async create(): Promise<ChatHarness> {
    const stack = getLocalStack();
    const serviceKey = getLocalPrivilegedKey();
    const run = randomUUID().slice(0, 8);
    const embeddingModel = `fake-embed-chat-${run}`;
    const fake = (): string => `fake-${randomBytes(12).toString('hex')}`;
    const keys: HarnessKeys = {
      chat: fake(),
      fallback: fake(),
      moderation: fake(),
      embedding: fake(),
    };
    const primary = await startFakeLlmServer({
      label: 'FAKE-primary',
      acceptedKeys: [keys.chat, keys.moderation, keys.embedding],
      embeddingModel,
    });
    const fallback = await startFakeLlmServer({
      label: 'FAKE-fallback',
      acceptedKeys: [keys.fallback],
      embeddingModel,
    });
    return new ChatHarness(stack, serviceKey, run, keys, primary, fallback);
  }

  /** The API environment: every required variable, all against the local stack and the fakes. */
  env(variant: ApiVariant = {}): Record<string, string> {
    const fallback = variant.fallback ?? true;
    const env: Record<string, string> = {
      SUPABASE_URL: this.stack.apiUrl,
      SUPABASE_SECRET_KEY: this.serviceKey,
      VISITOR_TOKEN_SECRET: this.secrets.visitorToken,
      TURNSTILE_SECRET_KEY: this.secrets.turnstile,
      RATE_LIMIT_KEY_SECRET: this.secrets.rateLimit,
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
      RETRIEVAL_TOP_K: '3',
      RETRIEVAL_MIN_SIMILARITY: '0.5',
      CHAT_CONTEXT_MAX_TOKENS: '6000',
      CHAT_HISTORY_MAX_MESSAGES: '6',
      CHAT_MAX_OUTPUT_TOKENS: '800',
      // P7-D1: required by the corrected API (a hard output cap and a history route rate limit).
      // Wave 1 ignores variables it does not know.
      CHAT_MAX_OUTPUT_CHARS: '6000',
      HISTORY_RATE_PER_SESSION_LIMIT: '1000',
      HISTORY_RATE_WINDOW_SECONDS: '600',
      // Round prices, so a cost can be computed by hand: USD per million tokens.
      CHAT_PRICE_INPUT_PER_MILLION: '10',
      CHAT_PRICE_OUTPUT_PER_MILLION: '20',
      MODERATION_PRICE_INPUT_PER_MILLION: '1',
      MODERATION_PRICE_OUTPUT_PER_MILLION: '2',
      EMBEDDING_PRICE_PER_MILLION_TOKENS: '3',
      CHAT_RESERVATION_TTL_SECONDS: '120',
      CHAT_PROVIDER_ATTEMPTS: '2',
      HISTORY_PAGE_SIZE: '4',
      CHAT_PRIMARY_PROVIDER: 'openai_compatible',
      CHAT_PRIMARY_MODEL: this.chatModel,
      CHAT_PRIMARY_API_KEY: this.keys.chat,
      CHAT_PRIMARY_BASE_URL: this.primary.baseUrl,
      EMBEDDING_PROVIDER: 'openai_compatible',
      EMBEDDING_MODEL: this.embeddingModel,
      EMBEDDING_DIMENSIONS: '1536',
      EMBEDDING_API_KEY: this.keys.embedding,
      EMBEDDING_BASE_URL: this.primary.baseUrl,
      MODERATION_PROVIDER: 'openai_compatible',
      MODERATION_MODEL: 'fake-moderation-classifier',
      MODERATION_MODE: 'llm_classifier',
      MODERATION_API_KEY: this.keys.moderation,
      MODERATION_BASE_URL: this.primary.baseUrl,
    };
    if (fallback) {
      Object.assign(env, {
        CHAT_FALLBACK_PROVIDER: 'openai_compatible',
        CHAT_FALLBACK_MODEL: this.fallbackModel,
        CHAT_FALLBACK_API_KEY: this.keys.fallback,
        CHAT_FALLBACK_BASE_URL: this.fallbackServer.baseUrl,
        CHAT_FALLBACK_PRICE_INPUT_PER_MILLION: '5',
        CHAT_FALLBACK_PRICE_OUTPUT_PER_MILLION: '10',
      });
    }
    return { ...env, ...variant.env };
  }

  /** Starts (or returns) a named API instance. */
  async api(name = 'main', variant: ApiVariant = {}): Promise<ApiHandle> {
    const existing = this.apis.get(name);
    if (existing !== undefined) return existing;
    const handle = await startApiProcess(name, this.env(variant));
    this.apis.set(name, handle);
    return handle;
  }

  /** Output of every API instance started so far, in start order. */
  allOutput(): string {
    return [...this.apis.values()].map((a) => a.output()).join('\n');
  }

  allApis(): ApiHandle[] {
    return [...this.apis.values()];
  }

  /** A fresh bot with settings, public config (contact and escalation messages) and no documents. */
  async createBot(spec: BotSpec = {}): Promise<ChatBot> {
    this.botCounter += 1;
    const slug = `p7e2e-${this.run}-${String(this.botCounter)}`;
    const languages = spec.supportedLanguages ?? ['en', 'es'];
    const [bot] = (await this.rest.post('bot_profiles', {
      slug,
      identity_prompt: 'P7 E2E TEST PLACEHOLDER',
      tone: 'friendly',
      scope: 'questions about the Acme product',
      allowed_languages: languages,
      embedding_model: spec.embeddingModel ?? this.embeddingModel,
      embedding_dimensions: 1536,
      enabled: spec.enabled ?? true,
    })) as { id: string }[];
    if (bot === undefined) throw new Error('bot insert returned nothing');
    const big = { limit: 5000, window_seconds: 3600 };
    await this.rest.post('client_settings', {
      bot_id: bot.id,
      allowed_origins: ['https://e2e-allowed.example.com'],
      rate_policy: {
        session_create_per_ip: { limit: 1000, window_seconds: 3600 },
        session_create_per_bot: { limit: 100_000, window_seconds: 3600 },
        message_per_session: { limit: 1000, window_seconds: 600 },
        message_per_ip: { limit: 5000, window_seconds: 3600 },
        concurrent_requests_per_session: 1,
      },
      budget_policy: { daily_cap_usd: spec.dailyCap ?? 50 },
      retention_policy: { conversation_days: 90, usage_months: 13 },
      upload_policy: {
        max_bytes: 20971520,
        max_pages: 300,
        index_max_attempts: 3,
        cleanup_max_attempts: 3,
        quotas: { register: big, upload: big, reindex: big, write: big },
      },
      handoff_policy: spec.handoffPolicy ?? {},
      cache_policy: {},
      feature_flags: { turnstile_required: false, ...spec.flags },
    });
    const contact: ContactSpec = spec.contact ?? DEFAULT_CONTACT;
    await this.rest.post('public_bot_config', {
      bot_id: bot.id,
      bot_slug: slug,
      display_name: 'Acme Assistant',
      supported_languages: languages,
      escalation_label: 'Contact us',
      escalation_messages: spec.escalationMessages ?? { en: ESCALATION_EN, es: ESCALATION_ES },
      contact_email: contact.email ?? null,
      contact_phone: contact.phone ?? null,
      contact_whatsapp_url: contact.whatsapp ?? null,
      contact_page_url: contact.page ?? null,
      business_hours: contact.hours ?? null,
      timezone: contact.timezone ?? null,
    });
    const b = new ChatBot(this, bot.id, slug, spec);
    this.bots.push(b);
    return b;
  }

  /** Clears the fakes between tests. */
  resetFakes(): void {
    this.primary.reset();
    this.fallbackServer.reset();
  }

  /** Signs claims with the harness secret exactly as the API does (for forged-token cases). */
  signToken(
    claims: { bot_id: string; session_id: string; token_version: number; iat: number; exp: number },
    secret: string = this.secrets.visitorToken,
  ): string {
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const input = `v1.${payload}`;
    return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
  }

  async close(): Promise<void> {
    for (const api of this.apis.values()) await api.stop().catch(() => undefined);
    for (const b of [...this.bots].reverse()) await b.dispose().catch(() => undefined);
    await this.primary.close();
    await this.fallbackServer.close();
  }
}

// ---------------------------------------------------------------------------------------------------
// Script builders
// ---------------------------------------------------------------------------------------------------

/** Splits text into pieces of `size` characters (so headers and markers straddle pieces). */
export function pieces(text: string, size = 17): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** A complete `EVIDENCE: SUFFICIENT` reply, streamed in small pieces. */
export function answerScript(
  body: string,
  extra: Partial<ChatScript> = {},
  pieceSize = 17,
): ChatScript {
  return {
    pieces: pieces(`EVIDENCE: SUFFICIENT\n${body}`, pieceSize),
    pieceDelayMs: 4,
    ...extra,
  };
}

/** A reply that starts with the given header line. */
export function headerScript(
  header: string,
  body = '',
  extra: Partial<ChatScript> = {},
): ChatScript {
  return { pieces: pieces(`${header}\n${body}`, 11), pieceDelayMs: 4, ...extra };
}

/** `n` characters of plain, harmless text made of short words (no digits, no links). */
export function plainText(n: number, seed = 'alpha bravo cedar delta ember fjord garnet '): string {
  let out = '';
  while (out.length < n) out += seed;
  return out.slice(0, n);
}

/** Sum of numeric cost columns, rounded to 8 places. */
export function sumCost(rows: readonly { estimated_cost: number | string }[]): number {
  return Math.round(rows.reduce((s, r) => s + Number(r.estimated_cost), 0) * 1e8) / 1e8;
}
