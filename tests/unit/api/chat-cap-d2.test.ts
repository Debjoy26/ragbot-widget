import { afterEach, describe, expect, it } from 'vitest';
import {
  ANSWER_HEADER,
  CHUNK_A,
  chatBody,
  closeApps,
  deltaText,
  eventOf,
  parseSse,
  postChat,
  setup,
} from './chat-harness.ts';

afterEach(closeApps);

// P7-D2 F9: when CHAT_MAX_OUTPUT_CHARS cuts the answer in the middle of a [[chunk_id]] marker, the
// visitor must not see the first half of it, and neither may the stored message.

const CAP = 100; // the smallest CHAT_MAX_OUTPUT_CHARS the configuration accepts

describe('P7-D2 F9: the output cap cuts inside a citation marker', () => {
  // How many characters of `[[<36-character id>]]` (40 in all) survive the cut.
  const cases: ReadonlyArray<readonly [string, number]> = [
    ['after the first bracket', 1],
    ['after the opening brackets', 2],
    ['inside the id', 9],
    ['just before the closing brackets', 38],
    ['between the closing brackets', 39],
  ];

  it.each(cases)('cut %s: no part of the marker is shown or stored', async (_name, into) => {
    const lead = `${'a'.repeat(CAP - into - 1)} `; // CAP - into characters
    const body = `${lead}[[${CHUNK_A}]] and more text after it`;
    const h = setup({
      env: { CHAT_MAX_OUTPUT_CHARS: String(CAP) },
      chat: [{ chunks: [`${ANSWER_HEADER}${body}`] }],
    });
    const res = await postChat(h, chatBody());
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    const shown = deltaText(events);
    expect(shown.startsWith('aaaa')).toBe(true);
    expect(shown).not.toContain('[');
    expect(shown).not.toContain(CHUNK_A.slice(0, 8));
    const stored = String(h.calls('finish_chat_turn')[0]?.args['p_content']);
    expect(stored).not.toContain('[');
    expect(stored).not.toContain(CHUNK_A.slice(0, 8));
    expect(eventOf(events, 'done').data.status).toBe('partial');
  });

  it('a whole marker inside the cap is still stripped and cited', async () => {
    const body = `Plans start at ten dollars [[${CHUNK_A}]]. More text that goes on and on and on past the cap.`;
    const h = setup({
      env: { CHAT_MAX_OUTPUT_CHARS: String(CAP) },
      chat: [{ chunks: [`${ANSWER_HEADER}${body}`] }],
    });
    const res = await postChat(h, chatBody());
    const events = parseSse(res.body);
    expect(deltaText(events)).toMatch(/^Plans start at ten dollars\./);
    expect(deltaText(events)).not.toContain('[[');
    expect(eventOf(events, 'sources').data.sources.map((s) => s.chunk_id)).toEqual([CHUNK_A]);
  });
});
