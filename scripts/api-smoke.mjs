#!/usr/bin/env node
// Smoke test for the BUILT API (api/dist/main.js) against the LOCAL Supabase stack (P4-D1).
//
//   npm run build && node scripts/api-smoke.mjs
//
// It starts the real entry point as a child process with labelled smoke-only secrets and the local
// stack's service key (read from `supabase status -o json`), then checks: bad and missing
// configuration exit 1 naming the variable without its value; /health/live and /health/ready;
// the error envelope on an unknown route; CORS for an allowed and a refused origin; and that
// POST /v1/sessions for the seeded dev bot (200, token shape and HMAC, session row exists), an
// unknown slug (403) and a strict-body violation (400); and that
// SIGTERM flips /health/ready to 503 while draining and exits 0. Nothing it prints contains the
// key or any smoke secret. Any failed check makes the script exit non-zero.
//
// Safety: the Supabase URL must be a loopback address, otherwise the script refuses to run.
// `API_SMOKE_SUPABASE_URL` may override the URL (used to prove that refusal); it never carries a key.
// No network access other than loopback.

import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ENTRY = fileURLToPath(new URL('../api/dist/main.js', import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ALLOWED_ORIGIN = 'https://smoke-allowed.example.com';
const REFUSED_ORIGIN = 'https://smoke-refused.example.com';

// SMOKE-ONLY values (the signing secret is random per run). None of these is a real credential. All must differ from each other.
const SMOKE_SECRETS = {
  VISITOR_TOKEN_SECRET: randomBytes(32).toString('hex'),
  TURNSTILE_SECRET_KEY: 'SMOKE-ONLY-turnstile-secret',
  RATE_LIMIT_KEY_SECRET: randomBytes(32).toString('hex'),
  GEMINI_API_KEY: 'SMOKE-ONLY-gemini-api-key',
};

const failures = [];
let passed = 0;
let skipped = 0;
const secretValues = new Set(Object.values(SMOKE_SECRETS));

/** Removes every known secret from text before it is printed. */
function scrub(text) {
  let out = String(text);
  for (const s of secretValues) out = out.split(s).join('[redacted]');
  return out;
}

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}${detail === '' ? '' : ` -- ${scrub(detail)}`}`);
  }
}

function skip(name, reason) {
  skipped += 1;
  console.log(`SKIP ${name} -- ${reason}`);
}

function fatal(message) {
  console.error(`api-smoke: ${scrub(message)}`);
  process.exit(1);
}

function localStack() {
  let stdout;
  try {
    stdout = execFileSync('npx', ['--no-install', 'supabase', 'status', '-o', 'json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60_000,
      // `npx` on Windows is a .cmd shim that cannot be executed without a
      // shell (ENOENT). Same command everywhere else.
      shell: process.platform === 'win32',
    });
  } catch {
    fatal('the local Supabase stack is not running (npm run db:start)');
  }
  let status;
  try {
    status = JSON.parse(stdout.slice(stdout.indexOf('{')));
  } catch {
    fatal('could not parse `supabase status -o json`');
  }
  const pick = (...names) => names.map((n) => status[n]).find((v) => typeof v === 'string' && v);
  const url = pick('API_URL');
  const key = pick('SERVICE_ROLE_KEY', 'SECRET_KEY');
  if (url === undefined || key === undefined)
    fatal('`supabase status` did not report a URL and key');
  return { url, key };
}

function requireLoopback(raw) {
  let host;
  try {
    host = new URL(raw).hostname;
  } catch {
    fatal('the Supabase URL is not a valid URL');
  }
  if (!LOOPBACK.has(host) && !LOOPBACK.has(`[${host}]`)) {
    fatal('refusing to run against a non-loopback Supabase URL');
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function baseEnv(url, key, port) {
  return {
    PATH: process.env.PATH ?? '',
    SUPABASE_URL: url,
    SUPABASE_SECRET_KEY: key,
    ...SMOKE_SECRETS,
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    PORT: String(port),
    LOG_LEVEL: 'info',
    // One trusted hop: the sessions checks send a random X-Forwarded-For so each run has its own
    // rate-limit bucket and repeated runs never exhaust the dev bot's session-create limit.
    TRUSTED_PROXY_HOPS: '1',
    BODY_LIMIT_BYTES: '65536',
    REQUEST_TIMEOUT_MS: '10000',
    CONNECTION_TIMEOUT_MS: '10000',
    READY_TIMEOUT_MS: '3000',
    DB_TIMEOUT_MS: '3000',
    VISITOR_TOKEN_TTL_SECONDS: '900',
    SESSION_PREFLIGHT_PER_IP_LIMIT: '1000',
    SESSION_PREFLIGHT_WINDOW_SECONDS: '3600',
    TURNSTILE_TIMEOUT_MS: '3000',
    CHAT_DEADLINE_MS: '30000',
    PROVIDER_MAX_ATTEMPTS: '2',
    RETRIEVAL_TOP_K: '5',
    RETRIEVAL_MIN_SIMILARITY: '0.5',
    CHAT_CONTEXT_MAX_TOKENS: '6000',
    CHAT_HISTORY_MAX_MESSAGES: '6',
    CHAT_MAX_OUTPUT_TOKENS: '800',
    CHAT_MAX_OUTPUT_CHARS: '8000',
    CHAT_PRICE_INPUT_PER_MILLION: '0.1',
    CHAT_PRICE_OUTPUT_PER_MILLION: '0.4',
    MODERATION_PRICE_INPUT_PER_MILLION: '0.1',
    MODERATION_PRICE_OUTPUT_PER_MILLION: '0.4',
    EMBEDDING_PRICE_PER_MILLION_TOKENS: '0.15',
    CHAT_RESERVATION_TTL_SECONDS: '120',
    CHAT_PROVIDER_ATTEMPTS: '2',
    HISTORY_PAGE_SIZE: '20',
    HISTORY_RATE_PER_SESSION_LIMIT: '60',
    HISTORY_RATE_WINDOW_SECONDS: '60',
    CHAT_PRIMARY_PROVIDER: 'gemini',
    CHAT_PRIMARY_MODEL: 'smoke-chat-model',
    EMBEDDING_PROVIDER: 'gemini',
    EMBEDDING_MODEL: 'smoke-embedding-model',
    EMBEDDING_DIMENSIONS: '1536',
    MODERATION_PROVIDER: 'gemini',
    MODERATION_MODEL: 'smoke-moderation-model',
    MODERATION_MODE: 'llm_classifier',
  };
}

/** Starts the built entry point with exactly this environment. Output is captured, not echoed. */
function start(env) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const run = { child, output: '', exit: undefined };
  const collect = (d) => (run.output += d.toString('utf8'));
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  run.done = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      run.exit = { code, signal };
      resolve(run.exit);
    });
  });
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}

async function get(port, path, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

async function post(port, path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A random documentation-range IPv6 address: its own /64, so its own rate-limit bucket. */
function randomClientAddress() {
  const g = () => randomBytes(2).toString('hex');
  return `2001:db8:${g()}:${g()}::1`;
}

/** Service-key call to the LOCAL stack, for reading and removing the smoke session row. */
async function serviceCall(url, key, method, path) {
  const headers = { apikey: key };
  if (key.split('.').length === 3) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${url}${path}`, { method, headers, signal: AbortSignal.timeout(5000) });
  const text = await res.text();
  return { status: res.status, json: text === '' ? null : JSON.parse(text) };
}

