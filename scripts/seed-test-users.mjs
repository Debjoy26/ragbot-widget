#!/usr/bin/env node
// TEST FIXTURE FOR THE LOCAL STACK ONLY (B-13 to B-15, P3.5). Creates five accounts for trying the admin
// panel by hand, plus a few sample rows. It is NEVER applied to a client project: it refuses every URL that
// is not a loopback address, there is no flag to override that, and it must not be added to any deploy step.
//
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SECRET_KEY=<local secret key> \
//     SEED_TEST_PASSWORD=<at least 12 characters> node scripts/seed-test-users.mjs
//
// Accounts (all @example.test, confirmed, same password from SEED_TEST_PASSWORD):
//   seed-owner, seed-admin, seed-analyst  active members with that role
//   seed-revoked                          an admin membership that is inactive
//   seed-nonmember                        a signed-in user with no membership at all
// Sample rows on the seeded dev bot (tagged "[seed]", added only when missing): one open conversation with
// a visitor message, an assistant reply and a system row; documents in the states pending_upload,
// uploaded and failed (OCR_REQUIRED). No Storage objects are created, so uploaded files do not exist.
// TOTP is not enrolled: enrol it from each account's first sign-in, or the panel shows nothing.
//
// Rules:
//   * SUPABASE_URL, SUPABASE_SECRET_KEY and SEED_TEST_PASSWORD come from the environment only. Any one
//     missing or empty: stop with a clear error (no default password).
//   * The script prints email addresses only. Never the key, the password, a token or a response body.
//   * Safe to run again: existing users are reused (their password is set to the current
//     SEED_TEST_PASSWORD), memberships are set to the role above, sample rows are not duplicated.
// Exit status: 0 done, 1 failed, 2 bad usage or missing configuration.

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEV_BOT_ID = '00000000-0000-4000-8000-0000000000b1';
const TIMEOUT_MS = 20_000;
const MAX_USER_PAGES = 50;
const PER_PAGE = 200;
const MIN_PASSWORD_LENGTH = 12;

const ACCOUNTS = [
  { name: 'seed-owner', role: 'owner', active: true },
  { name: 'seed-admin', role: 'admin', active: true },
  { name: 'seed-analyst', role: 'analyst', active: true },
  { name: 'seed-revoked', role: 'admin', active: false },
  { name: 'seed-nonmember', role: null, active: false },
];

function usage(message) {
  console.error(`seed-test-users: ${message}`);
  console.error(
    'usage: SUPABASE_URL=<local url> SUPABASE_SECRET_KEY=<local key> SEED_TEST_PASSWORD=<12+ chars> node scripts/seed-test-users.mjs',
  );
  process.exit(2);
}

function fail(message) {
  console.error(`seed-test-users: ${message}`);
  process.exit(1);
}

if (process.argv.length > 2) usage('this script takes no arguments');

