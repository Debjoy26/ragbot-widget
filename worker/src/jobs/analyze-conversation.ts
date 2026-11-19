// `analyze_conversation` job handler (P9-T2): background conversation analysis (W-10).
//
// State machine, mirroring the index handler's contract with the runtime:
//  * Invalid payload, a deleted conversation (RB037 on the context read) or an empty
//    transcript: nothing to do — log and RETURN. The runtime completes the job.
//  * Provider transient/rate-limited failure: THROW, so the runtime retries with backoff.
//    A failed attempt counts its estimate and settles it, like the index batches.
//  * Provider billing/auth failure, unusable model output, or a reached daily cap (RB001):
//    permanent — write a `failed` analysis row and RETURN. The runtime completes the job.
//  * Lease lost or an aborted signal: record any incurred spend, but do not
//    write a result or settle a stale claim. Maintenance recovers its reservation.
//
// Budget (TECH_SPECS §8): reserve_analysis_budget before any provider call, settle with the
// actual cost, release only when nothing was spent. Usage rows use operation 'analysis'.
// Logging: ids, counts and codes only. Never message content or the summary.
import { z } from 'zod';
import {
  analyzeConversationPayloadSchema,
  isRetryableErrorKind,
  ProviderError,
  type ChatProvider,
  type ChatStream,
} from '@ragbot/shared';
import { DbError } from '../lib/db.js';
import { errorCode } from '../lib/logger.js';
import { LeaseLostError, RetryJobError, type JobHandler } from '../runtime.js';

/** Analysis prompt version, stored on every completed row. */
export const ANALYSIS_PROMPT_VERSION = 'rag-analysis-v1';
/** At most this many recent messages reach the model. */
export const ANALYSIS_MAX_MESSAGES = 20;
/** Each message is truncated to this many characters before the prompt. */
export const ANALYSIS_MAX_MESSAGE_CHARS = 500;
/** Reservation lifetime. A settled or released reservation ignores it. */
export const RESERVATION_TTL_SECONDS = 3600;
/** Budget is accounted in microdollars. */
const MIN_RESERVATION_USD = 0.000001;
/** Conservative token estimate, mirroring the index handler (bytes, not chars). */
const ESTIMATE_BYTES_PER_TOKEN = 3;
/** Output cap for the analysis reply. */
const ANALYSIS_MAX_OUTPUT_TOKENS = 500;

const contextSchema = z.looseObject({
  bot: z.looseObject({
    identity_prompt: z.string(),
    tone: z.string(),
    scope: z.string(),
    allowed_languages: z.array(z.string()),
  }),
  messages: z.array(
    z.looseObject({
      role: z.string(),
      content: z.string(),
    }),
  ),
});

const analysisSchema = z.strictObject({
  summary: z.string().min(1).max(2000),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  intent: z.string().min(1).max(200),
});

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / ESTIMATE_BYTES_PER_TOKEN));
}

/** Cost in USD, mirroring the index handler (tokens × price / 1e6, float noise absorbed). */
function usd(tokens: number, pricePerMillion: number): number {
  return Math.ceil(tokens * pricePerMillion * 100 - 1e-6) / 100_000_000;
}

function buildPrompt(messages: readonly { role: string; content: string }[]): string {
  const lines = messages.map((m) => {
    const who = m.role === 'assistant' ? 'assistant' : 'visitor';
    return `[${who}] ${m.content.slice(0, ANALYSIS_MAX_MESSAGE_CHARS)}`;
  });
  return `Conversation (most recent last):\n${lines.join('\n')}`;
}

const SYSTEM_PROMPT =
  'You analyze a customer-support conversation for the site team. ' +
  'Reply with exactly one JSON object and no other text: ' +
  '{"summary": "...", "sentiment": "positive|neutral|negative", "intent": "..."}. ' +
  'summary: one or two sentences, plain facts, no personal data. ' +
  'intent: a few words, e.g. pricing question, human contact request.';

