#!/usr/bin/env node
// Creates the first admin of a client project (G-23, ADR 0017): invites the user by email and adds the
// admin_memberships row. Run it by hand from a trusted machine; nothing in the app calls it.
//
//   SUPABASE_URL=<project url> SUPABASE_SECRET_KEY=<secret key> \
//     node scripts/create-first-admin.mjs --email <address> --role owner \
//       [--confirm-project <ref>] [--adopt-existing]
//
// Before you run it:
//   * Public signup must be OFF on the project first (Auth settings: "Allow new users to sign up"
//     disabled). With signup on, anyone can pre-register the owner's address with a password they
//     chose, and that account would then be handed the owner role.
//   * The service key belongs in the environment (the variables above), never on the command line:
//     command lines end up in shell history and process listings. This script has no key argument.
//
// Rules:
//   * SUPABASE_URL and SUPABASE_SECRET_KEY come from the environment only. Either one missing: stop.
//   * A loopback URL (the local stack) needs no confirmation. Any other URL must be
//     https://<20-letter ref>.supabase.co and needs --confirm-project <ref> with the same ref.
//   * The user gets an invite email and chooses their own password. This script never sets a password
//     and never prints the key, a response body or an invite link. A password set before TOTP
//     enrolment would give full access (the first factor can be enrolled at aal1).
//   * An existing user is reused only if the account has never been confirmed and has never signed in
//     (email_confirmed_at and last_sign_in_at both empty), which is what an unanswered invite looks
//     like. Anything else may be an account somebody registered in advance, with a password the
//     owner does not know, and the script refuses. --adopt-existing overrides that refusal: use it
//     only when you have checked that the account really belongs to the intended owner.
//   * Safe to run again: an existing membership is left as it is. It stops if that membership has
//     another role or is inactive; it never changes either.
// Exit status: 0 done, 1 failed, 2 bad usage or missing configuration.

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMEOUT_MS = 20_000;
const MAX_USER_PAGES = 50;
const PER_PAGE = 200;

function usage(message) {
  console.error(`create-first-admin: ${message}`);
  console.error(
    'usage: create-first-admin.mjs --email <address> --role owner [--confirm-project <ref>] [--adopt-existing]',
  );
  process.exit(2);
}

function fail(message) {
  console.error(`create-first-admin: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  const allowed = new Set(['--email', '--role', '--confirm-project']);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--adopt-existing') {
      if (out[flag] !== undefined) usage(`${flag} given twice`);
      out[flag] = true;
      continue;
    }
    i += 1;
    const value = argv[i];
    if (!allowed.has(flag)) usage(`unknown argument ${JSON.stringify(String(flag).slice(0, 40))}`);
    if (value === undefined || value.startsWith('--')) usage(`${flag} needs a value`);
    if (out[flag] !== undefined) usage(`${flag} given twice`);
    out[flag] = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const email = (args['--email'] ?? '').trim().toLowerCase();
const role = args['--role'];
const confirm = args['--confirm-project'];
const adoptExisting = args['--adopt-existing'] === true;

if (!EMAIL_PATTERN.test(email) || email.length > 254) usage('--email must be an email address');
if (role !== 'owner') usage('--role must be owner');

const rawUrl = process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
if (!rawUrl) usage('SUPABASE_URL is not set');
if (!secretKey) usage('SUPABASE_SECRET_KEY is not set');

let base;
try {
  base = new URL(rawUrl);
} catch {
  usage('SUPABASE_URL is not a valid URL');
}
if (
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  !['', '/'].includes(base.pathname)
) {
  usage('SUPABASE_URL must be a plain origin with no credentials, path or query');
}

if (LOOPBACK.has(base.hostname)) {
  if (base.protocol !== 'http:' && base.protocol !== 'https:')
    usage('SUPABASE_URL must be http or https');
} else {
  const m = /^([a-z]{20})\.supabase\.co$/.exec(base.hostname);
  if (base.protocol !== 'https:' || !m) {
    usage('a remote SUPABASE_URL must be https://<project ref>.supabase.co');
  }
  if (!confirm) usage('--confirm-project <ref> is required for a remote project');
  if (confirm !== m[1]) usage('--confirm-project does not match the project ref in SUPABASE_URL');
}
const origin = base.origin;

// The legacy service key is a JWT and is also sent as the bearer token; a new-style secret key is not
// a JWT and must go in the apikey header only.
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
    fail(`could not reach the project (${method} ${path.split('?')[0]})`);
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

function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

/** Finds the user by email. Returns { id, untouched } or null; `untouched` means invited by an operator, never confirmed and never signed in. */
async function findUser(address) {
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
        return {
          id: u.id,
          untouched:
            !isEmpty(u.invited_at) && isEmpty(u.email_confirmed_at) && isEmpty(u.last_sign_in_at),
        };
      }
    }
    if (r.body.users.length < PER_PAGE) return null;
  }
  fail('too many users to search; stopping instead of guessing');
}

/** Refuses to use an account that was confirmed or has signed in, unless --adopt-existing was given. */
function requireUntouched(user) {
  if (user.untouched || adoptExisting) return;
  fail(
    'this email already has an account that was not created by an invite, or was confirmed or has signed in. It may have been ' +
      'registered in advance with a password the owner does not know, so it was not used and no ' +
      'membership was added. Check with the owner, then re-run with --adopt-existing only if the ' +
      'account is really theirs. (Turn public signup off first.)',
  );
}

async function main() {
  const existing = await findUser(email);
  let userId = null;
  let created = false;
  if (existing !== null) {
    requireUntouched(existing);
    userId = existing.id;
  } else {
    const r = await call('POST', '/auth/v1/invite', { email });
    if (r.status === 200 && r.body && UUID_PATTERN.test(r.body.id)) {
      userId = r.body.id;
      created = true;
    } else if (r.status === 422) {
      // Someone created the user between the lookup and the invite: look again once.
      const raced = await findUser(email);
      if (raced === null) fail(`the invite was refused (${reason(r)})`);
      requireUntouched(raced);
      userId = raced.id;
    } else {
      fail(`the invite was refused (${reason(r)})`);
    }
  }

  const ins = await call(
    'POST',
    '/rest/v1/admin_memberships?on_conflict=user_id',
    { user_id: userId, role, active: true },
    { prefer: 'resolution=ignore-duplicates,return=minimal' },
  );
  if (ins.status !== 201 && ins.status !== 200 && ins.status !== 204) {
    fail(`could not add the membership (${reason(ins)})`);
  }

  const chk = await call(
    'GET',
    `/rest/v1/admin_memberships?select=role,active&user_id=eq.${userId}`,
  );
  const row = Array.isArray(chk.body) ? chk.body[0] : undefined;
  if (chk.status !== 200 || !row) fail(`could not read the membership back (${reason(chk)})`);
  if (row.role !== role || row.active !== true) {
    fail('this user already has a membership with a different role or is inactive; not changed');
  }

  console.log(
    `${created ? 'invited' : adoptExisting ? 'adopted existing user' : 'existing user'}: user_id=${userId} role=${role}`,
  );
  console.log(
    'The user sets a password from the invite email, then enrols TOTP before using the panel.',
  );
}

await main();
