import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkerConfig, type WorkerConfig } from '../../../worker/src/lib/config.ts';
import { buildPdf } from '../../unit/worker/fixtures/pdf.ts';
import {
  createTotpSession,
  deleteAuthUser,
  randomTestPassword,
  readResponse,
  rpc,
  sqlstateOf,
  type HttpResult,
  type TestSession,
} from './auth-session.ts';
import { fakeVectorFor } from './fake-embeddings.ts';
import {
  getLocalPrivilegedKey,
  getLocalStack,
  keyHeaders,
  type LocalStack,
} from './local-stack.ts';

// Fixtures for the P6 ingestion tests (end to end, against the LOCAL stack). All content is synthetic and
// generated at run time. The only fake is the embedding provider (see fake-embeddings.ts). Everything the
// tests create (users, bots, documents, objects, jobs) is removed by `close()` / `dispose()`.
//
// ISOLATION: a runtime or worker process claims ANY queued `index_document` or `cleanup` job on the stack.
// The two ingestion test files therefore hold a file lock (`acquireIngestionLock`) while they run, and
// `IngestionHarness.create()` refuses to start when foreign index or cleanup jobs are queued or running.
// Run them without other integration files in parallel (for example `vitest run
// tests/integration/ingestion-*.test.ts`), because other files, like admin-real-session, also queue jobs.

export { buildPdf };

const WORKER_ROOT = fileURLToPath(new URL('../../../worker/', import.meta.url));
/** The built worker entry point (needs `npm run build`). */
export const WORKER_ENTRY = join(WORKER_ROOT, 'dist', 'worker.js');

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs = 30_000,
  intervalMs = 100,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() >= end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(intervalMs);
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------------------------------
// Synthetic content
// ---------------------------------------------------------------------------------------------------

const WORDS = [
  'alpha',
  'bravo',
  'cedar',
  'delta',
  'ember',
  'fjord',
  'garnet',
  'harbor',
  'indigo',
  'juniper',
  'kestrel',
  'lantern',
  'meadow',
  'nimbus',
  'orchid',
  'prairie',
];

/** Plain text of `paragraphs` paragraphs (about 80 words each), every paragraph starting with `marker`. */
export function makeText(marker: string, paragraphs = 14): string {
  const out: string[] = [];
  let n = 0;
  for (let p = 0; p < paragraphs; p++) {
    const words: string[] = [`${marker}-section-${String(p)}`];
    for (let i = 0; i < 80; i++) {
      words.push(`${WORDS[(n * 7 + i * 3) % WORDS.length] ?? 'alpha'}${String((n + i) % 97)}`);
      n += 1;
    }
    out.push(words.join(' '));
  }
  return out.join('\n\n');
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A PDF with a text layer, one short paragraph per page. */
export function makeTextPdf(marker: string, pages = 2): Uint8Array {
  const body: string[][] = [];
  for (let p = 0; p < pages; p++) {
    body.push([
      `${marker} page ${String(p + 1)} first line of synthetic text`,
      `${marker} page ${String(p + 1)} second line with more synthetic words`,
      `${marker} page ${String(p + 1)} third line for the chunker to keep`,
    ]);
  }
  return buildPdf({ pages: body });
}

/** A PDF whose pages carry no text layer (a "scan"). */
export function makeScannedPdf(pages = 2): Uint8Array {
  return buildPdf({ pages: Array.from({ length: pages }, () => []) });
}

/** Bytes that look like a Linux executable, for the "renamed to .pdf" case. */
export function makeExecutableBytes(): Uint8Array {
  return new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, ...randomBytes(300)]);
}

// ---------------------------------------------------------------------------------------------------
// File lock shared by the two ingestion test files
// ---------------------------------------------------------------------------------------------------

