import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CHUNK_OVERLAP_TOKENS,
  CHUNK_TARGET_TOKENS,
  CHUNKING_FINGERPRINT,
  CHUNKING_VERSION,
  ChunkLimitError,
  chunkDocument,
  chunkDocumentAsync,
  deriveChunkingVersion,
  estimateTokens,
  matchHeading,
  MAX_HEADING_INDENT,
  MAX_HEADING_LINE_CHARS,
  MAX_HEADING_MARKS,
  splitHard,
  splitSentences,
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

const GOLDEN_COUNTS = [6, 3, 4];
const GOLDEN_HASH = '69c308e50e67948fb36af8c5c21a18a3ba0d5f93bfd6b6458a6e318b59101101';
// The version hash changed from 63a5402b to e9e81409 when sentence and heading detection moved from
// backtracking regexes to linear scans (P6-D3, review R-1): the pattern set the hash covers is
// different. The chunk OUTPUT hash above did not change, so stored chunks stay valid in content.
//
// It changed again, from e9e81409 to eb436a36, when the two literals in matchHeading (the indent
// maximum 3 and the heading-mark maximum 6) became the named constants MAX_HEADING_INDENT and
// MAX_HEADING_MARKS and were added to the hashed sizes (review P6-R4, F8). The output hash did not
// change.
const GOLDEN_VERSION = 'c1-350-50-eb436a36';

