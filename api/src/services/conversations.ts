// Database access for chat turns (migration 013): the bot's chat context, conversation turns,
// server-side history, and the per-request usage ledger. P7. Every call is a service-role RPC
// from the frozen interface; this module never touches tables directly.
//
// Errors: a database answer that does not match its schema is INTERNAL_ERROR (fail closed).
// RB037 ("not found or not owned") from a turn or history call becomes INVALID_REQUEST with the
// same answer for "no such conversation" and "someone else's conversation", so it is no oracle.
// Nothing here logs; callers log ids, codes and counts only.

import { z } from 'zod';
import {
  handoffReasonSchema,
  messageStatusSchema,
  type HandoffReason,
  type HistoryMessage,
  type MessageStatus,
} from '@ragbot/shared';
import { AppError } from '../lib/errors.js';
import { DbError, type Db } from '../lib/supabase.js';
import type { SourceRow } from './citations.js';

const NOT_FOUND_SQLSTATE = 'RB037';
const INVALID_ARGUMENT_SQLSTATE = '22023';

const internal = (internalName: string): AppError =>
  new AppError('INTERNAL_ERROR', { internalName });

/** One row from a set-returning RPC (PostgREST answers an array); a bare object is accepted too. */
function rowsOf(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
}

// ---------------------------------------------------------------------------
// Chat context
// ---------------------------------------------------------------------------

const optionalText = z.string().nullable();

const contextSchema = z.looseObject({
  bot: z.looseObject({
    id: z.uuid(),
    slug: z.string(),
    enabled: z.boolean(),
    display_name: z.string(),
    identity_prompt: z.string(),
    tone: z.string(),
    scope: z.string(),
    allowed_languages: z.array(z.string()),
    embedding_model: z.string(),
    embedding_dimensions: z.int(),
    settings_version: z.int(),
  }),
  settings: z.looseObject({
    feature_flags: z.record(z.string(), z.unknown()),
    handoff_policy: z.record(z.string(), z.unknown()),
  }),
  contact: z.looseObject({
    supported_languages: z.array(z.string()),
    escalation_label: z.string(),
    escalation_messages: z.record(z.string(), z.string()),
    email: optionalText,
    phone: optionalText,
    whatsapp_url: optionalText,
    page_url: optionalText,
    business_hours: z.record(z.string(), z.string()).nullable(),
    timezone: optionalText,
  }),
});

export type ChatContext = z.output<typeof contextSchema>;

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

const turnRowSchema = z.object({
  conversation_id: z.uuid(),
  user_message_id: z.uuid(),
  prior_no_knowledge: z.int().min(0),
});

export interface StartedTurn {
  readonly conversationId: string;
  readonly userMessageId: string;
  /** Earlier no-knowledge handoffs in this conversation. */
  readonly priorNoKnowledge: number;
}

export interface FinishTurnInput {
  readonly botId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly messageId: string;
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly content: string;
  readonly status: MessageStatus;
  readonly provider: string | null;
  readonly model: string | null;
  readonly handoffReason: HandoffReason | null;
  readonly sources: readonly SourceRow[];
}

