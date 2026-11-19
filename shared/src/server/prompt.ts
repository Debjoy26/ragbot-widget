// Pure server prompt budgeting, history selection and assembly.
import {
  buildPrompt,
  type BuiltPrompt,
  type EvidenceChunk,
  type ProviderChatMessage,
  type PromptBotSettings,
} from '../index.js';
import type { RetrievedChunk } from './retrieval-types.js';

interface TokenPrice {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
}

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
 *  * A user message is excluded when it is itself `blocked`: input that moderation refused must
 *    never be fed back to the model. Migration 013 sets that status on the question, so position
 *    does not matter (P7-R4 #1 removed an adjacency rule that dropped the wrong question when two
 *    turns interleave).
 *  * The result alternates, starts with a user message and ends with an assistant message.
 *
 * `rows` are oldest first and must not include the question being answered.
 */
export function selectHistory(rows: readonly StoredMessage[], max: number): ProviderChatMessage[] {
  const kept: ProviderChatMessage[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const m = rows[i] as StoredMessage;
    if (m.role === 'user') {
      // Migration 013 marks a refused question `blocked` itself. Two turns running at once store
      // their rows interleaved (u_A, u_B, a_A, a_B), so the refusal need not follow its question.
      if (m.status === 'blocked') continue;
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
