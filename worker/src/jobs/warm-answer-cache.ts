// C8: bounded, fenced warming (plan.md P7.5 C8, PRE-P11 T12).
//
// Integrated from the isolated H1 draft: only the per-layer fenced publish
// RPCs (T10/T11) may persist candidates — there is no combined publish RPC.
// Every external invocation is charged conservatively before it is sent; failed
// or unobservable calls keep that charge. No question, output or config is logged.
//
// Fence order per variant: get_warm_job_context (live claim + current versions
// + enabled policy) -> reserve_warm_budget (atomic shared cap, per job /
// generation / question hash) -> pending record_warm_usage BEFORE each provider
// call -> final record_warm_usage after -> per-layer fenced publish
// (C4 embedding, then C5 retrieval anchored on it, then C6 moderation,
// then C7 answer) -> settle_warm_budget. A variant that fails anywhere keeps
// its conservative charge and never publishes; the job still resolves so the
// next version change warms again.
import { createHash, randomUUID } from 'node:crypto';
import {
  assertEmbeddingShape,
  neutraliseDelimiters,
  parseEvidenceHeader,
  PROMPT_TEMPLATE_VERSION,
  warmAnswerCachePayloadSchema,
  type ChatProvider,
  type EmbeddingProvider,
  type ModerationProvider,
} from '@ragbot/shared';
import {
  assertVectorBounds,
  CLASSIFIER_MAX_OUTPUT_TOKENS,
  CLASSIFIER_SYSTEM_PROMPT,
} from '@ragbot/shared/ai';
import {
  createEmbeddingCache,
  isEmbeddingCacheEnabled,
  type EmbeddingCacheRecord,
} from '@ragbot/shared/server/embedding-cache';
import {
  createModerationCache,
  isModerationCacheEnabled,
  type ModerationCacheRecord,
} from '@ragbot/shared/server/moderation-cache';
import {
  createRetrievalCache,
  isRetrievalCacheEnabled,
  queryEmbeddingHash,
  type RetrievalCacheRecord,
} from '@ragbot/shared/server/retrieval-cache';
import {
  createAnswerCache,
  containsPII,
  normalizeQuestion,
  isAnswerCacheEnabled,
  type AnswerCacheRecord,
} from '@ragbot/shared/server/answer-cache';
import {
  buildAllowList,
  citedChunkIds,
  delink,
  sanitiseModelText,
  stripCitationMarkers,
} from '@ragbot/shared/server/citations';
import { assemblePrompt } from '@ragbot/shared/server/prompt';
import { chatContextSchema } from '@ragbot/shared/server/context';
import { retrievedChunkSchema, type RetrievedChunk } from '@ragbot/shared/server/retrieval-types';
import type { WarmingConfig } from '../lib/warming-config.js';
import { RetryJobError, type JobHandler } from '../runtime.js';

export interface WarmDeps {
  readonly embedding: EmbeddingProvider;
  readonly chat: ChatProvider;
  readonly moderation: ModerationProvider;
  readonly config: WarmingConfig;
}
interface Candidate {
  layer: 'c4' | 'c5' | 'c6' | 'c7';
  record: unknown;
}
interface Quote {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}
const ACCOUNTING_TIMEOUT_MS = 1500;
// Provider framing/hidden tokenization margin, in addition to UTF-8 byte bounds.
const FRAMING_TOKEN_MARGIN = 4096;
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
const stopped = (): never => {
  throw new Error('warm_stopped');
};
// Token counts bound for integer RPC params; costs stay fractional.
const toInt = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);
// Reservation identity: one hash per normalized question + language variant.
const questionHash = (normalisedQuestion: string, language: string): string =>
  createHash('sha256').update(`${normalisedQuestion}${language}`, 'utf8').digest('hex');
