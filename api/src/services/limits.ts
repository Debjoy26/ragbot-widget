// Rate limits and budget reservations (ADR 0007, TECH_SPECS sections 5 and 8). P5-B.
//
// Counters live in Postgres (`record_rate_limit_attempt`, one atomic upsert), never in this
// process: invariant 6. Keys are HMACs (lib/rate-key.ts), so no plain IP or identifier is stored.
// Every limit comes from the database policy and is validated here; a missing or invalid policy is
// INTERNAL_ERROR (fail closed), never a built-in default. This module does not log.
//
// Budget calls go through their own RPCs, each its own transaction, with the opt-in contention
// retry (40P01 / 55P03, once). Callers must update `request_runs` only after a reservation has
// committed (status section 3a bf), which is what separate RPC calls give.

import { z } from 'zod';
import { DbError, type Db } from '../lib/supabase.js';
import { AppError } from '../lib/errors.js';
import { ipBucket, rateKey } from '../lib/rate-key.js';
import type { VisitorContext } from './auth.js';

/**
 * One counter rule: `limit` attempts per fixed window of `window_seconds`. Ranges: the SQL
 * policy checks accept a limit of 1..999999999, and `record_rate_limit_attempt` a window of
 * 1..86400 seconds.
 */
export const rateRuleSchema = z.strictObject({
  limit: z.int().min(1).max(999_999_999),
  window_seconds: z.int().min(1).max(86_400),
});
export type RateRule = z.output<typeof rateRuleSchema>;

/** Per-message limits from `get_rate_policy` (`message_per_session`, `message_per_ip`). */
export const messageRatePolicySchema = z.looseObject({
  message_per_session: rateRuleSchema,
  message_per_ip: rateRuleSchema,
});
export type MessageRatePolicy = z.output<typeof messageRatePolicySchema>;

/** Per bot and IP bucket session-create limit from `get_session_policy`. */
export const sessionCreatePolicySchema = z.object({
  session_limit: z.int().min(1).max(999_999_999),
  session_window_seconds: z.int().min(1).max(86_400),
});
export type SessionCreatePolicy = z.output<typeof sessionCreatePolicySchema>;

/** Per-bot aggregate session-create limit from `get_session_policy` (`rate_policy.session_create_per_bot`). */
export const botSessionCreatePolicySchema = z.object({
  bot_session_limit: z.int().min(1).max(999_999_999),
  bot_session_window_seconds: z.int().min(1).max(86_400),
});
export type BotSessionCreatePolicy = z.output<typeof botSessionCreatePolicySchema>;

const attemptRowSchema = z.object({
  request_count: z.int().min(0),
  allowed: z.boolean(),
  window_start: z.string().min(1),
  window_expires_at: z.string().min(1),
});

const uuidSchema = z.uuid();
const MAX_RESERVATION_TTL_SECONDS = 86_400;

export interface Limits {
  /**
   * Bot-independent per-IP-bucket limit on session creation (SESSION_PREFLIGHT_*), counted before
   * the bot policy is read, so a caller cannot probe slugs or the database without bound. Throws
   * RATE_LIMITED when over.
   */
  consumeSessionPreflight(ip: string): Promise<void>;
  /** Counts one session-create attempt for this bot and IP bucket. Throws RATE_LIMITED when over. */
  consumeSessionCreate(botId: string, ip: string, policy: unknown): Promise<void>;
  /** Counts one session-create attempt against the bot's aggregate limit. Throws RATE_LIMITED when over. */
  consumeSessionCreateBot(botId: string, policy: unknown): Promise<void>;
  /** The message rate policy of a bot, validated. Throws INTERNAL_ERROR when missing or invalid. */
  loadMessagePolicy(botId: string): Promise<MessageRatePolicy>;
  /**
   * Counts one message: per session first, then per IP bucket. Throws RATE_LIMITED when either is
   * over, and INTERNAL_ERROR (before any counting) when `ratePolicy` is missing or invalid.
   */
  consumeMessage(visitor: VisitorContext, ip: string, ratePolicy: unknown): Promise<void>;
  /** Reserves budget for a run (the run id is the request id). Returns the reservation id. */
  reserve(botId: string, runId: string, amount: number, ttlSeconds: number): Promise<string>;
  settle(botId: string, reservationId: string, actualAmount: number): Promise<void>;
  release(botId: string, reservationId: string): Promise<void>;
}

export interface CreateLimitsOptions {
  db: Pick<Db, 'rpc'>;
  /** RATE_LIMIT_KEY_SECRET. */
  rateKeySecret: string;
  /** SESSION_PREFLIGHT_PER_IP_LIMIT and SESSION_PREFLIGHT_WINDOW_SECONDS. Required, no default. */
  sessionPreflight: RateRule;
  /** Clock in epoch milliseconds, for the retry-after hint. Injected for tests. */
  now?: () => number;
}

const internal = (internalName: string): AppError =>
  new AppError('INTERNAL_ERROR', { internalName });

