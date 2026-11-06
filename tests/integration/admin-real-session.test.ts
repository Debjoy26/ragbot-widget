import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import {
  adminAddDocumentVersionResponseSchema,
  adminCompleteUploadResponseSchema,
  adminDocumentStatusResponseSchema,
  adminGetSettingsResponseSchema,
  adminListBotsResponseSchema,
  adminListMembersResponseSchema,
  adminRegisterDocumentResponseSchema,
  adminReindexDocumentResponseSchema,
  adminRequestDownloadResponseSchema,
  adminRetryVersionResponseSchema,
  adminSettingsVersionResponseSchema,
  adminVoidResponseSchema,
  jobSchema,
  publicBotConfigSchema,
  schemaVersionResponseSchema,
  type AdminSettingsRow,
} from '@ragbot/shared';
import {
  createTotpSession,
  decodeJwtClaims,
  deleteAuthUser,
  randomTestPassword,
  readResponse,
  rpc,
  sqlstateOf,
  type HttpResult,
  type TestSession,
} from './helpers/auth-session.ts';
import {
  anonHeaders,
  getLocalPrivilegedKey,
  getLocalStack,
  keyHeaders,
  userHeaders,
  type LocalStack,
} from './helpers/local-stack.ts';

// P3.5-T3 (B-13): the browser RPCs, RLS reads and Storage policies exercised over HTTP with REAL sessions.
// Every token comes from the local Auth service: password sign-in gives aal1, a verified TOTP factor gives
// aal2. No claim is forged. No mocks. Needs `npm run db:start` with TOTP enabled and migrations applied.
// The privileged key is used only to set up and clean up (users, memberships, a test bot, fixture rows).
// Emails use example.test and are unique per run. Tokens, keys and passwords are never printed.
//
// ADR 0017 "to confirm when built" - what this suite established on the local stack (Storage 1.x, see report):
//  * A signed DOWNLOAD URL is created by POST /object/sign/knowledge/<path> under the member's token. It
//    needs only the SELECT policy knowledge_select_members (owner/admin at aal2). No other privilege.
//  * The URL itself carries a Storage-signed token and is a bearer capability: anyone holding it can fetch
//    the object with no Authorization header until it expires. Revoking the member does not recall a URL
//    already issued; keep expiresIn short.
//  * A signed UPLOAD URL (POST /object/upload/sign/...) needs the INSERT policy (pending version path).
//  * Reading storage.objects from admin_complete_upload works because the function is SECURITY DEFINER
//    (it runs as its owner, which is not bound by the authenticated-role policies); RB038 when absent.

let stack: LocalStack;
let key: string;
const RUN = randomUUID().slice(0, 8);
const password = randomTestPassword();

type Role = 'owner' | 'admin' | 'analyst';
interface Principal {
  name: string;
  /** Token, or null for the anonymous caller. */
  token: string | null;
  aal: 'aal1' | 'aal2' | 'anon';
  /** The role of an ACTIVE membership; null for nonmember, revoked and anon. */
  role: Role | null;
}

const sessions = new Map<string, TestSession>();
const createdUserIds: string[] = [];
let botId = '';
let botSlug = '';
let conversationId = '';
let secondConversationId = '';
const objectPaths: string[] = [];
const extraBotIds: string[] = [];
let principals: Principal[] = [];

const NOBODY = '00000000-0000-4000-8000-00000000dead';

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

