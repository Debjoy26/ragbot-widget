// Chat generation: prompt assembly within a token budget, provider retry and fallback, and the
// cost estimates behind the budget reservation (TECH_SPECS sections 6 and 8, ARCHITECTURE section 5,
// PRD W-08). P7.
//
// Retry and fallback rules (the eligibility matrix):
//  * Only while NOTHING has been released to the visitor (no `delta` sent; `control.released()`).
//    Text that was received but is still held back (the header line, a moderation buffer) is
//    thrown away with the failed attempt: `onRestart` tells the caller to reset. After the first
//    release the stream is never retried and never moved to another provider: the failure is
//    `interrupted` (the route sends STREAM_INTERRUPTED and stores the text so far as partial).
//  * Only `transient` and `rate_limited` errors retry (up to CHAT_PROVIDER_ATTEMPTS attempts per
//    provider, including the first) and then fall back to the configured fallback. `auth`,
//    `billing` and `permanent` errors, and any non-provider error, end the request as unavailable
//    at once: there is no policy that allows falling back on them.
//  * A client disconnect, the total deadline and a deliberate stop each abort the upstream call.
//
// Every attempt, failed or not, is reported through `onAttempt` with its token counts and cost, so
// the usage ledger has one row per provider call. Usage reported by the provider is used when it
// exists; otherwise (a billed failure, or an aborted stream) the cost is ESTIMATED from the prompt
// and the characters received. The provider's own billing stays the final authority.
//
// This module never logs and never puts text, URLs or keys in an error.

import {
  buildPrompt,
  isRetryableErrorKind,
  ProviderError,
  type BuiltPrompt,
  type ChatProvider,
  type ChatUsage,
  type EvidenceChunk,
  type ProviderChatMessage,
  type ProviderErrorKind,
  type PromptBotSettings,
} from '@ragbot/shared';
import type { TokenPrice } from '../lib/config.js';
import type { RetrievedChunk } from './retrieval.js';

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

/**
 * Characters per token for the PROMPT BUDGET (CHAT_CONTEXT_MAX_TOKENS). Deliberately low, so the
 * estimate runs high for Latin text.
 */
export const CHARS_PER_TOKEN = 3;

export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

/**
 * Worst-case tokens for `chars` characters of text: one token per character, which no tokenizer
 * exceeds for ordinary text (CJK and other scripts come near it). Used for the budget
 * RESERVATION and for pricing calls that report no usage, so spend is never under-counted.
 */
export function worstCaseTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars));
}

export function promptChars(prompt: BuiltPrompt): number {
  let chars = prompt.system.length;
  for (const m of prompt.messages) chars += m.content.length;
  return chars;
}

export function promptTokens(prompt: BuiltPrompt): number {
  return estimateTokens(promptChars(prompt));
}