/** Strip one wrapping ```json fence; the schema stays strict after it. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

export interface AnalyzeConversationDeps {
  readonly chat: ChatProvider;
}

export function createAnalyzeConversationHandler(deps: AnalyzeConversationDeps): JobHandler {
  const { chat } = deps;
  return async (job, ctx) => {
    const payload = analyzeConversationPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      ctx.log.error('analysis_payload_invalid');
      return;
    }
    const { conversation_id: conversationId } = payload.data;
    const log = ctx.log.child({ conversation_id: conversationId });
    const { signal } = ctx;
    if (!Number.isInteger(job.analysisGeneration) || Number(job.analysisGeneration) < 1)
      throw new Error('analysis_generation_missing');
    const fence = {
      p_job_id: job.id,
      p_worker: ctx.workerId,
      p_generation: job.analysisGeneration,
    };
    const price = {
      inputPerMillion: ctx.config.analysisPriceInputPerMillionTokens,
      outputPerMillion: ctx.config.analysisPriceOutputPerMillionTokens,
    };

    // 1. Context: recent messages plus the bot's public identity. Gone → nothing to do.
    let botIdentity: string;
    let prompt: string;
    try {
      const raw = await ctx.db.rpc<unknown>('get_analysis_job_context', fence, signal);
      const parsed = contextSchema.safeParse(raw);
      if (!parsed.success) throw new Error('invalid analysis context');
      const messages = parsed.data.messages.slice(-ANALYSIS_MAX_MESSAGES);
      if (messages.length === 0) {
        log.info('analysis_no_messages');
        return;
      }
      const bot = parsed.data.bot;
      botIdentity = `Bot identity: ${bot.identity_prompt} Tone: ${bot.tone} Scope: ${bot.scope}`;
      prompt = buildPrompt(messages);
    } catch (err) {
      if (err instanceof DbError && err.sqlstate === 'RB037') {
        log.info('analysis_conversation_gone');
        return;
      }
      throw err;
    }
    if (signal.aborted) throw new LeaseLostError();

    // 2. Reserve before any provider call.
    const estimatedCost = Math.max(
      MIN_RESERVATION_USD,
      usd(estimateTokens(`${SYSTEM_PROMPT}\n${botIdentity}\n${prompt}`), price.inputPerMillion) +
        usd(ANALYSIS_MAX_OUTPUT_TOKENS, price.outputPerMillion),
    );
    let reservationId: string | null = null;
    try {
      const reserved = await ctx.db.rpc<unknown>(
        'reserve_analysis_budget',
        { ...fence, p_amount: estimatedCost, p_ttl_seconds: RESERVATION_TTL_SECONDS },
        signal,
      );
      if (typeof reserved !== 'string' || reserved === '') throw new Error('invalid reservation');
      reservationId = reserved;
    } catch (err) {
      if (err instanceof DbError && err.sqlstate === 'RB001') {
        log.warn('analysis_budget_exceeded');
        await ctx.db.rpc<unknown>('fail_analysis_job', fence, signal);
        return;
      }
      throw err;
    }

    let actualCost = 0;
    const recordSpend = async (inputTokens: number, outputTokens: number, latencyMs: number) => {
      const cost =
        usd(inputTokens, price.inputPerMillion) + usd(outputTokens, price.outputPerMillion);
      actualCost = Math.max(actualCost, cost);
      try {
        // No abort signal: the money is spent, and an abort must not drop the row.
        await ctx.db.rpc<unknown>('record_analysis_usage', {
          p_job_id: job.id,
          p_generation: job.analysisGeneration,
          p_reservation_id: reservationId,
          p_provider: chat.provider,
          p_model: chat.model,
          p_input_tokens: inputTokens,
          p_output_tokens: outputTokens,
          p_estimated_cost: cost,
          p_latency_ms: latencyMs,
        });
      } catch (usageErr) {
        log.error('analysis_usage_record_failed', { code: errorCode(usageErr) });
      }
    };
    const settleOrRelease = async () => {
      if (reservationId === null) return;
      const id = reservationId;
      reservationId = null;
      try {
        await ctx.db.rpc<unknown>('settle_analysis_budget', {
          ...fence,
          p_reservation_id: id,
          p_actual: actualCost,
        });
      } catch (err) {
        log.warn('analysis_settle_failed', { code: errorCode(err) });
      }
    };
    const failRow = async (code: string) => {
      await settleOrRelease();
      await ctx.db.rpc<unknown>('fail_analysis_job', fence, signal);
      log.warn('analysis_failed', { code });
    };

    // 3. Analyze. Transient failures throw (the runtime retries); anything permanent
    // writes a failed row and returns.
    let text = '';
    let inputTokens = estimateTokens(`${SYSTEM_PROMPT}\n${botIdentity}\n${prompt}`);
    let outputTokens = 0;
    let invoked = false;
    let truncated: boolean;
    let stream: ChatStream | undefined;
    const providerController = new AbortController();
    const started = Date.now();
    try {
      if (signal.aborted) throw new LeaseLostError();
      await ctx.heartbeat();
      stream = chat.stream({
        system: `${SYSTEM_PROMPT}\n${botIdentity}`,
        messages: [{ role: 'user', content: prompt }],
        maxOutputTokens: ANALYSIS_MAX_OUTPUT_TOKENS,
        signal: AbortSignal.any([signal, providerController.signal]),
      });
      invoked = true;
      let step = await stream.next();
      while (step.done !== true) {
        text += step.value.text;
        if (text.length > 16000) throw new Error('analysis_output_limit');
        if (signal.aborted) throw new LeaseLostError();
        step = await stream.next();
      }
      const usage = step.value;
      truncated = usage.truncated === true;
      if (typeof usage.inputTokens === 'number' && usage.inputTokens > 0) {
        inputTokens = usage.inputTokens;
      }
      if (typeof usage.outputTokens === 'number' && usage.outputTokens > 0) {
        outputTokens = usage.outputTokens;
      }
    } catch (err) {
      // A stream may bill even after cancellation. Record a conservative full
      // output allowance when final usage is unavailable; no stale result write.
      const knownUnbilled =
        err instanceof ProviderError &&
        !err.billed &&
        (err.kind === 'auth' || err.kind === 'billing' || err.kind === 'rate_limited');
      if (invoked && !knownUnbilled) {
        await recordSpend(inputTokens, ANALYSIS_MAX_OUTPUT_TOKENS, Date.now() - started);
      }
      if (err instanceof LeaseLostError || signal.aborted) return;
      if (err instanceof RetryJobError) throw err;
      if (err instanceof ProviderError && isRetryableErrorKind(err.kind)) {
        // The estimate is recorded even though the attempt will be retried:
        // fail-closed over-count, bounded by one estimate per attempt. The
        // next attempt reserves anew; never skip recording real spend.
        await settleOrRelease();
        throw err;
      }
      if (err instanceof ProviderError && (err.kind === 'auth' || err.kind === 'billing')) {
        await settleOrRelease();
        await ctx.db.rpc<unknown>('fail_analysis_job', fence, signal);
        log.warn('analysis_provider_refused', { code: err.kind });
        return;
      }
      await settleOrRelease();
      throw err;
    } finally {
      providerController.abort();
      await stream?.return({ inputTokens: 0, outputTokens: 0 }).catch(() => undefined);
    }

    const latencyMs = Date.now() - started;
    if (truncated) {
      await recordSpend(inputTokens, outputTokens, latencyMs);
      await failRow('analysis_output_truncated');
      return;
    }
    let parsed: z.infer<typeof analysisSchema> | undefined;
    try {
      const shape = analysisSchema.safeParse(JSON.parse(stripFence(text)) as unknown);
      if (shape.success) parsed = shape.data;
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) {
      await recordSpend(inputTokens, outputTokens, latencyMs);
      await failRow('analysis_unusable_output');
      return;
    }
    await recordSpend(inputTokens, outputTokens, latencyMs);
    try {
      await ctx.db.rpc<unknown>(
        'save_analysis_job_result',
        {
          ...fence,
          p_summary: parsed.summary,
          p_sentiment: parsed.sentiment,
          p_intent: parsed.intent,
          p_analysis_version: ANALYSIS_PROMPT_VERSION,
        },
        signal,
      );
    } catch (err) {
      // Deleted between the context read and the save: nothing to attach the
      // analysis to. The spend is real, so usage stays and the reservation
      // settles; retrying would only dead-letter. Same quiet return as the
      // context-read RB037 above.
      if (err instanceof DbError && err.sqlstate === 'RB037') {
        await settleOrRelease();
        log.info('analysis_conversation_gone');
        return;
      }
      throw err;
    }
    await settleOrRelease();
    log.info('analysis_saved', {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    });
  };
}
