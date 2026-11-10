// POST /v1/chat orchestration (TECH_SPECS sections 4 and 6.1, ARCHITECTURE section 3). P7.
//
// Two phases, so the route can answer with JSON before any byte of SSE is written:
//
//  prepare()  steps 3-6  context, disabled-bot and slug checks, embedding model guard, reserve the
//                        worst-case budget, start_chat_turn, mark the run running. ANY failure here
//                        releases the reservation, marks the run failed, and rethrows an AppError:
//                        the route answers with the JSON envelope and nothing has been spent.
//  run()      steps 7-20 `meta`, input moderation in parallel with the query embedding, the
//                        handoff triggers, retrieval, prompt, generation with retry and fallback,
//                        header hold-back, citations, de-linking, output moderation, persistence,
//                        usage, settlement, then `done`. run() never throws: every failure becomes
//                        an `error` event, a stored message and a closed run.
//
// Invariants kept here (handover section 4):
//  * Browser input is the question and an optional language hint only. History, evidence, system
//    prompt and contact details are server-side.
//  * Contact values and the handoff message are configuration, never model text.
//  * The first line of the model reply (the evidence header) is never streamed.
//  * Nothing leaves the server before it has passed output moderation (buffer: the whole answer;
//    rolling: each batch). Blocked text is never released.
//  * Spend: reserve first; one usage row per provider call, failed and fallback calls included;
//    settle at the usage sum, release only when nothing was spent.
//  * A run never stays reserved or running: every path ends in finishRun.
//  * Logs: ids, codes, counts and timings only. No message, evidence, history or model text.

import { randomUUID } from 'node:crypto';
import {
  isRetryableErrorKind,
  parseEvidenceHeader,
  toErrorEnvelope,
  type ChatRequest,
  type EmbeddingProvider,
  type ErrorCode,
  type HandoffReason,
  type MessageStatus,
  type ProviderChatMessage,
  ProviderError,
} from '@ragbot/shared';
import type { AppConfig } from '../lib/config.js';
import { AppError, toAppError } from '../lib/errors.js';
import { DbError } from '../lib/supabase.js';
import type { SseWriter } from '../lib/sse.js';
import type { VisitorContext } from './auth.js';
import {
  buildAllowList,
  buildSources,
  type BuiltSources,
  citedChunkIds,
  delink,
  SafeTextStream,
  type AllowList,
} from './citations.js';
import {
  UsageLedger,
  type ChatContext,
  type Conversations,
  type UsageEntry,
} from './conversations.js';
import {
  contactCard,
  escalationMessage,
  matchesHumanRequest,
  noKnowledgeReason,
  parseHandoffPolicy,
  planHandoff,
  resolveLanguage,
  type HandoffPlan,
  type HandoffPolicy,
} from './handoff.js';
import {
  assemblePrompt,
  CHARS_PER_TOKEN,
  defaultSleep,
  estimateTokens,
  LlmAborted,
  LlmFailure,
  selectHistory,
  STREAM_RETRY_AFTER_SECONDS,
  worstCaseChatCost,
  worstCaseTokens,
  type Llm,
  type LlmAttempt,
} from './llm.js';
import {
  ModerationFailure,
  worstCaseModerationCost,
  type ModerationMode,
  type Moderator,
} from './moderation.js';
import {
  createOutputGate,
  OutputBlocked,
  type OutputGate,
  ROLLING_BATCH_CHARS,
  type OutputMode,
} from './output-moderation.js';
import type { EmbeddedQuery, RetrievedChunk, Retrieval } from './retrieval.js';
import type { Limits } from './limits.js';
import type { Runs } from './runs.js';

/** If the first line of the reply has not ended after this many characters it is not a header. */
export const HEADER_MAX_CHARS = 200;
/** Smallest reservation the budget accepts (it must be positive). */
const MIN_RESERVATION_USD = 0.000001;
const MIN_HEARTBEAT_MS = 1_000;
/** Input moderation and the query embedding each get one retry on a transient failure. */
const INPUT_STAGE_CALLS = 2;
const INPUT_RETRY_DELAY_MS = 300;

export type ChatConfig = Pick<
  AppConfig,
  | 'chatDeadlineMs'
  | 'connectionTimeoutMs'
  | 'chatContextMaxTokens'
  | 'chatHistoryMaxMessages'
  | 'chatMaxOutputTokens'
  | 'chatMaxOutputChars'
  | 'chatProviderAttempts'
  | 'chatReservationTtlSeconds'
  | 'chatPrice'
  | 'chatFallbackPrice'
  | 'moderationPrice'
  | 'embeddingPricePerMillionTokens'
>;

