// POST /v1/sessions (TECH_SPECS section 2, ADR 0007, ADR 0010). P5-B.
//
// Order is part of the contract:
//   1. strict body validation
//   2. bot-independent per-IP preflight limit (before any database policy read, so slugs cannot
//      be probed without bound)
//   3. policy by slug; an unknown and a disabled bot get the SAME FORBIDDEN answer
//   4. session-create limits: this bot and the caller's IP bucket, then the bot's aggregate
//      (before any challenge call, so the limits also bound how often Cloudflare is asked)
//   5. if the bot requires it, a challenge token that verifies; missing or failing is FORBIDDEN
//   6. create the visitor_sessions row, issue the token, validate the response, send it
//
// Logs carry ids, counts and codes only: never the slug, the challenge token or the bearer token.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createSessionRequestSchema, createSessionResponseSchema } from '@ragbot/shared';
import { AppError } from '../lib/errors.js';
import { DbError, type Db } from '../lib/supabase.js';
import type { VisitorAuth } from '../services/auth.js';
import type { Limits } from '../services/limits.js';
import type { TurnstileVerifier } from '../services/turnstile.js';

/** SQLSTATE `create_visitor_session` raises when the bot is disabled (a race after the policy read). */
const BOT_DISABLED_SQLSTATE = 'RB039';

export interface SessionsDeps {
  readonly db: Pick<Db, 'rpc'>;
  readonly auth: Pick<VisitorAuth, 'issueToken'>;
  readonly limits: Pick<
    Limits,
    'consumeSessionPreflight' | 'consumeSessionCreate' | 'consumeSessionCreateBot'
  >;
  readonly turnstile: TurnstileVerifier;
  /** VISITOR_TOKEN_TTL_SECONDS. */
  readonly ttlSeconds: number;
}

/** Only `enabled` is read first: a disabled bot's row may carry nulls in every other column. */
const policyEnabledSchema = z.looseObject({ enabled: z.boolean() });

const policyHeadSchema = z.looseObject({
  bot_id: z.uuid(),
  enabled: z.literal(true),
  turnstile_required: z.boolean(),
});

const sessionRowSchema = z.object({
  session_id: z.uuid(),
  token_version: z.int().min(1),
  expires_at: z.string().min(1),
});

/** One row from a set-returning RPC; PostgREST answers an array. Anything else is malformed. */
function singleRow(raw: unknown): unknown {
  return Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
}

const internal = (internalName: string): AppError =>
  new AppError('INTERNAL_ERROR', { internalName });

/** One answer for "no such bot", "bot disabled" and a failed challenge: nothing tells them apart. */
const forbidden = (): AppError => new AppError('FORBIDDEN', { internalName: 'session_refused' });

export function registerSessionRoutes(app: FastifyInstance, deps: SessionsDeps): void {
  const { db, auth, limits, turnstile, ttlSeconds } = deps;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError('session ttl must be a positive integer (seconds)');
  }

  app.post('/v1/sessions', async (request, reply) => {
    // 1. Body. Strict: an unknown field is a client bug or an attack, not something to ignore.
    const body = createSessionRequestSchema.safeParse(request.body);
    if (!body.success) {
      throw new AppError('INVALID_REQUEST', { internalName: 'sessions_body_invalid' });
    }

    // 2. Preflight limit, bot-independent. Over the limit raises RATE_LIMITED with a retry hint.
    await limits.consumeSessionPreflight(request.clientIp);

    // 3. Policy.
    const rawPolicy = await db.rpc<unknown>('get_session_policy', {
      p_bot_slug: body.data.bot_slug,
    });
    if (Array.isArray(rawPolicy) && rawPolicy.length === 0) throw forbidden();
    const policyRow = singleRow(rawPolicy);
    if (policyRow === undefined) throw internal('session_policy_bad_row');
    const enabled = policyEnabledSchema.safeParse(policyRow);
    if (!enabled.success) throw internal('session_policy_bad_row');
    if (!enabled.data.enabled) throw forbidden();
    const head = policyHeadSchema.safeParse(policyRow);
    if (!head.success) throw internal('session_policy_bad_row');
    const policy = head.data;

    // 4. Limits: per bot and IP bucket, then the bot's aggregate. Over a limit raises RATE_LIMITED
    // with a retry hint. The limits service validates the values and fails closed.
    await limits.consumeSessionCreate(policy.bot_id, request.clientIp, {
      session_limit: policy['session_limit'],
      session_window_seconds: policy['session_window_seconds'],
    });
    await limits.consumeSessionCreateBot(policy.bot_id, {
      bot_session_limit: policy['bot_session_limit'],
      bot_session_window_seconds: policy['bot_session_window_seconds'],
    });

    // 5. Challenge. Verified server-side; a missing token, a failure and an outage all refuse.
    if (policy.turnstile_required) {
      const challenge = body.data.challenge_token;
      if (challenge === undefined) throw forbidden();
      if (!(await turnstile.verify(challenge, request.clientIp))) throw forbidden();
    }

    // 6. Session row and token.
    let rawSession: unknown;
    try {
      rawSession = await db.rpc<unknown>('create_visitor_session', {
        p_bot_id: policy.bot_id,
        p_ttl_seconds: ttlSeconds,
      });
    } catch (err) {
      if (err instanceof DbError && err.sqlstate === BOT_DISABLED_SQLSTATE) throw forbidden();
      throw err;
    }
    const session = sessionRowSchema.safeParse(singleRow(rawSession));
    if (!session.success) throw internal('session_row_bad');
    const rowExpiresMs = Date.parse(session.data.expires_at);
    if (!Number.isFinite(rowExpiresMs)) throw internal('session_row_bad');

    const issued = auth.issueToken({
      bot_id: policy.bot_id,
      session_id: session.data.session_id,
      token_version: session.data.token_version,
    });
    // The database row is the authority on expiry; never promise more than it will honour.
    const expiresMs = Math.min(rowExpiresMs, Date.parse(issued.expires_at));
    const response = createSessionResponseSchema.safeParse({
      token: issued.token,
      expires_at: new Date(expiresMs).toISOString(),
    });
    if (!response.success) throw internal('session_response_invalid');

    request.log.info(
      { bot_id: policy.bot_id, session_id: session.data.session_id },
      'visitor session created',
    );
    return reply.status(200).send(response.data);
  });
}
