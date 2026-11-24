import { afterEach, describe, expect, it } from 'vitest';
import type { ChatUsage } from '@ragbot/shared';
import {
  ANSWER_HEADER,
  BOT,
  CHUNK_A,
  RUN,
  chatBody,
  closeApps,
  defaultContext,
  deltaText,
  eventOf,
  names,
  parseSse,
  postChat,
  setup,
  type Options,
} from './chat-harness.ts';
import { fakeProviderError } from '../../helpers/fake-ai.ts';
import {
  createOutputGate,
  OutputBlocked,
  ROLLING_BATCH_CHARS,
} from '../../../api/src/services/output-moderation.ts';
import { UsageLedger } from '../../../api/src/services/conversations.ts';
import { FakeModerationProvider } from '../../helpers/fake-ai.ts';
import { createModerator } from '../../../api/src/services/moderation.ts';

afterEach(closeApps);

const FIRST = `${'alpha '.repeat(80)}`; // 480 chars: one rolling batch
const SECOND = `${'beta '.repeat(80)}BAD ${'gamma '.repeat(5)}`;
const buffer = defaultContext({
  settings: { feature_flags: { output_moderation_mode: 'buffer' } },
});
const rolling = defaultContext({
  settings: { feature_flags: { output_moderation_mode: 'rolling' } },
});

/** Blocks the batch that contains the word BAD; the visitor message is never blocked. */
const blockBad = (text: string, i: number) => (i > 0 && text.includes('BAD') ? 'block' : 'allow');

async function run(options: Options = {}) {
  const h = setup(options);
  const res = await postChat(h, chatBody());
  expect(res.statusCode).toBe(200);
  return { h, events: parseSse(res.body) };
}

describe('output moderation: buffer mode (C5)', () => {
  it('checks the whole answer once, and releases it only after it passed', async () => {
    const { h, events } = await run({
      context: buffer,
      chat: [{ chunks: [`${ANSWER_HEADER}${FIRST}`, SECOND.replace('BAD', 'fine')] }],
      moderation: () => 'allow',
    });
    expect(h.moderationProvider.calls).toBe(2); // the question, then the whole answer
    expect(h.moderationProvider.texts[1]).toContain('alpha');
    expect(h.moderationProvider.texts[1]).toContain('gamma');
    expect(eventOf(events, 'done').data.status).toBe('complete');
  });

  it('a block releases nothing: handoff blocked, status blocked, no answer text on the wire', async () => {
    const { h, events } = await run({
      context: buffer,
      chat: [{ chunks: [`${ANSWER_HEADER}${FIRST}`, SECOND] }],
      moderation: blockBad,
    });
    expect(names(events)).toEqual(['meta', 'delta', 'sources', 'handoff', 'done']);
    expect(deltaText(events)).toBe('Please contact our team.');
    expect(JSON.stringify(events)).not.toContain('alpha');
    expect(eventOf(events, 'handoff').data.reason).toBe('blocked');
    expect(eventOf(events, 'done').data.status).toBe('blocked');
    expect(h.calls('finish_chat_turn')[0]?.args).toMatchObject({
      p_status: 'blocked',
      p_handoff_reason: 'blocked',
    });
  });
});