describe('chunking config', () => {
  it('has a versioned config constant derived from the sizes, weights and patterns', () => {
    expect(CHUNKING_VERSION).toMatch(
      new RegExp(`^c1-${CHUNK_TARGET_TOKENS}-${CHUNK_OVERLAP_TOKENS}-[0-9a-f]{8}$`),
    );
    expect(deriveChunkingVersion(CHUNKING_FINGERPRINT)).toBe(CHUNKING_VERSION);
    expect(chunkDocument([], 'text/plain').version).toBe(CHUNKING_VERSION);
  });

  it('changes the version when a token weight, a size, a separator or a pattern changes', () => {
    const base = CHUNKING_FINGERPRINT;
    const variants = [
      {
        ...base,
        weights: [...base.weights.slice(0, 1), base.weights[1]! + 1, ...base.weights.slice(2)],
      },
      { ...base, sizes: [...base.sizes.slice(0, 2), base.sizes[2]! + 1] },
      { ...base, separators: ['\n\n\n'] },
      { ...base, patterns: [...base.patterns.slice(0, 1), /\s*/, ...base.patterns.slice(2)] },
      { ...base, patterns: [...base.patterns.slice(0, -1), /^#{1,5}/] },
      { ...base, patterns: [...base.patterns.slice(0, 1), /^\s*/i, ...base.patterns.slice(2)] },
    ];
    const versions = new Set([CHUNKING_VERSION, ...variants.map(deriveChunkingVersion)]);
    expect(versions.size).toBe(variants.length + 1);
  });

  // F8: the literals inside matchHeading shape which lines are headings, so they are hashed too.
  it('hashes the heading indent maximum, the heading mark maximum and the heading line cap', () => {
    expect(MAX_HEADING_INDENT).toBe(3);
    expect(MAX_HEADING_MARKS).toBe(6);
    const sizes = CHUNKING_FINGERPRINT.sizes;
    for (const constant of [MAX_HEADING_INDENT, MAX_HEADING_MARKS, MAX_HEADING_LINE_CHARS]) {
      expect(sizes).toContain(constant);
    }
    const versions = new Set([CHUNKING_VERSION]);
    for (const constant of [MAX_HEADING_INDENT, MAX_HEADING_MARKS, MAX_HEADING_LINE_CHARS]) {
      const at = sizes.lastIndexOf(constant);
      const changed = sizes.map((n, i) => (i === at ? n + 1 : n));
      versions.add(deriveChunkingVersion({ ...CHUNKING_FINGERPRINT, sizes: changed }));
    }
    expect(versions.size).toBe(4);
  });

  it('matchHeading honours the named indent and mark maxima', () => {
    expect(matchHeading(`${' '.repeat(MAX_HEADING_INDENT)}# t`)).toBe('t');
    expect(matchHeading(`${' '.repeat(MAX_HEADING_INDENT + 1)}# t`)).toBeNull();
    expect(matchHeading(`${'#'.repeat(MAX_HEADING_MARKS)} t`)).toBe('t');
    expect(matchHeading(`${'#'.repeat(MAX_HEADING_MARKS + 1)} t`)).toBeNull();
  });

  // GOLDEN OUTPUT. If this test fails, the chunk output for a fixed input changed. That makes every
  // stored chunk of every document stale. Bump the `c1` generation prefix in deriveChunkingVersion
  // (so `chunking_version` changes and retried jobs re-chunk from 0) and then update the hashes
  // below. A change to a weight, size or pattern changes the version string by itself, but the
  // output hash must still be updated deliberately.
  it('pins the chunk output for a fixed input (golden)', () => {
    const markdown = [
      '# Opening hours',
      '',
      prose(40),
      '',
      '## Contact',
      '',
      '```',
      'code block line one',
      '',
      'code block line two',
      '```',
      '',
      prose(30, 100),
      '',
      '\u65E5\u672C\u8A9E\u306E\u6587\u7AE0\u3067\u3059\u3002'.repeat(120),
    ].join('\n');
    const pdfPages = [
      { number: 1, text: prose(35) },
      { number: 2, text: `${prose(5)}\n\n${prose(60, 200)}` },
    ];
    const outputs = [
      chunkDocument([{ number: 1, text: markdown }], 'text/markdown'),
      chunkDocument([{ number: 1, text: prose(90, 300) }], 'text/plain'),
      chunkDocument(pdfPages, 'application/pdf'),
    ];
    const hash = createHash('sha256')
      .update(JSON.stringify(outputs.map((o) => o.chunks)))
      .digest('hex');
    expect(outputs.map((o) => o.chunks.length)).toEqual(GOLDEN_COUNTS);
    expect(hash).toBe(GOLDEN_HASH);
    expect(CHUNKING_VERSION).toBe(GOLDEN_VERSION);
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

describe('chunkDocumentAsync', () => {
  const text = (n: number): string => prose(n);

  it('gives exactly the same output as chunkDocument', async () => {
    const pages = [
      { number: 1, text: `# Title\n\n${text(300)}\n\n## Part\n\n${text(200)}` },
      { number: 2, text: text(150) },
    ];
    for (const type of ['text/markdown', 'text/plain', 'application/pdf'] as const) {
      const sync = chunkDocument(pages, type);
      const async = await chunkDocumentAsync(pages, type, { maxChunks: 10_000 });
      expect(async).toEqual(sync);
    }
  });

  it('lets the event loop run while it chunks a large document (heartbeats keep firing)', async () => {
    const big = [
      { number: 1, text: Array.from({ length: 60 }, (_, i) => text(1000 + i)).join('\n\n') },
    ];
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    try {
      const result = await chunkDocumentAsync(big, 'text/plain', { maxChunks: 1_000_000 });
      expect(result.chunks.length).toBeGreaterThan(100);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });

  it('stops with ChunkLimitError once the chunk cap would be passed, and allows exactly the cap', async () => {
    const pages = [{ number: 1, text: text(600) }];
    const total = chunkDocument(pages, 'text/plain').chunks.length;
    expect(total).toBeGreaterThan(3);
    await expect(
      chunkDocumentAsync(pages, 'text/plain', { maxChunks: total - 1 }),
    ).rejects.toBeInstanceOf(ChunkLimitError);
    const ok = await chunkDocumentAsync(pages, 'text/plain', { maxChunks: total });
    expect(ok.chunks).toHaveLength(total);
  });

  it('rejects with an AbortError when the signal aborts', async () => {
    const controller = new AbortController();
    const big = [
      { number: 1, text: Array.from({ length: 80 }, (_, i) => text(1000 + i)).join('\n\n') },
    ];
    const pending = chunkDocumentAsync(big, 'text/plain', {
      maxChunks: 1_000_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'fails closed on an invalid maxChunks (%s)',
    async (maxChunks) => {
      await expect(
        chunkDocumentAsync([{ number: 1, text: 'hello there' }], 'text/plain', { maxChunks }),
      ).rejects.toBeInstanceOf(RangeError);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// P6-D3 R-1: chunking time is linear in the input. Hostile shapes used to cost time quadratic in
// the length of a run (32000 consecutive `!` took about 2.7 s; 1,000,000 would take well over 20
// minutes).
// ---------------------------------------------------------------------------------------------
describe('chunkDocument: linear time on hostile input (R-1)', () => {
  const N = 1_000_000;
  const LIMIT_MS = 2000;
  const shapes: readonly [string, 'text/plain' | 'text/markdown', string][] = [
    ['a run of "!"', 'text/plain', `a${'!'.repeat(N)}b`],
    ['a run of "."', 'text/plain', '.'.repeat(N)],
    ['punctuation, closers, no whitespace', 'text/plain', `x${'.")'.repeat(N / 3)}y`],
    ['spaces inside a Markdown heading', 'text/markdown', `# a${' '.repeat(N)}b`],
    ['a heading ending in a run of "#"', 'text/markdown', `# a ${'#'.repeat(N)}`],
    ['a single line of "#"', 'text/markdown', '#'.repeat(N)],
    ['only spaces', 'text/plain', ' '.repeat(N)],
    ['only newlines', 'text/markdown', '\n'.repeat(N)],
    ['blank lines made of spaces', 'text/plain', '\n \n'.repeat(N / 3)],
    ['combining marks after one letter', 'text/plain', `a${'\u0301'.repeat(N)}`],
    ['zero-width joiners after one letter', 'text/plain', `a${'\u200D'.repeat(N)}`],
    ['one unbroken CJK run', 'text/plain', '\u65E5'.repeat(N)],
    ['one unbroken ASCII word', 'text/plain', 'a'.repeat(N)],
    ['one-character words', 'text/plain', 'a '.repeat(N / 2)],
    ['one-character sentences', 'text/plain', 'a. '.repeat(N / 3)],
    ['one million heading lines', 'text/markdown', '# h\n'.repeat(N / 4)],
  ];

  it.each(shapes)(
    'chunks 1,000,000 characters of %s in under 2 seconds',
    (_name, mediaType, text) => {
      expect(text.length).toBeGreaterThanOrEqual(N - 4);
      const started = performance.now();
      const { chunks } = chunkDocument([{ number: 1, text }], mediaType);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(LIMIT_MS);
      chunks.forEach((chunk, i) => {
        expect(chunk.chunk_index).toBe(i);
        expect(chunk.token_count).toBeLessThanOrEqual(CHUNK_TARGET_TOKENS);
      });
    },
  );

  // F7: a very long separator (whitespace between two atoms) used to be rescanned for every
  // overlap atom the packer dropped. The cost is now read once per atom. This is a regression guard
  // with a generous bound: the old code also finished this shape in under 2 s (about 0.45 s against
  // about 0.1 s now on the development machine), so it does not fail on the old code by itself; the
  // golden test and the tests above pin the output, which did not change.
  it('chunks 2,000,000 characters of tiny sentences split by 200,000 spaces in under 2 seconds', () => {
    const unit = Array.from({ length: 200 }, (_, i) => `S${String(i)}.`).join(' ');
    let text = '';
    while (text.length < 2_000_000) text += `${unit}${' '.repeat(200_000)}End.`;
    const started = performance.now();
    const { chunks } = chunkDocument([{ number: 1, text }], 'text/plain');
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(LIMIT_MS);
    expect(chunks.length).toBeGreaterThan(10);
    chunks.forEach((chunk, i) => {
      expect(chunk.chunk_index).toBe(i);
      expect(chunk.token_count).toBeLessThanOrEqual(CHUNK_TARGET_TOKENS);
    });
  });

  it('keeps time proportional to size: 16 times the input costs far less than 16 squared', () => {
    const time = (n: number): number => {
      const started = performance.now();
      chunkDocument([{ number: 1, text: `a${'!'.repeat(n)}b` }], 'text/plain');
      return performance.now() - started;
    };
    time(20_000); // warm up
    const small = Math.max(time(40_000), 1);
    const large = time(640_000);
    expect(large / small).toBeLessThan(16 * 6);
  });

  it('never treats a line longer than the heading cap as a heading', () => {
    const longLine = `# ${'h'.repeat(MAX_HEADING_LINE_CHARS)}`;
    expect(matchHeading(longLine)).toBeNull();
    expect(matchHeading(`# ${'h'.repeat(MAX_HEADING_LINE_CHARS - 2)}`)).not.toBeNull();
    const { chunks } = chunkDocument([{ number: 1, text: `${longLine}\n\nbody` }], 'text/markdown');
    expect(chunks.every((c) => c.section === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The linear scans must select exactly what the old backtracking code selected. The old patterns
// and the old hard splitter are copied here as the reference.
// ---------------------------------------------------------------------------------------------
describe('linear scans match the legacy regexes (R-1)', () => {
  const LEGACY_SENTENCE =
    /[.!?\u2026]+["'\u201D\u2019)\]]*(?=\s)|[\u3002\uFF01\uFF1F\uFF0E]+[\u300D\u300F\uFF09]*/gu;
  const LEGACY_HEADING = /^\s{0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;

  function legacySentences(text: string): { text: string; sep: string }[] {
    const pieces: { text: string; sep: string }[] = [];
    let pos = 0;
    let sep = '';
    for (const m of text.matchAll(LEGACY_SENTENCE)) {
      const end = m.index + m[0].length;
      pieces.push({ text: text.slice(pos, end), sep });
      const ws = /^\s*/.exec(text.slice(end))?.[0] ?? '';
      sep = ws;
      pos = end + ws.length;
    }
    if (pos < text.length) pieces.push({ text: text.slice(pos), sep });
    return pieces;
  }

  const CAP_Q = CHUNK_TARGET_TOKENS * 4;
  function legacyHard(text: string): { text: string; sep: string }[] {
    const quarter = (t: string): number => {
      let q = 0;
      for (const ch of t) {
        const cp = ch.codePointAt(0) as number;
        q += cp < 0x80 ? 1 : cp < 0x2e80 ? 2 : 4;
      }
      return q;
    };
    const combining = /^(?:\p{M}|\u200D|\uFE0F|[\u{E0100}-\u{E01EF}])/u;
    const points = Array.from(text);
    const pieces: { text: string; sep: string }[] = [];
    let start = 0;
    while (start < points.length) {
      let q = 0;
      let end = start;
      while (end < points.length) {
        const cost = quarter(points[end] as string);
        if (q + cost > CAP_Q && end > start) break;
        q += cost;
        end += 1;
      }
      while (
        end < points.length &&
        end > start + 1 &&
        (combining.test(points[end] as string) || points[end - 1] === '\u200D')
      ) {
        end -= 1;
      }
      pieces.push({ text: points.slice(start, end).join(''), sep: '' });
      start = end;
    }
    return pieces;
  }

  // Small deterministic generator (a linear congruential sequence); no Math.random.
  function generator(seed: number): () => number {
    let state = seed;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }
  const ALPHABET = [
    'a',
    'b',
    'Word',
    ' ',
    '  ',
    '\t',
    '\r',
    '.',
    '!',
    '?',
    '\u2026',
    '"',
    "'",
    ')',
    ']',
    '\u201D',
    '#',
    '##',
    '#######',
    '\u3002',
    '\uFF01',
    '\u300D',
    '\uFF09',
    '\u65E5',
    '\u0301',
    '\u200D',
    '\u{1F600}',
    '\u2028',
    ' # ',
    '\u00E9',
    '\u00A0',
    '\uFE0F',
    '\n',
  ];
  function randomText(next: () => number, length: number): string {
    let out = '';
    for (let i = 0; i < length; i += 1) {
      out += ALPHABET[Math.floor(next() * ALPHABET.length)] as string;
    }
    return out;
  }

  it('splits sentences exactly as the legacy pattern did, on 20000 random strings', () => {
    const next = generator(7);
    for (let i = 0; i < 20_000; i += 1) {
      const text = randomText(next, 1 + Math.floor(next() * 40));
      expect(splitSentences(text), JSON.stringify(text)).toEqual(legacySentences(text));
    }
  });

  it('finds the same headings and heading text as the legacy pattern, on 20000 random lines', () => {
    const next = generator(11);
    for (let i = 0; i < 20_000; i += 1) {
      const line = randomText(next, 1 + Math.floor(next() * 24)).replaceAll('\n', ' ');
      const legacy = LEGACY_HEADING.exec(line);
      const expected = legacy === null ? null : (legacy[1] ?? '');
      const actual = matchHeading(line);
      // Only the trimmed label is used by the chunker; compare that and the match/no-match answer.
      expect(actual === null, JSON.stringify(line)).toBe(expected === null);
      if (expected !== null)
        expect((actual as string).trim(), JSON.stringify(line)).toBe(expected.trim());
    }
  });

  it('keeps the heading edge cases of the legacy pattern', () => {
    expect(matchHeading('# Title')).toBe('Title');
    expect(matchHeading('## Title ##')).toBe('Title');
    expect(matchHeading('   ### Title  ')).toBe('Title');
    expect(matchHeading('#')).toBe('');
    expect(matchHeading('#\tTitle')).toBe('Title');
    expect(matchHeading('#NoSpace')).toBeNull();
    expect(matchHeading('####### seven')).toBeNull();
    expect(matchHeading('    # four spaces')).toBeNull();
    expect(matchHeading('# Title\r')).toBeNull(); // `.` never matched a carriage return
    expect(matchHeading('# C# and F#')).toBe('C# and F#');
    expect(matchHeading('# ###')).toBe('###');
  });

  it('cuts an unbroken run exactly as the legacy splitter did', () => {
    const next = generator(23);
    const parts = ['x', '\u0301', '\u200D', '\u65E5', '\u{1F600}', '\u00E9', '\uFE0F', 'ab'];
    for (let i = 0; i < 200; i += 1) {
      let text = '';
      const length = 1 + Math.floor(next() * 3000);
      for (let j = 0; j < length; j += 1) {
        text += parts[Math.floor(next() * parts.length)] as string;
      }
      expect(splitHard(text), `case ${String(i)}`).toEqual(legacyHard(text));
    }
    for (const unit of ['\u0301', '\u200D', '\u65E5', 'x']) {
      const text = `a${unit.repeat(5000)}`;
      expect(splitHard(text)).toEqual(legacyHard(text));
    }
  });
});