async function svc(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  return readResponse(
    await fetch(`${stack.apiUrl}${path}`, {
      method,
      headers: {
        ...keyHeaders(key),
        'content-type': 'application/json',
        prefer: 'return=representation',
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

function rows(r: HttpResult): Record<string, unknown>[] {
  expect(r.status, 'service call status').toBeLessThan(300);
  expect(Array.isArray(r.body)).toBe(true);
  return r.body as Record<string, unknown>[];
}

function authHeaders(token: string | null): Record<string, string> {
  return token === null ? anonHeaders(stack) : userHeaders(stack, token);
}

async function restGet(token: string | null, path: string): Promise<HttpResult> {
  return readResponse(
    await fetch(`${stack.apiUrl}/rest/v1/${path}`, { headers: authHeaders(token) }),
  );
}

function expectSchema<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`response does not match its schema: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

function expectCode(r: HttpResult, code: string): void {
  expect(r.status, `HTTP status for ${code}`).toBeGreaterThanOrEqual(400);
  expect(sqlstateOf(r)).toBe(code);
}

function expectOk(r: HttpResult): void {
  expect(r.status, `HTTP status (SQLSTATE ${String(sqlstateOf(r))})`).toBeLessThan(300);
}

/**
 * Storage answers every refusal with HTTP 400 and puts the real status in the JSON body (`statusCode`).
 * That body code is what is asserted: 403 = row-level security refused it, 404 = the object is hidden from
 * the caller, 409 = already exists, 413 = too large, 415 = type not allowed.
 */
function storageCode(r: HttpResult): string | null {
  const c = (r.body as Record<string, unknown> | null)?.['statusCode'];
  return typeof c === 'string' ? c : typeof c === 'number' ? String(c) : null;
}

function expectRefused(r: HttpResult, codes: readonly string[] = ['403', '404']): void {
  expect(r.status, 'a refusal, not a success').toBeGreaterThanOrEqual(400);
  expect(codes, `Storage status code in the body (HTTP ${r.status})`).toContain(storageCode(r));
}

// Storage ---------------------------------------------------------------------------------------

async function upload(
  token: string | null,
  path: string,
  bytes: Uint8Array | Buffer,
  contentType = 'text/plain',
  upsert = false,
): Promise<HttpResult> {
  return readResponse(
    await fetch(`${stack.apiUrl}/storage/v1/object/knowledge/${path}`, {
      method: 'POST',
      headers: {
        ...authHeaders(token),
        'content-type': contentType,
        ...(upsert ? { 'x-upsert': 'true' } : {}),
      },
      body: new Uint8Array(bytes),
    }),
  );
}

async function signDownload(
  token: string | null,
  path: string,
  expiresIn = 60,
): Promise<HttpResult> {
  return readResponse(
    await fetch(`${stack.apiUrl}/storage/v1/object/sign/knowledge/${path}`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ expiresIn }),
    }),
  );
}

function signedUrlOf(r: HttpResult): string {
  const u = (r.body as Record<string, unknown> | null)?.['signedURL'];
  expect(typeof u).toBe('string');
  return `${stack.apiUrl}/storage/v1${String(u)}`;
}

async function directDownload(
  token: string | null,
  path: string,
): Promise<{ status: number; bytes: Buffer; code: string | null }> {
  const res = await fetch(`${stack.apiUrl}/storage/v1/object/authenticated/knowledge/${path}`, {
    headers: authHeaders(token),
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  let code: string | null = null;
  if (res.status >= 400) {
    try {
      code = storageCode({
        status: res.status,
        body: JSON.parse(bytes.toString('utf8')) as unknown,
      });
    } catch {
      code = null;
    }
  }
  return { status: res.status, bytes, code };
}

/** Does the object exist? Checked with the privileged key. */
async function objectExists(path: string): Promise<boolean> {
  const res = await fetch(`${stack.apiUrl}/storage/v1/object/authenticated/knowledge/${path}`, {
    headers: keyHeaders(key),
  });
  await res.arrayBuffer();
  return res.status === 200;
}

async function objectBytes(path: string): Promise<Buffer> {
  const res = await fetch(`${stack.apiUrl}/storage/v1/object/authenticated/knowledge/${path}`, {
    headers: keyHeaders(key),
  });
  return Buffer.from(await res.arrayBuffer());
}

// Documents -------------------------------------------------------------------------------------

interface Registered {
  documentId: string;
  versionId: string;
  path: string;
}

async function register(
  token: string,
  opts: { size: number; mediaType?: string; title?: string; policy?: string } = { size: 10 },
): Promise<Registered> {
  const r = await rpc(stack, token, 'admin_register_document', {
    p_bot_id: botId,
    p_title: opts.title ?? `T3 doc ${randomBytes(3).toString('hex')}`,
    p_media_type: opts.mediaType ?? 'text/plain',
    p_byte_size: opts.size,
    p_disclosure_policy: opts.policy ?? 'excluded',
  });
  expectOk(r);
  const [row] = expectSchema(adminRegisterDocumentResponseSchema, r.body);
  if (row === undefined) throw new Error('no row');
  objectPaths.push(row.storage_path);
  return { documentId: row.document_id, versionId: row.version_id, path: row.storage_path };
}

async function jobsFor(versionId: string): Promise<Record<string, unknown>[]> {
  return rows(
    await svc(
      'GET',
      `/rest/v1/jobs?dedupe_key=eq.index:version:${versionId}&select=id,type,state,max_attempts,payload`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeUser(label: string, role: Role | 'none', active = true): Promise<TestSession> {
  const email = `t3-${label}-${RUN}@example.test`;
  const s = await createTotpSession(stack, key, email, password);
  createdUserIds.push(s.userId);
  sessions.set(label, s);
  if (role !== 'none') {
    rows(await svc('POST', '/rest/v1/admin_memberships', { user_id: s.userId, role, active }));
  }
  return s;
}

beforeAll(async () => {
  stack = getLocalStack();
  key = getLocalPrivilegedKey();

  await makeUser('owner', 'owner');
  await makeUser('admin', 'admin');
  await makeUser('analyst', 'analyst');
  await makeUser('nonmember', 'none');
  await makeUser('revoked', 'admin', false);
  await makeUser('torevoke', 'admin');

  const get = (n: string): TestSession => {
    const s = sessions.get(n);
    if (s === undefined) throw new Error(`missing session ${n}`);
    return s;
  };
  principals = [
    { name: 'anonymous', token: null, aal: 'anon', role: null },
    ...(['owner', 'admin', 'analyst'] as const).flatMap((r) => [
      { name: `${r} aal1`, token: get(r).aal1Token, aal: 'aal1' as const, role: r },
      { name: `${r} aal2`, token: get(r).aal2Token, aal: 'aal2' as const, role: r },
    ]),
    { name: 'nonmember aal1', token: get('nonmember').aal1Token, aal: 'aal1', role: null },
    { name: 'nonmember aal2', token: get('nonmember').aal2Token, aal: 'aal2', role: null },
    { name: 'revoked aal1', token: get('revoked').aal1Token, aal: 'aal1', role: null },
    { name: 'revoked aal2', token: get('revoked').aal2Token, aal: 'aal2', role: null },
  ];

  // A private test bot, so quotas, settings and documents are isolated from the seeded dev bot.
  botSlug = `t3-${RUN}`;
  const [bot] = rows(
    await svc('POST', '/rest/v1/bot_profiles', {
      slug: botSlug,
      identity_prompt: 'T3 TEST PLACEHOLDER',
      allowed_languages: ['en'],
      embedding_model: 'gemini-embedding-001',
      embedding_dimensions: 1536,
    }),
  );
  botId = String(bot?.['id']);
  rows(
    await svc('POST', '/rest/v1/client_settings', {
      bot_id: botId,
      allowed_origins: ['http://localhost:3000'],
      rate_policy: { concurrent_requests_per_session: 1 },
      budget_policy: { daily_cap_usd: 5 },
      retention_policy: { conversation_days: 90, usage_months: 13 },
      upload_policy: {
        max_bytes: 20971520,
        max_pages: 300,
        index_max_attempts: 3,
        cleanup_max_attempts: 3,
        quotas: {
          register: { limit: 200, window_seconds: 3600 },
          upload: { limit: 200, window_seconds: 3600 },
          reindex: { limit: 200, window_seconds: 3600 },
          write: { limit: 200, window_seconds: 3600 },
        },
      },
      handoff_policy: {},
      cache_policy: {},
    }),
  );

  // Conversations with a user, an assistant and a system message (fake text).
  for (const which of ['first', 'second'] as const) {
    const [conv] = rows(await svc('POST', '/rest/v1/conversations', { bot_id: botId }));
    const id = String(conv?.['id']);
    if (which === 'first') conversationId = id;
    else secondConversationId = id;
    rows(
      await svc('POST', '/rest/v1/messages', [
        { conversation_id: id, role: 'user', content: 'T3 fake visitor message' },
        { conversation_id: id, role: 'assistant', content: 'T3 fake assistant reply' },
        { conversation_id: id, role: 'system', content: 'T3 fake system row' },
      ]),
    );
  }
}, 180_000);

afterAll(async () => {
  if (key === undefined) return;
  for (const p of objectPaths) {
    await fetch(`${stack.apiUrl}/storage/v1/object/knowledge/${p}`, {
      method: 'DELETE',
      headers: keyHeaders(key),
    }).then((r) => r.arrayBuffer());
  }
  for (const b of extraBotIds) {
    await svc('DELETE', `/rest/v1/jobs?payload->>bot_id=eq.${b}`);
    await svc('DELETE', `/rest/v1/bot_profiles?id=eq.${b}`);
  }
  if (botId !== '') {
    await svc('DELETE', `/rest/v1/jobs?payload->>bot_id=eq.${botId}`);
    // Cascades to client_settings, public_bot_config, documents, versions, conversations, messages.
    await svc('DELETE', `/rest/v1/bot_profiles?id=eq.${botId}`);
  }
  for (const id of createdUserIds) await deleteAuthUser(stack, key, id); // memberships cascade
}, 120_000);

// ---------------------------------------------------------------------------
// (a) The tokens are what they claim to be
// ---------------------------------------------------------------------------

describe('real sessions carry the right assurance level', () => {
  it.each(['owner', 'admin', 'analyst', 'nonmember', 'revoked'])(
    '%s: aal1 token says aal1, aal2 token says aal2 with a TOTP method',
    (label) => {
      const s = sessions.get(label);
      if (s === undefined) throw new Error('missing session');
      const c1 = decodeJwtClaims(s.aal1Token);
      const c2 = decodeJwtClaims(s.aal2Token);
      expect(c1['aal']).toBe('aal1');
      expect(c2['aal']).toBe('aal2');
      expect(c1['role']).toBe('authenticated');
      expect(c2['role']).toBe('authenticated');
      expect(c1['sub']).toBe(s.userId);
      expect(c2['sub']).toBe(s.userId);
      expect(JSON.stringify(c2['amr'])).toContain('totp');
      expect(JSON.stringify(c1['amr'])).not.toContain('totp');
      // Both are unexpired, so any refusal below is the database's decision, not an expiry.
      expect(Number(c1['exp'])).toBeGreaterThan(Date.now() / 1000 + 60);
      expect(Number(c2['exp'])).toBeGreaterThan(Date.now() / 1000 + 60);
    },
  );

  it('a token with its aal claim rewritten is rejected before any function runs (bad signature)', async () => {
    const s = sessions.get('nonmember');
    if (s === undefined) throw new Error('missing session');
    const parts = s.aal1Token.split('.');
    const claims = decodeJwtClaims(s.aal1Token);
    claims['aal'] = 'aal2';
    const forged = `${parts[0]}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${parts[2]}`;
    const r = await rpc(stack, forged, 'schema_version');
    expect(r.status).toBe(401);
    expect(r.body).not.toBe(10);
  });
});

// ---------------------------------------------------------------------------
// (b) Every browser RPC, every principal
// ---------------------------------------------------------------------------

interface RpcCase {
  name: string;
  roles: readonly Role[] | 'any';
  args: Record<string, unknown>;
  /** What an allowed caller gets for these arguments: HTTP success, or this SQLSTATE (a business refusal). */
  allowed: 'ok' | string;
}

const ALL: readonly Role[] = ['owner', 'admin', 'analyst'];
const WRITE: readonly Role[] = ['owner', 'admin'];
const rpcCases: RpcCase[] = [
  {
    name: 'admin_register_document',
    roles: WRITE,
    allowed: 'RB037',
    args: {
      p_bot_id: NOBODY,
      p_title: 'x',
      p_media_type: 'text/plain',
      p_byte_size: 10,
      p_disclosure_policy: 'excluded',
    },
  },
  {
    name: 'admin_add_document_version',
    roles: WRITE,
    allowed: 'RB037',
    args: { p_document_id: NOBODY, p_media_type: 'text/plain', p_byte_size: 10 },
  },
  { name: 'admin_complete_upload', roles: WRITE, allowed: 'RB037', args: { p_version_id: NOBODY } },
  { name: 'admin_retry_version', roles: WRITE, allowed: 'RB037', args: { p_version_id: NOBODY } },
  {
    name: 'admin_reindex_document',
    roles: WRITE,
    allowed: 'RB037',
    args: { p_document_id: NOBODY },
  },
  {
    name: 'admin_document_status',
    roles: ALL,
    allowed: 'RB037',
    args: { p_bot_id: NOBODY, p_limit: 10, p_offset: 0 },
  },
  {
    name: 'admin_request_download',
    roles: WRITE,
    allowed: 'RB037',
    args: { p_version_id: NOBODY },
  },
  {
    name: 'admin_delete_document',
    roles: WRITE,
    allowed: 'RB037',
    args: { p_document_id: NOBODY },
  },
  { name: 'admin_list_bots', roles: ALL, allowed: 'ok', args: {} },
  { name: 'admin_get_settings', roles: ALL, allowed: 'RB037', args: { p_bot_id: NOBODY } },
  {
    name: 'admin_update_settings',
    roles: WRITE,
    allowed: 'RB037',
    args: { p_bot_id: NOBODY, p_expected_settings_version: 1, p_patch: { greeting: 'hello' } },
  },
  {
    name: 'admin_set_bot_enabled',
    roles: WRITE,
    allowed: 'RB037',
    args: { p_bot_id: NOBODY, p_expected_settings_version: 1, p_enabled: false },
  },
  {
    name: 'admin_delete_conversation',
    roles: WRITE,
    allowed: 'RB037',
    args: { p_conversation_id: NOBODY },
  },
  { name: 'admin_list_members', roles: WRITE, allowed: 'ok', args: {} },
  { name: 'schema_version', roles: 'any', allowed: 'ok', args: {} },
];

function expectedFor(c: RpcCase, p: Principal): 'ok' | string {
  if (p.aal === 'anon') return '42501'; // no EXECUTE for anon
  if (c.roles === 'any') return c.allowed; // any signed-in user, no membership needed
  if (p.role === null) return 'RB033'; // nonmember or revoked, at either aal
  if (!c.roles.includes(p.role)) return 'RB033'; // role not allowed (checked before aal)
  if (p.aal === 'aal1') return 'RB032'; // allowed role, no MFA
  return c.allowed;
}

describe('every browser-callable RPC over /rest/v1/rpc, for every principal', () => {
  for (const c of rpcCases) {
    describe(c.name, () => {
      for (const pName of [
        'anonymous',
        'owner aal1',
        'owner aal2',
        'admin aal1',
        'admin aal2',
        'analyst aal1',
        'analyst aal2',
        'nonmember aal1',
        'nonmember aal2',
        'revoked aal1',
        'revoked aal2',
      ]) {
        it(`${pName}`, async () => {
          const p = principals.find((x) => x.name === pName);
          if (p === undefined) throw new Error('missing principal');
          const want = expectedFor(c, p);
          const r = await rpc(stack, p.token, c.name, c.args);
          if (want === 'ok') {
            expectOk(r);
            if (c.name === 'admin_list_bots') expectSchema(adminListBotsResponseSchema, r.body);
            if (c.name === 'admin_list_members')
              expectSchema(adminListMembersResponseSchema, r.body);
            if (c.name === 'schema_version')
              expect(expectSchema(schemaVersionResponseSchema, r.body)).toBe(10);
          } else {
            expectCode(r, want);
          }
        });
      }
    });
  }

  it('the guard and audit helpers are not callable by a signed-in owner at aal2', async () => {
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    for (const [name, args] of [
      ['admin_require', { p_roles: ['owner'] }],
      [
        'admin_audit',
        { p_action: 'x.y', p_resource_type: 'bot', p_resource_id: NOBODY, p_metadata: {} },
      ],
      ['admin_consume_quota', { p_bot_id: botId, p_kind: 'register' }],
      ['admin_policy_int', { p_bot_id: botId, p_key: 'max_bytes', p_min: 1, p_max: 100 }],
      ['reserve_job_budget', { p_bot_id: botId, p_job_id: NOBODY, p_amount: 1, p_ttl_seconds: 60 }],
    ] as const) {
      const r = await rpc(stack, owner.aal2Token, name, args);
      expect(r.status, name).toBeGreaterThanOrEqual(400);
      expect(['42501', 'PGRST202'], name).toContain(sqlstateOf(r));
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Reads under RLS
// ---------------------------------------------------------------------------

describe('reads under row-level security', () => {
  for (const p of ['owner aal2', 'admin aal2', 'analyst aal2']) {
    it(`${p} sees conversations and non-system messages, never system rows`, async () => {
      const pr = principals.find((x) => x.name === p);
      if (pr === undefined) throw new Error('missing principal');
      const conv = await restGet(pr.token, `conversations?bot_id=eq.${botId}&select=id`);
      expectOk(conv);
      expect((conv.body as unknown[]).length).toBe(2);

      const msgs = await restGet(
        pr.token,
        `messages?conversation_id=eq.${conversationId}&select=role&order=role`,
      );
      expectOk(msgs);
      expect((msgs.body as { role: string }[]).map((m) => m.role)).toEqual(['assistant', 'user']);

      const sys = await restGet(
        pr.token,
        `messages?conversation_id=eq.${conversationId}&role=eq.system&select=id`,
      );
      expectOk(sys);
      expect(sys.body).toEqual([]);
    });
  }

  for (const p of [
    'owner aal1',
    'admin aal1',
    'analyst aal1',
    'nonmember aal2',
    'revoked aal2',
    'nonmember aal1',
  ]) {
    it(`${p} sees no conversations and no messages`, async () => {
      const pr = principals.find((x) => x.name === p);
      if (pr === undefined) throw new Error('missing principal');
      for (const q of [
        `conversations?bot_id=eq.${botId}&select=id`,
        `messages?conversation_id=eq.${conversationId}&select=id`,
      ]) {
        const r = await restGet(pr.token, q);
        expectOk(r);
        expect(r.body).toEqual([]);
      }
    });
  }

  it('anonymous has no table access at all (permission denied)', async () => {
    for (const q of [
      `conversations?select=id`,
      `messages?select=id`,
      `audit_logs?select=id`,
      `documents?select=id`,
    ]) {
      const r = await restGet(null, q);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(sqlstateOf(r)).toBe('42501');
    }
  });

  it('only owner and admin read audit_logs; analyst reads none (aal2)', async () => {
    // The register below writes an audit row; the analyst's view must stay empty.
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    await register(owner.aal2Token, { size: 5, title: 'T3 audit probe' });
    const q = `audit_logs?action=eq.document.register&select=id`;
    const asOwner = await restGet(owner.aal2Token, q);
    expectOk(asOwner);
    expect((asOwner.body as unknown[]).length).toBeGreaterThan(0);
    const analyst = sessions.get('analyst');
    if (analyst === undefined) throw new Error('missing session');
    const asAnalyst = await restGet(analyst.aal2Token, q);
    expectOk(asAnalyst);
    expect(asAnalyst.body).toEqual([]);
  });

  it('an analyst at aal2 reads document metadata but not data entries', async () => {
    const analyst = sessions.get('analyst');
    if (analyst === undefined) throw new Error('missing session');
    const docs = await restGet(analyst.aal2Token, `documents?bot_id=eq.${botId}&select=id`);
    expectOk(docs);
    expect((docs.body as unknown[]).length).toBeGreaterThan(0);
    const entries = await restGet(analyst.aal2Token, 'data_entries?select=id');
    expectOk(entries);
    expect(entries.body).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (e) Document upload through the real Storage API
// ---------------------------------------------------------------------------

describe('document upload path', () => {
  const content = Buffer.from('t3 fake document body'); // 21 bytes
  let main: Registered;

  it('register returns ids and a generated path under the bot, document and version', async () => {
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    main = await register(owner.aal2Token, { size: content.length });
    expect(main.path).toBe(`${botId}/${main.documentId}/${main.versionId}/original.txt`);
    const status = await rpc(stack, owner.aal2Token, 'admin_document_status', {
      p_bot_id: botId,
      p_limit: 50,
      p_offset: 0,
    });
    expectOk(status);
    const list = expectSchema(adminDocumentStatusResponseSchema, status.body);
    const mine = list.find((d) => d.document_id === main.documentId);
    expect(mine?.latest_version_status).toBe('pending_upload');
    expect(mine?.status).toBe('draft');
  });

  it('registering above the bot limit is RB031, an unsupported type is 22023, a short title is fine, admin may register', async () => {
    const owner = sessions.get('owner');
    const admin = sessions.get('admin');
    if (owner === undefined || admin === undefined) throw new Error('missing session');
    const base = {
      p_bot_id: botId,
      p_title: 'T3 limits',
      p_media_type: 'text/plain',
      p_disclosure_policy: 'excluded',
    };
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_register_document', {
        ...base,
        p_byte_size: 20971521,
      }),
      'RB031',
    );
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_register_document', { ...base, p_byte_size: 0 }),
      '22023',
    );
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_register_document', {
        ...base,
        p_byte_size: 10,
        p_media_type: 'image/png',
      }),
      '22023',
    );
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_register_document', {
        ...base,
        p_byte_size: 10,
        p_disclosure_policy: 'public',
      }),
      '22023',
    );
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_register_document', {
        ...base,
        p_byte_size: 10,
        p_title: '<b>' + 'x'.repeat(300),
      }),
      '22023',
    );
    const viaAdmin = await register(admin.aal2Token, {
      size: 3,
      mediaType: 'text/markdown',
      title: 'T3 by admin',
    });
    expect(viaAdmin.path.endsWith('/original.md')).toBe(true);
  });

  it('refuses an upload before registration of that path, to a path of another version, and to a deleted-looking path', async () => {
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    const other = `${botId}/${main.documentId}/${randomUUID()}/original.txt`;
    const r = await upload(owner.aal2Token, other, content);
    expectRefused(r, ['403']);
    expect(await objectExists(other)).toBe(false);
    const wrongName = `${botId}/${main.documentId}/${main.versionId}/other.txt`;
    expectRefused(await upload(owner.aal2Token, wrongName, content), ['403']);
    expect(await objectExists(wrongName)).toBe(false);
  });

  it('refuses an upload as analyst (aal2), as owner at aal1, as nonmember, as revoked and as anonymous', async () => {
    for (const p of [
      'analyst aal2',
      'owner aal1',
      'admin aal1',
      'nonmember aal2',
      'revoked aal2',
      'anonymous',
    ]) {
      const pr = principals.find((x) => x.name === p);
      if (pr === undefined) throw new Error('missing principal');
      expectRefused(await upload(pr.token, main.path, content), ['403']);
    }
    expect(await objectExists(main.path)).toBe(false);
  });

  it('refuses a file type outside the bucket list and an oversize file, leaving no object behind', async () => {
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    const doc = await register(owner.aal2Token, { size: 1000 });
    const png = await upload(
      owner.aal2Token,
      doc.path,
      Buffer.from('not really a png'),
      'image/png',
    );
    expectRefused(png, ['415']);
    expect(await objectExists(doc.path)).toBe(false);

    const big = Buffer.alloc(20 * 1024 * 1024 + 1, 0x61); // one byte over the bucket limit
    const over = await upload(owner.aal2Token, doc.path, big);
    expectRefused(over, ['413']);
    expect(await objectExists(doc.path)).toBe(false);
  }, 120_000);

  it('accepts the upload from the owner at aal2 to the exact registered path', async () => {
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    const r = await upload(owner.aal2Token, main.path, content);
    expectOk(r);
    expect(await objectBytes(main.path)).toEqual(content);
  });

  it('refuses a second upload and an x-upsert overwrite of the same path; the bytes stay unchanged', async () => {
    const owner = sessions.get('owner');
    const admin = sessions.get('admin');
    if (owner === undefined || admin === undefined) throw new Error('missing session');
    const evil = Buffer.from('overwritten');
    // Without x-upsert the existing object is a plain conflict (409); with x-upsert the overwrite would
    // need an UPDATE policy, which does not exist, so row-level security refuses it (403).
    expectRefused(await upload(owner.aal2Token, main.path, evil), ['409']);
    expectRefused(await upload(owner.aal2Token, main.path, evil, 'text/plain', true), ['403']);
    expectRefused(await upload(admin.aal2Token, main.path, evil, 'text/plain', true), ['403']);
    expect(await objectBytes(main.path)).toEqual(content);
  });

  it('complete: analyst RB033, owner at aal1 RB032, then the owner queues exactly one index job', async () => {
    const owner = sessions.get('owner');
    const analyst = sessions.get('analyst');
    if (owner === undefined || analyst === undefined) throw new Error('missing session');
    expectCode(
      await rpc(stack, analyst.aal2Token, 'admin_complete_upload', {
        p_version_id: main.versionId,
      }),
      'RB033',
    );
    expectCode(
      await rpc(stack, owner.aal1Token, 'admin_complete_upload', { p_version_id: main.versionId }),
      'RB032',
    );
    expect(await jobsFor(main.versionId)).toEqual([]);

    // The file is 21 bytes; the registration said 21.
    const r = await rpc(stack, owner.aal2Token, 'admin_complete_upload', {
      p_version_id: main.versionId,
    });
    expectOk(r);
    const [row] = expectSchema(adminCompleteUploadResponseSchema, r.body);
    expect(row).toEqual({ version_id: main.versionId, status: 'uploaded', job_queued: true });

    const jobs = await jobsFor(main.versionId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: 'index_document', state: 'queued', max_attempts: 3 });
    expect(jobs[0]?.['payload']).toEqual({
      bot_id: botId,
      document_id: main.documentId,
      version_id: main.versionId,
    });
  });

  it('a second complete changes nothing and queues no second job', async () => {
    const admin = sessions.get('admin');
    if (admin === undefined) throw new Error('missing session');
    const r = await rpc(stack, admin.aal2Token, 'admin_complete_upload', {
      p_version_id: main.versionId,
    });
    expectOk(r);
    const [row] = expectSchema(adminCompleteUploadResponseSchema, r.body);
    expect(row).toEqual({ version_id: main.versionId, status: 'uploaded', job_queued: false });
    expect(await jobsFor(main.versionId)).toHaveLength(1);
  });

  it('after complete, no further upload to that path is accepted', async () => {
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    expectRefused(
      await upload(owner.aal2Token, main.path, Buffer.from('late'), 'text/plain', true),
      ['403'],
    );
    expect(await objectBytes(main.path)).toEqual(content);
  });

  it('upload with the wrong size, then complete: RB030, no job, version stays pending', async () => {
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    const doc = await register(owner.aal2Token, { size: 10 });
    expectOk(await upload(owner.aal2Token, doc.path, Buffer.from('1234567'))); // 7 bytes
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_complete_upload', { p_version_id: doc.versionId }),
      'RB030',
    );
    expect(await jobsFor(doc.versionId)).toEqual([]);
    const v = rows(
      await svc('GET', `/rest/v1/document_versions?id=eq.${doc.versionId}&select=status`),
    );
    expect(v[0]?.['status']).toBe('pending_upload');
  });

  it('complete before any upload: RB038, no job', async () => {
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    const doc = await register(owner.aal2Token, { size: 10 });
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_complete_upload', { p_version_id: doc.versionId }),
      'RB038',
    );
    expect(await jobsFor(doc.versionId)).toEqual([]);
  });

  it('add-version issues the next number and path; reindex needs a live version (RB030 here)', async () => {
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    const r = await rpc(stack, owner.aal2Token, 'admin_add_document_version', {
      p_document_id: main.documentId,
      p_media_type: 'application/pdf',
      p_byte_size: 99,
    });
    expectOk(r);
    const [row] = expectSchema(adminAddDocumentVersionResponseSchema, r.body);
    expect(row?.version_number).toBe(2);
    expect(row?.storage_path).toBe(`${botId}/${main.documentId}/${row?.version_id}/original.pdf`);
    objectPaths.push(String(row?.storage_path));
    // A PDF version needs the PDF type: text/plain on a .pdf path is allowed by the bucket (see report).
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_reindex_document', {
        p_document_id: main.documentId,
      }),
      'RB030',
    );
  });

  it('retry refuses a version that is not failed (RB030) and the status page validates', async () => {
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_retry_version', { p_version_id: main.versionId }),
      'RB030',
    );
    const analyst = sessions.get('analyst');
    if (analyst === undefined) throw new Error('missing session');
    const page = await rpc(stack, analyst.aal2Token, 'admin_document_status', {
      p_bot_id: botId,
      p_limit: 2,
      p_offset: 0,
    });
    expectOk(page);
    expect(expectSchema(adminDocumentStatusResponseSchema, page.body).length).toBeLessThanOrEqual(
      2,
    );
    expectCode(
      await rpc(stack, analyst.aal2Token, 'admin_document_status', {
        p_bot_id: botId,
        p_limit: 501,
        p_offset: 0,
      }),
      '22023',
    );
    expectCode(
      await rpc(stack, analyst.aal2Token, 'admin_document_status', {
        p_bot_id: botId,
        p_limit: 5,
        p_offset: -1,
      }),
      '22023',
    );
  });

  it('add-version rejects an unsupported type (22023) and an oversize file (RB031)', async () => {
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_add_document_version', {
        p_document_id: main.documentId,
        p_media_type: 'image/png',
        p_byte_size: 1,
      }),
      '22023',
    );
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_add_document_version', {
        p_document_id: main.documentId,
        p_media_type: 'text/plain',
        p_byte_size: 20971521,
      }),
      'RB031',
    );
  });

  it('retry: a failed version goes back to uploaded with one new job; analyst RB033, aal1 RB032; a repeat is RB030', async () => {
    const owner = sessions.get('owner');
    const analyst = sessions.get('analyst');
    if (owner === undefined || analyst === undefined) throw new Error('missing session');
    const doc = await register(owner.aal2Token, { size: 5 });
    expectOk(await upload(owner.aal2Token, doc.path, Buffer.from('12345')));
    // Stand-in for the worker (service role): the version failed during indexing.
    rows(
      await svc('PATCH', `/rest/v1/document_versions?id=eq.${doc.versionId}`, {
        status: 'failed',
        failure_code: 'INDEXING_FAILED',
        batches_done: 1,
        batches_total: 4,
      }),
    );
    const page = await rpc(stack, analyst.aal2Token, 'admin_document_status', {
      p_bot_id: botId,
      p_limit: 500,
      p_offset: 0,
    });
    expectOk(page);
    expect(
      expectSchema(adminDocumentStatusResponseSchema, page.body).find(
        (d) => d.document_id === doc.documentId,
      ),
    ).toMatchObject({
      latest_version_status: 'failed',
      failure_code: 'INDEXING_FAILED',
      batches_done: 1,
      batches_total: 4,
    });

    const args = { p_version_id: doc.versionId };
    expectCode(await rpc(stack, analyst.aal2Token, 'admin_retry_version', args), 'RB033');
    expectCode(await rpc(stack, owner.aal1Token, 'admin_retry_version', args), 'RB032');
    expect(await jobsFor(doc.versionId)).toEqual([]);

    const r = await rpc(stack, owner.aal2Token, 'admin_retry_version', args);
    expectOk(r);
    expect(expectSchema(adminRetryVersionResponseSchema, r.body)).toEqual([
      { version_id: doc.versionId, status: 'uploaded' },
    ]);
    expect(await jobsFor(doc.versionId)).toHaveLength(1);
    const v = rows(
      await svc(
        'GET',
        `/rest/v1/document_versions?id=eq.${doc.versionId}&select=status,failure_code,batches_done`,
      ),
    );
    expect(v[0]).toEqual({ status: 'uploaded', failure_code: null, batches_done: null });
    expectCode(await rpc(stack, owner.aal2Token, 'admin_retry_version', args), 'RB030');
  });

  it('reindex: a new version over the live original is queued; the live version stays active until the worker replaces it', async () => {
    const owner = sessions.get('owner');
    const analyst = sessions.get('analyst');
    if (owner === undefined || analyst === undefined) throw new Error('missing session');
    const doc = await register(owner.aal2Token, { size: 5 });
    expectOk(await upload(owner.aal2Token, doc.path, Buffer.from('12345')));
    expectOk(
      await rpc(stack, owner.aal2Token, 'admin_complete_upload', { p_version_id: doc.versionId }),
    );
    // Stand-in for the worker (service role): version 1 is live.
    rows(
      await svc('PATCH', `/rest/v1/document_versions?id=eq.${doc.versionId}`, { status: 'ready' }),
    );
    rows(
      await svc('PATCH', `/rest/v1/documents?id=eq.${doc.documentId}`, {
        status: 'ready',
        active_version_id: doc.versionId,
      }),
    );

    const args = { p_document_id: doc.documentId };
    expectCode(await rpc(stack, analyst.aal2Token, 'admin_reindex_document', args), 'RB033');
    expectCode(await rpc(stack, owner.aal1Token, 'admin_reindex_document', args), 'RB032');
    const r = await rpc(stack, owner.aal2Token, 'admin_reindex_document', args);
    expectOk(r);
    const [row] = expectSchema(adminReindexDocumentResponseSchema, r.body);
    expect(row?.version_number).toBe(2);

    const d = rows(
      await svc(
        'GET',
        `/rest/v1/documents?id=eq.${doc.documentId}&select=status,active_version_id`,
      ),
    );
    expect(d[0]).toEqual({ status: 'ready', active_version_id: doc.versionId });
    const v2 = rows(
      await svc(
        'GET',
        `/rest/v1/document_versions?id=eq.${row?.version_id}&select=status,storage_path`,
      ),
    );
    expect(v2[0]).toEqual({ status: 'uploaded', storage_path: doc.path }); // same original, nothing copied
    expect(await jobsFor(String(row?.version_id))).toHaveLength(1);
    const page = await rpc(stack, analyst.aal2Token, 'admin_document_status', {
      p_bot_id: botId,
      p_limit: 500,
      p_offset: 0,
    });
    expect(
      expectSchema(adminDocumentStatusResponseSchema, page.body).find(
        (x) => x.document_id === doc.documentId,
      ),
    ).toMatchObject({
      active_version_id: doc.versionId,
      latest_version_id: row?.version_id,
      latest_version_number: 2,
    });
  });

  it('delete document: analyst RB033, admin queues cleanup, a repeat is safe, then it vanishes from the status page', async () => {
    const owner = sessions.get('owner');
    const admin = sessions.get('admin');
    const analyst = sessions.get('analyst');
    if (owner === undefined || admin === undefined || analyst === undefined)
      throw new Error('missing session');
    const doc = await register(owner.aal2Token, { size: 4, title: 'T3 to delete' });
    expectCode(
      await rpc(stack, analyst.aal2Token, 'admin_delete_document', {
        p_document_id: doc.documentId,
      }),
      'RB033',
    );
    const first = await rpc(stack, admin.aal2Token, 'admin_delete_document', {
      p_document_id: doc.documentId,
    });
    expectOk(first);
    expectSchema(adminVoidResponseSchema, first.body);
    const again = await rpc(stack, admin.aal2Token, 'admin_delete_document', {
      p_document_id: doc.documentId,
    });
    expectOk(again);
    const cleanup = rows(
      await svc(
        'GET',
        `/rest/v1/jobs?type=eq.cleanup&payload->>resource_id=eq.${doc.documentId}&select=state,payload`,
      ),
    );
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]?.['payload']).toEqual({
      bot_id: botId,
      scope: 'document',
      resource_id: doc.documentId,
    });
    const status = await rpc(stack, owner.aal2Token, 'admin_document_status', {
      p_bot_id: botId,
      p_limit: 500,
      p_offset: 0,
    });
    expect(
      expectSchema(adminDocumentStatusResponseSchema, status.body).some(
        (d) => d.document_id === doc.documentId,
      ),
    ).toBe(false);
  });

  // Used by the download tests below.
  it('keeps the completed document for the download tests', () => {
    expect(main.path.length).toBeGreaterThan(0);
  });

  describe('(f) download of the completed document', () => {
    it('request-download returns the path for owner and admin and writes an audit row', async () => {
      for (const label of ['owner', 'admin']) {
        const s = sessions.get(label);
        if (s === undefined) throw new Error('missing session');
        const r = await rpc(stack, s.aal2Token, 'admin_request_download', {
          p_version_id: main.versionId,
        });
        expectOk(r);
        expect(expectSchema(adminRequestDownloadResponseSchema, r.body)).toBe(main.path);
      }
      const audit = rows(
        await svc(
          'GET',
          `/rest/v1/audit_logs?action=eq.document.download&resource_id=eq.${main.versionId}&select=actor_user_id,safe_metadata`,
        ),
      );
      expect(audit).toHaveLength(2);
      for (const a of audit)
        expect(Object.keys(a['safe_metadata'] as object).sort()).toEqual([
          'bot_id',
          'document_id',
          'version_id',
        ]);
    });

    it('request-download is refused for analyst (RB033), aal1 (RB032), nonmember and revoked (RB033), anon (42501)', async () => {
      const args = { p_version_id: main.versionId };
      const cases: [string, string][] = [
        ['analyst aal2', 'RB033'],
        ['owner aal1', 'RB032'],
        ['admin aal1', 'RB032'],
        ['nonmember aal2', 'RB033'],
        ['revoked aal2', 'RB033'],
        ['anonymous', '42501'],
      ];
      for (const [pName, code] of cases) {
        const p = principals.find((x) => x.name === pName);
        if (p === undefined) throw new Error('missing principal');
        expectCode(await rpc(stack, p.token, 'admin_request_download', args), code);
      }
    });

    it('owner and admin get a signed URL; the URL and a direct authenticated download both return the bytes', async () => {
      for (const label of ['owner', 'admin']) {
        const s = sessions.get(label);
        if (s === undefined) throw new Error('missing session');
        const signed = await signDownload(s.aal2Token, main.path);
        expectOk(signed);
        const url = signedUrlOf(signed);
        const viaUrl = await fetch(url); // no Authorization header
        expect(viaUrl.status).toBe(200);
        expect(Buffer.from(await viaUrl.arrayBuffer())).toEqual(content);
        const direct = await directDownload(s.aal2Token, main.path);
        expect(direct.status).toBe(200);
        expect(direct.bytes).toEqual(content);
      }
    });

    it('a signed URL is a bearer capability: it works for anyone holding it, until it expires, and only for its own path', async () => {
      const owner = sessions.get('owner');
      if (owner === undefined) throw new Error('missing session');
      const url = signedUrlOf(await signDownload(owner.aal2Token, main.path, 60));
      const anonFetch = await fetch(url, { headers: anonHeaders(stack) });
      expect(anonFetch.status).toBe(200);
      await anonFetch.arrayBuffer();

      const tampered = url.replace('original.txt', 'original2.txt');
      const t = await fetch(tampered);
      expect(t.status).toBeGreaterThanOrEqual(400);
      await t.arrayBuffer();

      const shortLived = signedUrlOf(await signDownload(owner.aal2Token, main.path, 1));
      await new Promise((r) => setTimeout(r, 2500));
      const expired = await fetch(shortLived);
      expect(expired.status).toBeGreaterThanOrEqual(400);
      await expired.arrayBuffer();
    }, 30_000);

    it('signing and direct download are refused for analyst, aal1, nonmember, revoked and anonymous', async () => {
      for (const pName of [
        'analyst aal2',
        'owner aal1',
        'admin aal1',
        'nonmember aal2',
        'revoked aal2',
        'anonymous',
      ]) {
        const p = principals.find((x) => x.name === pName);
        if (p === undefined) throw new Error('missing principal');
        expectRefused(await signDownload(p.token, main.path));
        const d = await directDownload(p.token, main.path);
        expect(['403', '404'], `${pName} direct download (HTTP ${d.status})`).toContain(d.code);
        expect(d.bytes.equals(content)).toBe(false);
      }
    });

    it('signing a path that does not exist fails even for the owner', async () => {
      const owner = sessions.get('owner');
      if (owner === undefined) throw new Error('missing session');
      expectRefused(
        await signDownload(
          owner.aal2Token,
          `${botId}/${randomUUID()}/${randomUUID()}/original.txt`,
        ),
      );
    });

    it('listing the bucket works for owner/admin at aal2 only and nobody can delete or move an object', async () => {
      const list = async (token: string | null): Promise<HttpResult> =>
        readResponse(
          await fetch(`${stack.apiUrl}/storage/v1/object/list/knowledge`, {
            method: 'POST',
            headers: { ...authHeaders(token), 'content-type': 'application/json' },
            body: JSON.stringify({ prefix: botId, limit: 100 }),
          }),
        );
      const owner = sessions.get('owner');
      if (owner === undefined) throw new Error('missing session');
      const asOwner = await list(owner.aal2Token);
      expectOk(asOwner);
      expect((asOwner.body as unknown[]).length).toBeGreaterThan(0);
      for (const pName of ['analyst aal2', 'owner aal1', 'nonmember aal2', 'revoked aal2']) {
        const p = principals.find((x) => x.name === pName);
        if (p === undefined) throw new Error('missing principal');
        const r = await list(p.token);
        if (r.status < 300) expect(r.body).toEqual([]);
        else expectRefused(r, ['403', '404']);
      }

      const del = await readResponse(
        await fetch(`${stack.apiUrl}/storage/v1/object/knowledge/${main.path}`, {
          method: 'DELETE',
          headers: authHeaders(owner.aal2Token),
        }),
      );
      expectRefused(del, ['403', '404']); // no DELETE policy: an object can never be removed from a browser
      expect(await objectBytes(main.path)).toEqual(content);

      const move = await readResponse(
        await fetch(`${stack.apiUrl}/storage/v1/object/move`, {
          method: 'POST',
          headers: { ...authHeaders(owner.aal2Token), 'content-type': 'application/json' },
          body: JSON.stringify({
            bucketId: 'knowledge',
            sourceKey: main.path,
            destinationKey: `${botId}/moved.txt`,
          }),
        }),
      );
      expectRefused(move, ['403', '404']);
      expect(await objectBytes(main.path)).toEqual(content);
    });

    it('a signed UPLOAD URL needs the insert policy: owner gets one for a pending path, analyst and a completed path get none', async () => {
      const owner = sessions.get('owner');
      const analyst = sessions.get('analyst');
      if (owner === undefined || analyst === undefined) throw new Error('missing session');
      const doc = await register(owner.aal2Token, { size: 5 });
      const signUp = async (token: string | null, path: string): Promise<HttpResult> =>
        readResponse(
          await fetch(`${stack.apiUrl}/storage/v1/object/upload/sign/knowledge/${path}`, {
            method: 'POST',
            headers: authHeaders(token),
          }),
        );
      expectRefused(await signUp(analyst.aal2Token, doc.path), ['403']);
      expectRefused(await signUp(owner.aal1Token, doc.path), ['403']);
      expectRefused(await signUp(null, doc.path), ['403']);
      expectRefused(
        await signUp(owner.aal2Token, `${botId}/${randomUUID()}/${randomUUID()}/original.txt`),
        ['403'],
      );
      // The completed document's object already exists: Storage says so (409) before any policy question.
      expectRefused(await signUp(owner.aal2Token, main.path), ['403', '409']);

      const ok = await signUp(owner.aal2Token, doc.path);
      expectOk(ok);
      const url = (ok.body as Record<string, unknown>)['url'];
      expect(typeof url).toBe('string');
      // The signed upload URL is itself a capability: it needs no Authorization header.
      const put = await fetch(
        `${stack.apiUrl}/storage/v1${String(url).replace(/^\/storage\/v1/, '')}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'text/plain', apikey: stack.anonKey },
          body: Buffer.from('12345'),
        },
      );
      await put.arrayBuffer();
      expect(put.status).toBe(200);
      expect(await objectBytes(doc.path)).toEqual(Buffer.from('12345'));
      const done = await rpc(stack, owner.aal2Token, 'admin_complete_upload', {
        p_version_id: doc.versionId,
      });
      expectOk(done);
    });
  });
});