/** The subset of the request logger used here. */
export interface ChatLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface ChatDeps {
  readonly config: ChatConfig;
  readonly conversations: Conversations;
  readonly limits: Pick<Limits, 'reserve' | 'settle' | 'release'>;
  readonly runs: Pick<Runs, 'markRunning' | 'finishRun'>;
  readonly retrieval: Retrieval;
  readonly llm: Llm;
  readonly moderator: Moderator;
  readonly moderationMode: ModerationMode;
  /** The query embedding provider; its model must equal the bot's embedding model. */
  readonly embedding: Pick<EmbeddingProvider, 'provider' | 'model' | 'dimensions'>;
  readonly now?: () => number;
  /** Waits before the one retry of the input stage; abortable. Injected for tests. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface PrepareInput {
  readonly visitor: VisitorContext;
  /** The context `checkBot` returned for this request. */
  readonly ctx: ChatContext;
  readonly runId: string;
  readonly body: ChatRequest;
  /** When the HTTP request started; CHAT_DEADLINE_MS counts from here. */
  readonly startedAt: number;
}

export interface PreparedTurn {
  readonly botId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly messageId: string;
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly priorNoKnowledge: number;
  /** False for the first turn of a new conversation (nothing to load as history). */
  readonly hadConversation: boolean;
  readonly reservationId: string;
  readonly ctx: ChatContext;
  readonly message: string;
  readonly language: string | undefined;
  readonly outputMode: OutputMode;
  readonly policy: HandoffPolicy;
  readonly startedAt: number;
}

export interface RunIo {
  /** Headers and meta are written by run(); the writer must not have been started. */
  readonly sse: SseWriter;
  readonly log: ChatLogger;
  /** Aborted when the client disconnects. */
  readonly clientSignal: AbortSignal;
  /** Headers for the SSE response (security, CORS, request id). */
  readonly headers: Readonly<Record<string, string | number | readonly string[] | undefined>>;
}

export interface ChatService {
  /**
   * Loads the bot's context and refuses (403) a disabled bot or a `bot_slug` that is not the
   * token's bot. The route calls it before the rate limit and the run, so a mismatched request
   * counts against nothing and creates no run.
   */
  checkBot(visitor: VisitorContext, botSlug: string): Promise<ChatContext>;
  prepare(input: PrepareInput): Promise<PreparedTurn>;
  run(turn: PreparedTurn, io: RunIo): Promise<void>;
}

type Terminal =
  | {
      readonly kind: 'answer';
      readonly cited: readonly string[];
      /** Stopped at the output-token limit or the output character cap: stored as partial. */
      readonly truncated: boolean;
    }
  | {
      readonly kind: 'handoff';
      readonly plan: HandoffPlan;
      readonly status: 'complete' | 'blocked';
    }
  | {
      readonly kind: 'error';
      readonly code: ErrorCode;
      readonly retryAfterSeconds: number | undefined;
      /** Send a handoff with reason `unavailable` after the error. */
      readonly unavailable: boolean;
      readonly internal: string;
    }
  /** Output moderation blocked text after part of the answer was already released. */
  | { readonly kind: 'cut' }
  | { readonly kind: 'aborted' };

const internal = (internalName: string): AppError =>
  new AppError('INTERNAL_ERROR', { internalName });

function outputModeOf(flags: Readonly<Record<string, unknown>>): OutputMode {
  const value = flags['output_moderation_mode'];
  if (value === undefined) return 'rolling'; // ADR 0004 default
  if (value === 'buffer' || value === 'rolling') return value;
  throw internal('output_mode_bad');
}