const historyRowSchema = z.object({
  id: z.uuid(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  status: messageStatusSchema,
  handoff_reason: handoffReasonSchema.nullable(),
  created_at: z.string().min(1),
  has_more: z.boolean(),
});

export interface HistoryPage {
  readonly messages: readonly HistoryMessage[];
  readonly hasMore: boolean;
}

export interface Conversations {
  loadContext(botId: string): Promise<ChatContext>;
  startTurn(input: {
    botId: string;
    sessionId: string;
    runId: string;
    conversationId: string | null;
    content: string;
  }): Promise<StartedTurn>;
  finishTurn(input: FinishTurnInput): Promise<void>;
  history(input: {
    botId: string;
    sessionId: string;
    conversationId: string;
    before: string | null;
    limit: number;
    signal?: AbortSignal;
  }): Promise<HistoryPage>;
  recordUsage(botId: string, runId: string, entry: UsageEntry): Promise<void>;
}

import type { ConfigCache } from './config-cache.js';

export interface CreateConversationsOptions {
  readonly db: Pick<Db, 'rpc'>;
  readonly configCache?: ConfigCache<ChatContext>;
}

export function createConversations(options: CreateConversationsOptions): Conversations {
  const { db, configCache } = options;

  function mapTurnError(err: unknown): never {
    if (err instanceof DbError) {
      if (err.sqlstate === NOT_FOUND_SQLSTATE) {
        throw new AppError('INVALID_REQUEST', { internalName: 'conversation_not_found' });
      }
      if (err.sqlstate === INVALID_ARGUMENT_SQLSTATE) {
        throw new AppError('INVALID_REQUEST', { internalName: 'chat_turn_invalid' });
      }
    }
    throw err;
  }

  return {
    async loadContext(botId) {
      // C2 — check in-process config cache before DB (bot_id+settings_version key, 30-60s TTL, kill switch).
      if (configCache) {
        // Cheap version fetch would be ideal; without it we still use TTL-only get.
        const hit = configCache.get(botId);
        if (hit !== undefined) return hit;
      }
      const raw = await db.rpc<unknown>('get_chat_context', { p_bot_id: botId });
      const rows = rowsOf(raw);
      const parsed = rows.length === 1 ? contextSchema.safeParse(rows[0]) : undefined;
      if (parsed === undefined || !parsed.success) throw internal('chat_context_bad');
      if (parsed.data.bot.id !== botId) throw internal('chat_context_bad');
      const ctx = parsed.data;
      if (configCache) configCache.set(botId, ctx);
      return ctx;
    },

    async startTurn(input) {
      let raw: unknown;
      try {
        raw = await db.rpc<unknown>(
          'start_chat_turn',
          {
            p_bot_id: input.botId,
            p_visitor_session_id: input.sessionId,
            p_run_id: input.runId,
            p_conversation_id: input.conversationId,
            p_content: input.content,
          },
          undefined,
          { retryOnContention: true },
        );
      } catch (err) {
        return mapTurnError(err);
      }
      const rows = rowsOf(raw);
      const parsed = rows.length === 1 ? turnRowSchema.safeParse(rows[0]) : undefined;
      if (parsed === undefined || !parsed.success) throw internal('start_turn_bad_row');
      return {
        conversationId: parsed.data.conversation_id,
        userMessageId: parsed.data.user_message_id,
        priorNoKnowledge: parsed.data.prior_no_knowledge,
      };
    },

    async finishTurn(input) {
      // Not abortable and not tied to the client: a turn is stored even if the visitor left.
      await db.rpc<unknown>(
        'finish_chat_turn',
        {
          p_bot_id: input.botId,
          p_visitor_session_id: input.sessionId,
          p_run_id: input.runId,
          p_message_id: input.messageId,
          p_conversation_id: input.conversationId,
          p_user_message_id: input.userMessageId,
          p_content: input.content,
          p_status: input.status,
          p_provider: input.provider,
          p_model: input.model,
          p_handoff_reason: input.handoffReason,
          p_sources: input.sources,
        },
        undefined,
        { retryOnContention: true },
      );
    },

    async history(input) {
      let raw: unknown;
      try {
        raw = await db.rpc<unknown>(
          'get_conversation_history',
          {
            p_bot_id: input.botId,
            p_visitor_session_id: input.sessionId,
            p_conversation_id: input.conversationId,
            p_before: input.before,
            p_limit: input.limit,
          },
          input.signal,
        );
      } catch (err) {
        return mapTurnError(err);
      }
      const rows = rowsOf(raw);
      const messages: HistoryMessage[] = [];
      let hasMore = false;
      for (const row of rows) {
        const parsed = historyRowSchema.safeParse(row);
        if (!parsed.success) throw internal('history_bad_row');
        const r = parsed.data;
        const createdMs = Date.parse(r.created_at);
        if (!Number.isFinite(createdMs)) throw internal('history_bad_row');
        hasMore = hasMore || r.has_more;
        messages.push({
          id: r.id,
          role: r.role,
          content: r.content,
          status: r.status,
          ...(r.handoff_reason === null ? {} : { handoff_reason: r.handoff_reason }),
          created_at: new Date(createdMs).toISOString(),
        });
      }
      if (messages.length > input.limit) throw internal('history_too_many_rows');
      return { messages, hasMore };
    },

    async recordUsage(botId, runId, entry) {
      const whole = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
      await db.rpc<unknown>(
        'record_request_usage',
        {
          p_bot_id: botId,
          p_run_id: runId,
          p_provider: entry.provider,
          p_model: entry.model,
          p_operation: entry.operation,
          p_input_tokens: whole(entry.inputTokens),
          p_output_tokens: whole(entry.outputTokens),
          p_estimated_cost: Number.isFinite(entry.cost) && entry.cost > 0 ? entry.cost : 0,
          p_latency_ms: whole(entry.latencyMs),
        },
        undefined,
        { retryOnContention: true },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Usage ledger: one row per provider call of one request
// ---------------------------------------------------------------------------

export interface UsageEntry {
  readonly provider: string;
  readonly model: string;
  readonly operation: 'chat' | 'embedding_query' | 'moderation';
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** USD. */
  readonly cost: number;
  readonly latencyMs: number;
}

/** Where provider-call services report spend. */
export interface UsageSink {
  record(entry: UsageEntry): void;
}

/**
 * Collects the usage of one request and writes each entry to `usage_events` as it arrives. The
 * running total is kept in memory, so the amount to settle never depends on a write succeeding:
 * a failed write is counted (`failedWrites`) and the spend still counts.
 */
export class UsageLedger implements UsageSink {
  readonly #conversations: Pick<Conversations, 'recordUsage'>;
  readonly #botId: string;
  readonly #runId: string;
  readonly #pending: Promise<void>[] = [];
  #total = 0;
  #count = 0;
  #failedWrites = 0;

  constructor(conversations: Pick<Conversations, 'recordUsage'>, botId: string, runId: string) {
    this.#conversations = conversations;
    this.#botId = botId;
    this.#runId = runId;
  }

  record(entry: UsageEntry): void {
    this.#count += 1;
    if (Number.isFinite(entry.cost) && entry.cost > 0) this.#total += entry.cost;
    this.#pending.push(
      this.#conversations.recordUsage(this.#botId, this.#runId, entry).catch(() => {
        this.#failedWrites += 1;
      }),
    );
  }

  /** Waits for every write started so far. Never rejects. */
  async drain(): Promise<void> {
    await Promise.all(this.#pending.splice(0));
  }

  /** Sum of the recorded costs, in USD, rounded to 8 decimals (float noise only). */
  get total(): number {
    return Math.round(this.#total * 1e8) / 1e8;
  }

  get count(): number {
    return this.#count;
  }

  get failedWrites(): number {
    return this.#failedWrites;
  }
}

/**
 * `feature_flags.history_enabled` (ADR 0009): on unless the flag says otherwise. Anything that is
 * present but not the boolean `true` counts as off (fail closed), so a garbled value cannot expose
 * history.
 */
export function historyEnabled(flags: Readonly<Record<string, unknown>>): boolean {
  const value = flags['history_enabled'];
  return value === undefined || value === true;
}