// ---------------------------------------------------------------------------
// (g) Anonymous caller with the publishable key
// ---------------------------------------------------------------------------

describe('anonymous access to the knowledge bucket', () => {
  it('gets nothing: no read, no list, no sign, no upload, no bucket metadata beyond what is public', async () => {
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    const doc = await register(owner.aal2Token, { size: 5, title: 'T3 anon probe' });
    expectOk(await upload(owner.aal2Token, doc.path, Buffer.from('12345')));

    // Each URL form Storage offers for reading.
    const forms = [
      `object/knowledge/${doc.path}`,
      `object/public/knowledge/${doc.path}`,
      `object/authenticated/knowledge/${doc.path}`,
      `object/info/knowledge/${doc.path}`,
      `object/info/authenticated/knowledge/${doc.path}`,
    ];
    for (const f of forms) {
      const res = await fetch(`${stack.apiUrl}/storage/v1/${f}`, { headers: anonHeaders(stack) });
      const text = await res.text();
      expect(res.status, f).toBeGreaterThanOrEqual(400);
      expect(text).not.toContain('12345');
    }

    const list = await readResponse(
      await fetch(`${stack.apiUrl}/storage/v1/object/list/knowledge`, {
        method: 'POST',
        headers: { ...anonHeaders(stack), 'content-type': 'application/json' },
        body: JSON.stringify({ prefix: botId, limit: 100 }),
      }),
    );
    if (list.status < 300) expect(list.body).toEqual([]);
    else expectRefused(list);

    expectRefused(await signDownload(null, doc.path));
    expectRefused(await upload(null, doc.path, Buffer.from('abcde')), ['403', '409']);
    expectRefused(await upload(null, `${botId}/new-file.txt`, Buffer.from('abcde')), ['403']);
    expect(await objectBytes(doc.path)).toEqual(Buffer.from('12345'));

    // Direct table access to storage.objects is not exposed through PostgREST at all.
    const direct = await restGet(null, 'objects?select=name');
    expect(direct.status).toBeGreaterThanOrEqual(400);
  });

  it('a signed-in nonmember at aal2 gets nothing either, on any URL form', async () => {
    const nm = sessions.get('nonmember');
    if (nm === undefined) throw new Error('missing session');
    const doc = await register(sessions.get('owner')?.aal2Token ?? '', {
      size: 5,
      title: 'T3 nonmember probe',
    });
    expectOk(await upload(sessions.get('owner')?.aal2Token ?? '', doc.path, Buffer.from('12345')));
    const d = await directDownload(nm.aal2Token, doc.path);
    expect(['403', '404']).toContain(d.code);
    expectRefused(await signDownload(nm.aal2Token, doc.path));
  });
});