/** Checks the issued token's shape and signature without printing it. Returns the session id. */
function checkToken(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  const shaped = parts.length === 3 && parts[0] === 'v1';
  check('sessions: the token has the v1.<payload>.<signature> shape', shaped);
  if (!shaped) return undefined;
  const expected = createHmac('sha256', SMOKE_SECRETS.VISITOR_TOKEN_SECRET)
    .update(`${parts[0]}.${parts[1]}`)
    .digest('base64url');
  check('sessions: the token signature verifies with the signing secret', parts[2] === expected);
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    claims = undefined;
  }
  const nowS = Math.floor(Date.now() / 1000);
  check(
    'sessions: the claims name a bot, a session and a token version, and expire in the future',
    claims !== undefined &&
      UUID.test(claims.bot_id) &&
      UUID.test(claims.session_id) &&
      claims.token_version === 1 &&
      claims.exp > nowS &&
      claims.exp - claims.iat === 900,
  );
  return claims?.session_id;
}

async function refuses(name, env, mustName, mustNotContain) {
  const run = start(env);
  const exit = await Promise.race([run.done, sleep(15_000).then(() => undefined)]);
  if (exit === undefined) run.child.kill('SIGKILL');
  check(`${name}: exits 1`, exit?.code === 1, `exit ${JSON.stringify(exit)}`);
  check(`${name}: names ${mustName}`, run.output.includes(mustName));
  for (const bad of mustNotContain) {
    check(`${name}: output does not contain its value`, !run.output.includes(bad));
  }
}