export function createLimits(options: CreateLimitsOptions): Limits {
  const { db, rateKeySecret } = options;
  const preflightRule = rateRuleSchema.safeParse(options.sessionPreflight);
  if (!preflightRule.success) throw new TypeError('session preflight limit is required and valid');
  const sessionPreflight = preflightRule.data;
  const now = options.now ?? Date.now;
  if (typeof rateKeySecret !== 'string' || rateKeySecret.length === 0) {
    throw new TypeError('rate limit key secret is required');
  }
  // Fail at construction, not at the first request, if the secret is unusable.
  rateKey(rateKeySecret, 'message_ip', ['self-test']);

  /** Counts one attempt and throws RATE_LIMITED, with a retry hint, when it is over the limit. */
  async function consume(key: string, rule: RateRule): Promise<void> {
    const raw = await db.rpc<unknown>(
      'record_rate_limit_attempt',
      { p_key_hash: key, p_window_seconds: rule.window_seconds, p_limit: rule.limit },
      undefined,
      { retryOnContention: true },
    );
    const rows = Array.isArray(raw) ? raw : [raw];
    const parsed = rows.length === 1 ? attemptRowSchema.safeParse(rows[0]) : undefined;
    if (parsed === undefined || !parsed.success) throw internal('rate_limit_bad_row');
    if (parsed.data.allowed) return;
    const expiresMs = Date.parse(parsed.data.window_expires_at);
    // An unreadable expiry still refuses; the hint falls back to the whole window.
    const retryAfter = Number.isFinite(expiresMs)
      ? Math.max(1, Math.ceil((expiresMs - now()) / 1000))
      : rule.window_seconds;
    throw new AppError('RATE_LIMITED', {
      retryAfterSeconds: Math.min(retryAfter, rule.window_seconds),
      internalName: 'rate_limited',
    });
  }

  function parsePolicy<S extends z.ZodType>(schema: S, value: unknown, name: string): z.output<S> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw internal(name);
    return parsed.data;
  }

  function checkUuid(value: string): void {
    if (!uuidSchema.safeParse(value).success) throw new TypeError('expected a uuid');
  }

  return {
    async consumeSessionPreflight(ip) {
      await consume(rateKey(rateKeySecret, 'session_preflight', [ipBucket(ip)]), sessionPreflight);
    },

    async consumeSessionCreate(botId, ip, policy) {
      const p = parsePolicy(sessionCreatePolicySchema, policy, 'session_policy_invalid');
      await consume(rateKey(rateKeySecret, 'session_create_ip', [botId, ipBucket(ip)]), {
        limit: p.session_limit,
        window_seconds: p.session_window_seconds,
      });
    },

    async consumeSessionCreateBot(botId, policy) {
      const p = parsePolicy(botSessionCreatePolicySchema, policy, 'session_policy_invalid');
      await consume(rateKey(rateKeySecret, 'session_create_bot', [botId]), {
        limit: p.bot_session_limit,
        window_seconds: p.bot_session_window_seconds,
      });
    },

    async loadMessagePolicy(botId) {
      const raw = await db.rpc<unknown>('get_rate_policy', { p_bot_id: botId });
      return parsePolicy(messageRatePolicySchema, raw, 'rate_policy_invalid');
    },

    async consumeMessage(visitor, ip, ratePolicy) {
      const policy = parsePolicy(messageRatePolicySchema, ratePolicy, 'rate_policy_invalid');
      // Session first: it is the precise signal. The address is shared (NAT) and spoofable, so it
      // is the coarser second check, and a refused session does not spend IP allowance.
      await consume(
        rateKey(rateKeySecret, 'message_session', [visitor.bot_id, visitor.session_id]),
        policy.message_per_session,
      );
      await consume(
        rateKey(rateKeySecret, 'message_ip', [visitor.bot_id, ipBucket(ip)]),
        policy.message_per_ip,
      );
    },

    async reserve(botId, runId, amount, ttlSeconds) {
      checkUuid(botId);
      checkUuid(runId);
      if (!Number.isFinite(amount) || amount <= 0) throw new TypeError('amount must be positive');
      if (
        !Number.isInteger(ttlSeconds) ||
        ttlSeconds < 1 ||
        ttlSeconds > MAX_RESERVATION_TTL_SECONDS
      ) {
        throw new TypeError('ttl must be 1..86400 seconds');
      }
      const id = await db
        .rpc<unknown>(
          'reserve_request_budget',
          { p_bot_id: botId, p_request_id: runId, p_amount: amount, p_ttl_seconds: ttlSeconds },
          undefined,
          { retryOnContention: true },
        )
        .catch((err: unknown) => {
          // RB004 here: the run does not exist for this bot, is no longer live, or its reservation
          // cannot be reused. The caller has just created or held that run, so this is a state
          // fault in this service, not a visitor error: INTERNAL_ERROR. (RB039, a disabled bot,
          // and RB001, over budget, keep their own mapping in the error handler.)
          if (err instanceof DbError && err.sqlstate === 'RB004') {
            throw internal('reserve_run_not_active');
          }
          throw err;
        });
      if (typeof id !== 'string' || !uuidSchema.safeParse(id).success) {
        throw internal('reservation_bad_id');
      }
      return id;
    },

    async settle(botId, reservationId, actualAmount) {
      checkUuid(botId);
      checkUuid(reservationId);
      if (!Number.isFinite(actualAmount) || actualAmount < 0) {
        throw new TypeError('amount must not be negative');
      }
      await db.rpc<unknown>(
        'settle_budget_reservation',
        { p_bot_id: botId, p_reservation_id: reservationId, p_actual_amount: actualAmount },
        undefined,
        { retryOnContention: true },
      );
    },

    async release(botId, reservationId) {
      checkUuid(botId);
      checkUuid(reservationId);
      await db.rpc<unknown>(
        'release_budget_reservation',
        { p_bot_id: botId, p_reservation_id: reservationId },
        undefined,
        { retryOnContention: true },
      );
    },
  };
}