describe('output moderation: rolling mode (C5)', () => {
  it('releases each batch only after it passed, and the remainder at the end', async () => {
    const { h, events } = await run({
      context: rolling,
      chat: [{ chunks: [`${ANSWER_HEADER}${FIRST}`, 'tail words here'] }],
    });
    const deltas = events.filter((e) => e.event === 'delta');
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(h.moderationProvider.calls).toBe(3); // question, batch, remainder
    expect(h.moderationProvider.texts[1]?.length).toBeGreaterThanOrEqual(ROLLING_BATCH_CHARS);
    expect(deltaText(events)).toContain('tail words here');
  });

  it('is the default when the flag is absent (ADR 0004)', async () => {
    const { h } = await run({ chat: [{ chunks: [`${ANSWER_HEADER}${FIRST}`, 'tail'] }] });
    expect(h.moderationProvider.calls).toBe(3);
  });

  it('a later block stops the stream: earlier batches stay, status partial', async () => {
    const { h, events } = await run({
      context: rolling,
      chat: [{ chunks: [`${ANSWER_HEADER}${FIRST}`, SECOND, 'never reached'] }],
      moderation: blockBad,
    });
    expect(names(events).at(-1)).toBe('done');
    expect(eventOf(events, 'done').data.status).toBe('partial');
    expect(names(events)).not.toContain('handoff');
    expect(deltaText(events)).toContain('alpha');
    expect(deltaText(events)).not.toContain('BAD');
    expect(deltaText(events)).not.toContain('beta');
    expect(h.calls('finish_chat_turn')[0]?.args).toMatchObject({
      p_status: 'partial',
      p_content: deltaText(events),
    });
    expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'partial');
  });

  it('a block of the first batch releases nothing and is a blocked handoff', async () => {
    const { events } = await run({
      context: rolling,
      chat: [{ chunks: [`${ANSWER_HEADER}BAD ${FIRST}`] }],
      moderation: blockBad,
    });
    expect(eventOf(events, 'handoff').data.reason).toBe('blocked');
    expect(eventOf(events, 'done').data.status).toBe('blocked');
    expect(JSON.stringify(events)).not.toContain('alpha');
  });

  it('moderates text without citation markers', async () => {
    const { h } = await run({
      context: rolling,
      chat: [{ chunks: [`${ANSWER_HEADER}Plans [[11111111-1111-1111-1111-111111111111]] start.`] }],
    });
    for (const text of h.moderationProvider.texts.slice(1)) expect(text).not.toContain('[[');
  });

  it('an output moderation outage before any release is unavailable; after a release it is interrupted', async () => {
    const before = await run({
      context: rolling,
      chat: [{ chunks: [`${ANSWER_HEADER}${FIRST}`] }],
      moderation: (_t, i) => (i === 0 ? 'allow' : fakeProviderError('transient')),
    });
    expect(names(before.events)).toEqual(['meta', 'error', 'handoff']);
    expect(eventOf(before.events, 'error').data.code).toBe('PROVIDER_UNAVAILABLE');

    const after = await run({
      context: rolling,
      chat: [{ chunks: [`${ANSWER_HEADER}${FIRST}`, SECOND, 'more words'] }],
      moderation: (_t, i) => (i < 2 ? 'allow' : fakeProviderError('transient')),
    });
    expect(eventOf(after.events, 'error').data.code).toBe('STREAM_INTERRUPTED');
    expect(after.h.calls('finish_chat_turn')[0]?.args['p_status']).toBe('partial');
  });

  it('a garbled output_moderation_mode is an internal error before any spend', async () => {
    const h = setup({
      context: defaultContext({
        settings: { feature_flags: { output_moderation_mode: 'whenever' } },
      }),
    });
    const res = await postChat(h, chatBody());
    expect(res.statusCode).toBe(500);
    expect(h.limits.reserve).not.toHaveBeenCalled();
    expect(h.moderationProvider.calls).toBe(0);
  });
});

describe('output gate unit', () => {
  const ledger = () => new UsageLedger({ recordUsage: async () => undefined }, BOT, RUN);

  it('holds a short buffer-mode push, releases on finish, then refuses after a block', async () => {
    const provider = new FakeModerationProvider((t) => (t.includes('BAD') ? 'block' : 'allow'));
    const moderator = createModerator({
      provider,
      mode: 'llm_classifier',
      price: { inputPerMillion: 0, outputPerMillion: 0 },
    });
    const gate = createOutputGate({
      mode: 'buffer',
      moderator,
      signal: new AbortController().signal,
      usage: ledger(),
    });
    expect(await gate.push('x'.repeat(5000))).toBe('');
    expect(provider.calls).toBe(0);
    expect(await gate.finish()).toHaveLength(5000);
    expect(gate.releasedChars).toBe(5000);

    const blocking = createOutputGate({
      mode: 'rolling',
      moderator,
      signal: new AbortController().signal,
      usage: ledger(),
    });
    await expect(blocking.push(`BAD ${'y'.repeat(ROLLING_BATCH_CHARS)}`)).rejects.toBeInstanceOf(
      OutputBlocked,
    );
    await expect(blocking.push('more')).rejects.toBeInstanceOf(OutputBlocked);
    expect(blocking.releasedChars).toBe(0);
  });
});

