import { describe, expect, it } from 'vitest';
import {
  CHUNK_OVERLAP_TOKENS,
  CHUNK_TARGET_TOKENS,
  CHUNKING_VERSION,
  chunkDocument,
  estimateTokens,
  type Chunk,
} from '../../../worker/src/lib/chunk.ts';

// Deterministic synthetic prose: numbered sentences so overlap and order are easy to check.
function prose(sentences: number, start = 1): string {
  return Array.from(
    { length: sentences },
    (_, i) => `Sentence number ${start + i} talks about topic ${(start + i) % 7}.`,
  ).join(' ');
}

const SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function checkInvariants(chunks: Chunk[]): void {
  chunks.forEach((chunk, i) => {
    expect(chunk.chunk_index).toBe(i);
    expect(chunk.content.trim()).not.toBe('');
    expect(chunk.content).toBe(chunk.content.trim());
    expect(chunk.token_count).toBe(estimateTokens(chunk.content));
    expect(chunk.token_count).toBeGreaterThan(0);
    expect(chunk.token_count).toBeLessThanOrEqual(CHUNK_TARGET_TOKENS);
    expect(SURROGATE.test(chunk.content)).toBe(false);
  });
}

describe('chunking config', () => {
  it('has a versioned config constant derived from the sizes', () => {
    expect(CHUNKING_VERSION).toBe(`c1-${CHUNK_TARGET_TOKENS}-${CHUNK_OVERLAP_TOKENS}`);
    expect(chunkDocument([], 'text/plain').version).toBe(CHUNKING_VERSION);
  });

  it('estimates tokens with integer arithmetic', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('\u65E5\u672C\u8A9E')).toBe(3); // one token per CJK character
  });
});

describe('chunkDocument: basics', () => {
  it('returns no chunks for an empty document or empty pages', () => {
    expect(chunkDocument([], 'text/plain').chunks).toEqual([]);
    expect(chunkDocument([{ number: 1, text: '' }], 'text/plain').chunks).toEqual([]);
    expect(chunkDocument([{ number: 1, text: ' \n\n \t ' }], 'text/markdown').chunks).toEqual([]);
    expect(chunkDocument([{ number: 2, text: '  ' }], 'application/pdf').chunks).toEqual([]);
  });

  it('keeps a short document as one chunk', () => {
    const { chunks } = chunkDocument(
      [{ number: 1, text: 'Hello there.\n\nSecond paragraph.' }],
      'text/plain',
    );
    expect(chunks).toEqual([
      {
        chunk_index: 0,
        content: 'Hello there.\n\nSecond paragraph.',
        token_count: estimateTokens('Hello there.\n\nSecond paragraph.'),
        page_number: null,
        section: null,
      },
    ]);
  });

  it('is deterministic: the same input gives identical output', () => {
    const pages = [
      { number: 1, text: prose(200) },
      { number: 2, text: `# Head\n\n${prose(120, 300)}` },
    ];
    const a = JSON.stringify(chunkDocument(pages, 'application/pdf'));
    const b = JSON.stringify(chunkDocument(structuredClone(pages), 'application/pdf'));
    expect(a).toBe(b);
    const md = [{ number: 1, text: `# A\n\n${prose(300)}\n\n## B\n\n${prose(200, 400)}` }];
    expect(JSON.stringify(chunkDocument(md, 'text/markdown'))).toBe(
      JSON.stringify(chunkDocument(md, 'text/markdown')),
    );
  });
});

describe('chunkDocument: size, contiguity and overlap', () => {
  const text = prose(400);
  const { chunks } = chunkDocument([{ number: 1, text }], 'text/plain');

  it('splits long text into several chunks within the size bound', () => {
    expect(chunks.length).toBeGreaterThan(3);
    checkInvariants(chunks);
    // Chunks are reasonably full: all but the last use most of the target.
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.token_count).toBeGreaterThan(CHUNK_TARGET_TOKENS * 0.7);
    }
  });

  it('numbers chunks from 0 without gaps', () => {
    expect(chunks.map((c) => c.chunk_index)).toEqual(chunks.map((_, i) => i));
  });

  it('breaks on sentence boundaries, never mid-word', () => {
    for (const chunk of chunks) {
      expect(chunk.content.startsWith('Sentence number ')).toBe(true);
      expect(chunk.content.endsWith('.')).toBe(true);
    }
  });

  it('overlaps adjacent chunks by roughly the configured amount and loses nothing', () => {
    for (let i = 1; i < chunks.length; i += 1) {
      const prev = (chunks[i - 1] as Chunk).content;
      const cur = (chunks[i] as Chunk).content;
      const firstSentence = cur.slice(0, cur.indexOf('.') + 1);
      const at = prev.lastIndexOf(firstSentence);
      expect(at).toBeGreaterThanOrEqual(0); // the chunk starts with a sentence from the previous one
      const overlapText = prev.slice(at);
      expect(estimateTokens(overlapText)).toBeLessThanOrEqual(CHUNK_OVERLAP_TOKENS);
      expect(cur.startsWith(overlapText)).toBe(true);
    }
    // Every source sentence appears in some chunk.
    const joined = chunks.map((c) => c.content).join('\n');
    for (let n = 1; n <= 400; n += 1) expect(joined).toContain(`Sentence number ${n} `);
  });
});