/** USD for a token count at a price per million tokens. Never negative, never NaN. */
export function costUsd(
  usage: { readonly inputTokens: number; readonly outputTokens: number },
  price: TokenPrice,
): number {
  const cost =
    (Math.max(0, usage.inputTokens) * price.inputPerMillion +
      Math.max(0, usage.outputTokens) * price.outputPerMillion) /
    1_000_000;
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

/** The most one chat call can cost: a full-context prompt and a full-length answer. */
export function worstCaseChatCost(
  contextMaxTokens: number,
  maxOutputTokens: number,
  price: TokenPrice,
): number {
  return costUsd({ inputTokens: contextMaxTokens, outputTokens: maxOutputTokens }, price);
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * Makes a history list safe to put in front of the final user turn: no empty messages,
 * consecutive messages of one role merged (so the roles alternate), no leading assistant message
 * (providers expect a user turn first) and no trailing user message (the final turn is a user
 * message, and two in a row are refused by some providers). Pure; keeps order.
 */
export function normaliseHistory(messages: readonly ProviderChatMessage[]): ProviderChatMessage[] {
  const out: ProviderChatMessage[] = [];
  for (const m of messages) {
    if (m.content.trim() === '') continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.role === m.role) {
      out[out.length - 1] = { role: m.role, content: `${last.content}\n\n${m.content}` };
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  while (out[0]?.role === 'assistant') out.shift();
  while (out[out.length - 1]?.role === 'user') out.pop();
  return out;
}

/** A stored message as `get_conversation_history` returns it (the fields used here). */
export interface StoredMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly status: string;
}

/**
 * Chooses the stored messages that may go back to the model, at most `max` of them.
 *
 *  * An assistant message is used only when it is `complete`. `partial` is excluded on purpose: it
 *    was cut by an error, the output cap or a moderation block part-way, so it is incomplete or
 *    contains text that was stopped; a `failed` one has no text; a `blocked` one is a refusal.
 *  * A user message whose reply is `blocked` is excluded with it: input that moderation refused
 *    must never be fed back to the model (the reply comes right after its question).
 *  * The result alternates, starts with a user message and ends with an assistant message.
 *
 * `rows` are oldest first and must not include the question being answered.
 */
export function selectHistory(rows: readonly StoredMessage[], max: number): ProviderChatMessage[] {
  const kept: ProviderChatMessage[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const m = rows[i] as StoredMessage;
    if (m.role === 'user') {
      const next = rows[i + 1];
      if (next !== undefined && next.role === 'assistant' && next.status === 'blocked') {
        i += 1; // the refused question and its refusal
        continue;
      }
      kept.push({ role: 'user', content: m.content });
    } else if (m.status === 'complete') {
      kept.push({ role: 'assistant', content: m.content });
    }
  }
  // Window after cleaning, then clean again: the cut may leave an assistant message first.
  const cleaned = normaliseHistory(kept);
  return normaliseHistory(cleaned.slice(Math.max(0, cleaned.length - Math.max(0, max))));
}

export interface AssembleInput {
  readonly bot: PromptBotSettings;
  readonly question: string;
  /** Best match first. */
  readonly chunks: readonly RetrievedChunk[];
  /** Oldest first. */
  readonly history: readonly ProviderChatMessage[];
  readonly preferredLanguage: string | undefined;
  readonly maxTokens: number;
}

export interface AssembledPrompt {
  readonly prompt: BuiltPrompt;
  /** The chunks that fit, in rank order: the only ids a citation may name. */
  readonly evidence: readonly RetrievedChunk[];
  readonly historyCount: number;
  readonly estimatedTokens: number;
  /** Prompt size in characters: the worst-case token count (1 char = 1 token). */
  readonly chars: number;
}

function toEvidence(chunk: RetrievedChunk): EvidenceChunk {
  return { chunk_id: chunk.chunk_id, text: chunk.content, title: chunk.document_title };
}

/**
 * Builds the prompt so that its estimated size is at most `maxTokens`. Evidence has priority:
 * chunks are added in rank order (one that does not fit is skipped), then as much history as fits,
 * newest first, so the oldest turns are dropped first. Nothing is truncated mid-chunk.
 */
export function assemblePrompt(input: AssembleInput): AssembledPrompt {
  const common = {
    bot: input.bot,
    question: input.question,
    preferredLanguage: input.preferredLanguage,
  };
  const size = (evidence: readonly RetrievedChunk[], history: readonly ProviderChatMessage[]) =>
    promptTokens(buildPrompt({ ...common, evidence: evidence.map(toEvidence), history }));

  const evidence: RetrievedChunk[] = [];
  const history: ProviderChatMessage[] = [];
  if (size(evidence, history) <= input.maxTokens) {
    for (const chunk of input.chunks) {
      if (size([...evidence, chunk], history) <= input.maxTokens) evidence.push(chunk);
    }
    const candidates = normaliseHistory(input.history);
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const message = candidates[i] as ProviderChatMessage;
      if (size(evidence, [message, ...history]) > input.maxTokens) break;
      history.unshift(message);
    }
    // The budget may cut between a question and its answer: the list must still start with a user.
    while (history[0]?.role === 'assistant') history.shift();
  }
  const prompt = buildPrompt({ ...common, evidence: evidence.map(toEvidence), history });
  return {
    prompt,
    evidence,
    historyCount: history.length,
    estimatedTokens: promptTokens(prompt),
    chars: promptChars(prompt),
  };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface LlmProvider {
  readonly provider: ChatProvider;
  readonly price: TokenPrice;
}

/** One provider call, reported when it ends. Costs include estimates for calls without usage. */
export interface LlmAttempt {
  readonly provider: string;
  readonly model: string;
  readonly outcome: 'ok' | 'failed' | 'aborted';
  readonly errorKind: ProviderErrorKind | 'unexpected' | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
  readonly latencyMs: number;
  /** True when the token counts are estimates because the provider reported none. */
  readonly estimated: boolean;
  /** The provider stopped at its output-token limit (`ChatUsage.truncated`). */
  readonly truncated: boolean;
}

export interface LlmRequest {
  readonly system: string;
  readonly messages: readonly ProviderChatMessage[];
  readonly maxOutputTokens: number;
  /** Estimated prompt size, used to price a call that ends without reported usage. */
  readonly estimatedInputTokens: number;
}

export interface LlmControl {
  readonly client: AbortSignal;
  readonly deadline: AbortSignal;
  /** Aborted by the caller to stop reading (it no longer needs the rest of the answer). */
  readonly stop: AbortSignal;
  /** True once the caller has sent any text to the visitor. After that nothing is retried. */
  readonly released: () => boolean;
  /**
   * Called before an attempt starts when the previous attempt yielded text that was never
   * released: the caller must discard everything it kept from that attempt.
   */
  readonly onRestart: () => void;
  readonly onAttempt: (attempt: LlmAttempt) => void;
}

export type LlmFailureReason = 'unavailable' | 'interrupted';

/** Thrown when generation cannot continue. Carries codes only, never provider text. */
export class LlmFailure extends Error {
  override readonly name = 'LlmFailure';
  readonly reason: LlmFailureReason;
  /** True when text had already been released to the visitor (`interrupted`). */
  readonly released: boolean;
  readonly kind: ProviderErrorKind | 'deadline' | 'unexpected';
  readonly retryAfterSeconds: number | undefined;

  constructor(
    reason: LlmFailureReason,
    released: boolean,
    kind: ProviderErrorKind | 'deadline' | 'unexpected',
    retryAfterSeconds?: number,
  ) {
    super(`llm ${reason}`);
    this.reason = reason;
    this.released = released;
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Thrown when the client disconnected: nothing more is wanted. */
export class LlmAborted extends Error {
  override readonly name = 'LlmAborted';
  constructor() {
    super('llm aborted');
  }
}

export interface Llm {
  /**
   * Streams the answer text. Returns when the answer is complete or when `control.stop` aborts
   * it. Throws LlmFailure or LlmAborted.
   */
  generate(request: LlmRequest, control: LlmControl): AsyncGenerator<string, void, void>;
}

export interface CreateLlmOptions {
  readonly primary: LlmProvider;
  readonly fallback: LlmProvider | null;
  /** CHAT_PROVIDER_ATTEMPTS: total attempts per provider before the first token. */
  readonly attempts: number;
  /** Waits between attempts; abortable. Injected for tests. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

const BACKOFF_BASE_MS = 250;
const MAX_BACKOFF_MS = 5_000;
/** Retry hint (seconds) sent with STREAM_INTERRUPTED when the provider gave none. */
export const STREAM_RETRY_AFTER_SECONDS = 2;

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function createLlm(options: CreateLlmOptions): Llm {
  const { primary, fallback } = options;
  if (!Number.isInteger(options.attempts) || options.attempts < 1 || options.attempts > 3) {
    throw new TypeError('attempts must be 1..3');
  }
  const attempts = options.attempts;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const providers: readonly LlmProvider[] = fallback === null ? [primary] : [primary, fallback];

  /** Retry hint for an interruption: only kinds that a later retry can fix carry one. */
  function interruptionHint(
    kind: ProviderErrorKind | 'unexpected',
    providerHint: number | undefined,
  ): number | undefined {
    if (kind === 'unexpected' || !isRetryableErrorKind(kind)) return undefined;
    return providerHint ?? STREAM_RETRY_AFTER_SECONDS;
  }

  function deadlineFailure(control: LlmControl): LlmFailure {
    const released = control.released();
    return new LlmFailure(
      released ? 'interrupted' : 'unavailable',
      released,
      'deadline',
      released ? STREAM_RETRY_AFTER_SECONDS : undefined,
    );
  }

  async function* generate(
    request: LlmRequest,
    control: LlmControl,
  ): AsyncGenerator<string, void, void> {
    let lastKind: ProviderErrorKind | 'deadline' | 'unexpected' = 'transient';
    let lastRetryAfter: number | undefined;
    /** The previous attempt yielded text that the caller still holds. */
    let dirty = false;

    for (const candidate of providers) {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (control.client.aborted) throw new LlmAborted();
        if (control.deadline.aborted) throw deadlineFailure(control);
        if (dirty) {
          control.onRestart();
          dirty = false;
        }
        const signal = AbortSignal.any([control.client, control.deadline, control.stop]);
        const started = now();
        let chars = 0;
        let reported = false;
        let stream: ReturnType<ChatProvider['stream']> | undefined;

        const report = (
          outcome: LlmAttempt['outcome'],
          errorKind: LlmAttempt['errorKind'],
          usage: ChatUsage | null,
          billed: boolean,
        ): void => {
          if (reported) return;
          reported = true;
          // Reported usage wins. Without it, a call that may have been charged (billed failure,
          // aborted stream) is priced from the prompt and the text received (1 char = 1 token, never
          // more than the output cap the provider enforces); the rest cost nothing.
          const charged = outcome === 'aborted' || billed;
          const inputTokens = usage?.inputTokens ?? (charged ? request.estimatedInputTokens : 0);
          const outputTokens =
            usage?.outputTokens ??
            (charged ? Math.min(worstCaseTokens(chars), request.maxOutputTokens) : 0);
          control.onAttempt({
            provider: candidate.provider.provider,
            model: candidate.provider.model,
            outcome,
            errorKind,
            inputTokens,
            outputTokens,
            cost: costUsd({ inputTokens, outputTokens }, candidate.price),
            latencyMs: Math.max(0, now() - started),
            estimated: usage === null && charged,
            // Read through a local type so this compiles before and after ChatUsage gains the field.
            truncated: (usage as { truncated?: boolean } | null)?.truncated === true,
          });
        };

        try {
          stream = candidate.provider.stream({
            system: request.system,
            messages: request.messages,
            maxOutputTokens: request.maxOutputTokens,
            signal,
          });
          let step = await stream.next();
          while (step.done !== true) {
            const text = step.value.text;
            if (text.length > 0) {
              chars += text.length;
              dirty = true;
              yield text;
            }
            step = await stream.next();
          }
          report('ok', null, step.value, false);
          return;
        } catch (err) {
          if (control.client.aborted) {
            report('aborted', null, null, false);
            throw new LlmAborted();
          }
          if (control.stop.aborted && !control.deadline.aborted) {
            report('aborted', null, null, false);
            return;
          }
          if (control.deadline.aborted) {
            report('aborted', null, null, false);
            throw deadlineFailure(control);
          }
          const providerError = err instanceof ProviderError ? err : undefined;
          const kind: ProviderErrorKind | 'unexpected' = providerError?.kind ?? 'unexpected';
          report('failed', kind, null, providerError?.billed === true);
          lastKind = kind;
          lastRetryAfter = providerError?.retryAfterSeconds ?? undefined;
          if (control.released()) {
            throw new LlmFailure('interrupted', true, kind, interruptionHint(kind, lastRetryAfter));
          }
          if (providerError === undefined || !providerError.isRetryable()) {
            // auth, billing, permanent or unexpected: no retry and no fallback.
            throw new LlmFailure('unavailable', false, kind);
          }
          if (attempt < attempts) {
            const wait = Math.min(
              MAX_BACKOFF_MS,
              lastRetryAfter === undefined
                ? BACKOFF_BASE_MS * 2 ** (attempt - 1)
                : lastRetryAfter * 1000,
            );
            await sleep(wait, AbortSignal.any([control.client, control.deadline]));
          }
        } finally {
          // The consumer stopped reading (generator return), or an error left the stream open.
          report('aborted', null, null, false);
          if (stream !== undefined) await stream.return(undefined as never).catch(() => undefined);
        }
      }
    }
    throw new LlmFailure('unavailable', false, lastKind, lastRetryAfter);
  }

  return { generate };
}