/** Drain scenario on one kept-alive connection: see the comment where it is used. */
function drainProbe(port, afterHold) {
  return new Promise((resolve) => {
    let received = '';
    const socket = connect({ port, host: '127.0.0.1' }, () => {
      // The readiness request is held unfinished (headers not yet ended), which keeps the connection
      // busy through server.close(). It is completed after SIGTERM, so the one response on this
      // connection is always the readiness answer given while draining.
      socket.write('GET /health/ready HTTP/1.1\r\nHost: smoke\r\n');
      afterHold().then(() => {
        socket.write('\r\n');
      });
    });
    socket.on('data', (d) => (received += d.toString('latin1')));
    socket.on('error', () => undefined);
    socket.on('close', () => resolve(received));
    setTimeout(() => socket.destroy(), 8000).unref();
  });
}

async function main() {
  if (!existsSync(ENTRY)) fatal('api/dist/main.js not found: run `npm run build` first');

  const stack = localStack();
  const url = process.env.API_SMOKE_SUPABASE_URL ?? stack.url;
  requireLoopback(url);
  const key = stack.key;
  secretValues.add(key);

  // 1. Bad configuration.
  const badValue = 'smoke-bad-port-value';
  await refuses('bad config (PORT)', { ...baseEnv(url, key, 8080), PORT: badValue }, 'PORT', [
    badValue,
    key,
  ]);

  // 2. Missing configuration.
  const missing = baseEnv(url, key, 8080);
  delete missing.SUPABASE_SECRET_KEY;
  await refuses('missing config (SUPABASE_SECRET_KEY)', missing, 'SUPABASE_SECRET_KEY', [key]);
  await refuses('empty environment', { PATH: process.env.PATH ?? '' }, 'Invalid configuration', [
    key,
  ]);

  // 3. A good boot.
  const port = await freePort();
  const run = start(baseEnv(url, key, port));
  const up = await waitFor(async () => (await get(port, '/health/live')).status === 200, 15_000);
  check('starts and answers /health/live', up, scrub(run.output).slice(-400));
  if (!up) {
    run.child.kill('SIGKILL');
    return;
  }

  const live = await get(port, '/health/live');
  check(
    '/health/live is 200 {"status":"ok"}',
    live.status === 200 && live.text === '{"status":"ok"}',
  );
  const ready = await get(port, '/health/ready');
  check(
    '/health/ready is 200 against the local stack',
    ready.status === 200 && ready.text === '{"status":"ok"}',
    ready.text,
  );

  const nope = await get(port, '/nope');
  check(
    '/nope answers the error envelope with a request id',
    nope.status === 404 &&
      nope.json?.code === 'INVALID_REQUEST' &&
      typeof nope.json?.request_id === 'string' &&
      nope.json.request_id === nope.headers.get('x-request-id') &&
      Object.keys(nope.json).length === 2,
    nope.text,
  );
  check(
    'security headers are set',
    nope.headers.get('x-content-type-options') === 'nosniff' &&
      nope.headers.get('strict-transport-security') !== null &&
      nope.headers.get('content-security-policy') === "default-src 'none'; frame-ancestors 'none'",
  );

  const allowed = await get(port, '/health/live', { origin: ALLOWED_ORIGIN });
  check(
    'CORS: an allowed origin is echoed',
    allowed.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN,
  );
  const refused = await get(port, '/health/live', { origin: REFUSED_ORIGIN });
  check(
    'CORS: a refused origin gets no CORS headers',
    refused.headers.get('access-control-allow-origin') === null,
  );
  const bad = await get(port, '/%zz');
  check(
    'a bad URL gets the envelope, not a default body',
    bad.status === 400 && bad.json?.code === 'INVALID_REQUEST' && !bad.text.includes('%zz'),
    bad.text,
  );

  // 3b. POST /v1/sessions against the seeded dev bot (turnstile_required is false in the dev seed).
  const client = { 'x-forwarded-for': randomClientAddress() };
  const made = await post(port, '/v1/sessions', { bot_slug: 'dev-bot' }, client);
  check(
    'sessions: dev-bot gets 200 with exactly { token, expires_at }',
    made.status === 200 &&
      made.json !== undefined &&
      Object.keys(made.json).sort().join(',') === 'expires_at,token' &&
      Number.isFinite(Date.parse(made.json.expires_at)),
    made.text.replace(/"token":"[^"]*"/, '"token":"[redacted]"'),
  );
  if (made.status === 200 && made.json !== undefined) {
    secretValues.add(made.json.token);
    const sessionId = checkToken(made.json.token);
    if (sessionId !== undefined) {
      const row = await serviceCall(
        url,
        key,
        'GET',
        `/rest/v1/visitor_sessions?id=eq.${sessionId}&select=bot_id,token_version,revoked_at`,
      );
      check(
        'sessions: the session row exists, is not revoked and has token_version 1',
        row.status === 200 &&
          row.json?.length === 1 &&
          row.json[0].token_version === 1 &&
          row.json[0].revoked_at === null,
      );
      const gone = await serviceCall(
        url,
        key,
        'DELETE',
        `/rest/v1/visitor_sessions?id=eq.${sessionId}`,
      );
      check('sessions: the smoke session row was removed', gone.status < 300);
    }
  }
  const unknown = await post(port, '/v1/sessions', { bot_slug: 'smoke-no-such-bot' }, client);
  check(
    'sessions: an unknown slug is 403 FORBIDDEN with the bare envelope',
    unknown.status === 403 &&
      unknown.json?.code === 'FORBIDDEN' &&
      Object.keys(unknown.json).sort().join(',') === 'code,request_id',
    unknown.text,
  );
  const strict = await post(port, '/v1/sessions', { bot_slug: 'dev-bot', extra: 1 }, client);
  check(
    'sessions: a strict-body violation is 400 INVALID_REQUEST',
    strict.status === 400 && strict.json?.code === 'INVALID_REQUEST',
    strict.text,
  );

  // 4. SIGTERM: hold a connection open, signal, then ask for readiness on that same
  // connection. POSIX-only: on Windows child.kill('SIGTERM') ends the child via
  // TerminateProcess, which no handler can catch, so the API can never flip to
  // 503-while-draining or exit 0 there (observed exit
  // {"code":null,"signal":"SIGTERM"}). The checks below keep full strength
  // where signals are real. See T20.
  if (process.platform === 'win32') {
    skip(
      'while draining, /health/ready is 503 {"status":"unavailable"}',
      'SIGTERM is uncatchable on Windows (TerminateProcess); drain path verified on POSIX only',
    );
    skip(
      'SIGTERM exits 0',
      'SIGTERM is uncatchable on Windows (TerminateProcess); exit path verified on POSIX only',
    );
    run.child.kill('SIGKILL');
    await run.done;
  } else {
    const drained = drainProbe(port, async () => {
      run.child.kill('SIGTERM');
      await sleep(500);
    });
    const answers = await drained;
    check(
      'while draining, /health/ready is 503 {"status":"unavailable"}',
      /HTTP\/1\.1 503/.test(answers) && answers.includes('{"status":"unavailable"}'),
      answers.slice(0, 300),
    );
    const exit = await Promise.race([run.done, sleep(15_000).then(() => undefined)]);
    if (exit === undefined) run.child.kill('SIGKILL');
    check('SIGTERM exits 0', exit?.code === 0, `exit ${JSON.stringify(exit)}`);
  }

  // 5. Nothing leaked.
  for (const s of secretValues) {
    check('output never contains a key or smoke secret', !run.output.includes(s));
  }
  check('the child wrote something to its log', run.output.length > 0);
}

await main();
console.log(
  `\n${String(passed)} passed, ${String(failures.length)} failed, ${String(skipped)} skipped`,
);
if (failures.length > 0) {
  console.log(`failed: ${failures.join('; ')}`);
  process.exit(1);
}
