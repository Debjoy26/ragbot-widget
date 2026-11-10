import { describe, expect, it } from 'vitest';
import { parseSse, type SseEvent } from '../../../shared/src/ai/index.ts';
import { ProviderError } from '../../../shared/src/providers.ts';
import { bodyOf, bytePieces, type BodyProbe } from './helpers.ts';

// P7-AI: the incremental SSE parser, on its own.

async function parse(
  chunks: readonly (string | Uint8Array)[],
  maxBytes?: number,
): Promise<SseEvent[]> {
  const reader = bodyOf(chunks).getReader();
  const out: SseEvent[] = [];
  for await (const ev of parseSse(reader, maxBytes)) out.push(ev);
  return out;
}

describe('parseSse', () => {
  it('parses simple events', async () => {
    expect(await parse(['data: one\n\ndata: two\n\n'])).toEqual([
      { event: undefined, data: 'one' },
      { event: undefined, data: 'two' },
    ]);
  });

  it('gives the same events however the bytes are cut', async () => {
    const text = 'event: a\ndata: {"x":"é😀"}\n\n: comment\n\nevent: b\r\ndata: 2\r\n\r\n';
    const whole = await parse([text]);
    expect(whole).toEqual([
      { event: 'a', data: '{"x":"é😀"}' },
      { event: 'b', data: '2' },
    ]);
    for (let size = 1; size <= text.length; size++) {
      expect(await parse(bytePieces(text, size))).toEqual(whole);
    }
  });

  it('treats LF, CRLF and lone CR as line ends', async () => {
    expect(await parse(['data: a\n\ndata: b\r\n\r\ndata: c\r\r'])).toEqual([
      { event: undefined, data: 'a' },
      { event: undefined, data: 'b' },
      { event: undefined, data: 'c' },
    ]);
  });

  it('holds a trailing CR until the next chunk shows whether an LF follows', async () => {
    expect(await parse(['data: a\r', '\n\r', '\ndata: b\n\n'])).toEqual([
      { event: undefined, data: 'a' },
      { event: undefined, data: 'b' },
    ]);
  });

  it('joins multi-line data with a newline', async () => {
    expect(await parse(['data: line1\ndata: line2\ndata:\ndata: line4\n\n'])).toEqual([
      { event: undefined, data: 'line1\nline2\n\nline4' },
    ]);
  });

  it('removes only one leading space after the colon', async () => {
    expect(await parse(['data:  two spaces\n\ndata:none\n\n'])).toEqual([
      { event: undefined, data: ' two spaces' },
      { event: undefined, data: 'none' },
    ]);
  });

  it('ignores comments, id, retry and unknown fields, and events with no data', async () => {
    expect(
      await parse([': hi\nid: 7\nretry: 100\nfoo: bar\n\nevent: only-name\n\ndata: x\n\n']),
    ).toEqual([{ event: undefined, data: 'x' }]);
  });

  it('does not carry an event name over to the next event', async () => {
    expect(await parse(['event: a\ndata: 1\n\ndata: 2\n\n'])).toEqual([
      { event: 'a', data: '1' },
      { event: undefined, data: '2' },
    ]);
  });

  it('strips a leading byte order mark', async () => {
    expect(await parse(['﻿data: x\n\n'])).toEqual([{ event: undefined, data: 'x' }]);
  });

  it('delivers a final event with no closing blank line and a final line with no terminator', async () => {
    expect(await parse(['data: a\n\ndata: b'])).toEqual([
      { event: undefined, data: 'a' },
      { event: undefined, data: 'b' },
    ]);
  });

  it('yields nothing for an empty stream', async () => {
    expect(await parse([])).toEqual([]);
  });

  it('refuses more than the byte cap, permanent and billed, and cancels the body', async () => {
    const probe: BodyProbe = { cancelled: false };
    const reader = bodyOf(['data: 1\n\n', 'data: 2\n\n', 'data: 3\n\n'], {
      probe,
      hang: true,
    }).getReader();
    const seen: SseEvent[] = [];
    let error: unknown;
    try {
      for await (const ev of parseSse(reader, 20)) seen.push(ev);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('permanent');
    expect((error as ProviderError).billed).toBe(true);
    expect(seen).toEqual([
      { event: undefined, data: '1' },
      { event: undefined, data: '2' },
    ]);
    expect(probe.cancelled).toBe(true);
  });

  it('counts bytes, not characters', async () => {
    // 4 bytes per character: 4 emoji are 8 characters but 16 bytes, 24 in all, over a 20-byte cap.
    await expect(parse(['data: 😀😀😀😀\n\n'], 20)).rejects.toBeInstanceOf(ProviderError);
    await expect(parse(['data: ab\n\n'], 20)).resolves.toHaveLength(1);
  });
});
