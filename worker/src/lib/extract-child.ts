// PDF text extraction child process (TECH_SPECS §7: heavy parsing runs in a bounded subprocess).
// Started by extract.ts with `--max-old-space-size` and killed at the timeout. Protocol:
//   argv[2]  maximum page count (positive integer)
//   stdin    the PDF bytes
//   stdout   one JSON line: {ok:true,pages:[{number,text}]} or {ok:false,reason}
// stderr is discarded by the parent. This file never writes document text anywhere but stdout, and
// it must stay standalone (no relative imports) so Node can run it directly from source too.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

type ChildFailure = 'encrypted' | 'too_many_pages' | 'corrupt';
type ChildResult =
  { ok: true; pages: { number: number; text: string }[] } | { ok: false; reason: ChildFailure };

// pdf.js prints warnings (for example, the optional canvas package) at import time. Silence them
// before the dynamic import below.
const noop = (): void => undefined;
for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
  console[level] = noop;
}

// An /Encrypt entry in a trailer or cross-reference stream. pdf.js accepts files that are encrypted
// with an empty user password, but the ingestion policy refuses every encrypted PDF.
const ENCRYPT_ENTRY = /\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/;

function fail(reason: ChildFailure): ChildResult {
  return { ok: false, reason };
}

async function extract(bytes: Uint8Array, maxPages: number): Promise<ChildResult> {
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  if (ENCRYPT_ENTRY.test(raw)) return fail('encrypted');

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const packageRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const asDir = (name: string): string => pathToFileURL(join(packageRoot, name)).href + '/';

  const task = pdfjs.getDocument({
    data: bytes,
    verbosity: 0,
    useSystemFonts: false,
    disableFontFace: true,
    enableXfa: false,
    standardFontDataUrl: asDir('standard_fonts'),
    cMapUrl: asDir('cmaps'),
    cMapPacked: true,
  });

  try {
    const doc = await task.promise;
    try {
      if (doc.numPages > maxPages) return fail('too_many_pages');
      const pages: { number: number; text: string }[] = [];
      for (let number = 1; number <= doc.numPages; number += 1) {
        const page = await doc.getPage(number);
        const content = await page.getTextContent();
        let text = '';
        for (const item of content.items) {
          if (!('str' in item)) continue;
          text += item.str;
          if (item.hasEOL) text += '\n';
        }
        page.cleanup();
        pages.push({ number, text });
      }
      return { ok: true, pages };
    } finally {
      await task.destroy();
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'PasswordException') return fail('encrypted');
    return fail('corrupt');
  }
}

async function main(): Promise<void> {
  const maxPages = Number(process.argv[2]);
  if (!Number.isInteger(maxPages) || maxPages < 1) process.exit(2);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = Buffer.concat(chunks);
  const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const result = await extract(bytes, maxPages);
  process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
}

main().catch(() => process.exit(3));