// ---------------------------------------------------------------------------
// (h) Settings round trip
// ---------------------------------------------------------------------------

describe('settings with real sessions', () => {
  const full = {
    display_name: 'T3 Assistant',
    supported_languages: ['en'],
    greeting: 'Hello from the T3 test.',
    primary_color: '#2563eb',
    position: 'bottom-right',
    escalation_label: 'Contact us',
    escalation_messages: { en: 'Please contact us.' },
    tone: 'friendly',
  };
  let version = 0;

  async function settings(token: string, bot = botId): Promise<AdminSettingsRow> {
    const r = await rpc(stack, token, 'admin_get_settings', { p_bot_id: bot });
    expectOk(r);
    const [row] = expectSchema(adminGetSettingsResponseSchema, r.body);
    if (row === undefined) throw new Error('no row');
    return row;
  }

  it('reads before publishing: identity fields, upload limits, no public config yet, version 1', async () => {
    const analyst = sessions.get('analyst');
    if (analyst === undefined) throw new Error('missing session');
    const row = await settings(analyst.aal2Token);
    expect(row).toMatchObject({
      bot_id: botId,
      slug: botSlug,
      enabled: false,
      settings_version: 1,
      max_bytes: 20971520,
      max_pages: 300,
      display_name: null,
      supported_languages: null,
    });
    expect(Object.keys(row)).not.toContain('identity_prompt');
    expect(Object.keys(row)).not.toContain('allowed_origins');
    version = row.settings_version;
  });

  it('the bot list shows the new bot with no display name; the dev bot is listed too', async () => {
    const analyst = sessions.get('analyst');
    if (analyst === undefined) throw new Error('missing session');
    const r = await rpc(stack, analyst.aal2Token, 'admin_list_bots');
    expectOk(r);
    const list = expectSchema(adminListBotsResponseSchema, r.body);
    expect(list.find((b) => b.id === botId)).toMatchObject({
      slug: botSlug,
      display_name: null,
      enabled: false,
    });
    expect(list.some((b) => b.slug === 'dev-bot')).toBe(true);
  });

  it('a first update without display_name and languages is RB035; analyst RB033; aal1 RB032', async () => {
    const owner = sessions.get('owner');
    const analyst = sessions.get('analyst');
    if (owner === undefined || analyst === undefined) throw new Error('missing session');
    const args = {
      p_bot_id: botId,
      p_expected_settings_version: version,
      p_patch: { greeting: 'hi' },
    };
    expectCode(await rpc(stack, owner.aal2Token, 'admin_update_settings', args), 'RB035');
    expectCode(
      await rpc(stack, analyst.aal2Token, 'admin_update_settings', { ...args, p_patch: full }),
      'RB033',
    );
    expectCode(
      await rpc(stack, owner.aal1Token, 'admin_update_settings', { ...args, p_patch: full }),
      'RB032',
    );
  });

  it('unknown keys and invalid values are RB035', async () => {
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    for (const bad of [
      { ...full, identity_prompt: 'x' },
      { ...full, enabled: true },
      { ...full, primary_color: 'blue' },
      { ...full, greeting: '<script>' },
      { ...full, contact_whatsapp_url: 'http://insecure.example.com' },
      {},
    ]) {
      expectCode(
        await rpc(stack, owner.aal2Token, 'admin_update_settings', {
          p_bot_id: botId,
          p_expected_settings_version: version,
          p_patch: bad,
        }),
        'RB035',
      );
    }
    expect((await settings(owner.aal2Token)).settings_version).toBe(version); // nothing changed
  });

  it('a valid first update creates the config and raises the version', async () => {
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    const r = await rpc(stack, owner.aal2Token, 'admin_update_settings', {
      p_bot_id: botId,
      p_expected_settings_version: version,
      p_patch: full,
    });
    expectOk(r);
    const next = expectSchema(adminSettingsVersionResponseSchema, r.body);
    expect(next).toBeGreaterThan(version);
    const row = await settings(owner.aal2Token);
    expect(row).toMatchObject({
      display_name: 'T3 Assistant',
      greeting: 'Hello from the T3 test.',
      tone: 'friendly',
      settings_version: next,
      enabled: false,
    });
    expect(row.supported_languages).toEqual(['en']);
    expect(row.escalation_messages).toEqual({ en: 'Please contact us.' });
  });

  it('a stale version is RB030 and changes nothing', async () => {
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    const before = await settings(owner.aal2Token);
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_update_settings', {
        p_bot_id: botId,
        p_expected_settings_version: version,
        p_patch: { greeting: 'stale' },
      }),
      'RB030',
    );
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_set_bot_enabled', {
        p_bot_id: botId,
        p_expected_settings_version: version,
        p_enabled: false,
      }),
      'RB030',
    );
    expect((await settings(owner.aal2Token)).greeting).toBe(before.greeting);
    version = before.settings_version;
  });

  it('enable gate: no contact channel is RB035; with one it succeeds and the public config is published', async () => {
    const owner = sessions.get('owner');
    const admin = sessions.get('admin');
    const analyst = sessions.get('analyst');
    if (owner === undefined || admin === undefined || analyst === undefined)
      throw new Error('missing session');
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_set_bot_enabled', {
        p_bot_id: botId,
        p_expected_settings_version: version,
        p_enabled: true,
      }),
      'RB035',
    );
    expectCode(
      await rpc(stack, analyst.aal2Token, 'admin_set_bot_enabled', {
        p_bot_id: botId,
        p_expected_settings_version: version,
        p_enabled: true,
      }),
      'RB033',
    );

    const a = await rpc(stack, admin.aal2Token, 'admin_update_settings', {
      p_bot_id: botId,
      p_expected_settings_version: version,
      p_patch: { contact_email: 't3-contact@example.test' },
    });
    expectOk(a);
    version = expectSchema(adminSettingsVersionResponseSchema, a.body);

    const anonBefore = await restGet(
      null,
      `public_bot_config?bot_slug=eq.${botSlug}&select=bot_slug`,
    );
    expectOk(anonBefore);
    expect(anonBefore.body).toEqual([]); // not published yet

    const e = await rpc(stack, admin.aal2Token, 'admin_set_bot_enabled', {
      p_bot_id: botId,
      p_expected_settings_version: version,
      p_enabled: true,
    });
    expectOk(e);
    version = expectSchema(adminSettingsVersionResponseSchema, e.body);
    expect((await settings(owner.aal2Token)).enabled).toBe(true);

    const anonAfter = await restGet(
      null,
      `public_bot_config?bot_slug=eq.${botSlug}&select=bot_slug,display_name`,
    );
    expectOk(anonAfter);
    expect(anonAfter.body).toEqual([{ bot_slug: botSlug, display_name: 'T3 Assistant' }]);
  });

  it('while enabled, a change that removes the last contact channel or an escalation message is RB035 and rolled back', async () => {
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_update_settings', {
        p_bot_id: botId,
        p_expected_settings_version: version,
        p_patch: { contact_email: null },
      }),
      'RB035',
    );
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_update_settings', {
        p_bot_id: botId,
        p_expected_settings_version: version,
        p_patch: { supported_languages: ['en', 'fr'] },
      }),
      'RB035',
    );
    const row = await settings(owner.aal2Token);
    expect(row.contact_email).toBe('t3-contact@example.test');
    expect(row.settings_version).toBe(version);
  });

  it('the audit rows for settings hold field names and versions, never values', async () => {
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    const r = await restGet(
      owner.aal2Token,
      `audit_logs?action=eq.settings.update&resource_id=eq.${botId}&select=safe_metadata,actor_user_id`,
    );
    expectOk(r);
    const list = r.body as { safe_metadata: Record<string, unknown> }[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    const text = JSON.stringify(list);
    expect(text).not.toContain('T3 Assistant');
    expect(text).not.toContain('t3-contact@example.test');
    for (const a of list)
      expect(Object.keys(a.safe_metadata).sort()).toEqual([
        'bot_id',
        'changed_fields',
        'expected_settings_version',
        'settings_version',
      ]);
  });

  // The seeded dev bot stores business_hours in the public contract shape ({"mon-fri": "09:00-17:00"}) and its
  // allowed_languages equal its supported_languages, so the merged-result gate passes for it. Saving a value
  // it already has changes nothing.
  it('an owner can save the seeded dev-bot settings unchanged (seed business_hours shape)', async () => {
    const owner = sessions.get('owner');
    if (owner === undefined) throw new Error('missing session');
    const dev = '00000000-0000-4000-8000-0000000000b1';
    const row = await settings(owner.aal2Token, dev);
    expect(row.greeting).not.toBeNull();
    const r = await rpc(stack, owner.aal2Token, 'admin_update_settings', {
      p_bot_id: dev,
      p_expected_settings_version: row.settings_version,
      p_patch: { greeting: row.greeting },
    });
    expectOk(r);
  });

  it('disable works, and members list shows the five test accounts with labels for owner and admin only', async () => {
    const admin = sessions.get('admin');
    const analyst = sessions.get('analyst');
    if (admin === undefined || analyst === undefined) throw new Error('missing session');
    const d = await rpc(stack, admin.aal2Token, 'admin_set_bot_enabled', {
      p_bot_id: botId,
      p_expected_settings_version: version,
      p_enabled: false,
    });
    expectOk(d);
    version = expectSchema(adminSettingsVersionResponseSchema, d.body);

    const m = await rpc(stack, admin.aal2Token, 'admin_list_members');
    expectOk(m);
    const members = expectSchema(adminListMembersResponseSchema, m.body);
    for (const label of ['owner', 'admin', 'analyst', 'revoked']) {
      const s = sessions.get(label);
      expect(members.find((x) => x.user_id === s?.userId)).toMatchObject({ label: s?.email });
    }
    expect(members.find((x) => x.user_id === sessions.get('revoked')?.userId)?.active).toBe(false);
    expect(members.some((x) => x.user_id === sessions.get('nonmember')?.userId)).toBe(false);
    expectCode(await rpc(stack, analyst.aal2Token, 'admin_list_members'), 'RB033');
  });
});

