// Request runs: idempotency, per-session concurrency and run state (TECH_SPECS section 4,
// status section 3a ae and am). P5-B. These are services for P7 to call; P5 adds no chat route.
//
//  * `beginRun` calls `begin_request_run`, which locks the session row, so two concurrent starts of
//    one session cannot both pass the concurrency cap, and one idempotency key cannot start twice.
//  * A duplicate key with the same request hash returns the STORED outcome of a finished run (never
//    regenerates, never spends again), or 409 while the first request is still in progress.
//  * The same key with a different hash is INVALID_REQUEST (400).
//  * State changes go through `set_request_run_state` only, which is conditional in SQL. This
//    module never updates `request_runs` directly.
//
// The module does not log; callers log ids and codes only.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { idempotentReplayResponseSchema, type IdempotentReplayResponse } from '@ragbot/shared';
import { DbError, type Db } from '../lib/supabase.js';
import { AppError } from '../lib/errors.js';
import type { VisitorContext } from './auth.js';

const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

/** Retry hint (seconds) on the 409 sent while the first request with the same key is still running. */
export const RUN_IN_PROGRESS_RETRY_AFTER_SECONDS = 2;

/** States a run can move to through finishRun. Anything else is refused before the database. */
export type TerminalRunState = 'succeeded' | 'failed' | 'partial';
const TERMINAL_STATES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'partial']);

/** Stable JSON: object keys sorted at every depth, arrays in order. Throws on values JSON cannot hold. */
function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('request body holds a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  throw new TypeError('request body holds a value that is not JSON');
}

/** sha256 (64 lowercase hex) of the canonical request body, independent of key order. */
export function requestHash(canonicalBody: unknown): string {
  return createHash('sha256').update(stableJson(canonicalBody), 'utf8').digest('hex');
}

export function isCanonicalIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && IDEMPOTENCY_KEY.test(key);
}

export type BeginRunResult =
  | { readonly kind: 'new'; readonly runId: string }
  /** A finished run for the same key and body: send this stored outcome, do not generate again. */
  | { readonly kind: 'replay'; readonly response: IdempotentReplayResponse };

const beginRowSchema = z.object({
  run_id: z.uuid().nullable(),
  outcome: z.enum(['new', 'duplicate', 'hash_mismatch', 'concurrency_limited']),
});

const runRowSchema = z.object({
  run_state: z.enum(['reserved', 'running', 'succeeded', 'failed', 'partial']),
  conversation_id: z.uuid().nullable(),
  message_id: z.uuid().nullable(),
  message_status: z.enum(['complete', 'partial', 'failed', 'blocked']).nullable(),
});

export interface Runs {
  /**
   * Starts a run for this visitor. Throws AppError: INVALID_REQUEST (400) for a bad key or a hash
   * mismatch, INVALID_REQUEST (409, with a retry hint) while the first request with this key is
   * still running, FORBIDDEN (403) when the bot is disabled (RB039),
   * RATE_LIMITED (429) when the session is at its concurrency cap, INTERNAL_ERROR for a malformed
   * database answer.
   */
  beginRun(visitor: VisitorContext, idempotencyKey: string, hash: string): Promise<BeginRunResult>;
  /** reserved -> running. False when the run was not in a state that allows it (no change made). */
  markRunning(botId: string, runId: string): Promise<boolean>;
  /** reserved or running -> a terminal state. False when the run was already finished (no change). */
  finishRun(botId: string, runId: string, state: TerminalRunState): Promise<boolean>;
}

export interface CreateRunsOptions {
  db: Pick<Db, 'rpc'>;
}

const internal = (internalName: string): AppError =>
  new AppError('INTERNAL_ERROR', { internalName });

export function createRuns(options: CreateRunsOptions): Runs {
  const { db } = options;

  async function setState(botId: string, runId: string, state: string): Promise<boolean> {
    if (!z.uuid().safeParse(botId).success || !z.uuid().safeParse(runId).success) {
      throw new TypeError('expected uuids');
    }
    const result = await db.rpc<unknown>(
      'set_request_run_state',
      { p_bot_id: botId, p_run_id: runId, p_state: state },
      undefined,
      { retryOnContention: true },
    );
    if (typeof result !== 'boolean') throw internal('run_state_bad_result');
    return result;
  }

  async function storedOutcome(botId: string, runId: string): Promise<BeginRunResult> {
    const raw = await db.rpc<unknown>('get_request_run', { p_bot_id: botId, p_run_id: runId });
    const rows = Array.isArray(raw) ? raw : [raw];
    const parsed = rows.length === 1 ? runRowSchema.safeParse(rows[0]) : undefined;
    if (parsed === undefined || !parsed.success) throw internal('run_bad_row');
    const row = parsed.data;
    if (!TERMINAL_STATES.has(row.run_state)) {
      // The first request is still being answered: the client must wait, not retry blindly.
      throw new AppError('INVALID_REQUEST', {
        httpStatus: 409,
        retryAfterSeconds: RUN_IN_PROGRESS_RETRY_AFTER_SECONDS,
        internalName: 'run_in_progress',
      });
    }
    const response = idempotentReplayResponseSchema.safeParse({
      request_id: runId,
      run_state: row.run_state,
      conversation_id: row.conversation_id,
      message_id: row.message_id,
      status: row.message_status,
    });
    if (!response.success) throw internal('run_bad_replay');
    return { kind: 'replay', response: response.data };
  }

  return {
    async beginRun(visitor, idempotencyKey, hash) {
      if (!isCanonicalIdempotencyKey(idempotencyKey)) {
        throw new AppError('INVALID_REQUEST', { internalName: 'idempotency_key_invalid' });
      }
      if (typeof hash !== 'string' || !HASH.test(hash)) throw new TypeError('bad request hash');

      const raw = await db
        .rpc<unknown>(
          'begin_request_run',
          {
            p_bot_id: visitor.bot_id,
            p_visitor_session_id: visitor.session_id,
            p_token_version: visitor.token_version,
            p_idempotency_key: idempotencyKey,
            p_request_hash: hash,
          },
          undefined,
          { retryOnContention: true },
        )
        .catch((err: unknown) => {
          // RB004 here means the visitor session is no longer valid (expired, revoked or rotated).
          if (err instanceof DbError && err.sqlstate === 'RB004') {
            throw new AppError('UNAUTHORIZED', { internalName: 'begin_run_session_invalid' });
          }
          throw err;
        });
      const rows = Array.isArray(raw) ? raw : [raw];
      const parsed = rows.length === 1 ? beginRowSchema.safeParse(rows[0]) : undefined;
      if (parsed === undefined || !parsed.success) throw internal('begin_run_bad_row');
      const { run_id: runId, outcome } = parsed.data;

      switch (outcome) {
        case 'new':
          if (runId === null) throw internal('begin_run_no_id');
          return { kind: 'new', runId };
        case 'duplicate':
          if (runId === null) throw internal('begin_run_no_id');
          return storedOutcome(visitor.bot_id, runId);
        case 'hash_mismatch':
          throw new AppError('INVALID_REQUEST', { internalName: 'idempotency_hash_mismatch' });
        case 'concurrency_limited':
          throw new AppError('RATE_LIMITED', { internalName: 'concurrency_limited' });
      }
    },

    markRunning: (botId, runId) => setState(botId, runId, 'running'),

    async finishRun(botId, runId, state) {
      if (!TERMINAL_STATES.has(state)) throw new TypeError('not a terminal run state');
      return setState(botId, runId, state);
    },
  };
}
