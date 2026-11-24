#!/usr/bin/env node
// Staging smoke test for the BUILT API (P10-T2).
//
//   npm run build && node scripts/smoke-test.mjs [--live]
//
// Flow: /health/live -> /health/ready -> POST /v1/sessions -> POST /v1/chat
// (SSE) -> contract checks -> timing report. Loopback only: the Supabase URL
// must be loopback or the script refuses to run.
//
// Two modes (the local stack has no documents and no real provider key):
//   default  Fail-closed contract: the smoke embedding model deliberately does
//            NOT match the dev bot's corpus model, so prepare() refuses before
//            reply.hijack() and the route answers with the JSON error envelope
//            (HTTP 500 INTERNAL_ERROR) having spent nothing and called nothing.
//            Asserts: stable code, no stack trace, no secret in the bytes, plus
//            first-event and total timings against the PRD §8 targets (TTFT <=
//            5 s, total <= 20 s; hard fail past 2x either).
//   --live   Full known-answer chat against a real provider. Needs
//            SMOKE_CHAT_API_KEY in the environment (a paid-tier key; never
//            committed, never printed) and asks a question the empty corpus
//            cannot answer: asserts meta first, done last, a `handoff` event
//            with reason no_knowledge and the seeded contact address. Not run
//            by default and not run in this repo's gates without owner approval
//            (paid-tier billing, same rule as the P11 evaluation).

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ENTRY = fileURLToPath(new URL('../api/dist/main.js', import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ALLOWED_ORIGIN = 'https://smoke-allowed.example.com';

// PRD §8 latency targets (single-sample smoke: warn past 1x, fail past 2x).
export const TTFT_TARGET_MS = 5000;
export const TOTAL_TARGET_MS = 20000;

// Stable error codes the browser may see (shared/src/contracts.ts error enum).
const ERROR_CODES = new Set([
  'INVALID_REQUEST',
  'SESSION_EXPIRED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'BUDGET_EXCEEDED',
  'FILE_UNSUPPORTED',
  'OCR_REQUIRED',
  'INDEXING_FAILED',
  'PROVIDER_UNAVAILABLE',
  'STREAM_INTERRUPTED',
  'INTERNAL_ERROR',
]);

// SMOKE-ONLY values (random per run). None is a real credential.
const SMOKE_SECRETS = {
  VISITOR_TOKEN_SECRET: randomBytes(32).toString('hex'),
  TURNSTILE_SECRET_KEY: 'SMOKE-ONLY-turnstile-secret',
  RATE_LIMIT_KEY_SECRET: randomBytes(32).toString('hex'),
  GEMINI_API_KEY: 'SMOKE-ONLY-gemini-api-key',
};

/** Split an SSE byte stream into [{ event, data }] in arrival order. */
export function parseSSEEvents(text) {
  const events = [];
  for (const chunk of String(text).split(/\n\n/)) {
    const lines = chunk.split('\n').map((l) => l.trim());
    if (lines.every((l) => l === '' || l.startsWith(':'))) continue;
    let event = 'message';
    const data = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      else if (line !== '') data.push(line);
    }
    events.push({ event, data: data.join('\n') });
  }
  return events;
}

/**
 * Fail-closed JSON contract (default mode): prepare() refuses before
 * reply.hijack(), so the route answers with the JSON error envelope and
 * nothing has been spent. The code is stable, there is no stack trace, and
 * nothing leaks a secret. Returns violation strings (empty = holds).
 */
export function checkJsonErrorContract(json, secrets) {
  const problems = [];
  if (json === null || typeof json !== 'object') {
    problems.push('error body is not a JSON object');
    return problems;
  }
  if (!ERROR_CODES.has(json.code)) problems.push(`unstable error code: ${json.code}`);
  const blob = JSON.stringify(json);
  if (/stack|Trace|at .*\(.*:\d+:\d+\)/.test(blob)) problems.push('body looks like a stack trace');
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 8 && blob.includes(s)) {
      problems.push('body contains a secret value');
      break;
    }
  }
  return problems;
}

