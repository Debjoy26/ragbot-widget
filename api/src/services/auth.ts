// Visitor authentication (TECH_SPECS sections 2 and 8, handover.md section 4). P4-T2.
//
// Token: `v1.<base64url(json claims)>.<base64url(hmac-sha256)>`, the HMAC taken over the ASCII
// string `v1.<payload>`. A token is only a claim of identity: authenticate() also checks the
// visitor_sessions row, so revocation and token_version bumps take effect at once.
//
// Nothing in this module logs, and no error message contains a token, the secret or claims.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import {
  httpStatusFor,
  isTokenExpired,
  visitorTokenClaimsSchema,
  type ErrorCode,
  type VisitorTokenClaims,
} from '@ragbot/shared';
import type { Db } from '../lib/supabase.js';

/**
 * Thrown for every authentication failure. Carries only a stable public code. The route layer maps
 * it to the error envelope; it is reconciled with the shared AppError at integration.
 */
export class VisitorAuthError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;

  constructor(code: ErrorCode) {
    super(code);
    this.name = 'VisitorAuthError';
    this.code = code;
    this.statusCode = httpStatusFor(code);
  }
}

/** What a request is allowed to act as, once authenticated. */
export interface VisitorContext {
  readonly bot_id: string;
  readonly session_id: string;
  readonly token_version: number;
}

export interface IssuedToken {
  readonly token: string;
  /** ISO 8601, UTC. */
  readonly expires_at: string;
}

export interface VisitorAuth {
  issueToken(input: VisitorContext): IssuedToken;
  verifyToken(token: string): VisitorTokenClaims;
  authenticate(token: string, expectedBotId?: string): Promise<VisitorContext>;
}

export interface CreateVisitorAuthOptions {
  /** Signing secret, at least 32 bytes (UTF-8). */
  secret: string;
  /** Token lifetime in seconds, a positive integer. */
  ttlSeconds: number;
  db: Pick<Db, 'selectOne'>;
  /** Clock in epoch milliseconds (Date.now-compatible). Injected for tests. */
  now?: () => number;
}

const VERSION = 'v1';
const MIN_SECRET_BYTES = 32;
const MAX_TOKEN_LENGTH = 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SIGNATURE_BYTES = 32;

interface SessionRow {
  token_version: number;
  expires_at: string;
  revoked_at: string | null;
}

/** Decodes strict, canonical base64url. Returns null for anything else. */
function decodeBase64url(part: string): Buffer | null {
  if (part.length === 0 || !BASE64URL.test(part)) return null;
  const bytes = Buffer.from(part, 'base64url');
  // Reject non-canonical encodings (stray trailing bits), so one byte string has one spelling.
  return bytes.toString('base64url') === part ? bytes : null;
}

