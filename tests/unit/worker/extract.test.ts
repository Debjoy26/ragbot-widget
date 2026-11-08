import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXTRACTION_VERSION,
  ExtractError,
  extractText,
  MIN_PDF_TEXT_CHARS,
  normalizeText,
  type ExtractLimits,
} from '../../../worker/src/lib/extract.ts';
import { buildEmptyPasswordEncryptedPdf, buildPdf, utf8 } from './fixtures/pdf.ts';

const LIMITS: ExtractLimits = {
  timeoutMs: 30_000,
  maxMemoryMb: 512,
  maxPages: 300,
  maxChars: 1_000_000,
};

async function failureOf(promise: Promise<unknown>): Promise<ExtractError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ExtractError);
    return err as ExtractError;
  }
  throw new Error('expected extraction to fail');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extractText: text and Markdown', () => {
  it('decodes plain text, strips the BOM and normalises newlines', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('line one\r\nline two\rline three\n')]);
    const result = await extractText(bytes, 'text/plain', LIMITS);
    expect(result.method).toBe('plain_text');
    expect(result.version).toBe(EXTRACTION_VERSION);
    expect(result.pages).toEqual([{ number: 1, text: 'line one\nline two\nline three\n' }]);
  });

  it('reports method markdown and keeps Markdown syntax as data', async () => {
    const source = '# Title\r\n\r\n<script>alert(1)</script>\r\n';
    const result = await extractText(utf8(source), 'text/markdown', LIMITS);
    expect(result.method).toBe('markdown');
    expect(result.pages[0]?.text).toBe('# Title\n\n<script>alert(1)</script>\n');
  });

  it('keeps non-ASCII text intact', async () => {
    const result = await extractText(
      utf8('caf\u00E9 \u65E5\u672C\u8A9E \u{1F600}'),
      'text/plain',
      LIMITS,
    );
    expect(result.pages[0]?.text).toBe('caf\u00E9 \u65E5\u672C\u8A9E \u{1F600}');
  });

  it('rejects invalid UTF-8 as FILE_UNSUPPORTED', async () => {
    const err = await failureOf(
      extractText(new Uint8Array([0x68, 0x69, 0xc3, 0x28]), 'text/plain', LIMITS),
    );
    expect(err.code).toBe('FILE_UNSUPPORTED');
    expect(err.reason).toBe('invalid_utf8');
  });

  it('rejects NUL bytes and binary content', async () => {
    const err = await failureOf(
      extractText(new Uint8Array([0x68, 0x00, 0x69]), 'text/markdown', LIMITS),
    );
    expect(err.code).toBe('FILE_UNSUPPORTED');
  });

  it('rejects empty and whitespace-only text; never ready with empty content', async () => {
    for (const body of ['', '  \r\n\t \n']) {
      const err = await failureOf(extractText(utf8(body), 'text/plain', LIMITS));
      expect(err.code).toBe('FILE_UNSUPPORTED');
    }
  });

  it('rejects a PDF declared as text', async () => {
    const err = await failureOf(
      extractText(buildPdf({ pages: [['some words here']] }), 'text/plain', LIMITS),
    );
    expect(err.code).toBe('FILE_UNSUPPORTED');
    expect(err.reason).toBe('type_mismatch');
  });

  it('rejects text declared as PDF without starting a child', async () => {
    const err = await failureOf(
      extractText(utf8('just some text, not a pdf'), 'application/pdf', LIMITS),
    );
    expect(err.code).toBe('FILE_UNSUPPORTED');
    expect(err.reason).toBe('type_mismatch');
  });

  it('rejects an unknown media type', async () => {
    const err = await failureOf(
      extractText(utf8('text'), 'image/png' as unknown as 'text/plain', LIMITS),
    );
    expect(err.code).toBe('FILE_UNSUPPORTED');
  });

  it('fails closed on missing or invalid limits', async () => {
    const bad: Partial<ExtractLimits>[] = [
      {},
      { timeoutMs: 0 },
      { maxMemoryMb: -1 },
      { maxPages: 1.5 },
      { maxChars: 0 },
      { maxChars: Number.NaN },
      { timeoutMs: Number.NaN },
    ];
    for (const patch of bad) {
      const limits = { ...LIMITS, ...patch } as ExtractLimits;
      const incomplete = Object.keys(patch).length === 0 ? ({} as ExtractLimits) : limits;
      await expect(extractText(utf8('hello'), 'text/plain', incomplete)).rejects.toBeInstanceOf(
        RangeError,
      );
    }
  });
});