const LOCK_DIR = join(tmpdir(), 'ragbot-p6-ingestion-tests.lock');

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Waits for the lock, steals it from a dead holder, and returns the release function. */
export async function acquireIngestionLock(timeoutMs = 900_000): Promise<() => void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid));
      return () => {
        rmSync(LOCK_DIR, { recursive: true, force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let holder = NaN;
    try {
      holder = Number(readFileSync(join(LOCK_DIR, 'pid'), 'utf8'));
    } catch {
      // The holder is between mkdir and writing its pid, or the lock was just released.
    }
    if (Number.isInteger(holder) && holder > 0 && !pidAlive(holder)) {
      rmSync(LOCK_DIR, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= end) throw new Error('timed out waiting for the ingestion test lock');
    await sleep(500);
  }
}

// ---------------------------------------------------------------------------------------------------
// Worker environment and config for tests
// ---------------------------------------------------------------------------------------------------

export interface WorkerEnvOptions {
  apiUrl: string;
  /** Local privileged key; never logged. */
  key: string;
  /** Embedding model id (must equal the bots' embedding_model). */
  model: string;
  /** A fake key generated at run time. */
  embeddingApiKey: string;
  /** Base URL of the fake embeddings server (or a closed loopback port for in-process tests). */
  embeddingBaseUrl: string;
  overrides?: Record<string, string>;
}

/** A complete, valid worker environment for the local stack. Short timers so tests are quick. */
export function workerEnv(o: WorkerEnvOptions): Record<string, string> {
  return {
    SUPABASE_URL: o.apiUrl,
    SUPABASE_SECRET_KEY: o.key,
    LOG_LEVEL: 'silent',
    DB_TIMEOUT_MS: '2000',
    STORAGE_TIMEOUT_MS: '10000',
    WORKER_CONCURRENCY: '3',
    JOB_LEASE_SECONDS: '6',
    JOB_HEARTBEAT_INTERVAL_SECONDS: '2',
    JOB_POLL_INTERVAL_MS: '100',
    JOB_BACKOFF_BASE_SECONDS: '1',
    JOB_BACKOFF_MAX_SECONDS: '2',
    SHUTDOWN_GRACE_MS: '1500',
    MAINTENANCE_INTERVAL_SECONDS: '86400',
    RETENTION_BATCH_SIZE: '50',
    PURGE_BATCH_SIZE: '50',
    CHAT_DEADLINE_MS: '60000',
    STUCK_RUN_THRESHOLD_SECONDS: '300',
    VISITOR_SESSION_GRACE_SECONDS: '3600',
    TERMINAL_JOB_RETENTION_DAYS: '30',
    ABANDONED_UPLOAD_HOURS: '24',
    EXTRACT_MAX_CHARS: '5000000',
    // P6-D2-W required limits (board INTERFACE of P6-D2-W): the largest download and chunk count.
    WORKER_MAX_DOWNLOAD_BYTES: '52428800',
    MAX_CHUNKS_PER_VERSION: '5000',
    EXTRACT_TIMEOUT_MS: '30000',
    EXTRACT_CHILD_MEMORY_MB: '512',
    EMBEDDING_BATCH_SIZE: '2',
    EMBEDDING_PRICE_PER_MILLION_TOKENS: '100',
    ANALYSIS_PRICE_INPUT_PER_MILLION_TOKENS: '10',
    ANALYSIS_PRICE_OUTPUT_PER_MILLION_TOKENS: '20',
    EMBEDDING_PROVIDER: 'openai_compatible',
    EMBEDDING_MODEL: o.model,
    EMBEDDING_DIMENSIONS: '1536',
    EMBEDDING_API_KEY: o.embeddingApiKey,
    EMBEDDING_BASE_URL: o.embeddingBaseUrl,
    ANALYSIS_PROVIDER: 'gemini',
    ANALYSIS_MODEL: 'gemini-2.5-flash-lite',
    GEMINI_API_KEY: `fake-${randomBytes(12).toString('hex')}`,
    ...o.overrides,
  };
}

export function loadTestConfig(env: Record<string, string>): WorkerConfig {
  return loadWorkerConfig(env);
}

// ---------------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------------

export interface VersionRow {
  id: string;
  document_id: string;
  version_number: number;
  storage_path: string;
  media_type: string;
  byte_size: number | null;
  status: string;
  failure_code: string | null;
  batches_done: number | null;
  batches_total: number | null;
  checksum: string | null;
  embedding_model: string | null;
  extraction_method: string | null;
  extraction_version: string | null;
  chunking_version: string | null;
  upload_etag: string | null;
  created_at: string;
}

export interface DocumentRow {
  id: string;
  bot_id: string;
  title: string;
  status: string;
  active_version_id: string | null;
  deleted_at: string | null;
}

export interface JobRow {
  id: string;
  type: string;
  state: string;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_until: string | null;
  available_at: string;
  last_error: string | null;
  dedupe_key: string;
  payload: Record<string, unknown>;
}

export interface StatusRow {
  document_id: string;
  title: string;
  status: string;
  active_version_id: string | null;
  latest_version_id: string | null;
  latest_version_number: number | null;
  latest_version_status: string | null;
  batches_done: number | null;
  batches_total: number | null;
  failure_code: string | null;
}

export interface MatchRow {
  chunk_id: string;
  document_id: string;
  document_version_id: string;
  chunk_index: number;
  similarity: number;
}

export interface UploadedVersion {
  documentId: string;
  versionId: string;
  versionNumber: number;
  path: string;
}

export interface UploadOptions {
  bytes: Uint8Array;
  /** The media type registered with the document. */
  mediaType: string;
  /** The content type the object is uploaded with; defaults to `mediaType`. */
  contentType?: string;
  title?: string;
  /** Only for a new document. */
  disclosure?: 'public_answer' | 'excluded';
}

export interface BotOptions {
  dailyCapUsd?: number;
  maxBytes?: number;
  maxPages?: number;
  indexMaxAttempts?: number;
  cleanupMaxAttempts?: number;
}

const TERMINAL_JOB = ['succeeded', 'failed', 'cancelled'];

// ---------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------

export class IngestionHarness {
  readonly run = randomUUID().slice(0, 8);
  /** Embedding model used by every bot of this harness. */
  readonly model: string;
  readonly embeddingApiKey = `fake-${randomBytes(12).toString('hex')}`;
  private readonly bots: TestBot[] = [];
  private readonly userIds: string[] = [];
  private readonly extraObjects: string[] = [];

  private constructor(
    readonly stack: LocalStack,
    readonly key: string,
    private readonly session: TestSession,
    private readonly releaseLock: () => void,
  ) {
    this.model = `fake-embed-${this.run}`;
    this.userIds.push(session.userId);
  }

  /** Takes the lock, checks the stack is idle, and signs in an owner with a real aal2 session. */
  static async create(): Promise<IngestionHarness> {
    const releaseLock = await acquireIngestionLock();
    try {
      const stack = getLocalStack();
      const key = getLocalPrivilegedKey();
      const probe = new RestClient(stack, key);
      const foreign = (await probe.get(
        'jobs?type=in.(index_document,cleanup)&state=in.(queued,running)&select=id',
      )) as unknown[];
      if (foreign.length > 0) {
        throw new Error(
          `refusing to start: ${String(foreign.length)} queued or running index/cleanup jobs already exist on the local stack. ` +
            'A runtime in these tests would claim them. Run the ingestion tests alone, after other suites have cleaned up.',
        );
      }
      const run = randomUUID().slice(0, 8);
      const session = await createTotpSession(
        stack,
        key,
        `p6-e2e-${run}@example.test`,
        randomTestPassword(),
      );
      try {
        await probe.post('admin_memberships', {
          user_id: session.userId,
          role: 'owner',
          active: true,
        });
      } catch (e) {
        await deleteAuthUser(stack, key, session.userId);
        throw e;
      }
      return new IngestionHarness(stack, key, session, releaseLock);
    } catch (e) {
      releaseLock();
      throw e;
    }
  }

  get apiUrl(): string {
    return this.stack.apiUrl;
  }

  rest(): RestClient {
    return new RestClient(this.stack, this.key);
  }

  /** Calls an admin RPC as the signed-in owner (aal2). Returns the raw result. */
  async adminRpc(name: string, args: Record<string, unknown>): Promise<HttpResult> {
    return rpc(this.stack, this.session.aal2Token, name, args);
  }

  async adminRpcOk(name: string, args: Record<string, unknown>): Promise<unknown> {
    const r = await this.adminRpc(name, args);
    if (r.status >= 300) {
      throw new Error(
        `admin call ${name} failed (HTTP ${String(r.status)}, SQLSTATE ${String(sqlstateOf(r))})`,
      );
    }
    return r.body;
  }

  /** A fresh bot with settings and policies, isolated from every other bot. */
  async createBot(options: BotOptions = {}): Promise<TestBot> {
    const slug = `p6e2e-${this.run}-${randomBytes(3).toString('hex')}`;
    const rest = this.rest();
    const [bot] = (await rest.post('bot_profiles', {
      slug,
      identity_prompt: 'P6 E2E TEST PLACEHOLDER',
      allowed_languages: ['en'],
      embedding_model: this.model,
      embedding_dimensions: 1536,
      // Enabled like a live bot. Indexing itself does not require it (a disabled bot indexes normally).
      enabled: true,
    })) as { id: string }[];
    if (bot === undefined) throw new Error('bot insert returned nothing');
    const big = { limit: 5000, window_seconds: 3600 };
    await rest.post('client_settings', {
      bot_id: bot.id,
      allowed_origins: ['http://localhost:3000'],
      rate_policy: { concurrent_requests_per_session: 1 },
      budget_policy: { daily_cap_usd: options.dailyCapUsd ?? 5 },
      retention_policy: { conversation_days: 90, usage_months: 13 },
      upload_policy: {
        max_bytes: options.maxBytes ?? 20971520,
        max_pages: options.maxPages ?? 300,
        index_max_attempts: options.indexMaxAttempts ?? 3,
        cleanup_max_attempts: options.cleanupMaxAttempts ?? 3,
        quotas: { register: big, upload: big, reindex: big, write: big },
      },
      handoff_policy: {},
      cache_policy: {},
    });
    const tb = new TestBot(this, bot.id, slug);
    this.bots.push(tb);
    return tb;
  }

  trackObject(path: string): void {
    this.extraObjects.push(path);
  }

  async putObject(
    path: string,
    bytes: Uint8Array,
    contentType: string,
    upsert = false,
  ): Promise<void> {
    const res = await fetch(`${this.apiUrl}/storage/v1/object/knowledge/${path}`, {
      method: 'POST',
      headers: {
        ...keyHeaders(this.key),
        'content-type': contentType,
        ...(upsert ? { 'x-upsert': 'true' } : {}),
      },
      body: new Uint8Array(bytes),
    });
    await res.arrayBuffer();
    if (res.status >= 300) throw new Error(`object upload failed (HTTP ${String(res.status)})`);
    this.trackObject(path);
  }

  async objectExists(path: string): Promise<boolean> {
    const res = await fetch(`${this.apiUrl}/storage/v1/object/authenticated/knowledge/${path}`, {
      headers: keyHeaders(this.key),
    });
    await res.arrayBuffer();
    return res.status === 200;
  }

  async removeObject(path: string): Promise<void> {
    const res = await fetch(`${this.apiUrl}/storage/v1/object/knowledge/${path}`, {
      method: 'DELETE',
      headers: keyHeaders(this.key),
    });
    await res.arrayBuffer();
  }

  /** The worker environment for this harness (see workerEnv). */
  env(embeddingBaseUrl: string, overrides: Record<string, string> = {}): Record<string, string> {
    return workerEnv({
      apiUrl: this.apiUrl,
      key: this.key,
      model: this.model,
      embeddingApiKey: this.embeddingApiKey,
      embeddingBaseUrl,
      overrides,
    });
  }

  /** In-process config. The fake provider is injected, so the base URL points at a closed port. */
  config(overrides: Record<string, string> = {}): WorkerConfig {
    return loadTestConfig(this.env('http://127.0.0.1:9', overrides));
  }

  /** Removes everything the harness created. Never throws. */
  async close(): Promise<void> {
    for (const b of [...this.bots].reverse()) await b.dispose().catch(() => undefined);
    for (const p of this.extraObjects) await this.removeObject(p).catch(() => undefined);
    for (const id of this.userIds)
      await deleteAuthUser(this.stack, this.key, id).catch(() => undefined);
    this.releaseLock();
  }
}

/** Minimal PostgREST client for the privileged key. Errors carry the status only. */
export class RestClient {
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

  get(path: string): Promise<unknown> {
    return this.call('GET', path);
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

  async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.call('POST', `rpc/${name}`, args);
  }
}

export class TestBot {
  private readonly objectPaths: string[] = [];

  constructor(
    readonly h: IngestionHarness,
    readonly id: string,
    readonly slug: string,
  ) {}

  private get rest(): RestClient {
    return this.h.rest();
  }

  // --- documents -------------------------------------------------------------------------------

  /** Registers a document, uploads the object, and confirms the upload (which queues the index job). */
  async register(o: UploadOptions): Promise<UploadedVersion> {
    const rows = (await this.h.adminRpcOk('admin_register_document', {
      p_bot_id: this.id,
      p_title: o.title ?? `P6 doc ${randomBytes(3).toString('hex')}`,
      p_media_type: o.mediaType,
      p_byte_size: o.bytes.length,
      p_disclosure_policy: o.disclosure ?? 'public_answer',
    })) as { document_id: string; version_id: string; storage_path: string }[];
    const row = rows[0];
    if (row === undefined) throw new Error('register returned nothing');
    return this.finishUpload(
      {
        documentId: row.document_id,
        versionId: row.version_id,
        versionNumber: 1,
        path: row.storage_path,
      },
      o,
    );
  }

  /** Adds a version to a document (new content), uploads it and confirms. */
  async addVersion(documentId: string, o: UploadOptions): Promise<UploadedVersion> {
    const rows = (await this.h.adminRpcOk('admin_add_document_version', {
      p_document_id: documentId,
      p_media_type: o.mediaType,
      p_byte_size: o.bytes.length,
    })) as { version_id: string; version_number: number; storage_path: string }[];
    const row = rows[0];
    if (row === undefined) throw new Error('add version returned nothing');
    return this.finishUpload(
      {
        documentId,
        versionId: row.version_id,
        versionNumber: row.version_number,
        path: row.storage_path,
      },
      o,
    );
  }

  /** Registers only (the version stays pending_upload); optionally uploads the object. */
  async registerPending(o: UploadOptions, upload: boolean): Promise<UploadedVersion> {
    const rows = (await this.h.adminRpcOk('admin_register_document', {
      p_bot_id: this.id,
      p_title: o.title ?? `P6 doc ${randomBytes(3).toString('hex')}`,
      p_media_type: o.mediaType,
      p_byte_size: o.bytes.length,
      p_disclosure_policy: o.disclosure ?? 'public_answer',
    })) as { document_id: string; version_id: string; storage_path: string }[];
    const row = rows[0];
    if (row === undefined) throw new Error('register returned nothing');
    if (upload) await this.putObject(row.storage_path, o.bytes, o.contentType ?? o.mediaType);
    return {
      documentId: row.document_id,
      versionId: row.version_id,
      versionNumber: 1,
      path: row.storage_path,
    };
  }

  private async finishUpload(v: UploadedVersion, o: UploadOptions): Promise<UploadedVersion> {
    await this.putObject(v.path, o.bytes, o.contentType ?? o.mediaType);
    await this.h.adminRpcOk('admin_complete_upload', { p_version_id: v.versionId });
    return v;
  }

  async putObject(
    path: string,
    bytes: Uint8Array,
    contentType: string,
    upsert = false,
  ): Promise<void> {
    await this.h.putObject(path, bytes, contentType, upsert);
    this.objectPaths.push(path);
  }

  async reindex(documentId: string): Promise<{ versionId: string; versionNumber: number }> {
    const rows = (await this.h.adminRpcOk('admin_reindex_document', {
      p_document_id: documentId,
    })) as { version_id: string; version_number: number }[];
    const row = rows[0];
    if (row === undefined) throw new Error('reindex returned nothing');
    return { versionId: row.version_id, versionNumber: row.version_number };
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.h.adminRpcOk('admin_delete_document', { p_document_id: documentId });
  }

  /** admin_document_status for this bot. */
  async status(): Promise<StatusRow[]> {
    return (await this.h.adminRpcOk('admin_document_status', {
      p_bot_id: this.id,
      p_limit: 100,
      p_offset: 0,
    })) as StatusRow[];
  }

  // --- reads (privileged) ----------------------------------------------------------------------

  async version(id: string): Promise<VersionRow> {
    const rows = (await this.rest.get(`document_versions?id=eq.${id}&select=*`)) as VersionRow[];
    const row = rows[0];
    if (row === undefined) throw new Error('version not found');
    return row;
  }

  async document(id: string): Promise<DocumentRow> {
    const rows = (await this.rest.get(`documents?id=eq.${id}&select=*`)) as DocumentRow[];
    const row = rows[0];
    if (row === undefined) throw new Error('document not found');
    return row;
  }

  async indexJob(versionId: string): Promise<JobRow> {
    const rows = (await this.rest.get(
      `jobs?dedupe_key=eq.index:version:${versionId}&select=*&order=created_at.desc`,
    )) as JobRow[];
    const row = rows[0];
    if (row === undefined) throw new Error('index job not found');
    return row;
  }

  async cleanupJob(documentId: string): Promise<JobRow | null> {
    const rows = (await this.rest.get(
      `jobs?dedupe_key=eq.cleanup:document:${documentId}&select=*`,
    )) as JobRow[];
    return rows[0] ?? null;
  }

  async job(id: string): Promise<JobRow> {
    const rows = (await this.rest.get(`jobs?id=eq.${id}&select=*`)) as JobRow[];
    const row = rows[0];
    if (row === undefined) throw new Error('job not found');
    return row;
  }

  async chunkIndexes(versionId: string): Promise<number[]> {
    const rows = (await this.rest.get(
      `document_chunks?document_version_id=eq.${versionId}&select=chunk_index&order=chunk_index`,
    )) as { chunk_index: number }[];
    return rows.map((r) => r.chunk_index);
  }

  async chunkCountForDocument(documentId: string): Promise<number> {
    const versions = (await this.rest.get(
      `document_versions?document_id=eq.${documentId}&select=id`,
    )) as { id: string }[];
    let total = 0;
    for (const v of versions) total += (await this.chunkIndexes(v.id)).length;
    return total;
  }

  async corpusVersion(): Promise<number> {
    const rows = (await this.rest.get(`bot_profiles?id=eq.${this.id}&select=corpus_version`)) as {
      corpus_version: number | string;
    }[];
    return Number(rows[0]?.corpus_version);
  }

  async usageEvents(): Promise<
    {
      job_id: string | null;
      operation: string;
      provider: string | null;
      model: string | null;
      input_tokens: number;
      estimated_cost: number | string;
    }[]
  > {
    return (await this.rest.get(
      `usage_events?bot_id=eq.${this.id}&select=job_id,operation,provider,model,input_tokens,estimated_cost&order=created_at`,
    )) as never;
  }

  async reservations(): Promise<
    { job_id: string | null; state: string; amount: number | string }[]
  > {
    return (await this.rest.get(
      `budget_reservations?bot_id=eq.${this.id}&select=job_id,state,amount&order=created_at`,
    )) as never;
  }

  /** Retrieval: the bot's top chunks for the (fake) embedding of `text`. */
  async match(text: string, count = 50): Promise<MatchRow[]> {
    const vector = `[${fakeVectorFor(text).join(',')}]`;
    return (await this.rest.rpc('match_document_chunks', {
      p_bot_id: this.id,
      p_query_embedding: vector,
      p_match_count: count,
    })) as MatchRow[];
  }

  // --- settings changes (privileged, for set-up) ------------------------------------------------

  async setUploadPolicy(patch: Record<string, unknown>): Promise<void> {
    const rows = (await this.rest.get(
      `client_settings?bot_id=eq.${this.id}&select=upload_policy`,
    )) as { upload_policy: Record<string, unknown> }[];
    const current = rows[0]?.upload_policy;
    if (current === undefined) throw new Error('settings not found');
    await this.rest.patch(`client_settings?bot_id=eq.${this.id}`, {
      upload_policy: { ...current, ...patch },
    });
  }

  /** Replaces budget_policy.daily_cap_usd, keeping the rest of the policy. */
  async setDailyCap(usd: number): Promise<void> {
    const rows = (await this.rest.get(
      `client_settings?bot_id=eq.${this.id}&select=budget_policy`,
    )) as { budget_policy: Record<string, unknown> }[];
    const current = rows[0]?.budget_policy;
    if (current === undefined) throw new Error('settings not found');
    await this.rest.patch(`client_settings?bot_id=eq.${this.id}`, {
      budget_policy: { ...current, daily_cap_usd: usd },
    });
  }

  async patchJob(jobId: string, patch: Record<string, unknown>): Promise<void> {
    await this.rest.patch(`jobs?id=eq.${jobId}`, patch);
  }

  /**
   * Simulates a lost lease: another worker id now owns the job until `forMs` from now. The real holder's
   * next fenced call is refused (RB013); claim_jobs hands the job out again once the time has passed.
   */
  async stealLease(jobId: string, forMs: number): Promise<void> {
    await this.patchJob(jobId, {
      locked_by: `thief-${this.h.run}`,
      locked_until: new Date(Date.now() + forMs).toISOString(),
    });
  }

  /** Overwrites the content of every chunk of a version (to tell leftover chunks from new ones). */
  async setChunkContents(versionId: string, content: string): Promise<void> {
    await this.rest.patch(`document_chunks?document_version_id=eq.${versionId}`, { content });
  }

  async chunkContents(versionId: string): Promise<string[]> {
    const rows = (await this.rest.get(
      `document_chunks?document_version_id=eq.${versionId}&select=content&order=chunk_index`,
    )) as { content: string }[];
    return rows.map((r) => r.content);
  }

  async setEmbeddingModel(model: string): Promise<void> {
    await this.rest.patch(`bot_profiles?id=eq.${this.id}`, { embedding_model: model });
  }

  async patchVersion(versionId: string, patch: Record<string, unknown>): Promise<void> {
    await this.rest.patch(`document_versions?id=eq.${versionId}`, patch);
  }

  // --- waiting -----------------------------------------------------------------------------------

  async waitVersion(
    versionId: string,
    statuses: readonly string[],
    timeoutMs = 40_000,
  ): Promise<VersionRow> {
    return waitFor(
      `version to reach ${statuses.join('/')}`,
      async () => {
        const v = await this.version(versionId);
        return statuses.includes(v.status) ? v : null;
      },
      timeoutMs,
      150,
    );
  }

  /** Waits until the version's index job is no longer queued or running. */
  async waitJobDone(versionId: string, timeoutMs = 40_000): Promise<JobRow> {
    return waitFor(
      'index job to finish',
      async () => {
        const j = await this.indexJob(versionId);
        return TERMINAL_JOB.includes(j.state) ? j : null;
      },
      timeoutMs,
      150,
    );
  }

  async waitCleanupDone(documentId: string, timeoutMs = 40_000): Promise<JobRow> {
    return waitFor(
      'cleanup job to finish',
      async () => {
        const j = await this.cleanupJob(documentId);
        return j !== null && TERMINAL_JOB.includes(j.state) ? j : null;
      },
      timeoutMs,
      150,
    );
  }

  /** Removes this bot's jobs, rows (cascade) and objects. Never throws. */
  async dispose(): Promise<void> {
    await this.rest.delete(`jobs?payload->>bot_id=eq.${this.id}`).catch(() => undefined);
    await this.rest.delete(`bot_profiles?id=eq.${this.id}`).catch(() => undefined);
    for (const p of this.objectPaths) await this.h.removeObject(p).catch(() => undefined);
  }
}
