import { createHmac, randomBytes } from 'node:crypto';
import {
  anonHeaders,
  assertLoopbackUrl,
  keyHeaders,
  userHeaders,
  type LocalStack,
} from './local-stack.ts';

// Real Supabase Auth sessions for the LOCAL stack (P3.5-T3, B-13). A user is created through the Auth
// admin API, signs in with a password (an aal1 token), and enrols and verifies a real TOTP factor through
// /auth/v1/factors (an aal2 token). Nothing is forged: both tokens are issued by the local Auth service.
// Tokens, passwords, TOTP secrets and keys are never logged and never put in an error message.

export interface TestSession {
  userId: string;
  email: string;
  /** Token from the password sign-in: `aal: aal1`. */
  aal1Token: string;
  /** Token from the verified TOTP challenge: `aal: aal2`. */
  aal2Token: string;
}

export interface HttpResult {
  status: number;
  /** Parsed JSON body, or the raw text when the body is not JSON, or null when empty. */
  body: unknown;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/u, '').replace(/\s+/gu, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('the TOTP secret is not valid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP: HMAC-SHA-1, 6 digits, 30 second step. */
export function totpCode(secretBase32: string, nowMs: number = Date.now()): string {
  const counter = BigInt(Math.floor(nowMs / 1000 / 30));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', base32Decode(secretBase32)).update(msg).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    ((hmac[offset + 1] ?? 0) << 16) |
    ((hmac[offset + 2] ?? 0) << 8) |
    (hmac[offset + 3] ?? 0);
  return String(bin % 1_000_000).padStart(6, '0');
}

/** Decodes the payload of a JWT (no signature check: the services verify tokens, tests only inspect claims). */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined) throw new Error('not a JWT');
  const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null)
    throw new Error('JWT payload is not an object');
  return parsed as Record<string, unknown>;
}

/** A random password for a test user. Generated per run, never stored. */
export function randomTestPassword(): string {
  return `Tp-${randomBytes(18).toString('base64url')}`;
}

export async function readResponse(res: Response): Promise<HttpResult> {
  const text = await res.text();
  if (text === '') return { status: res.status, body: null };
  try {
    return { status: res.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: res.status, body: text };
  }
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

/** Creates a confirmed user through the Auth admin API (privileged key; local stack only). */
export async function createAuthUser(
  stack: LocalStack,
  privilegedKey: string,
  email: string,
  password: string,
): Promise<string> {
  assertLoopbackUrl(stack.apiUrl);
  const res = await fetch(`${stack.apiUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { ...keyHeaders(privilegedKey), 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const r = await readResponse(res);
  const id = obj(r.body)['id'];
  if (r.status >= 300 || typeof id !== 'string') {
    throw new Error(`could not create the test user (HTTP ${r.status})`);
  }
  return id;
}

export async function deleteAuthUser(
  stack: LocalStack,
  privilegedKey: string,
  userId: string,
): Promise<void> {
  assertLoopbackUrl(stack.apiUrl);
  await fetch(`${stack.apiUrl}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: keyHeaders(privilegedKey),
  });
}

/** Password sign-in. Returns the access token of an aal1 session. */
export async function signInWithPassword(
  stack: LocalStack,
  email: string,
  password: string,
): Promise<string> {
  assertLoopbackUrl(stack.apiUrl);
  const res = await fetch(`${stack.apiUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: stack.anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const r = await readResponse(res);
  const token = obj(r.body)['access_token'];
  if (r.status >= 300 || typeof token !== 'string') {
    throw new Error(`password sign-in failed (HTTP ${r.status})`);
  }
  return token;
}

/**
 * Enrols a TOTP factor for the signed-in user, answers a challenge with a real code computed from the
 * returned secret, and returns the aal2 access token. The secret stays in memory and is dropped.
 */
export async function enrolAndVerifyTotp(stack: LocalStack, aal1Token: string): Promise<string> {
  assertLoopbackUrl(stack.apiUrl);
  const headers = { ...userHeaders(stack, aal1Token), 'content-type': 'application/json' };

  const enrol = await readResponse(
    await fetch(`${stack.apiUrl}/auth/v1/factors`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        factor_type: 'totp',
        friendly_name: `t3-${randomBytes(4).toString('hex')}`,
      }),
    }),
  );
  const factorId = obj(enrol.body)['id'];
  const secret = obj(obj(enrol.body)['totp'])['secret'];
  if (enrol.status >= 300 || typeof factorId !== 'string' || typeof secret !== 'string') {
    throw new Error(`TOTP enrolment failed (HTTP ${enrol.status})`);
  }

  // Avoid a code that expires while the request is in flight.
  const intoStep = Date.now() % 30_000;
  if (intoStep > 27_000) await new Promise((r) => setTimeout(r, 30_000 - intoStep + 200));

  const challenge = await readResponse(
    await fetch(`${stack.apiUrl}/auth/v1/factors/${factorId}/challenge`, {
      method: 'POST',
      headers,
      body: '{}',
    }),
  );
  const challengeId = obj(challenge.body)['id'];
  if (challenge.status >= 300 || typeof challengeId !== 'string') {
    throw new Error(`TOTP challenge failed (HTTP ${challenge.status})`);
  }

  const verify = await readResponse(
    await fetch(`${stack.apiUrl}/auth/v1/factors/${factorId}/verify`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ challenge_id: challengeId, code: totpCode(secret) }),
    }),
  );
  const aal2 = obj(verify.body)['access_token'];
  if (verify.status >= 300 || typeof aal2 !== 'string') {
    throw new Error(`TOTP verification failed (HTTP ${verify.status})`);
  }
  return aal2;
}

/** Creates a user, signs in, enrols and verifies TOTP. Returns both tokens. */
export async function createTotpSession(
  stack: LocalStack,
  privilegedKey: string,
  email: string,
  password: string,
): Promise<TestSession> {
  const userId = await createAuthUser(stack, privilegedKey, email, password);
  try {
    const aal1Token = await signInWithPassword(stack, email, password);
    const aal2Token = await enrolAndVerifyTotp(stack, aal1Token);
    return { userId, email, aal1Token, aal2Token };
  } catch (e) {
    await deleteAuthUser(stack, privilegedKey, userId);
    throw e;
  }
}

/** A PostgREST error body carries the SQLSTATE in `code`. Returns it, or null when the call succeeded. */
export function sqlstateOf(r: HttpResult): string | null {
  if (r.status < 300) return null;
  const code = obj(r.body)['code'];
  return typeof code === 'string' ? code : null;
}

/** Calls a function through PostgREST as the given token (or as anon when token is null). */
export async function rpc(
  stack: LocalStack,
  token: string | null,
  name: string,
  args: Record<string, unknown> = {},
): Promise<HttpResult> {
  assertLoopbackUrl(stack.apiUrl);
  const headers: Record<string, string> =
    token === null
      ? { ...anonHeaders(stack), 'content-type': 'application/json' }
      : { ...userHeaders(stack, token), 'content-type': 'application/json' };
  return readResponse(
    await fetch(`${stack.apiUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
    }),
  );
}