describe('output cap and provider truncation (P7-D1 fix 5 and fix 12, R1-2, R2-9)', () => {
  const cited = `[[${CHUNK_A}]]`;

  it('a provider that stopped at its output-token limit gives a partial turn and done(partial)', async () => {
    const { h, events } = await run({
      chat: [
        {
          chunks: [`${ANSWER_HEADER}Plans start at ten dollars ${cited}, and then`],
          usage: { inputTokens: 100, outputTokens: 800, truncated: true } as ChatUsage,
        },
      ],
    });
    expect(names(events)).toEqual(['meta', 'delta', 'sources', 'done']);
    expect(eventOf(events, 'done').data.status).toBe('partial');
    // The cited source is still announced and stored.
    expect(eventOf(events, 'sources').data.sources.map((s) => s.chunk_id)).toEqual([CHUNK_A]);
    expect(h.calls('finish_chat_turn')[0]?.args).toMatchObject({
      p_status: 'partial',
      p_handoff_reason: null,
    });
    expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'partial');
  });

  it('truncated: false (or absent) is a complete turn', async () => {
    const { events } = await run({
      chat: [
        {
          chunks: [`${ANSWER_HEADER}Short answer.`],
          usage: { inputTokens: 100, outputTokens: 5, truncated: false } as ChatUsage,
        },
      ],
    });
    expect(eventOf(events, 'done').data.status).toBe('complete');
  });

  it('a truncation flag on a reply that is only a handoff changes nothing', async () => {
    const { events } = await run({
      chat: [
        {
          chunks: ['EVIDENCE: INSUFFICIENT\n'],
          usage: { inputTokens: 100, outputTokens: 5, truncated: true } as ChatUsage,
        },
      ],
    });
    expect(eventOf(events, 'done').data.status).toBe('complete');
    expect(eventOf(events, 'handoff').data.reason).toBe('no_knowledge');
  });

  it.each(['rolling', 'buffer'] as const)(
    'CHAT_MAX_OUTPUT_CHARS stops the stream, keeps what fits and stores partial (%s mode)',
    async (mode) => {
      const piece = 'word '.repeat(100); // 500 characters
      const { h, events } = await run({
        context: defaultContext({ settings: { feature_flags: { output_moderation_mode: mode } } }),
        env: { CHAT_MAX_OUTPUT_CHARS: '700' },
        // After three chunks the provider would stall until the deadline: the cap must have
        // stopped the stream before that.
        chat: [{ chunks: [`${ANSWER_HEADER}${piece}`, piece, piece], hangAfter: 3 }],
      });
      const text = deltaText(events);
      expect(text.length).toBeLessThanOrEqual(700);
      expect(text.length).toBeGreaterThan(600);
      expect(eventOf(events, 'done').data.status).toBe('partial');
      expect(names(events)).toEqual(
        mode === 'rolling'
          ? ['meta', 'delta', 'delta', 'sources', 'done']
          : ['meta', 'delta', 'sources', 'done'],
      );
      expect(h.calls('finish_chat_turn')[0]?.args).toMatchObject({
        p_status: 'partial',
        p_content: text,
      });
      expect(h.runs.finishRun).toHaveBeenCalledWith(BOT, RUN, 'partial');
    },
    20_000,
  );

  it('an answer of exactly CHAT_MAX_OUTPUT_CHARS characters is complete', async () => {
    const { events } = await run({
      env: { CHAT_MAX_OUTPUT_CHARS: '1000' },
      chat: [{ chunks: [`${ANSWER_HEADER}${'a'.repeat(600)}`, 'b'.repeat(400)] }],
    });
    expect(deltaText(events)).toHaveLength(1000);
    expect(eventOf(events, 'done').data.status).toBe('complete');
  });

  it('never cuts a surrogate pair in half', async () => {
    const { events } = await run({
      env: { CHAT_MAX_OUTPUT_CHARS: '101' },
      chat: [{ chunks: [`${ANSWER_HEADER}${'\u{1F600}'.repeat(60)}`] }],
    });
    const text = deltaText(events);
    expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(text).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(text.length).toBe(100);
    expect(eventOf(events, 'done').data.status).toBe('partial');
  });

  it('the text moderated never exceeds the cap either', async () => {
    const { h } = await run({
      env: { CHAT_MAX_OUTPUT_CHARS: '700' },
      chat: [{ chunks: [`${ANSWER_HEADER}${'word '.repeat(300)}`] }],
    });
    const moderated = h.moderationProvider.texts.slice(1).join('');
    expect(moderated.length).toBeLessThanOrEqual(700);
  });
});

describe('all-dropped citations are logged (P11-F2)', () => {
  const INVENTED = '22222222-2222-4222-8222-222222222222';

  it('logs when every cited id was invented, serving the stripped answer as complete', async () => {
    const { h, events } = await run({
      chat: [{ chunks: [`${ANSWER_HEADER}To claim, you need an order number [[${INVENTED}]].`] }],
    });
    expect(eventOf(events, 'done').data.status).toBe('complete');
    expect(eventOf(events, 'sources').data.sources).toEqual([]);
    expect(deltaText(events)).not.toContain(INVENTED);
    expect(h.capture.text).toContain('answer_citations_all_dropped');
  });

  it('does not log when a real citation survives (including inside a multi-id marker)', async () => {
    const { h, events } = await run({
      chat: [
        {
          chunks: [
            `${ANSWER_HEADER}To claim, you need an order number [[${INVENTED}, ${CHUNK_A}]].`,
          ],
        },
      ],
    });
    expect(eventOf(events, 'sources').data.sources.map((s) => s.chunk_id)).toEqual([CHUNK_A]);
    expect(h.capture.text).not.toContain('answer_citations_all_dropped');
  });
});