export function createVisitorAuth(options: CreateVisitorAuthOptions): VisitorAuth {
  const { secret, ttlSeconds, db } = options;
  const now = options.now ?? Date.now;

  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
    throw new TypeError(`visitor token secret must be at least ${String(MIN_SECRET_BYTES)} bytes`);
  }
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError('visitor token ttl must be a positive integer (seconds)');
  }
  const key = Buffer.from(secret, 'utf8');

  const sign = (signingInput: string): Buffer =>
    createHmac('sha256', key).update(signingInput, 'utf8').digest();

  const nowSeconds = (): number => Math.floor(now() / 1000);

  function issueToken(input: VisitorContext): IssuedToken {
    const iat = nowSeconds();
    if (!Number.isSafeInteger(iat) || iat < 0) throw new RangeError('clock is not usable');
    const exp = iat + ttlSeconds;
    // Fixed key order; the strict schema also rejects malformed ids and versions before signing.
    const claims = visitorTokenClaimsSchema.parse({
      bot_id: input.bot_id,
      session_id: input.session_id,
      token_version: input.token_version,
      iat,
      exp,
    });
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const signingInput = `${VERSION}.${payload}`;
    return {
      token: `${signingInput}.${sign(signingInput).toString('base64url')}`,
      expires_at: new Date(exp * 1000).toISOString(),
    };
  }

  function verifyToken(token: string): VisitorTokenClaims {
    const unauthorized = (): VisitorAuthError => new VisitorAuthError('UNAUTHORIZED');

    // 1. Shape. Nothing is decoded as JSON until the signature has passed.
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      throw unauthorized();
    }
    const parts = token.split('.');
    if (parts.length !== 3) throw unauthorized();
    const [version, payloadPart, signaturePart] = parts as [string, string, string];
    if (version !== VERSION) throw unauthorized();
    const payload = decodeBase64url(payloadPart);
    const signature = decodeBase64url(signaturePart);
    if (payload === null || signature === null) throw unauthorized();
    if (signature.length !== SIGNATURE_BYTES) throw unauthorized();

    // 2. Signature, in constant time on equal-length buffers.
    const expected = sign(`${version}.${payloadPart}`);
    if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) {
      throw unauthorized();
    }

    // 3. Claims. Our own signature covers them, but they are still checked strictly.
    let json: unknown;
    try {
      json = JSON.parse(payload.toString('utf8'));
    } catch {
      throw unauthorized();
    }
    const parsed = visitorTokenClaimsSchema.safeParse(json);
    if (!parsed.success) throw unauthorized();

    // 4. Expiry, only for a token we signed.
    if (isTokenExpired(parsed.data, nowSeconds())) throw new VisitorAuthError('SESSION_EXPIRED');
    return parsed.data;
  }

  async function authenticate(token: string, expectedBotId?: string): Promise<VisitorContext> {
    const claims = verifyToken(token);

    let row: SessionRow | null;
    try {
      row = await db.selectOne<SessionRow>(
        'visitor_sessions',
        { id: claims.session_id, bot_id: claims.bot_id },
        ['token_version', 'expires_at', 'revoked_at'],
      );
    } catch {
      // Fail closed: if the session cannot be checked, the visitor is not let in.
      throw new VisitorAuthError('PROVIDER_UNAVAILABLE');
    }

    if (row === null) throw new VisitorAuthError('UNAUTHORIZED');
    if (
      row === undefined ||
      typeof row !== 'object' ||
      !Number.isInteger(row.token_version) ||
      typeof row.expires_at !== 'string' ||
      (row.revoked_at !== null && typeof row.revoked_at !== 'string')
    ) {
      // A malformed row is a database fault, never a pass.
      throw new VisitorAuthError('PROVIDER_UNAVAILABLE');
    }
    const expiresAtMs = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAtMs)) throw new VisitorAuthError('PROVIDER_UNAVAILABLE');

    if (row.token_version !== claims.token_version) throw new VisitorAuthError('UNAUTHORIZED');
    if (row.revoked_at !== null) throw new VisitorAuthError('UNAUTHORIZED');
    const clock = now();
    if (!Number.isFinite(clock) || clock >= expiresAtMs) {
      throw new VisitorAuthError('SESSION_EXPIRED');
    }
    if (expectedBotId !== undefined && expectedBotId !== claims.bot_id) {
      throw new VisitorAuthError('FORBIDDEN');
    }
    return {
      bot_id: claims.bot_id,
      session_id: claims.session_id,
      token_version: claims.token_version,
    };
  }

  return { issueToken, verifyToken, authenticate };
}

/** Strict `Bearer <token>`: one space, case-insensitive scheme, nothing else. */
export function bearerToken(authorizationHeader: unknown): string {
  if (
    typeof authorizationHeader !== 'string' ||
    authorizationHeader.length > MAX_TOKEN_LENGTH + 7
  ) {
    throw new VisitorAuthError('UNAUTHORIZED');
  }
  const match = /^bearer ([^\s]+)$/i.exec(authorizationHeader);
  if (match === null) throw new VisitorAuthError('UNAUTHORIZED');
  return match[1] as string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireVisitor(). Absent on routes that do not use it. */
    visitor?: VisitorContext;
  }
}

/** Fastify preHandler: authenticates the bearer token and sets `req.visitor`. Throws VisitorAuthError. */
export function requireVisitor(
  auth: Pick<VisitorAuth, 'authenticate'>,
): preHandlerAsyncHookHandler {
  return async function requireVisitorHook(
    req: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const token = bearerToken(req.headers.authorization);
    req.visitor = await auth.authenticate(token);
  };
}