// ---------------------------------------------------------------------------
// Conversation delete
// ---------------------------------------------------------------------------

describe('conversation delete with real sessions', () => {
  it('analyst RB033, aal1 RB032, owner deletes the conversation and its messages; a repeat is RB037', async () => {
    const owner = sessions.get('owner');
    const analyst = sessions.get('analyst');
    if (owner === undefined || analyst === undefined) throw new Error('missing session');
    const args = { p_conversation_id: secondConversationId };
    expectCode(await rpc(stack, analyst.aal2Token, 'admin_delete_conversation', args), 'RB033');
    expectCode(await rpc(stack, owner.aal1Token, 'admin_delete_conversation', args), 'RB032');
    const r = await rpc(stack, owner.aal2Token, 'admin_delete_conversation', args);
    expectOk(r);
    expectSchema(adminVoidResponseSchema, r.body);
    expect(
      rows(await svc('GET', `/rest/v1/conversations?id=eq.${secondConversationId}&select=id`)),
    ).toEqual([]);
    expect(
      rows(
        await svc('GET', `/rest/v1/messages?conversation_id=eq.${secondConversationId}&select=id`),
      ),
    ).toEqual([]);
    expect(
      rows(await svc('GET', `/rest/v1/messages?conversation_id=eq.${conversationId}&select=id`)),
    ).toHaveLength(3);
    expectCode(await rpc(stack, owner.aal2Token, 'admin_delete_conversation', args), 'RB037');
  });
});

