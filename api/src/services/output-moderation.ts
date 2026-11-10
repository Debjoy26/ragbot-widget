// Output moderation policy for streamed answers (ADR 0004, ARCHITECTURE section 7). P7.
//
// Per client (`feature_flags.output_moderation_mode`):
//  * `buffer`: nothing is released until the WHOLE answer has passed moderation. A block releases
//    nothing at all. Strictest, but the visitor sees the answer only at the end.
//  * `rolling` (the ADR default): text is checked in batches and each batch is released only after
//    it passes. A batch is checked once it holds at least ROLLING_BATCH_CHARS characters, and the
//    remainder is checked at the end. A block stops the stream; earlier batches were already
//    released. RESIDUAL RISK: a batch is judged alone, so harm that only shows across batches, or
//    inside text already released, is not caught.
//
// The gate only decides WHEN text may be released; callers push token-safe pieces (see
// SafeTextStream), so a batch never ends inside a URL, email or phone number.

import type { UsageSink } from './conversations.js';
import type { Moderator } from './moderation.js';

export type OutputMode = 'buffer' | 'rolling';

/** Characters accumulated before a rolling batch is checked. */
export const ROLLING_BATCH_CHARS = 400;

/** Thrown when moderation blocked text. Nothing in the blocked batch was released. */
export class OutputBlocked extends Error {
  override readonly name = 'OutputBlocked';
  constructor() {
    super('output blocked');
  }
}

export interface OutputGate {
  /** Adds text; returns the text now approved for release ('' while it is being held). */
  push(text: string): Promise<string>;
  /** Checks what is left; returns the final approved text. */
  finish(): Promise<string>;
  /** Characters released so far. */
  readonly releasedChars: number;
}

export interface CreateOutputGateOptions {
  readonly mode: OutputMode;
  readonly moderator: Moderator;
  readonly signal: AbortSignal;
  readonly usage: UsageSink;
}

export function createOutputGate(options: CreateOutputGateOptions): OutputGate {
  const { mode, moderator, signal, usage } = options;
  let pending = '';
  let releasedChars = 0;
  let blocked = false;

  async function check(): Promise<string> {
    if (pending === '') return '';
    const batch = pending;
    const verdict = await moderator.moderate(batch, signal, usage);
    if (verdict !== 'allow') {
      blocked = true;
      pending = '';
      throw new OutputBlocked();
    }
    pending = '';
    releasedChars += batch.length;
    return batch;
  }

  function guard(): void {
    if (blocked) throw new OutputBlocked();
  }

  return {
    async push(text) {
      guard();
      pending += text;
      if (mode === 'buffer' || pending.length < ROLLING_BATCH_CHARS) return '';
      return check();
    },
    async finish() {
      guard();
      return check();
    },
    get releasedChars() {
      return releasedChars;
    },
  };
}