export function createChatService(deps: ChatDeps): ChatService {
  const { config, conversations, limits, runs, retrieval, llm, moderator } = deps;
  const now = deps.now ?? Date.now;

  const sleep = deps.sleep ?? defaultSleep;

  /**
   * Worst-case USD for one request: reserved before any provider call. It covers
   *  * every chat attempt: CHAT_PROVIDER_ATTEMPTS for each configured provider, each with a full
   *    prompt (CHAT_CONTEXT_MAX_TOKENS at the budget's 3 characters per token is the longest
   *    prompt that can be sent, counted here at 1 character = 1 token) and the full output cap;
   *  * input moderation and the query embedding, twice each (one retry);
   *  * output moderation of an answer of CHAT_MAX_OUTPUT_CHARS characters (1 char = 1 token), in
   *    rolling batches or one call, each call with the classifier's real prompt and output cap.
   */
  function reservationAmount(messageChars: number, mode: OutputMode): number {
    const promptTokens = worstCaseTokens(config.chatContextMaxTokens * CHARS_PER_TOKEN);
    const prices = [
      config.chatPrice,
      ...(config.chatFallbackPrice === null ? [] : [config.chatFallbackPrice]),
    ];
    let chat = 0;
    for (const price of prices) {
      chat +=
        config.chatProviderAttempts *
        worstCaseChatCost(promptTokens, config.chatMaxOutputTokens, price);
    }
    const outputChars = config.chatMaxOutputChars;
    const outputCalls = mode === 'buffer' ? 1 : Math.ceil(outputChars / ROLLING_BATCH_CHARS) + 1;
    const total =
      INPUT_STAGE_CALLS *
        worstCaseModerationCost(messageChars, deps.moderationMode, config.moderationPrice, 1) +
      (INPUT_STAGE_CALLS * worstCaseTokens(messageChars) * config.embeddingPricePerMillionTokens) /
        1_000_000 +
      chat +
      worstCaseModerationCost(
        outputChars,
        deps.moderationMode,
        config.moderationPrice,
        outputCalls,
      );
    return Math.max(MIN_RESERVATION_USD, Math.ceil(total * 1e6) / 1e6);
  }

  async function checkBot(visitor: VisitorContext, botSlug: string): Promise<ChatContext> {
    const ctx = await conversations.loadContext(visitor.bot_id);
    // A disabled bot and a slug that is not the token's bot get the same answer.
    if (!ctx.bot.enabled || ctx.bot.slug !== botSlug) {
      throw new AppError('FORBIDDEN', { internalName: 'chat_bot_refused' });
    }
    return ctx;
  }

  async function prepare(input: PrepareInput): Promise<PreparedTurn> {
    const { visitor, runId, body } = input;
    let reservationId: string | null = null;
    try {
      const { ctx } = input;
      // Checked again here so prepare() is safe on its own; the route has already called checkBot.
      if (ctx.bot.id !== visitor.bot_id || !ctx.bot.enabled || ctx.bot.slug !== body.bot_slug) {
        throw new AppError('FORBIDDEN', { internalName: 'chat_bot_refused' });
      }
      const policy = parseHandoffPolicy(ctx.settings.handoff_policy);
      const outputMode = outputModeOf(ctx.settings.feature_flags);
      // ADR 0013: every handoff needs a contact channel and a message to show. A bot without
      // them is a configuration fault: refuse before anything is spent, never send a blank reply.
      if (contactCard(ctx) === null || escalationMessage(ctx, undefined) === '') {
        throw internal('handoff_config_missing');
      }

      // Embedding model guard: queries use the corpus's model or the request fails. No switch.
      if (
        ctx.bot.embedding_model !== deps.embedding.model ||
        ctx.bot.embedding_dimensions !== deps.embedding.dimensions
      ) {
        throw internal('embedding_model_mismatch');
      }

      reservationId = await limits.reserve(
        visitor.bot_id,
        runId,
        reservationAmount(body.message.length, outputMode),
        config.chatReservationTtlSeconds,
      );
      const started = await conversations.startTurn({
        botId: visitor.bot_id,
        sessionId: visitor.session_id,
        runId,
        conversationId: body.conversation_id,
        content: body.message,
      });
      if (!(await runs.markRunning(visitor.bot_id, runId))) throw internal('run_not_markable');

      return {
        botId: visitor.bot_id,
        sessionId: visitor.session_id,
        runId,
        messageId: randomUUID(),
        conversationId: started.conversationId,
        userMessageId: started.userMessageId,
        priorNoKnowledge: started.priorNoKnowledge,
        hadConversation: body.conversation_id !== null,
        reservationId,
        ctx,
        message: body.message,
        language: resolveLanguage(body.preferred_language, ctx.contact.supported_languages),
        outputMode,
        policy,
        startedAt: input.startedAt,
      };
    } catch (err) {
      // Nothing was spent: give the reservation back and close the run, best effort.
      if (reservationId !== null) {
        await limits.release(visitor.bot_id, reservationId).catch(() => undefined);
      }
      await runs.finishRun(visitor.bot_id, runId, 'failed').catch(() => undefined);
      throw err;
    }
  }

  async function run(turn: PreparedTurn, io: RunIo): Promise<void> {
    const { sse, log, clientSignal } = io;
    const { ctx } = turn;
    const logBase = { run_id: turn.runId, bot_id: turn.botId, session_id: turn.sessionId };
    const ledger = new UsageLedger(conversations, turn.botId, turn.runId);
    const work: Promise<unknown>[] = [];

    // Cancellation: the client leaving, the total deadline, and a deliberate stop of generation.
    const deadlineCtl = new AbortController();
    const remaining = Math.max(0, config.chatDeadlineMs - (now() - turn.startedAt));
    const deadlineTimer = setTimeout(() => deadlineCtl.abort(), remaining);
    const stopCtl = new AbortController();
    const workSignal = AbortSignal.any([clientSignal, deadlineCtl.signal]);
    const heartbeat = setInterval(
      () => sse.keepAlive(),
      Math.max(MIN_HEARTBEAT_MS, Math.floor(config.connectionTimeoutMs / 3)),
    );
    deadlineTimer.unref();
    heartbeat.unref();

    const out = { text: '', deltas: 0 };
    const raw = { text: '' };
    let lastAttempt = null as LlmAttempt | null;
    let evidenceForSources: ReadonlyMap<string, RetrievedChunk> = new Map();
    const allow: AllowList = buildAllowList(contactCard(ctx) ?? {});
    // The allowlist keeps the configured contact values in an excerpt from being de-linked (P7-D1-B).
    const sourcesFor = (cited: readonly string[]): BuiltSources =>
      buildSources(cited, evidenceForSources, allow);
    const safeSend = async (event: Parameters<SseWriter['send']>[0]): Promise<boolean> => {
      // `error` and `done` end the stream: no keep-alive comment may follow them.
      if (event.event === 'error' || event.event === 'done') clearInterval(heartbeat);
      try {
        return await sse.send(event);
      } catch {
        log.error({ ...logBase, code: 'sse_protocol' }, 'sse event refused');
        return false;
      }
    };

    /** Writes text as `delta` events and remembers what the visitor was shown. */
    async function deliver(text: string, isConfig: boolean): Promise<void> {
      const shown = isConfig ? text : delink(text, allow);
      if (shown === '') return;
      out.text += shown;
      out.deltas += 1;
      await safeSend({ event: 'delta', data: { text: shown } });
    }

    function interruptedTerminal(internalName: string, retryAfter: number | undefined): Terminal {
      return {
        kind: 'error',
        code: 'STREAM_INTERRUPTED',
        retryAfterSeconds: retryAfter,
        unavailable: false,
        internal: internalName,
      };
    }

    function unavailableTerminal(internalName: string, retryAfter?: number): Terminal {
      return {
        kind: 'error',
        code: 'PROVIDER_UNAVAILABLE',
        retryAfterSeconds: retryAfter,
        unavailable: true,
        internal: internalName,
      };
    }

    async function handoffTerminal(
      reason: HandoffReason,
      status: 'complete' | 'blocked',
    ): Promise<Terminal> {
      const plan = planHandoff(reason, ctx, turn.language, turn.policy);
      if (plan.omitted === 'message_missing') {
        log.warn(
          { ...logBase, code: 'handoff_message_missing', reason },
          'handoff message missing',
        );
      }
      if (plan.omitted === 'contact_missing') {
        log.warn(
          { ...logBase, code: 'handoff_contact_missing', reason },
          'handoff contact missing',
        );
      }
      await deliver(plan.message, true);
      return { kind: 'handoff', plan, status };
    }

    /** Turns anything thrown during the pipeline into a terminal state. */
    function classify(err: unknown): Terminal {
      if (clientSignal.aborted || err instanceof LlmAborted) return { kind: 'aborted' };
      // Once a delta was sent, a failure interrupts the answer; before that nothing was shown.
      const released = out.deltas > 0;
      if (err instanceof LlmFailure) {
        if (err.reason === 'interrupted') {
          return interruptedTerminal(`llm_${err.kind}`, err.retryAfterSeconds);
        }
        return unavailableTerminal(`llm_${err.kind}`, err.retryAfterSeconds);
      }
      if (err instanceof ModerationFailure) {
        return released
          ? interruptedTerminal(`moderation_${err.kind}`, moderationRetryHint(err))
          : unavailableTerminal(`moderation_${err.kind}`);
      }
      if (deadlineCtl.signal.aborted) {
        return released
          ? interruptedTerminal('deadline', STREAM_RETRY_AFTER_SECONDS)
          : unavailableTerminal('deadline');
      }
      if (err instanceof ProviderError) return unavailableTerminal(`provider_${err.kind}`);
      const app = toAppError(err);
      return {
        kind: 'error',
        code: app.code,
        retryAfterSeconds: app.retryAfterSeconds,
        unavailable: app.code === 'PROVIDER_UNAVAILABLE',
        internal: app.internalName ?? 'unexpected',
      };
    }

    /** A retry hint only for kinds that a later retry can fix. */
    function moderationRetryHint(err: ModerationFailure): number | undefined {
      return err.kind !== 'unexpected' && isRetryableErrorKind(err.kind)
        ? STREAM_RETRY_AFTER_SECONDS
        : undefined;
    }

    /** Rejects when `signal` aborts, even if `promise` never settles (a provider that ignores it). */
    function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
      if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
      return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(new DOMException('aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
          (value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
          },
          (err: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(err);
          },
        );
      });
    }

    /** One retry of a call that failed with a transient error, if time and the signal allow. */
    async function withOneRetry<T>(
      call: () => Promise<T>,
      transient: (err: unknown) => boolean,
      signal: AbortSignal,
    ): Promise<T> {
      try {
        return await call();
      } catch (err) {
        if (signal.aborted || !transient(err)) throw err;
        // The retry must still fit inside the total deadline.
        if (now() - turn.startedAt + INPUT_RETRY_DELAY_MS >= config.chatDeadlineMs) throw err;
        await sleep(INPUT_RETRY_DELAY_MS, signal);
        if (signal.aborted) throw err;
        return await call();
      }
    }

    /** Query embedding with its own usage row. Resolves or rejects; never leaves a call unrecorded. */
    async function embedQuery(signal: AbortSignal): Promise<EmbeddedQuery> {
      const started = now();
      const row = (tokens: number): UsageEntry => ({
        provider: deps.embedding.provider,
        model: deps.embedding.model,
        operation: 'embedding_query',
        inputTokens: tokens,
        outputTokens: 0,
        cost: (tokens * config.embeddingPricePerMillionTokens) / 1_000_000,
        latencyMs: Math.max(0, now() - started),
      });
      try {
        const query = await retrieval.embedQuery(turn.message, signal);
        ledger.record(row(query.inputTokens ?? estimateTokens(turn.message.length)));
        return query;
      } catch (err) {
        ledger.record(
          row(err instanceof ProviderError && err.billed ? estimateTokens(turn.message.length) : 0),
        );
        throw err;
      }
    }

    /**
     * Step 8: input moderation in parallel with the query embedding. Whatever way this stage ends
     * (a verdict, a failure, the deadline, the client leaving) the work still running is aborted in
     * the `finally`, and nothing here waits for a provider that ignores the abort.
     */
    async function inputStage(
      humanRequested: boolean,
    ): Promise<{ verdict: 'allow' | 'block'; query: EmbeddedQuery | null }> {
      const modCtl = new AbortController();
      const embedCtl = new AbortController();
      const modSignal = AbortSignal.any([workSignal, modCtl.signal]);
      const embedSignal = AbortSignal.any([workSignal, embedCtl.signal]);
      // A request that plainly asks for a person does not need the embedding.
      const embedPromise = humanRequested
        ? null
        : withOneRetry(
            () => embedQuery(embedSignal),
            (err) => err instanceof ProviderError && err.isRetryable(),
            embedSignal,
          );
      let embedFailure: { readonly err: unknown } | null = null;
      if (embedPromise !== null) {
        work.push(embedPromise.catch(() => undefined));
        embedPromise.catch((err: unknown) => {
          // An embedding that failed on its own ends the request: stop waiting for moderation.
          if (!embedSignal.aborted) {
            embedFailure = { err };
            modCtl.abort();
          }
        });
      }
      try {
        let verdict: 'allow' | 'block';
        try {
          verdict = await raceAbort(
            withOneRetry(
              () => moderator.moderate(turn.message, modSignal, ledger),
              (err) =>
                err instanceof ModerationFailure &&
                err.kind !== 'unexpected' &&
                isRetryableErrorKind(err.kind),
              modSignal,
            ),
            modSignal,
          );
        } catch (err) {
          const failure = embedFailure as { readonly err: unknown } | null;
          if (failure !== null && !workSignal.aborted) throw failure.err;
          throw err;
        }
        if (verdict === 'block' || embedPromise === null) return { verdict, query: null };
        return { verdict, query: await raceAbort(embedPromise, embedSignal) };
      } finally {
        modCtl.abort();
        embedCtl.abort();
      }
    }

    /** Steps 8-17: everything between `meta` and the final events. */
    async function pipeline(): Promise<Terminal> {
      // A client that is already gone never causes a provider call.
      if (clientSignal.aborted) return { kind: 'aborted' };
      const humanRequested = matchesHumanRequest(turn.message);
      const stage = await inputStage(humanRequested);

      // 9. Blocked: the policy message and a handoff. Nothing is retrieved or generated.
      if (stage.verdict === 'block') return handoffTerminal('blocked', 'blocked');
      // 10. The visitor asks for a person: answer with the contact card, no retrieval or model.
      if (stage.query === null) return handoffTerminal('human_requested', 'complete');
      if (clientSignal.aborted) return { kind: 'aborted' };

      // 11. Retrieval. No evidence above the threshold means no generation.
      const query = stage.query;
      const chunks = await retrieval.match(turn.botId, query.vector, workSignal);
      if (clientSignal.aborted) return { kind: 'aborted' };
      const missReason = noKnowledgeReason(turn.priorNoKnowledge, turn.policy);
      if (chunks.length === 0) return handoffTerminal(missReason, 'complete');

      // 12. Prompt: bounded server-side history (the new question is already stored; drop it).
      const history = await loadHistory();
      const assembled = assemblePrompt({
        bot: {
          display_name: ctx.bot.display_name,
          identity_prompt: ctx.bot.identity_prompt,
          tone: ctx.bot.tone,
          scope: ctx.bot.scope,
          allowed_languages: ctx.bot.allowed_languages,
          settings_version: ctx.bot.settings_version,
        },
        question: turn.message,
        chunks,
        history,
        preferredLanguage: turn.language,
        maxTokens: config.chatContextMaxTokens,
      });
      if (assembled.evidence.length === 0) return handoffTerminal(missReason, 'complete');
      log.info(
        {
          ...logBase,
          chunk_count: chunks.length,
          evidence: assembled.evidence.length,
          history_count: assembled.historyCount,
          prompt_tokens: assembled.estimatedTokens,
        },
        'chat prompt built',
      );
      return generate(assembled, missReason);
    }

    async function loadHistory(): Promise<ProviderChatMessage[]> {
      const max = config.chatHistoryMaxMessages;
      if (max === 0 || !turn.hadConversation) return [];
      // Over-fetch (the question just stored comes back as the newest row, and blocked or
      // incomplete turns are dropped below) but stay inside the database function's limit of 100.
      const page = await conversations.history({
        botId: turn.botId,
        sessionId: turn.sessionId,
        conversationId: turn.conversationId,
        before: null,
        limit: Math.min(100, max * 2 + 1),
        signal: workSignal,
      });
      return selectHistory(
        page.messages.filter((m) => m.id !== turn.userMessageId),
        max,
      );
    }

    /** Steps 13-17. */
    async function generate(
      assembled: ReturnType<typeof assemblePrompt>,
      missReason: 'no_knowledge' | 'repeated_no_knowledge',
    ): Promise<Terminal> {
      const evidence = new Map<string, RetrievedChunk>(
        assembled.evidence.map((c) => [c.chunk_id, c]),
      );
      const newGate = (): OutputGate =>
        createOutputGate({
          mode: turn.outputMode,
          moderator,
          signal: workSignal,
          usage: ledger,
        });
      let gate = newGate();
      let safeText = new SafeTextStream();
      let header = '';
      let outcome: ReturnType<typeof parseEvidenceHeader>['outcome'] | undefined;
      /** Characters of answer text taken so far, against CHAT_MAX_OUTPUT_CHARS. */
      let bodyChars = 0;
      let capped = false;
      const stream = llm.generate(
        {
          system: assembled.prompt.system,
          messages: assembled.prompt.messages,
          maxOutputTokens: config.chatMaxOutputTokens,
          estimatedInputTokens: assembled.chars,
        },
        {
          client: clientSignal,
          deadline: deadlineCtl.signal,
          stop: stopCtl.signal,
          // Retry and fallback are allowed exactly while no delta has been sent.
          released: () => out.deltas > 0,
          // A failed attempt's held-back text (header, buffer, markers) is thrown away with it.
          onRestart: () => {
            header = '';
            outcome = undefined;
            raw.text = '';
            bodyChars = 0;
            safeText = new SafeTextStream();
            gate = newGate();
          },
          onAttempt: (attempt) => {
            lastAttempt = attempt;
            ledger.record({
              provider: attempt.provider,
              model: attempt.model,
              operation: 'chat',
              inputTokens: attempt.inputTokens,
              outputTokens: attempt.outputTokens,
              cost: attempt.cost,
              latencyMs: attempt.latencyMs,
            });
            if (attempt.outcome !== 'ok') {
              log.warn(
                {
                  ...logBase,
                  code: 'llm_attempt_failed',
                  kind: attempt.errorKind,
                  outcome: attempt.outcome,
                },
                'chat provider attempt did not complete',
              );
            }
          },
        },
      );

      /**
       * Body text of an answer: strip markers, hold for moderation, de-link, send. Text beyond
       * CHAT_MAX_OUTPUT_CHARS is cut off (never in the middle of a surrogate pair) and the
       * stream is stopped: the answer is stored as partial.
       */
      const handleBody = async (text: string): Promise<void> => {
        if (text === '' || capped) return;
        let taken = text;
        const room = config.chatMaxOutputChars - bodyChars;
        if (taken.length > room) {
          let end = Math.max(0, room);
          const last = taken.charCodeAt(end - 1);
          if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
          taken = taken.slice(0, end);
          capped = true;
          stopCtl.abort();
        }
        bodyChars += taken.length;
        raw.text += taken;
        const piece = safeText.push(taken);
        if (piece !== '') await deliver(await gate.push(piece), false);
      };

      try {
        for await (const chunk of stream) {
          if (clientSignal.aborted) return { kind: 'aborted' };
          if (outcome === undefined) {
            // 14. The first line is held back until it is complete: it is never streamed.
            header += chunk;
            const newline = header.indexOf('\n');
            if (newline === -1) {
              if (header.length <= HEADER_MAX_CHARS) continue;
              outcome = null; // no header line within the bound: garbled
            } else {
              const parsed = parseEvidenceHeader(header);
              outcome = parsed.outcome;
              if (outcome === 'answer') await handleBody(parsed.body);
            }
            if (outcome !== 'answer') {
              stopCtl.abort(); // the rest of the reply is not wanted
              break;
            }
            if (capped) break;
            continue;
          }
          await handleBody(chunk);
          if (capped) break;
        }
        if (clientSignal.aborted) return { kind: 'aborted' };

        if (outcome === undefined) {
          // The reply ended before a newline: it may be just the header.
          const parsed = parseEvidenceHeader(header);
          outcome = parsed.outcome;
          if (outcome === 'answer') await handleBody(parsed.body);
        }
        if (outcome === 'contact_requested') return handoffTerminal('human_requested', 'complete');
        if (outcome === 'out_of_scope') return handoffTerminal('out_of_scope', 'complete');
        if (outcome !== 'answer') return handoffTerminal(missReason, 'complete'); // hedge or garbled

        // 15-16. The remainder of the answer.
        await deliver(await gate.push(safeText.flush()), false);
        await deliver(await gate.finish(), false);
        if (out.text.trim() === '') return handoffTerminal(missReason, 'complete');
        return {
          kind: 'answer',
          cited: citedChunkIds(raw.text, new Set(evidence.keys())),
          // The provider hit its output-token limit, or the character cap cut the answer.
          truncated: capped || lastAttempt?.truncated === true,
        };
      } catch (err) {
        if (err instanceof OutputBlocked) {
          stopCtl.abort();
          // Nothing released yet: a clean block. Otherwise part of the answer was already shown.
          return gate.releasedChars === 0 ? handoffTerminal('blocked', 'blocked') : { kind: 'cut' };
        }
        if (err instanceof ModerationFailure && gate.releasedChars > 0) {
          stopCtl.abort();
          return interruptedTerminal(`moderation_${err.kind}`, moderationRetryHint(err));
        }
        stopCtl.abort();
        throw err;
      } finally {
        // Keeps the evidence map reachable for sources, which are built from `cited` by finalize.
        evidenceForSources = evidence;
      }
    }

    async function settleWork(): Promise<void> {
      const left = Math.max(0, config.chatDeadlineMs - (now() - turn.startedAt));
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(work),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, left);
        }),
      ]);
      clearTimeout(timer);
    }

    // ---- Run ------------------------------------------------------------------------------
    let terminal: Terminal;
    try {
      sse.start(io.headers);
      await safeSend({
        event: 'meta',
        data: {
          request_id: turn.runId,
          conversation_id: turn.conversationId,
          message_id: turn.messageId,
        },
      });
      terminal = await pipeline();
    } catch (err) {
      terminal = classify(err);
      if (terminal.kind === 'error') {
        log.warn({ ...logBase, code: terminal.code, internal: terminal.internal }, 'chat failed');
      }
    }
    clearTimeout(deadlineTimer);
    stopCtl.abort();
    // Wait for abandoned work (an aborted embedding, say) only as long as the deadline allows:
    // a provider that ignores the abort must not hold the request open.
    await settleWork();

    // ---- Finish ---------------------------------------------------------------------------
    // The message is stored BEFORE `sources`, `handoff` or `error` are written for it, so the
    // stream never announces sources that were not stored.
    let status: MessageStatus;
    let handoffReason: HandoffReason | null = null;
    let sources = sourcesFor([]);
    let tail: 'done' | 'none' = 'done';

    switch (terminal.kind) {
      case 'answer':
        status = terminal.truncated ? 'partial' : 'complete';
        sources = sourcesFor(terminal.cited);
        break;
      case 'handoff':
        status = terminal.status;
        handoffReason = terminal.plan.reason;
        break;
      case 'cut':
        status = 'partial';
        break;
      case 'error':
        // Text was released: partial. Nothing released: failed (a retry or fallback may have
        // discarded held-back text, which is never stored).
        status = out.text === '' ? 'failed' : 'partial';
        if (terminal.unavailable) handoffReason = 'unavailable';
        tail = 'none';
        break;
      case 'aborted':
        status = out.text === '' ? 'failed' : 'partial';
        tail = 'none';
        break;
    }

    // 18. Persist the assistant message with its source snapshot. Never tied to the client.
    let persisted = true;
    const finishInput = {
      botId: turn.botId,
      sessionId: turn.sessionId,
      runId: turn.runId,
      messageId: turn.messageId,
      conversationId: turn.conversationId,
      userMessageId: turn.userMessageId,
      content: out.text,
      status,
      provider: lastAttempt?.provider ?? null,
      model: lastAttempt?.model ?? null,
      handoffReason,
    };
    const sqlstateOf = (err: unknown): string | undefined =>
      err instanceof DbError ? err.sqlstate : undefined;
    try {
      try {
        await conversations.finishTurn({ ...finishInput, sources: [...sources.rows] });
      } catch (err) {
        // 22023: a cited chunk or version was deleted or changed between retrieval and now. The
        // answer is kept, without the sources; the stream does not announce them either.
        if (sqlstateOf(err) !== '22023' || sources.rows.length === 0) throw err;
        log.warn(
          { ...logBase, code: 'sources_dropped', dropped: sources.rows.length },
          'cited sources changed; storing the answer without them',
        );
        sources = sourcesFor([]);
        await conversations.finishTurn({ ...finishInput, sources: [] });
      }
    } catch (err) {
      // RB030 (a second turn for this run) and RB037 (the run is no longer live) are never success.
      persisted = false;
      log.error(
        { ...logBase, code: 'finish_turn_failed', sqlstate: sqlstateOf(err) },
        'assistant message not stored',
      );
    }

    // The closing events of the stream, now that the outcome is stored (or known not to be).
    if (!persisted && terminal.kind !== 'error' && terminal.kind !== 'aborted') {
      tail = 'none';
      await safeSend({
        event: 'error',
        data: toErrorEnvelope({ code: 'INTERNAL_ERROR', request_id: turn.runId }),
      });
    } else if (terminal.kind === 'answer') {
      await safeSend({ event: 'sources', data: { sources: [...sources.refs] } });
    } else if (terminal.kind === 'handoff') {
      await safeSend({ event: 'sources', data: { sources: [] } });
      if (terminal.plan.event !== null) {
        await safeSend({ event: 'handoff', data: terminal.plan.event });
      }
    } else if (terminal.kind === 'cut') {
      await safeSend({ event: 'sources', data: { sources: [] } });
    } else if (terminal.kind === 'error') {
      await safeSend({
        event: 'error',
        data: toErrorEnvelope({
          code: terminal.code,
          request_id: turn.runId,
          retry_after_seconds: terminal.retryAfterSeconds,
        }),
      });
      if (terminal.unavailable) {
        const plan = planHandoff('unavailable', ctx, turn.language, turn.policy);
        if (plan.event !== null) await safeSend({ event: 'handoff', data: plan.event });
        else {
          log.warn({ ...logBase, code: `handoff_${plan.omitted ?? 'omitted'}` }, 'handoff omitted');
        }
      }
    }

    // 19-20. Usage rows, then settle at their sum (release only when nothing was spent).
    await ledger.drain();
    const spent = ledger.total;
    try {
      if (spent > 0) await limits.settle(turn.botId, turn.reservationId, spent);
      else await limits.release(turn.botId, turn.reservationId);
    } catch {
      try {
        // A reservation the reaper already expired cannot be released, but it can still be settled.
        if (spent === 0) await limits.settle(turn.botId, turn.reservationId, 0);
        else throw new Error('settle failed');
      } catch {
        log.error({ ...logBase, code: 'settle_failed' }, 'budget reservation not closed');
      }
    }
    const runState = !persisted
      ? 'failed'
      : status === 'partial'
        ? 'partial'
        : status === 'failed'
          ? 'failed'
          : 'succeeded';
    try {
      if (!(await runs.finishRun(turn.botId, turn.runId, runState))) {
        log.warn({ ...logBase, code: 'run_already_finished' }, 'run was already finished');
      }
    } catch {
      log.error({ ...logBase, code: 'finish_run_failed' }, 'run state not stored');
    }

    clearInterval(heartbeat);
    if (tail === 'done') await safeSend({ event: 'done', data: { status } });
    sse.end();
    log.info(
      {
        ...logBase,
        status,
        run_state: runState,
        handoff_reason: handoffReason,
        deltas: out.deltas,
        sources: sources.refs.length,
        usage_rows: ledger.count,
        usage_write_failures: ledger.failedWrites,
        cost_usd: spent,
        client_gone: sse.clientGone,
        duration_ms: Math.max(0, now() - turn.startedAt),
      },
      'chat finished',
    );
  }

  return { checkBot, prepare, run };
}