/** Known-answer contract for --live: meta first, done last, no_knowledge handoff. */
export function checkLiveContract(events, secrets) {
  const problems = [];
  if (events.length === 0) {
    problems.push('no SSE events received');
    return problems;
  }
  if (events[0].event !== 'meta')
    problems.push(`first event is '${events[0].event}', expected 'meta'`);
  const last = events[events.length - 1];
  if (last.event !== 'done') problems.push(`last event is '${last.event}', expected 'done'`);
  const handoff = events.find((e) => e.event === 'handoff');
  if (handoff === undefined) {
    problems.push('no handoff event on an unanswerable question');
  } else {
    let payload;
    try {
      payload = JSON.parse(handoff.data);
    } catch {
      problems.push('handoff data is not JSON');
      payload = undefined;
    }
    if (payload !== undefined && payload.reason !== 'no_knowledge') {
      problems.push(`handoff reason is '${payload.reason}', expected 'no_knowledge'`);
    }
  }
  const blob = JSON.stringify(events);
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 8 && blob.includes(s)) {
      problems.push('bytes contain a secret value');
      break;
    }
  }
  return problems;
}

/** SLO verdict: warn past 1x target, fail past 2x. */
export function evaluateSLO({ ttftMs, totalMs }) {
  const ttftVerdict =
    ttftMs <= TTFT_TARGET_MS ? 'pass' : ttftMs <= 2 * TTFT_TARGET_MS ? 'warn' : 'fail';
  const totalVerdict =
    totalMs <= TOTAL_TARGET_MS ? 'pass' : totalMs <= 2 * TOTAL_TARGET_MS ? 'warn' : 'fail';
  return {
    ttftMs,
    totalMs,
    ttftVerdict,
    totalVerdict,
    failed: ttftVerdict === 'fail' || totalVerdict === 'fail',
  };
}

const failures = [];
let passed = 0;
const secretValues = new Set(Object.values(SMOKE_SECRETS));

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

function fatal(message) {
  console.error(`smoke-test: ${message}`);
  process.exit(2);
}

function stackUrl() {
  let stdout;
  try {
    stdout = execFileSync('npx', ['--no-install', 'supabase', 'status', '-o', 'json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60000,
      // Windows: npx is a .cmd shim, resolvable only through a shell.
      shell: process.platform === 'win32',
    });
  } catch {
    fatal('the local Supabase stack is not running (start it first)');
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
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    fatal(`unparseable Supabase URL: ${url}`);
  }
  if (!LOOPBACK.has(host) && !LOOPBACK.has(`[${host}]`))
    fatal('refusing to run against a non-loopback Supabase URL');
  return { url, key };
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

function baseEnv(url, key, port, live) {
  return {
    PATH: process.env.PATH ?? '',
    SUPABASE_URL: url,
    SUPABASE_SECRET_KEY: key,
    ...SMOKE_SECRETS,
    ...(live ? { GEMINI_API_KEY: live } : {}),
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    PORT: String(port),
    LOG_LEVEL: 'warn',
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
    // Default mode: deliberately NOT the corpus model, so prepare() refuses
    // before any spend or provider call. Live mode matches the seed instead.
    EMBEDDING_PROVIDER: 'gemini',
    EMBEDDING_MODEL: live ? 'gemini-embedding-001' : 'smoke-embedding-model',
    EMBEDDING_DIMENSIONS: '1536',
    MODERATION_PROVIDER: 'gemini',
    MODERATION_MODEL: live ? 'gemini-3.5-flash-lite' : 'smoke-moderation-model',
    MODERATION_MODE: 'llm_classifier',
  };
}

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
  return { status: res.status, json: await res.json().catch(() => undefined) };
}