// ---------------------------------------------------------------------------
// Debug cycle P35-D1: seed, job payloads, write quota, Storage visibility, analyst reads, budget attempts
// ---------------------------------------------------------------------------

const DEV_BOT = '00000000-0000-4000-8000-0000000000b1';

/** Runs SQL as the database owner inside the LOCAL DB container (psql on stdin). Local stack only. */
function localSql(sql: string): string {
  const config = readFileSync(
    fileURLToPath(new URL('../../supabase/config.toml', import.meta.url)),
    'utf8',
  );
  const m = /^project_id\s*=\s*"([^"]+)"/m.exec(config);
  if (!m) throw new Error('no project_id in supabase/config.toml');
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      `supabase_db_${m[1]}`,
      'psql',
      '-U',
      'postgres',
      '-X',
      '-q',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      '-',
    ],
    { input: sql, encoding: 'utf8', timeout: 60_000 },
  ).trim();
}

/** A private bot with a settings row; `quotas` is the upload_policy.quotas object. */
async function makeBot(label: string, quotas: Record<string, unknown>): Promise<string> {
  const [bot] = rows(
    await svc('POST', '/rest/v1/bot_profiles', {
      slug: `t3-${label}-${RUN}`,
      identity_prompt: 'T3 TEST PLACEHOLDER',
      allowed_languages: ['en'],
      embedding_model: 'gemini-embedding-001',
      embedding_dimensions: 1536,
    }),
  );
  const id = String(bot?.['id']);
  extraBotIds.push(id);
  rows(
    await svc('POST', '/rest/v1/client_settings', {
      bot_id: id,
      allowed_origins: ['http://localhost:3000'],
      rate_policy: { concurrent_requests_per_session: 1 },
      budget_policy: { daily_cap_usd: 5 },
      retention_policy: { conversation_days: 90, usage_months: 13 },
      upload_policy: {
        max_bytes: 20971520,
        max_pages: 300,
        index_max_attempts: 3,
        cleanup_max_attempts: 3,
        quotas,
      },
      handoff_policy: {},
      cache_policy: {},
    }),
  );
  return id;
}

async function addConversation(bot: string): Promise<string> {
  const [conv] = rows(await svc('POST', '/rest/v1/conversations', { bot_id: bot }));
  return String(conv?.['id']);
}

function session(name: string): TestSession {
  const s = sessions.get(name);
  if (s === undefined) throw new Error(`missing session ${name}`);
  return s;
}

describe('the seeded dev bot (C-2)', () => {
  it('passes the publish gate, and its public config parses with the widget schema', async () => {
    expect(
      localSql(`select coalesce(public.admin_settings_gate_error('${DEV_BOT}'), '<ok>');`),
    ).toBe('<ok>');
    const r = await svc('GET', `/rest/v1/public_bot_config?bot_id=eq.${DEV_BOT}&select=*`);
    const [row] = rows(r);
    if (row === undefined) throw new Error('the seeded dev bot has no public config row');
    const parsed = publicBotConfigSchema.safeParse(row);
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues)).toBe(true);
    expect(row['business_hours']).toEqual({ 'mon-fri': '09:00-17:00' });
    const bot = rows(
      await svc('GET', `/rest/v1/bot_profiles?id=eq.${DEV_BOT}&select=allowed_languages`),
    )[0];
    expect(bot?.['allowed_languages']).toEqual(row['supported_languages']);
  });

  it('the seeded dev bot has a write quota', () => {
    expect(
      localSql(
        `select upload_policy -> 'quotas' -> 'write' ->> 'limit' from public.client_settings where bot_id = '${DEV_BOT}';`,
      ),
    ).toMatch(/^[1-9][0-9]*$/);
  });
});