const price = (
  inputTokens: number,
  outputTokens: number,
  rates: WarmingConfig['chatPrice'],
): Quote => ({
  inputTokens,
  outputTokens,
  cost:
    Math.ceil((inputTokens * rates.inputPerMillion + outputTokens * rates.outputPerMillion) * 100) /
    100_000_000,
});
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('warm_stopped'));
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error('warm_stopped'));
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => undefined);
  });
}

export function createWarmAnswerCacheHandler(deps?: WarmDeps | null): JobHandler {
  return async (job, ctx) => {
    const parsed = warmAnswerCachePayloadSchema.safeParse(job.payload);
    const settingsVersion = job.payload['settings_version'];
    if (
      !parsed.success ||
      !Number.isSafeInteger(settingsVersion) ||
      (settingsVersion as number) < 0
    ) {
      ctx.log.warn('warm_payload_invalid');
      return;
    }
    const generation = (job as typeof job & { readonly warmGeneration?: number }).warmGeneration;
    if (!Number.isSafeInteger(generation) || (generation as number) < 1)
      throw new RetryJobError('warm_generation_missing');
    const fence = { p_job_id: job.id, p_worker: ctx.workerId, p_generation: generation };
    const raw = await ctx.db.rpc<unknown>('get_warm_job_context', fence, ctx.signal);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      throw new RetryJobError('warm_context_invalid');
    const row = raw as Record<string, unknown>;
    if (row['state'] === 'disabled' || row['state'] === 'superseded') return;
    if (row['state'] !== 'ready') throw new RetryJobError('warm_context_invalid');
    if (!deps) throw new RetryJobError('warm_config_missing');
    const context = chatContextSchema.safeParse(row['context']);
    if (!context.success) throw new RetryJobError('warm_context_invalid');
    const contextValue = context.data;
    const bot = contextValue.bot;
    if (
      !bot.enabled ||
      bot.id !== parsed.data.bot_id ||
      bot.corpus_version !== parsed.data.corpus_version ||
      bot.settings_version !== parsed.data.settings_version
    )
      return;
    const { config, embedding, chat, moderation } = deps;
    // Model identity: the bot's embedding model must match the adapter and the
    // T06-validated worker embedding config; warmed chat/moderation keys must
    // equal the T06 identity keys the live API reads with (T06/T10/T11).
    const chatKey = `${chat.provider}/${chat.model}`;
    if (
      bot.embedding_model !== embedding.model ||
      bot.embedding_dimensions !== embedding.dimensions ||
      embedding.model !== config.ai.embedding.model ||
      embedding.provider !== config.ai.embedding.provider ||
      embedding.dimensions !== config.ai.embedding.dimensions ||
      (config.chatModelKey !== chatKey && !config.chatModelKey.startsWith(`${chatKey}|`)) ||
      config.moderationModelKey !==
        `${moderation.provider}/${moderation.model}/${config.moderationMode}`
    )
      throw new RetryJobError('warm_model_mismatch');
    const policy =
      (contextValue as unknown as Record<string, unknown>)['cache_policy'] ??
      contextValue.settings.cache_policy;
    const enabled = {
      c4: isEmbeddingCacheEnabled(policy),
      c5: isRetrievalCacheEnabled(policy),
      c6: isModerationCacheEnabled(policy),
      c7: isAnswerCacheEnabled(policy),
    };
    if (!Object.values(enabled).some(Boolean)) return;
    if (!Array.isArray(row['questions']) || !Array.isArray(row['languages']))
      throw new RetryJobError('warm_context_invalid');
    const questions = row['questions'] as unknown[];
    const configuredLanguages = row['languages'] as unknown[];
    // The context carries "" as the always-allowed default (no-preference)
    // variant alongside the bot's allowed languages (020 includes it, capped
    // at 21 total); "" is not subject to the allowed_languages membership check.
    if (
      questions.length > 12 ||
      configuredLanguages.length > 21 ||
      questions.some((q) => typeof q !== 'string' || q.length > config.moderationMaxChars) ||
      configuredLanguages.some(
        (language) =>
          typeof language !== 'string' ||
          (language !== '' && !bot.allowed_languages.includes(language)),
      )
    )
      throw new RetryJobError('warm_context_invalid');
    const languages = [...new Set(['', ...(configuredLanguages as string[])])];
    const seen = new Set<string>();
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(config.deadlineMs)]);
    const ensure = (): void => {
      if (signal.aborted) stopped();
    };
    const modOverhead =
      bytes(CLASSIFIER_SYSTEM_PROMPT) +
      bytes('<<<MESSAGE_TO_CLASSIFY>>>\n\n<<<END_MESSAGE_TO_CLASSIFY>>>') +
      FRAMING_TOKEN_MARGIN;
    const modQuote = (inputBytes: number): Quote =>
      config.moderationMode === 'endpoint'
        ? { inputTokens: 0, outputTokens: 0, cost: 0 }
        : price(inputBytes + modOverhead, CLASSIFIER_MAX_OUTPUT_TOKENS, config.moderationPrice);
    const quoteChat = price(
      config.contextMaxTokens * 12 + FRAMING_TOKEN_MARGIN,
      config.maxOutputTokens,
      config.chatPrice,
    );
    for (const [questionIndex, unknownQuestion] of questions.entries()) {
      const question = unknownQuestion as string;
      const normalized = normalizeQuestion(question);
      if (!normalized || seen.has(normalized) || containsPII(question)) continue;
      seen.add(normalized);
      for (const language of languages) {
        if (signal.aborted) break;
        const qHash = questionHash(normalized, language);
        let reservationId: string | null = null;
        let actualTotal = 0;
        const entries: Candidate[] = [];
        const inputQuote = modQuote(bytes(neutraliseDelimiters(question)));
        const embedQuote = {
          inputTokens: bytes(question),
          outputTokens: 0,
          cost:
            Math.ceil(bytes(question) * config.embeddingPricePerMillionTokens * 100) / 100_000_000,
        };
        // neutraliseDelimiters can expand an ASCII delimiter threefold in UTF-8.
        const outputQuote = modQuote(config.maxOutputChars * 12);
        try {
          ensure();
          await ctx.heartbeat();
          const reserve = await ctx.db.rpc<unknown>(
            'reserve_warm_budget',
            {
              ...fence,
              p_question_hash: qHash,
              p_amount: Math.max(
                0.000001,
                inputQuote.cost + embedQuote.cost + quoteChat.cost + outputQuote.cost,
              ),
              p_ttl_seconds: config.reserveTtlSeconds,
            },
            signal,
          );
          // Null is the fenced quiet skip (disabled/superseded mid-run): no spend.
          if (reserve === null) continue;
          if (
            typeof reserve !== 'string' ||
            !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(reserve)
          )
            throw new Error('warm_reservation_invalid');
          reservationId = reserve;
          const invoke = async <T>(
            operation: 'embedding_query' | 'moderation' | 'chat',
            provider: { provider: string; model: string },
            quote: Quote,
            call: () => Promise<T>,
            usage: (result: T) => Quote,
          ): Promise<T> => {
            ensure();
            await ctx.heartbeat();
            const invocationId = randomUUID();
            const base = {
              p_job_id: job.id,
              p_generation: generation,
              p_question_hash: qHash,
              p_reservation_id: reserve,
              p_invocation_id: invocationId,
              p_provider: provider.provider,
              p_model: provider.model,
              p_operation: operation,
            };
            await ctx.db.rpc(
              'record_warm_usage',
              {
                ...base,
                p_input_tokens: toInt(quote.inputTokens),
                p_output_tokens: toInt(quote.outputTokens),
                p_estimated_cost: quote.cost,
                p_latency_ms: 0,
                p_final: false,
              },
              signal,
            );
            ensure();
            const started = Date.now();
            // This continuation outlives a caller abort solely to finalize already-incurred spend.
            const pending = call().then(async (result) => {
              const actual = usage(result);
              if (
                ![actual.inputTokens, actual.outputTokens, actual.cost].every(
                  (n) => Number.isFinite(n) && n >= 0,
                )
              )
                throw new Error('warm_usage_invalid');
              await ctx.db.rpc(
                'record_warm_usage',
                {
                  ...base,
                  p_input_tokens: toInt(actual.inputTokens),
                  p_output_tokens: toInt(actual.outputTokens),
                  p_estimated_cost: actual.cost,
                  p_latency_ms: Math.max(0, Date.now() - started),
                  p_final: true,
                },
                AbortSignal.timeout(ACCOUNTING_TIMEOUT_MS),
              );
              actualTotal += actual.cost;
              if (
                actual.cost > quote.cost ||
                actual.inputTokens > quote.inputTokens ||
                actual.outputTokens > quote.outputTokens
              )
                throw new Error('warm_quote_overrun');
              return result;
            });
            // Failed calls intentionally keep their pending conservative charge.
            pending.catch(() => undefined);
            return raceAbort(pending, signal);
          };
          const moderationUsage = (
            result: Awaited<ReturnType<ModerationProvider['moderate']>>,
            quote: Quote,
          ): Quote =>
            result.usage === null
              ? quote
              : price(result.usage.inputTokens, result.usage.outputTokens, config.moderationPrice);
          const verdict = await invoke(
            'moderation',
            moderation,
            inputQuote,
            () => moderation.moderate(question, { signal }),
            (result) => moderationUsage(result, inputQuote),
          );
          if (verdict.verdict !== 'allow' && verdict.verdict !== 'block')
            throw new Error('warm_verdict_invalid');
          const c6 = createModerationCache({
            l2: {
              get: async () => null,
              set: async (record) => {
                entries.push({ layer: 'c6', record });
              },
            },
          });
          await c6.set(config.moderationModelKey, 'v1', question, verdict.verdict, policy);
          if (verdict.verdict === 'allow' && (enabled.c4 || enabled.c5 || enabled.c7)) {
            const embedded = await invoke(
              'embedding_query',
              embedding,
              embedQuote,
              () => embedding.embed([question], { taskType: 'query', signal }),
              (result) => ({
                inputTokens: result.inputTokens ?? embedQuote.inputTokens,
                outputTokens: 0,
                cost:
                  Math.ceil(
                    (result.inputTokens ?? embedQuote.inputTokens) *
                      config.embeddingPricePerMillionTokens *
                      100,
                  ) / 100_000_000,
              }),
            );
            assertEmbeddingShape(embedded.vectors, 1);
            assertVectorBounds(embedded.vectors);
            const vector = embedded.vectors[0];
            if (!vector) throw new Error('warm_vector_invalid');
            const c4 = createEmbeddingCache({
              l2: {
                get: async () => null,
                set: async (record) => {
                  entries.push({ layer: 'c4', record });
                },
              },
            });
            await c4.set(embedding.model, embedding.dimensions, question, vector, policy);
            if (enabled.c5 || enabled.c7) {
              ensure();
              const matched = await ctx.db.rpc<unknown>(
                'match_document_chunks',
                {
                  p_bot_id: bot.id,
                  p_query_embedding: `[${vector.join(',')}]`,
                  p_match_count: config.topK,
                  p_min_similarity: config.minSimilarity,
                },
                signal,
              );
              if (!Array.isArray(matched) || matched.length > config.topK)
                throw new Error('warm_retrieval_invalid');
              const chunks: RetrievedChunk[] = [];
              const ids = new Set<string>();
              for (const item of matched) {
                const itemResult = retrievedChunkSchema.safeParse(item);
                if (!itemResult.success) throw new Error('warm_retrieval_invalid');
                const chunk = itemResult.data;
                if (chunk.similarity < config.minSimilarity || ids.has(chunk.chunk_id)) continue;
                ids.add(chunk.chunk_id);
                chunks.push(chunk);
              }
              chunks.sort((a, b) => b.similarity - a.similarity);
              const c5 = createRetrievalCache({
                l2: {
                  get: async () => null,
                  set: async (record) => {
                    entries.push({ layer: 'c5', record });
                  },
                },
              });
              await c5.set(
                bot.id,
                bot.corpus_version,
                queryEmbeddingHash(vector),
                config.topK,
                config.minSimilarity,
                language,
                chunks.map((chunk) => ({
                  chunk_id: chunk.chunk_id,
                  document_version_id: chunk.document_version_id,
                  similarity: chunk.similarity,
                })),
                policy,
              );
              if (enabled.c7 && chunks.length) {
                const assembled = assemblePrompt({
                  bot,
                  question,
                  chunks,
                  history: [],
                  preferredLanguage: language || undefined,
                  maxTokens: config.contextMaxTokens,
                });
                const promptBytes =
                  bytes(assembled.prompt.system) +
                  assembled.prompt.messages.reduce((sum, m) => sum + bytes(m.content), 0);
                if (
                  assembled.evidence.length &&
                  promptBytes + FRAMING_TOKEN_MARGIN <= quoteChat.inputTokens
                ) {
                  const result = await invoke(
                    'chat',
                    chat,
                    quoteChat,
                    async () => {
                      const stream = chat.stream({
                        system: assembled.prompt.system,
                        messages: assembled.prompt.messages,
                        maxOutputTokens: config.maxOutputTokens,
                        signal,
                      });
                      let text = '';
                      try {
                        for (;;) {
                          const next = await raceAbort(stream.next(), signal);
                          if (next.done) return { text, usage: next.value };
                          text += next.value.text;
                          if (text.length > config.maxOutputChars)
                            throw new Error('warm_output_limit');
                        }
                      } finally {
                        void stream
                          .return({ inputTokens: 0, outputTokens: 0 })
                          .catch(() => undefined);
                      }
                    },
                    (result) =>
                      price(result.usage.inputTokens, result.usage.outputTokens, config.chatPrice),
                  );
                  const header = parseEvidenceHeader(result.text);
                  const evidence = new Map(
                    assembled.evidence.map((chunk) => [chunk.chunk_id, chunk] as const),
                  );
                  const cited = citedChunkIds(header.body, new Set(evidence.keys()));
                  const body = sanitiseModelText(header.body);
                  const displayBody = stripCitationMarkers(body);
                  // Contact values are always current config; never cache them inside model output.
                  const contactLike =
                    /https?:|www\.|mailto:|tel:|whatsapp|[\w.+-]+@[\w.-]+/i.test(displayBody) ||
                    containsPII(displayBody);
                  if (
                    !result.usage.truncated &&
                    header.outcome === 'answer' &&
                    cited.length &&
                    !contactLike
                  ) {
                    const answer = delink(displayBody, buildAllowList({}));
                    if (answer && answer.length <= config.moderationMaxChars) {
                      const outputVerdict = await invoke(
                        'moderation',
                        moderation,
                        outputQuote,
                        () => moderation.moderate(answer, { signal }),
                        (value) => moderationUsage(value, outputQuote),
                      );
                      if (outputVerdict.verdict === 'allow') {
                        const c7 = createAnswerCache({
                          l2: {
                            get: async () => null,
                            delete: async () => {},
                            set: async (record) => {
                              entries.push({ layer: 'c7', record });
                            },
                          },
                        });
                        await c7.set({
                          botId: bot.id,
                          corpusVersion: bot.corpus_version,
                          settingsVersion: bot.settings_version,
                          promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
                          chatModel: config.chatModelKey,
                          language,
                          rawQuestion: question,
                          answerText: answer,
                          sourceRefs: cited.map((id) => ({
                            chunk_id: id,
                            document_version_id: evidence.get(id)?.document_version_id ?? '',
                            source_label: evidence.get(id)?.document_title ?? '',
                          })),
                          handoffReason: null,
                          status: 'complete',
                          moderated: true,
                          cachePolicy: policy,
                        });
                      }
                    }
                  }
                }
              }
            }
          }
          ensure();
          await ctx.heartbeat();
          // Fenced per-layer publication in dependency order: C5 anchors on the
          // live C4 row, so C4 publishes first. A false return is the DB's quiet
          // skip (stale/ineligible); loud errors fail only this variant.
          for (const layer of ['c4', 'c5', 'c6', 'c7'] as const) {
            for (const entry of entries.filter((candidate) => candidate.layer === layer)) {
              if (layer === 'c4') {
                const record = entry.record as EmbeddingCacheRecord;
                await ctx.db.rpc(
                  'publish_warm_embedding',
                  {
                    ...fence,
                    p_key_hash: record.key_hash,
                    p_model: record.embedding_model,
                    p_dimensions: record.embedding_dimensions,
                    p_embedding_text: `[${record.embedding.join(',')}]`,
                    p_expires_at: record.expires_at,
                  },
                  signal,
                );
              } else if (layer === 'c5') {
                const record = entry.record as RetrievalCacheRecord;
                await ctx.db.rpc(
                  'publish_warm_retrieval',
                  {
                    ...fence,
                    p_key_hash: record.key_hash,
                    p_bot_id: record.bot_id,
                    p_corpus_version: record.corpus_version,
                    p_embedding_hash: record.embedding_hash,
                    p_k: record.k,
                    p_threshold: record.threshold,
                    p_language: record.language,
                    p_chunk_refs: record.chunk_refs,
                    p_expires_at: record.expires_at,
                  },
                  signal,
                );
              } else if (layer === 'c6') {
                const record = entry.record as ModerationCacheRecord;
                await ctx.db.rpc(
                  'publish_warm_moderation',
                  {
                    ...fence,
                    p_key_hash: record.key_hash,
                    p_policy_version: record.policy_version,
                    p_verdict: record.verdict,
                    p_model: config.moderationModelKey,
                    p_expires_at: record.expires_at,
                  },
                  signal,
                );
              } else {
                const record = entry.record as AnswerCacheRecord;
                await ctx.db.rpc(
                  'publish_warm_answer',
                  {
                    ...fence,
                    p_key_hash: record.cache_key_hash,
                    p_bot_id: record.bot_id,
                    p_language: record.language,
                    p_raw_question: question,
                    p_answer_text: record.answer_text,
                    p_source_refs: record.source_refs,
                    p_handoff_reason: record.handoff_reason,
                    p_status: 'complete',
                    p_moderated: true,
                    p_truncated: false,
                    p_prompt_template_version: PROMPT_TEMPLATE_VERSION,
                    p_chat_model: config.chatModelKey,
                    p_corpus_version: record.corpus_version,
                    p_settings_version: record.settings_version,
                    p_expires_at: record.expires_at,
                  },
                  signal,
                );
              }
            }
          }
        } catch {
          ctx.log.warn('warm_variant_failed', { question_index: questionIndex });
        } finally {
          if (reservationId !== null) {
            try {
              await ctx.db.rpc(
                'settle_warm_budget',
                {
                  p_job_id: job.id,
                  p_worker: ctx.workerId,
                  p_generation: generation,
                  p_question_hash: qHash,
                  p_reservation_id: reservationId,
                  p_actual: actualTotal,
                },
                AbortSignal.timeout(ACCOUNTING_TIMEOUT_MS),
              );
            } catch {
              ctx.log.warn('warm_settle_failed');
            }
          }
        }
      }
    }
    if (signal.aborted && !ctx.signal.aborted) throw new RetryJobError('warm_deadline');
  };
}
