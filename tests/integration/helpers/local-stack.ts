import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Local Supabase stack access for integration tests (P3-D5 G-19a).
// The URL and keys are read at run time from `supabase status -o json`. Nothing is hard-coded, and
// no key value is ever logged or placed in an error message. Remote URLs are refused.

export interface LocalStack {
  /** API base URL, e.g. the local Kong gateway. Always a loopback address. */
  apiUrl: string;
  /** Key for the `anon` role (legacy JWT anon key, or the publishable key). */
  anonKey: string;
}

/**
 * SQL `schema_version()` on a freshly reset local stack (all migrations in
 * `supabase/migrations` applied). Bump together with the pgTAP census tests
 * (220/250/260) whenever a migration moves `schema_version()`.
 */
export const EXPECTED_SCHEMA_VERSION = 29;

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function pickString(obj: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const v = obj[name];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * `supabase status` output, read once per worker process and shared by both
 * accessors below. One CLI spawn costs seconds on a loaded box (and tens of
 * seconds when Docker churns), and every integration file reads the stack in
 * `beforeAll`: without the cache each file paid two full spawns. The URL and
 * keys are pinned by the local stack config and cannot change mid-run; fresh
 * worker processes re-read. Tests reset it with resetLocalStackCacheForTests.
 */
let cachedStatus: Record<string, unknown> | undefined;

/** Test-only reset for the per-process status cache (keeps tests isolated). */
export function resetLocalStackCacheForTests(): void {
  cachedStatus = undefined;
}

function loadStatus(): Record<string, unknown> {
  if (cachedStatus !== undefined) return cachedStatus;
  let stdout: string;
  try {
    stdout = execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../../node_modules/supabase/dist/supabase.js', import.meta.url)),
        'status',
        '-o',
        'json',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 60_000,
      },
    );
  } catch {
    throw new Error('local Supabase stack is not running (start it with: npm run db:start)');
  }
  let parsed: unknown;
  try {
    // The CLI may print notices before the JSON object.
    parsed = JSON.parse(stdout.slice(stdout.indexOf('{')));
  } catch {
    throw new Error('could not parse `supabase status -o json` output');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('unexpected `supabase status -o json` output');
  }
  cachedStatus = parsed as Record<string, unknown>;
  return cachedStatus;
}

/** Reads the local stack's API URL and anon key. Throws (fail closed) if the stack is not running. */
export function getLocalStack(): LocalStack {
  const status = loadStatus();

  const apiUrl = pickString(status, 'API_URL');
  const anonKey = pickString(status, 'ANON_KEY', 'PUBLISHABLE_KEY');
  if (apiUrl === undefined || anonKey === undefined) {
    throw new Error('`supabase status` did not report API_URL and an anon/publishable key');
  }

  const host = new URL(apiUrl).hostname;
  if (!LOOPBACK_HOSTS.has(host) && !LOOPBACK_HOSTS.has(`[${host}]`)) {
    throw new Error('refusing to run integration tests against a non-loopback API URL');
  }
  return { apiUrl: apiUrl.replace(/\/+$/, ''), anonKey };
}

/** Request headers for the `anon` role over PostgREST. */
export function anonHeaders(stack: LocalStack): Record<string, string> {
  const headers: Record<string, string> = { apikey: stack.anonKey };
  // JWT-style keys are also sent as the bearer token; publishable keys are not JWTs.
  if (stack.anonKey.split('.').length === 3) headers['authorization'] = `Bearer ${stack.anonKey}`;
  return headers;
}

/**
 * Key for the privileged role of the LOCAL stack (the legacy service key, or the secret key). Same
 * rules as getLocalStack(): read at run time, loopback only, and the value must never be logged or put
 * in an error message. Use it for test set-up and clean-up only.
 */
export function getLocalPrivilegedKey(): string {
  const status = loadStatus();
  const apiUrl = pickString(status, 'API_URL');
  if (apiUrl === undefined) {
    throw new Error('`supabase status` did not report API_URL and an anon/publishable key');
  }
  const host = new URL(apiUrl).hostname;
  if (!LOOPBACK_HOSTS.has(host) && !LOOPBACK_HOSTS.has(`[${host}]`)) {
    throw new Error('refusing to run integration tests against a non-loopback API URL');
  }
  const key = pickString(status, 'SERVICE_ROLE_KEY', 'SECRET_KEY');
  if (key === undefined) {
    throw new Error('`supabase status` did not report a service or secret key');
  }
  return key;
}

/** Request headers for a key: JWT-style keys are also the bearer token; new-style keys are not. */
export function keyHeaders(key: string): Record<string, string> {
  const headers: Record<string, string> = { apikey: key };
  if (key.split('.').length === 3) headers['authorization'] = `Bearer ${key}`;
  return headers;
}

/** Throws unless the URL points at a loopback host. Used by helpers that create users or send tokens. */
export function assertLoopbackUrl(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('refusing to continue: the URL could not be parsed');
  }
  if (!LOOPBACK_HOSTS.has(host) && !LOOPBACK_HOSTS.has(`[${host}]`)) {
    throw new Error('refusing to continue: the URL is not a loopback address');
  }
}

/** Request headers for a signed-in user: the publishable/anon key as `apikey`, the user's token as bearer. */
export function userHeaders(stack: LocalStack, accessToken: string): Record<string, string> {
  return { apikey: stack.anonKey, authorization: `Bearer ${accessToken}` };
}
