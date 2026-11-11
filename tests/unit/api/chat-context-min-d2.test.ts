import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../api/src/lib/config.ts';
import { assemblePrompt } from '../../../api/src/services/llm.ts';
import { MAX_MESSAGE_CHARS } from '@ragbot/shared';
import {
  CONTEXT_ASSUMPTIONS,
  MIN_CHAT_CONTEXT_TOKENS,
} from '../../../api/src/lib/context-budget.ts';
import type { RetrievedChunk } from '../../../api/src/services/retrieval.ts';
import { validEnv } from './helpers.ts';

// P7-D2 F7d: CHAT_CONTEXT_MAX_TOKENS must be able to hold the system prompt, a question of the
// longest allowed length and one evidence chunk. Anything smaller would make every request fall
// through to "no evidence fits" (a handoff) while still being charged for the embedding and the
// moderation call, so it is refused at startup instead.

function failure(overrides: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(validEnv(overrides));
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error('expected loadConfig to throw');
}

describe('P7-D2 F7d: the smallest usable CHAT_CONTEXT_MAX_TOKENS', () => {
  it('accepts exactly the documented minimum and refuses one less', () => {
    expect(
      loadConfig(validEnv({ CHAT_CONTEXT_MAX_TOKENS: String(MIN_CHAT_CONTEXT_TOKENS) })),
    ).toMatchObject({
      chatContextMaxTokens: MIN_CHAT_CONTEXT_TOKENS,
    });
    expect(
      failure({ CHAT_CONTEXT_MAX_TOKENS: String(MIN_CHAT_CONTEXT_TOKENS - 1) }).variables,
    ).toEqual(['CHAT_CONTEXT_MAX_TOKENS']);
  });

  it('the default test value (6000) is accepted', () => {
    expect(loadConfig(validEnv()).chatContextMaxTokens).toBe(6000);
  });

  it('the minimum is a real fit: system prompt with maximal bot text, longest question, one chunk', () => {
    const a = CONTEXT_ASSUMPTIONS;
    expect(a.questionChars).toBe(MAX_MESSAGE_CHARS);
    const chunk: RetrievedChunk = {
      chunk_id: 'c'.repeat(36),
      document_id: 'd',
      document_version_id: 'v',
      document_title: 't'.repeat(a.titleChars),
      chunk_index: 0,
      content: 'x'.repeat(a.chunkChars),
      page_number: null,
      section: null,
      similarity: 0.9,
    };
    const assembled = assemblePrompt({
      bot: {
        display_name: 'n'.repeat(a.displayNameChars),
        identity_prompt: 'i'.repeat(a.identityPromptChars),
        tone: 't'.repeat(a.toneChars),
        scope: 's'.repeat(a.scopeChars),
        allowed_languages: Array.from({ length: a.languages }, () =>
          'x'.repeat(a.languageTagChars),
        ),
        settings_version: 123456,
      },
      question: 'q'.repeat(a.questionChars),
      chunks: [chunk],
      history: [],
      preferredLanguage: undefined,
      maxTokens: MIN_CHAT_CONTEXT_TOKENS,
    });
    expect(assembled.evidence).toHaveLength(1);
    expect(assembled.estimatedTokens).toBeLessThanOrEqual(MIN_CHAT_CONTEXT_TOKENS);
    // Not wildly loose either: within 5% of what the assembled prompt needs.
    expect(MIN_CHAT_CONTEXT_TOKENS - assembled.estimatedTokens).toBeLessThan(
      MIN_CHAT_CONTEXT_TOKENS * 0.05,
    );
  });
});