describe('job payloads written by SQL parse with the shared job schema (C-11)', () => {
  it('index_document (complete upload) and cleanup (delete document) payloads', async () => {
    const owner = session('owner');
    const doc = await register(owner.aal2Token, { size: 3 });
    expectOk(await upload(owner.aal2Token, doc.path, Buffer.from('abc')));
    expectOk(
      await rpc(stack, owner.aal2Token, 'admin_complete_upload', { p_version_id: doc.versionId }),
    );
    const [index] = await jobsFor(doc.versionId);
    if (index === undefined) throw new Error('no index job');
    const parsedIndex = jobSchema.safeParse({ type: index['type'], payload: index['payload'] });
    expect(
      parsedIndex.success,
      JSON.stringify(parsedIndex.success ? [] : parsedIndex.error.issues),
    ).toBe(true);
    expect(index['payload']).toEqual({
      bot_id: botId,
      document_id: doc.documentId,
      version_id: doc.versionId,
    });

    expectOk(
      await rpc(stack, owner.aal2Token, 'admin_delete_document', { p_document_id: doc.documentId }),
    );
    // The queued index job is cancelled by the delete (S-12), the cleanup job is queued and has the contract shape.
    expect(
      rows(await svc('GET', `/rest/v1/jobs?id=eq.${String(index['id'])}&select=state`))[0]?.[
        'state'
      ],
    ).toBe('cancelled');
    const [cleanup] = rows(
      await svc(
        'GET',
        `/rest/v1/jobs?dedupe_key=eq.cleanup:document:${doc.documentId}&select=type,state,payload`,
      ),
    );
    if (cleanup === undefined) throw new Error('no cleanup job');
    expect(cleanup['state']).toBe('queued');
    const parsedCleanup = jobSchema.safeParse({
      type: cleanup['type'],
      payload: cleanup['payload'],
    });
    expect(
      parsedCleanup.success,
      JSON.stringify(parsedCleanup.success ? [] : parsedCleanup.error.issues),
    ).toBe(true);
    expect(cleanup['payload']).toEqual({
      bot_id: botId,
      scope: 'document',
      resource_id: doc.documentId,
    });

    // A repeat is a no-op: no second job, no second audit row.
    const auditBefore = rows(
      await svc(
        'GET',
        `/rest/v1/audit_logs?action=eq.document.delete&resource_id=eq.${doc.documentId}&select=id`,
      ),
    );
    expectOk(
      await rpc(stack, owner.aal2Token, 'admin_delete_document', { p_document_id: doc.documentId }),
    );
    expect(
      rows(
        await svc(
          'GET',
          `/rest/v1/audit_logs?action=eq.document.delete&resource_id=eq.${doc.documentId}&select=id`,
        ),
      ),
    ).toHaveLength(auditBefore.length);
    expect(
      rows(await svc('GET', `/rest/v1/jobs?payload->>resource_id=eq.${doc.documentId}&select=id`)),
    ).toHaveLength(1);
  });

  it('the analyze_conversation job of a deleted conversation is cancelled', async () => {
    const owner = session('owner');
    const conv = await addConversation(botId);
    rows(
      await svc('POST', '/rest/v1/jobs', {
        type: 'analyze_conversation',
        payload: { bot_id: botId, conversation_id: conv },
        max_attempts: 3,
      }),
    );
    const [job] = rows(
      await svc('GET', `/rest/v1/jobs?payload->>conversation_id=eq.${conv}&select=id,type,payload`),
    );
    if (job === undefined) throw new Error('no analysis job');
    expect(jobSchema.safeParse({ type: job['type'], payload: job['payload'] }).success).toBe(true);
    expectOk(
      await rpc(stack, owner.aal2Token, 'admin_delete_conversation', { p_conversation_id: conv }),
    );
    expect(
      rows(await svc('GET', `/rest/v1/jobs?id=eq.${String(job['id'])}&select=state`))[0]?.['state'],
    ).toBe('cancelled');
  });
});

describe('the write quota over HTTP (RB034 and RB036)', () => {
  it('a bot with no write quota fails closed (RB036) on every write function, and nothing changes', async () => {
    const owner = session('owner');
    const bot = await makeBot('nowrite', {
      register: { limit: 50, window_seconds: 3600 },
      upload: { limit: 50, window_seconds: 3600 },
      reindex: { limit: 50, window_seconds: 3600 },
    });
    const conv = await addConversation(bot);
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_delete_conversation', { p_conversation_id: conv }),
      'RB036',
    );
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_update_settings', {
        p_bot_id: bot,
        p_expected_settings_version: 1,
        p_patch: { display_name: 'No write quota', supported_languages: ['en'] },
      }),
      'RB036',
    );
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_set_bot_enabled', {
        p_bot_id: bot,
        p_expected_settings_version: 1,
        p_enabled: true,
      }),
      'RB036',
    );
    // A document of this bot: register works (it has a register quota); download and delete need the write quota.
    const r = await rpc(stack, owner.aal2Token, 'admin_register_document', {
      p_bot_id: bot,
      p_title: 'T3 no write quota',
      p_media_type: 'text/plain',
      p_byte_size: 3,
      p_disclosure_policy: 'excluded',
    });
    expectOk(r);
    const [reg] = expectSchema(adminRegisterDocumentResponseSchema, r.body);
    if (reg === undefined) throw new Error('no row');
    objectPaths.push(reg.storage_path);
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_request_download', { p_version_id: reg.version_id }),
      'RB036',
    );
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_delete_document', {
        p_document_id: reg.document_id,
      }),
      'RB036',
    );
    expect(rows(await svc('GET', `/rest/v1/conversations?id=eq.${conv}&select=id`))).toHaveLength(
      1,
    );
    expect(
      rows(await svc('GET', `/rest/v1/documents?id=eq.${reg.document_id}&select=deleted_at`))[0]?.[
        'deleted_at'
      ],
    ).toBeNull();
    expect(
      rows(await svc('GET', `/rest/v1/public_bot_config?bot_id=eq.${bot}&select=bot_id`)),
    ).toEqual([]);
  });

  it('the write quota is counted per bot and refuses at the limit with RB034; register has its own', async () => {
    const owner = session('owner');
    const bot = await makeBot('quota', {
      register: { limit: 1, window_seconds: 3600 },
      upload: { limit: 50, window_seconds: 3600 },
      reindex: { limit: 50, window_seconds: 3600 },
      write: { limit: 1, window_seconds: 3600 },
    });
    const first = await addConversation(bot);
    const second = await addConversation(bot);
    expectOk(
      await rpc(stack, owner.aal2Token, 'admin_delete_conversation', { p_conversation_id: first }),
    );
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_delete_conversation', { p_conversation_id: second }),
      'RB034',
    );
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_update_settings', {
        p_bot_id: bot,
        p_expected_settings_version: 1,
        p_patch: { display_name: 'Over the limit', supported_languages: ['en'] },
      }),
      'RB034',
    );
    expect(rows(await svc('GET', `/rest/v1/conversations?id=eq.${second}&select=id`))).toHaveLength(
      1,
    );
    // The dev bot's write counter is not touched by this bot's calls.
    const args = {
      p_bot_id: bot,
      p_title: 'T3 register quota',
      p_media_type: 'text/plain',
      p_byte_size: 3,
      p_disclosure_policy: 'excluded',
    };
    const ok = await rpc(stack, owner.aal2Token, 'admin_register_document', args);
    expectOk(ok);
    const [reg] = expectSchema(adminRegisterDocumentResponseSchema, ok.body);
    if (reg !== undefined) objectPaths.push(reg.storage_path);
    expectCode(await rpc(stack, owner.aal2Token, 'admin_register_document', args), 'RB034');
  });
});

describe('Storage visibility follows the documents (S-5)', () => {
  it('a member can upload to a pending path, sign a download of it and see it until the document is deleted', async () => {
    const owner = session('owner');
    const admin = session('admin');
    const doc = await register(owner.aal2Token, { size: 5 });
    // The upload (an INSERT ... RETURNING) needs the SELECT policy too: the new row must be visible to its uploader.
    expectOk(await upload(owner.aal2Token, doc.path, Buffer.from('hello')));
    expectOk(await signDownload(owner.aal2Token, doc.path));
    expectOk(await signDownload(admin.aal2Token, doc.path));
    expect((await directDownload(owner.aal2Token, doc.path)).status).toBe(200);
    expectOk(
      await rpc(stack, owner.aal2Token, 'admin_complete_upload', { p_version_id: doc.versionId }),
    );
    expectOk(await signDownload(owner.aal2Token, doc.path));

    expectOk(
      await rpc(stack, admin.aal2Token, 'admin_delete_document', { p_document_id: doc.documentId }),
    );
    // The object is still in Storage (P6 cleans it up), but members can no longer see or sign it.
    expect(await objectExists(doc.path)).toBe(true);
    expectRefused(await signDownload(owner.aal2Token, doc.path));
    expectRefused(await signDownload(admin.aal2Token, doc.path));
    expect((await directDownload(owner.aal2Token, doc.path)).status).toBeGreaterThanOrEqual(400);
  });

  it('an object that no version owns is hidden from members, though it exists', async () => {
    const owner = session('owner');
    const orphan = `${botId}/${randomUUID()}/${randomUUID()}/original.txt`;
    objectPaths.push(orphan);
    const put = await readResponse(
      await fetch(`${stack.apiUrl}/storage/v1/object/knowledge/${orphan}`, {
        method: 'POST',
        headers: { ...keyHeaders(key), 'content-type': 'text/plain' },
        body: new Uint8Array(Buffer.from('orphan')),
      }),
    );
    expectOk(put);
    expect(await objectExists(orphan)).toBe(true);
    expectRefused(await signDownload(owner.aal2Token, orphan));
    expect((await directDownload(owner.aal2Token, orphan)).status).toBeGreaterThanOrEqual(400);
  });
});

describe('upload type and eTag at complete (S-7)', () => {
  it('a file whose content type differs from the registered media type is RB030; a matching one stores its eTag', async () => {
    const owner = session('owner');
    const wrong = await register(owner.aal2Token, { size: 4, mediaType: 'text/plain' });
    expectOk(await upload(owner.aal2Token, wrong.path, Buffer.from('# hi'), 'text/markdown'));
    expectCode(
      await rpc(stack, owner.aal2Token, 'admin_complete_upload', { p_version_id: wrong.versionId }),
      'RB030',
    );
    expect(
      rows(
        await svc(
          'GET',
          `/rest/v1/document_versions?id=eq.${wrong.versionId}&select=status,upload_etag`,
        ),
      )[0],
    ).toEqual({
      status: 'pending_upload',
      upload_etag: null,
    });
    expect(await jobsFor(wrong.versionId)).toEqual([]);

    const good = await register(owner.aal2Token, { size: 4, mediaType: 'text/markdown' });
    expectOk(await upload(owner.aal2Token, good.path, Buffer.from('# hi'), 'text/markdown'));
    expectOk(
      await rpc(stack, owner.aal2Token, 'admin_complete_upload', { p_version_id: good.versionId }),
    );
    const etag = rows(
      await svc('GET', `/rest/v1/document_versions?id=eq.${good.versionId}&select=upload_etag`),
    )[0]?.['upload_etag'];
    expect(typeof etag === 'string' && etag.length > 0).toBe(true);
  });
});

