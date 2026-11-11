// The smallest CHAT_CONTEXT_MAX_TOKENS that can serve a request at all (P7-D2 F7d).
//
// If the prompt budget cannot hold the system prompt, the longest allowed question and one evidence
// chunk, every request would fall through to "no evidence fits" and answer with a handoff, while
// the embedding and the input moderation call were already paid for. That is a configuration
// fault, so it is refused at startup (fail closed) instead of being discovered per request.
//
// The minimum is COMPUTED, not guessed: the real prompt template is built with the largest bot
// text, question and chunk listed below, and measured the way the budget measures (3 characters per
// token, see CHARS_PER_TOKEN in services/llm.ts). It therefore follows the template version.

import { buildPrompt, MAX_MESSAGE_CHARS } from '@ragbot/shared';
import { estimateTokens, promptChars } from '../services/llm.js';

/**
 * What the minimum assumes, in characters. Where a limit exists it is the real one; where none is
 * enforced (identity_prompt is written by an operator, not through the admin API) the figure is an
 * allowance, stated here so it can be argued with.
 */
export const CONTEXT_ASSUMPTIONS = {
  /** `settingsPlainText(80)` in shared/schemas. */
  displayNameChars: 80,
  /** An operator-written prompt: an ALLOWANCE, no limit is enforced. */
  identityPromptChars: 2000,
  /** `settingsSingleLineText(500)`. */
  toneChars: 500,
  /** `settingsFreeText(2000)`. */
  scopeChars: 2000,
  /** Supported languages listed in the system prompt, and the length of each tag. */
  languages: 10,
  languageTagChars: 8,
  /** `MAX_MESSAGE_CHARS`: the longest question the API accepts. */
  questionChars: MAX_MESSAGE_CHARS,
  /**
   * The longest chunk the worker produces: 350 estimated tokens (CHUNK_TARGET_TOKENS in
   * worker/src/lib/chunk.ts), where ASCII text counts a quarter token per character.
   */
  chunkChars: 1400,
  /** The longest document title that goes into an evidence block (`SourceRef.title`). */
  titleChars: 200,
  /** A chunk id is a UUID. */
  chunkIdChars: 36,
} as const;

function minimumTokens(): number {
  const a = CONTEXT_ASSUMPTIONS;
  const prompt = buildPrompt({
    bot: {
      display_name: 'n'.repeat(a.displayNameChars),
      identity_prompt: 'i'.repeat(a.identityPromptChars),
      tone: 't'.repeat(a.toneChars),
      scope: 's'.repeat(a.scopeChars),
      allowed_languages: Array.from({ length: a.languages }, () => 'x'.repeat(a.languageTagChars)),
      settings_version: 123_456,
    },
    question: 'q'.repeat(a.questionChars),
    evidence: [
      {
        chunk_id: 'c'.repeat(a.chunkIdChars),
        text: 'x'.repeat(a.chunkChars),
        title: 't'.repeat(a.titleChars),
      },
    ],
    history: [],
    preferredLanguage: 'x'.repeat(a.languageTagChars),
  });
  return estimateTokens(promptChars(prompt));
}

/** Tokens (at the budget's 3 characters per token) that the smallest useful prompt needs. */
export const MIN_CHAT_CONTEXT_TOKENS: number = minimumTokens();