describe('normalizeText', () => {
  it('removes control characters and repairs lone surrogates', () => {
    expect(normalizeText('a\u0000b\u0007c\u007fd')).toBe('abcd');
    expect(normalizeText('ok\ud800x')).toBe('ok\uFFFDx');
    expect(normalizeText('\uFEFFa\uFEFFb')).toBe('ab');
    expect(normalizeText('a\u2028b\u0085c')).toBe('a\nb\nc');
  });
});

describe('extractText: PDF', () => {
  it('extracts the text of a one-page PDF', async () => {
    const pdf = buildPdf({ pages: [['The quick brown fox jumps over the lazy dog.']] });
    const result = await extractText(pdf, 'application/pdf', LIMITS);
    expect(result.method).toBe('pdf_text');
    expect(result.version).toBe(EXTRACTION_VERSION);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.number).toBe(1);
    expect(result.pages[0]?.text).toContain('quick brown fox');
  });

  it('keeps page numbers on a multi-page PDF and drops empty pages', async () => {
    const pdf = buildPdf({
      pages: [
        ['First page has enough words to count.'],
        [],
        ['Third page carries more words.', 'Second line of the third page.'],
      ],
    });
    const result = await extractText(pdf, 'application/pdf', LIMITS);
    expect(result.pages.map((p) => p.number)).toEqual([1, 3]);
    expect(result.pages[0]?.text).toContain('First page');
    expect(result.pages[1]?.text).toContain('Third page');
    expect(result.pages[1]?.text).toContain('Second line');
  });

  it('returns OCR_REQUIRED for a PDF with no text layer', async () => {
    const err = await failureOf(
      extractText(buildPdf({ pages: [[], []] }), 'application/pdf', LIMITS),
    );
    expect(err.code).toBe('OCR_REQUIRED');
    expect(err.reason).toBe('no_text_layer');
  });

  it('returns OCR_REQUIRED when the total text is below the threshold', async () => {
    const tiny = 'x'.repeat(MIN_PDF_TEXT_CHARS - 1);
    const err = await failureOf(
      extractText(buildPdf({ pages: [[tiny]] }), 'application/pdf', LIMITS),
    );
    expect(err.code).toBe('OCR_REQUIRED');
    const enough = 'x'.repeat(MIN_PDF_TEXT_CHARS);
    const ok = await extractText(buildPdf({ pages: [[enough]] }), 'application/pdf', LIMITS);
    expect(ok.pages).toHaveLength(1);
  });

  it('returns FILE_UNSUPPORTED for an encrypted PDF', async () => {
    const pdf = buildPdf({ pages: [['Secret words that must not be read.']], encrypt: true });
    const err = await failureOf(extractText(pdf, 'application/pdf', LIMITS));
    expect(err.code).toBe('FILE_UNSUPPORTED');
    expect(err.reason).toBe('encrypted');
  });

  it('returns FILE_UNSUPPORTED for a corrupt PDF', async () => {
    const pdf = utf8('%PDF-1.4\nthis is not a real pdf body, just garbage \u0001\u0002\n%%EOF');
    const err = await failureOf(extractText(pdf, 'application/pdf', LIMITS));
    expect(err.code).toBe('FILE_UNSUPPORTED');
    expect(err.reason).toBe('corrupt');
  });

  it('returns FILE_UNSUPPORTED for a truncated PDF', async () => {
    const pdf = buildPdf({ pages: [['A page of reasonable length for truncation.']] });
    const err = await failureOf(
      extractText(pdf.slice(0, Math.floor(pdf.length / 2)), 'application/pdf', LIMITS),
    );
    expect(err.code).toBe('FILE_UNSUPPORTED');
  });

  it('returns FILE_UNSUPPORTED when the PDF has more pages than the limit', async () => {
    const pages = Array.from({ length: 5 }, (_, i) => [`Page number ${i + 1} has some text.`]);
    const err = await failureOf(
      extractText(buildPdf({ pages }), 'application/pdf', { ...LIMITS, maxPages: 4 }),
    );
    expect(err.code).toBe('FILE_UNSUPPORTED');
    expect(err.reason).toBe('too_many_pages');
    // At the limit it still works.
    const ok = await extractText(buildPdf({ pages }), 'application/pdf', {
      ...LIMITS,
      maxPages: 5,
    });
    expect(ok.pages).toHaveLength(5);
  });

  it('kills the child at the timeout with a distinct internal reason', async () => {
    const pdf = buildPdf({ pages: [['Some text on a page that will not be parsed in time.']] });
    const started = Date.now();
    const err = await failureOf(extractText(pdf, 'application/pdf', { ...LIMITS, timeoutMs: 1 }));
    expect(err.code).toBe('FILE_UNSUPPORTED');
    expect(err.reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('kills the child on a memory limit with a distinct internal reason', async () => {
    const pdf = buildPdf({ pages: [['Some text on a page.']] });
    const err = await failureOf(extractText(pdf, 'application/pdf', { ...LIMITS, maxMemoryMb: 1 }));
    expect(err.code).toBe('FILE_UNSUPPORTED');
    expect(err.reason).toBe('memory');
  });

  it('rejects with an AbortError when the signal aborts', async () => {
    const controller = new AbortController();
    const pdf = buildPdf({ pages: [['Some text on a page.']] });
    const pending = extractText(pdf, 'application/pdf', LIMITS, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      extractText(pdf, 'application/pdf', LIMITS, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('never writes document text to the console or to stdout/stderr', async () => {
    const marker = 'ZEBRA-MARKER-4821';
    const captured: string[] = [];
    const record = (...args: unknown[]): void => {
      captured.push(args.map(String).join(' '));
    };
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation(record);
    }
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    });
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    });

    const good = await extractText(
      buildPdf({ pages: [[`${marker} appears in this document.`]] }),
      'application/pdf',
      LIMITS,
    );
    const failures = await Promise.allSettled([
      extractText(
        buildPdf({ pages: [[`${marker} secret`]], encrypt: true }),
        'application/pdf',
        LIMITS,
      ),
      extractText(new Uint8Array([...utf8(marker), 0xff, 0xfe]), 'text/plain', LIMITS),
      extractText(utf8(`${marker} text`), 'application/pdf', LIMITS),
    ]);
    out.mockRestore();
    errOut.mockRestore();

    expect(good.pages[0]?.text).toContain(marker);
    for (const failure of failures) {
      expect(failure.status).toBe('rejected');
      if (failure.status === 'rejected') {
        expect(String((failure.reason as Error).message)).not.toContain(marker);
      }
    }
    expect(captured.join('\n')).not.toContain(marker);
  });
});

describe('extractText: text limit (EXTRACT_MAX_CHARS)', () => {
  it('refuses plain text and markdown over maxChars as FILE_UNSUPPORTED, and allows exactly maxChars', async () => {
    const text = 'word '.repeat(100).trim();
    for (const type of ['text/plain', 'text/markdown'] as const) {
      const err = await failureOf(
        extractText(utf8(text), type, { ...LIMITS, maxChars: text.length - 1 }),
      );
      expect(err.code).toBe('FILE_UNSUPPORTED');
      expect(err.reason).toBe('too_much_text');
      const ok = await extractText(utf8(text), type, { ...LIMITS, maxChars: text.length });
      expect(ok.pages).toHaveLength(1);
    }
  });

  it('refuses a PDF whose total text is over maxChars as FILE_UNSUPPORTED (summed over pages)', async () => {
    const pages = [['a'.repeat(60)], ['b'.repeat(60)]];
    const err = await failureOf(
      extractText(buildPdf({ pages }), 'application/pdf', { ...LIMITS, maxChars: 100 }),
    );
    expect(err.code).toBe('FILE_UNSUPPORTED');
    expect(err.reason).toBe('too_much_text');
    const ok = await extractText(buildPdf({ pages }), 'application/pdf', {
      ...LIMITS,
      maxChars: 200,
    });
    expect(ok.pages).toHaveLength(2);
  });
});

describe('extraction version', () => {
  it('is tied to the installed pdfjs-dist version, read at run time', () => {
    const pkg = createRequire(import.meta.url)('pdfjs-dist/package.json') as { version: string };
    expect(EXTRACTION_VERSION).toBe(`x1-pdfjs-${pkg.version}`);
  });
});

describe('extractText: encrypted PDFs with obfuscated names', () => {
  const lines = ['Hidden handbook sentence that only exists after decryption.'];

  it('control: the fixture is really encrypted and pdf.js opens it with the empty password', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({
      data: buildEmptyPasswordEncryptedPdf({ lines }),
      verbosity: 0,
    });
    const doc = await task.promise;
    const content = await (await doc.getPage(1)).getTextContent();
    const text = content.items.map((i) => ('str' in i ? i.str : '')).join('');
    expect(text).toContain('Hidden handbook sentence');
    await task.destroy();
  });

  it.each([
    ['plain /Encrypt', '/Encrypt'],
    ['one escaped letter', '/Encr#79pt'],
    ['an escaped first letter', '/#45ncrypt'],
    ['every letter escaped', '/#45#6e#63#72#79#70#74'],
    ['an escaped middle and last letter', '/Encr#79p#74'],
  ])('refuses a PDF encrypted with the empty password whose key is %s', async (_name, key) => {
    const pdf = buildEmptyPasswordEncryptedPdf({ lines, encryptKeyName: key });
    const err = await failureOf(extractText(pdf, 'application/pdf', LIMITS));
    expect(err.code).toBe('FILE_UNSUPPORTED');
    expect(err.reason).toBe('encrypted');
  });
});