describe('analyst reads of message_sources and conversation_analysis', () => {
  it('an analyst at aal2 reads both; aal1, nonmember and anonymous do not', async () => {
    const conv = await addConversation(botId);
    const [msg] = rows(
      await svc('POST', '/rest/v1/messages', {
        conversation_id: conv,
        role: 'assistant',
        content: 'T3 fake assistant answer',
      }),
    );
    const messageId = String(msg?.['id']);
    rows(
      await svc('POST', '/rest/v1/message_sources', {
        message_id: messageId,
        source_label: 'T3 source',
        excerpt: 'T3 fake excerpt',
      }),
    );
    rows(
      await svc('POST', '/rest/v1/conversation_analysis', {
        conversation_id: conv,
        summary: 'T3 fake summary',
      }),
    );
    const sources = `message_sources?message_id=eq.${messageId}&select=source_label`;
    const analysis = `conversation_analysis?conversation_id=eq.${conv}&select=summary`;
    for (const who of ['analyst aal2', 'admin aal2', 'owner aal2']) {
      const pr = principals.find((x) => x.name === who);
      if (pr === undefined) throw new Error('missing principal');
      const a = await restGet(pr.token, sources);
      expectOk(a);
      expect(a.body, who).toEqual([{ source_label: 'T3 source' }]);
      const b = await restGet(pr.token, analysis);
      expectOk(b);
      expect(b.body, who).toEqual([{ summary: 'T3 fake summary' }]);
    }
    for (const who of ['analyst aal1', 'owner aal1', 'nonmember aal2', 'revoked aal2']) {
      const pr = principals.find((x) => x.name === who);
      if (pr === undefined) throw new Error('missing principal');
      for (const q of [sources, analysis]) {
        const r = await restGet(pr.token, q);
        expectOk(r);
        expect(r.body, `${who} ${q}`).toEqual([]);
      }
    }
    for (const q of [sources, analysis]) {
      const r = await restGet(null, q);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(sqlstateOf(r)).toBe('42501');
    }
    // Later cases count the bot's conversations: remove this one (messages, sources and analysis cascade).
    expectOk(await svc('DELETE', `/rest/v1/conversations?id=eq.${conv}`));
  });
});

describe('job budget across attempts through SQL (S-1, C-1)', () => {
  async function reserveJob(bot: string, job: string, amount: number): Promise<HttpResult> {
    return svc('POST', '/rest/v1/rpc/reserve_job_budget', {
      p_bot_id: bot,
      p_job_id: job,
      p_amount: amount,
      p_ttl_seconds: 3600,
    });
  }
  const setJob = (id: string, state: string) =>
    svc('PATCH', `/rest/v1/jobs?id=eq.${id}`, {
      state,
      ...(state === 'queued' ? { locked_by: null, locked_until: null } : {}),
    });

  it('reserve, release, requeue, reserve works; a settled attempt counts toward the cap; a repeat is idempotent', async () => {
    const bot = await makeBot('budget', { write: { limit: 5, window_seconds: 3600 } }); // cap 5.0
    const [job] = rows(
      await svc('POST', '/rest/v1/jobs', {
        type: 'index_document',
        payload: { bot_id: bot },
        state: 'running',
        max_attempts: 3,
      }),
    );
    const jobId = String(job?.['id']);

    const r1 = await reserveJob(bot, jobId, 1);
    expectOk(r1);
    const id1 = String(r1.body);
    const repeat = await reserveJob(bot, jobId, 1);
    expectOk(repeat);
    expect(String(repeat.body)).toBe(id1);

    expectOk(
      await svc('POST', '/rest/v1/rpc/release_budget_reservation', {
        p_bot_id: bot,
        p_reservation_id: id1,
      }),
    );
    expectOk(await setJob(jobId, 'queued'));
    expectCode(await reserveJob(bot, jobId, 1), 'RB004'); // a queued job cannot reserve
    expectOk(await setJob(jobId, 'running'));
    const r2 = await reserveJob(bot, jobId, 1);
    expectOk(r2);
    const id2 = String(r2.body);
    expect(id2).not.toBe(id1);

    // Attempt 2 settles 4.5; attempt 3 may add at most 0.5 under the 5.0 cap.
    expectOk(
      await svc('POST', '/rest/v1/rpc/settle_budget_reservation', {
        p_bot_id: bot,
        p_reservation_id: id2,
        p_actual_amount: 4.5,
      }),
    );
    expectOk(await setJob(jobId, 'queued'));
    expectOk(await setJob(jobId, 'running'));
    expectCode(await reserveJob(bot, jobId, 0.6), 'RB001');
    const r3 = await reserveJob(bot, jobId, 0.5);
    expectOk(r3);
    const states = rows(
      await svc(
        'GET',
        `/rest/v1/budget_reservations?job_id=eq.${jobId}&select=state&order=created_at`,
      ),
    )
      .map((x) => x['state'])
      .sort();
    expect(states).toEqual(['released', 'reserved', 'settled']);
  });
});

// ---------------------------------------------------------------------------
// (d) Revocation
// ---------------------------------------------------------------------------

describe('revocation takes effect at once for a still-valid aal2 token', () => {
  it('works before, is refused everywhere after the membership is deactivated, and works again once reactivated', async () => {
    const s = sessions.get('torevoke');
    const owner = sessions.get('owner');
    if (s === undefined || owner === undefined) throw new Error('missing session');
    const doc = await register(owner.aal2Token, { size: 3 });
    expectOk(await upload(owner.aal2Token, doc.path, Buffer.from('abc')));

    const claims = decodeJwtClaims(s.aal2Token);
    expect(claims['aal']).toBe('aal2');
    expect(Number(claims['exp'])).toBeGreaterThan(Date.now() / 1000 + 60);

    const probe = async (): Promise<{
      rpc: HttpResult;
      read: HttpResult;
      sign: HttpResult;
      up: HttpResult;
      down: { status: number; code: string | null };
    }> => ({
      rpc: await rpc(stack, s.aal2Token, 'admin_list_members'),
      read: await restGet(s.aal2Token, `conversations?bot_id=eq.${botId}&select=id`),
      sign: await signDownload(s.aal2Token, doc.path),
      up: await upload(
        s.aal2Token,
        `${botId}/${randomUUID()}/${randomUUID()}/original.txt`,
        Buffer.from('x'),
      ),
      down: await directDownload(s.aal2Token, doc.path),
    });

    const before = await probe();
    expectOk(before.rpc);
    expect((before.read.body as unknown[]).length).toBe(1); // the second conversation is deleted
    expectOk(before.sign);
    expect(before.down.status).toBe(200);
    expectRefused(before.up, ['403']); // the random path is not a registered version, so refused even for a member

    rows(
      await svc('PATCH', `/rest/v1/admin_memberships?user_id=eq.${s.userId}`, { active: false }),
    );
    const after = await probe();
    expectCode(after.rpc, 'RB033');
    expect(after.read.body).toEqual([]);
    expectRefused(after.sign);
    expect(['403', '404']).toContain(after.down.code);
    expectRefused(after.up, ['403']);
    for (const name of [
      'admin_register_document',
      'admin_update_settings',
      'admin_request_download',
    ]) {
      const args =
        name === 'admin_register_document'
          ? {
              p_bot_id: botId,
              p_title: 'x',
              p_media_type: 'text/plain',
              p_byte_size: 1,
              p_disclosure_policy: 'excluded',
            }
          : name === 'admin_update_settings'
            ? { p_bot_id: botId, p_expected_settings_version: 1, p_patch: { greeting: 'x' } }
            : { p_version_id: doc.versionId };
      expectCode(await rpc(stack, s.aal2Token, name, args), 'RB033');
    }

    // The token itself is still valid: schema_version needs only a signed-in user.
    expectOk(await rpc(stack, s.aal2Token, 'schema_version'));

    rows(await svc('PATCH', `/rest/v1/admin_memberships?user_id=eq.${s.userId}`, { active: true }));
    expectOk((await probe()).rpc);
  });
});

// ---------------------------------------------------------------------------
// B-14: scripts/seed-test-users.mjs refuses unsafe input before making any request
// ---------------------------------------------------------------------------

describe('seed-test-users.mjs refuses unsafe input', () => {
  const SCRIPT = fileURLToPath(new URL('../../scripts/seed-test-users.mjs', import.meta.url));
  const GOOD_PASSWORD = randomBytes(18).toString('base64url');

  function run(env: Record<string, string | undefined>, args: string[] = []) {
    const clean: Record<string, string> = { PATH: process.env['PATH'] ?? '' };
    for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      env: clean,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  const local = {
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SECRET_KEY: 'placeholder-key',
    SEED_TEST_PASSWORD: GOOD_PASSWORD,
  };

  it('stops with exit 2 when the password variable is missing or empty (no default password)', () => {
    for (const v of [undefined, '']) {
      const r = run({ ...local, SEED_TEST_PASSWORD: v });
      expect(r.status).toBe(2);
      expect(r.out).toContain('SEED_TEST_PASSWORD is not set');
    }
  });

  it('stops when the password is shorter than 12 characters, or the URL or key is missing', () => {
    expect(run({ ...local, SEED_TEST_PASSWORD: 'short' }).status).toBe(2);
    expect(run({ ...local, SUPABASE_URL: undefined }).out).toContain('SUPABASE_URL is not set');
    expect(run({ ...local, SUPABASE_SECRET_KEY: undefined }).out).toContain(
      'SUPABASE_SECRET_KEY is not set',
    );
  });

  it.each([
    'https://abcdefghijklmnopqrst.supabase.co',
    'http://example.com',
    'http://10.0.0.5:54321',
    'http://127.0.0.1.evil.example:54321',
    'http://localhost.evil.example',
  ])('refuses the non-loopback URL %s and never prints the key or password', (url) => {
    const r = run({ ...local, SUPABASE_URL: url });
    expect(r.status).toBe(2);
    expect(r.out).toContain('not a loopback address');
    expect(r.out).not.toContain('placeholder-key');
    expect(r.out).not.toContain(GOOD_PASSWORD);
  });

  it('takes no arguments (no flag can turn the loopback check off)', () => {
    const r = run(local, ['--confirm-project', 'abcdefghijklmnopqrst']);
    expect(r.status).toBe(2);
    expect(r.out).toContain('takes no arguments');
  });
});