const rawUrl = process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const password = process.env.SEED_TEST_PASSWORD;
if (!rawUrl) usage('SUPABASE_URL is not set');
if (!secretKey) usage('SUPABASE_SECRET_KEY is not set');
if (!password) usage('SEED_TEST_PASSWORD is not set (there is no default password)');
if (password.length < MIN_PASSWORD_LENGTH) {
  usage(`SEED_TEST_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
}

let base;
try {
  base = new URL(rawUrl);
} catch {
  usage('SUPABASE_URL is not a valid URL');
}
if (!LOOPBACK.has(base.hostname)) {
  usage(
    'refusing to run: SUPABASE_URL is not a loopback address. This script is for the local stack only',
  );
}
if (base.protocol !== 'http:' && base.protocol !== 'https:')
  usage('SUPABASE_URL must be http or https');
if (
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  !['', '/'].includes(base.pathname)
) {
  usage('SUPABASE_URL must be a plain origin with no credentials, path or query');
}
const origin = base.origin;

// The legacy service key is a JWT and is also the bearer token; a new-style secret key goes in apikey only.
const authHeaders = { apikey: secretKey };
if (secretKey.split('.').length === 3) authHeaders.authorization = `Bearer ${secretKey}`;

/** Calls the API. Returns { status, body } with body parsed JSON or null. Never logs a body. */
async function call(method, path, json, extraHeaders = {}) {
  let res;
  try {
    res = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...authHeaders,
        ...extraHeaders,
        ...(json === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    fail(`could not reach the local stack (${method} ${path.split('?')[0]})`);
  }
  let body;
  try {
    const text = await res.text();
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** A short, fixed-vocabulary reason for an error response; never free text from the server. */
function reason(r) {
  const code =
    r.body && typeof r.body === 'object' ? (r.body.error_code ?? r.body.code) : undefined;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code)
    ? `${r.status} ${code}`
    : `${r.status}`;
}

function okStatus(r) {
  return r.status >= 200 && r.status < 300;
}

async function findUserId(address) {
  for (let page = 1; page <= MAX_USER_PAGES; page += 1) {
    const r = await call('GET', `/auth/v1/admin/users?page=${page}&per_page=${PER_PAGE}`);
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.users)) {
      fail(`could not list users (${reason(r)})`);
    }
    for (const u of r.body.users) {
      if (
        typeof u.email === 'string' &&
        u.email.toLowerCase() === address &&
        UUID_PATTERN.test(u.id)
      ) {
        return u.id;
      }
    }
    if (r.body.users.length < PER_PAGE) return null;
  }
  fail('too many users to search; stopping instead of guessing');
}

async function ensureUser(email) {
  const existing = await findUserId(email);
  if (existing !== null) {
    const r = await call('PUT', `/auth/v1/admin/users/${existing}`, {
      password,
      email_confirm: true,
    });
    if (!okStatus(r)) fail(`could not update ${email} (${reason(r)})`);
    return existing;
  }
  const r = await call('POST', '/auth/v1/admin/users', { email, password, email_confirm: true });
  if (!okStatus(r) || !r.body || !UUID_PATTERN.test(r.body.id)) {
    fail(`could not create ${email} (${reason(r)})`);
  }
  return r.body.id;
}

async function ensureMembership(userId, role, active, email) {
  const r = await call(
    'POST',
    '/rest/v1/admin_memberships?on_conflict=user_id',
    { user_id: userId, role, active },
    { prefer: 'resolution=merge-duplicates,return=minimal' },
  );
  if (!okStatus(r)) fail(`could not set the membership of ${email} (${reason(r)})`);
}

async function select(path) {
  const r = await call('GET', path);
  if (r.status !== 200 || !Array.isArray(r.body))
    fail(`could not read ${path.split('?')[0]} (${reason(r)})`);
  return r.body;
}

async function insert(table, rows) {
  const r = await call('POST', `/rest/v1/${table}`, rows, { prefer: 'return=representation' });
  if (!okStatus(r) || !Array.isArray(r.body))
    fail(`could not add sample rows to ${table} (${reason(r)})`);
  return r.body;
}

async function seedSampleRows(ownerId) {
  const bot = await select(`/rest/v1/bot_profiles?select=id&id=eq.${DEV_BOT_ID}`);
  if (bot.length === 0) {
    console.log('sample rows skipped: the seeded dev bot is missing (run supabase db reset first)');
    return;
  }

  const taggedMessage = await select(
    `/rest/v1/messages?select=id&role=eq.user&content=like.${encodeURIComponent('[seed]*')}&limit=1`,
  );
  if (taggedMessage.length === 0) {
    const [conv] = await insert('conversations', [{ bot_id: DEV_BOT_ID }]);
    await insert('messages', [
      { conversation_id: conv.id, role: 'user', content: '[seed] What are your opening hours?' },
      {
        conversation_id: conv.id,
        role: 'assistant',
        content: '[seed] Sample reply for the admin panel.',
      },
      {
        conversation_id: conv.id,
        role: 'system',
        content: '[seed] system row, never shown to members',
      },
    ]);
    console.log('sample rows: added one conversation with three messages');
  } else {
    console.log('sample rows: conversation already present');
  }

  const samples = [
    { title: '[seed] Pending upload', status: 'draft', version: 'pending_upload', failure: null },
    {
      title: '[seed] Uploaded, waiting to index',
      status: 'indexing',
      version: 'uploaded',
      failure: null,
    },
    {
      title: '[seed] Failed: needs OCR',
      status: 'failed',
      version: 'failed',
      failure: 'OCR_REQUIRED',
    },
  ];
  let added = 0;
  for (const s of samples) {
    const found = await select(
      `/rest/v1/documents?select=id&bot_id=eq.${DEV_BOT_ID}&title=eq.${encodeURIComponent(s.title)}&limit=1`,
    );
    if (found.length > 0) continue;
    const [doc] = await insert('documents', [
      {
        bot_id: DEV_BOT_ID,
        title: s.title,
        status: s.status,
        disclosure_policy: 'excluded',
        created_by: ownerId,
      },
    ]);
    const versionId = crypto.randomUUID();
    await insert('document_versions', [
      {
        id: versionId,
        document_id: doc.id,
        version_number: 1,
        storage_path: `${DEV_BOT_ID}/${doc.id}/${versionId}/original.txt`,
        media_type: 'text/plain',
        byte_size: 1024,
        status: s.version,
        ...(s.failure === null ? {} : { failure_code: s.failure }),
      },
    ]);
    added += 1;
  }
  console.log(`sample rows: added ${added} document(s)`);
}

async function main() {
  let ownerId = null;
  for (const a of ACCOUNTS) {
    const email = `${a.name}@example.test`;
    const userId = await ensureUser(email);
    if (a.role !== null) await ensureMembership(userId, a.role, a.active, email);
    if (a.name === 'seed-owner') ownerId = userId;
    const state = a.role === null ? 'no membership' : `${a.role}${a.active ? '' : ' (inactive)'}`;
    console.log(`account: ${email} - ${state}`);
  }
  await seedSampleRows(ownerId);
  console.log(
    'done. Passwords come from SEED_TEST_PASSWORD. Enrol TOTP at first sign-in for each account.',
  );
}

await main();