describe('chunkDocument: pages', () => {
  it('keeps the source page number and never spans pages', () => {
    const pages = [
      { number: 1, text: prose(100) },
      { number: 4, text: prose(100, 500) },
      { number: 5, text: 'Short last page.' },
    ];
    const { chunks } = chunkDocument(pages, 'application/pdf');
    checkInvariants(chunks);
    const numbers = chunks.map((c) => c.page_number);
    expect(new Set(numbers)).toEqual(new Set([1, 4, 5]));
    expect(numbers).toEqual([...numbers].sort((a, b) => (a as number) - (b as number)));
    for (const chunk of chunks) {
      if (chunk.page_number === 1) expect(chunk.content).not.toMatch(/number [5-9]\d\d /);
      if (chunk.page_number === 4) expect(chunk.content).toMatch(/Sentence number 5\d\d /);
    }
    expect(chunks.at(-1)).toMatchObject({ page_number: 5, content: 'Short last page.' });
    expect(chunks.every((c) => c.section === null)).toBe(true);
  });

  it('uses a null page number for text and Markdown', () => {
    for (const type of ['text/plain', 'text/markdown'] as const) {
      const { chunks } = chunkDocument([{ number: 1, text: 'Some words.' }], type);
      expect(chunks[0]?.page_number).toBeNull();
    }
  });
});

describe('chunkDocument: Markdown sections', () => {
  const md = [
    'Intro before any heading.',
    '',
    '# Getting started',
    'Install the thing.',
    '',
    '## Configuration',
    '',
    prose(150),
    '',
    '```sh',
    '# this is a shell comment, not a heading',
    'run --now',
    '```',
    '',
    '## Troubleshooting ##',
    '',
    'Restart it.',
  ].join('\n');
  const { chunks } = chunkDocument([{ number: 1, text: md }], 'text/markdown');

  it('maps each chunk to the nearest preceding heading at its start', () => {
    checkInvariants(chunks);
    expect(chunks[0]?.section).toBeNull(); // text before the first heading
    const sections = chunks.map((c) => c.section);
    expect(sections).toContain('Configuration');
    expect(sections.at(-1)).toBe('Troubleshooting');
    expect(sections).not.toContain('this is a shell comment, not a heading');
  });

  it('labels a chunk that starts at a heading with that heading', () => {
    const { chunks: small } = chunkDocument(
      [{ number: 1, text: '# One\n\nAlpha.\n\n# Two\n\nBeta.' }],
      'text/markdown',
    );
    expect(small).toHaveLength(1);
    expect(small[0]?.section).toBe('One');
    expect(small[0]?.content).toContain('# Two');
  });

  it('truncates very long headings and ignores empty ones', () => {
    const long = 'H'.repeat(500);
    const { chunks: out } = chunkDocument(
      [{ number: 1, text: `# ${long}\n\nBody.\n\n#\n\nMore.` }],
      'text/markdown',
    );
    expect(out[0]?.section).toBe('H'.repeat(200));
    expect(out[0]?.content).not.toMatch(/^#$/m);
  });

  it('gives no section for plain text, even with # lines', () => {
    const { chunks: plain } = chunkDocument(
      [{ number: 1, text: '# Not a heading\n\nBody.' }],
      'text/plain',
    );
    expect(plain.every((c) => c.section === null)).toBe(true);
  });
});

describe('chunkDocument: oversize and Unicode input', () => {
  it('splits a sentence longer than the target on word boundaries', () => {
    const words = Array.from({ length: 1500 }, (_, i) => `word${i}`).join(' ');
    const { chunks } = chunkDocument([{ number: 1, text: words }], 'text/plain');
    expect(chunks.length).toBeGreaterThan(2);
    checkInvariants(chunks);
    for (const chunk of chunks) {
      for (const w of chunk.content.split(' ')) expect(w).toMatch(/^word\d+$/);
    }
  });

  it('handles a very large document without recursion or argument-limit failures', () => {
    const { chunks } = chunkDocument([{ number: 1, text: 'ab '.repeat(300_000) }], 'text/plain');
    expect(chunks.length).toBeGreaterThan(100);
    expect(chunks.map((c) => c.chunk_index)).toEqual(chunks.map((_, i) => i));
  });

  it('splits an unbroken CJK run without breaking code points', () => {
    const run = '\u65E5\u672C\u8A9E'.repeat(1000);
    const { chunks } = chunkDocument([{ number: 1, text: run }], 'text/plain');
    expect(chunks.length).toBeGreaterThan(5);
    checkInvariants(chunks);
    expect(chunks.every((c) => /^[\u65E5\u672C\u8A9E]+$/.test(c.content))).toBe(true);
  });

  it('never splits surrogate pairs, combining marks or ZWJ sequences', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const accented = 'e\u0301';
    const run = (family + accented + '\u{1F600}').repeat(600);
    const { chunks } = chunkDocument([{ number: 1, text: run }], 'text/plain');
    expect(chunks.length).toBeGreaterThan(3);
    checkInvariants(chunks);
    for (const chunk of chunks) {
      // A cut never lands inside the family sequence or before a combining mark.
      expect(/^(?:\u0301|\u200D|\u{1F469}|\u{1F467})/u.test(chunk.content)).toBe(false);
      expect(/(?:\u200D|\u{1F468}|\u{1F469})$/u.test(chunk.content)).toBe(false);
    }
    expect(chunks.map((c) => c.content).join('')).toContain(family + accented);
  });

  it('splits CJK sentences on full-width terminators', () => {
    const sentence = '\u3053\u308C\u306F\u30C6\u30B9\u30C8\u3067\u3059\u3002';
    const { chunks } = chunkDocument([{ number: 1, text: sentence.repeat(300) }], 'text/plain');
    expect(chunks.length).toBeGreaterThan(1);
    checkInvariants(chunks);
    expect(chunks.every((c) => c.content.endsWith('\u3002'))).toBe(true);
  });

  it('preserves multi-paragraph structure inside a chunk', () => {
    const { chunks } = chunkDocument(
      [{ number: 1, text: 'One.\n\n\n\nTwo.\nStill two.' }],
      'text/plain',
    );
    expect(chunks[0]?.content).toBe('One.\n\nTwo.\nStill two.');
  });
});