async function main() {
  const live = process.argv.includes('--live');
  const liveKey = process.env.SMOKE_CHAT_API_KEY;
  if (live && (typeof liveKey !== 'string' || liveKey.length < 8)) {
    fatal('--live needs SMOKE_CHAT_API_KEY in the environment (paid-tier key, owner approval)');
  }
  if (!existsSync(ENTRY)) fatal('api/dist/main.js missing: run `npm run build` first');
  secretValues.add(liveKey ?? '');

  const { url, key } = stackUrl();
  const port = await freePort();
  const run = start(baseEnv(url, key, port, live ? liveKey : undefined));
  const stop = () => {
    run.child.kill('SIGTERM');
    return Promise.race([run.done, sleep(5000)]);
  };
  try {
    check(
      'server boots',
      await waitFor(async () => (await get(port, '/health/live')).status === 200, 30000),
    );
    const t0 = Date.now();
    const liveRes = await get(port, '/health/live');
    check('GET /health/live is 200 {ok}', liveRes.status === 200 && liveRes.json?.status === 'ok');
    const readyRes = await get(port, '/health/ready');
    const readyMs = Date.now() - t0;
    check(
      'GET /health/ready is 200 {ok}',
      readyRes.status === 200 && readyRes.json?.status === 'ok',
    );
    console.log(`info ready probe took ${readyMs} ms`);

    const fwd = `${randomBytes(4).toString('hex')}.example.com`;
    const session = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': fwd },
      body: JSON.stringify({ bot_slug: 'dev-bot' }),
      signal: AbortSignal.timeout(5000),
    });
    const sessionJson = await session.json().catch(() => undefined);
    check(
      'POST /v1/sessions issues a token',
      session.status === 200 && typeof sessionJson?.token === 'string',
      `status ${session.status}`,
    );
    if (typeof sessionJson?.token !== 'string') return;

    const chatStarted = Date.now();
    const chat = await fetch(`http://127.0.0.1:${port}/v1/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: live ? 'text/event-stream' : 'application/json',
        authorization: `Bearer ${sessionJson.token}`,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        bot_slug: 'dev-bot',
        conversation_id: null,
        message: 'What are your opening hours?',
      }),
      signal: AbortSignal.timeout(90000),
    });
    const totalMs = Date.now() - chatStarted;
    if (live) {
      const bytes = await chat.text();
      check('POST /v1/chat answers 200 SSE', chat.status === 200, `status ${chat.status}`);
      const events = parseSSEEvents(bytes);
      console.log(`info SSE events: ${events.map((e) => e.event).join(',') || '(none)'}`);
      if (process.argv.includes('--show-events')) {
        for (const e of events)
          console.log(`info event ${e.event}: ${scrub(e.data).slice(0, 500)}`);
      }
      const problems = checkLiveContract(events, secretValues);
      check('chat known-answer contract holds', problems.length === 0, problems.join('; '));
    } else {
      // Default mode: the embedding model guard refuses before hijack, so the
      // answer is the JSON error envelope (HTTP 500 INTERNAL_ERROR), fast.
      const body = await chat.json().catch(() => undefined);
      check(
        'POST /v1/chat fails closed with a stable code',
        chat.status === 500 && body?.code === 'INTERNAL_ERROR',
        `status ${chat.status}: ${scrub(JSON.stringify(body)).slice(0, 200)}`,
      );
      const problems = checkJsonErrorContract(body, secretValues);
      check('chat fail-closed contract holds', problems.length === 0, problems.join('; '));
    }

    // First-event timing: the stream has no per-event timestamps, so TTFT is
    // bounded above by the total on these short streams; measured properly in P11.
    const slo = evaluateSLO({ ttftMs: totalMs, totalMs });
    console.log(
      `info chat total ${totalMs} ms (TTFT target ${TTFT_TARGET_MS}, total target ${TOTAL_TARGET_MS})`,
    );
    check(
      'chat latency within 2x PRD targets',
      !slo.failed,
      `ttft~${slo.ttftMs} total~${slo.totalMs}`,
    );
  } finally {
    await stop();
  }
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(new URL(`file://${process.argv[1]}`, 'file:///'));
if (invokedAsScript) {
  main().then(
    () => {
      console.log(
        passed > 0 && failures.length === 0
          ? `smoke-test: ${passed} passed`
          : `smoke-test: ${failures.length} failed`,
      );
      process.exit(failures.length === 0 ? 0 : 1);
    },
    (err) => {
      console.error(`smoke-test: fatal: ${scrub(err?.message ?? String(err))}`);
      process.exit(2);
    },
  );
}
