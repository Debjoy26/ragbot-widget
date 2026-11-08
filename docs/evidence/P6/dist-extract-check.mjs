// Main-session check: the compiled extraction child runs from worker/dist (P6-EXTRACT left this untested).
import { buildPdf } from '../../../tests/unit/worker/fixtures/pdf.ts';
const { extractText } = await import('../../../worker/dist/lib/extract.js');
const pdf = buildPdf({
  pages: [
    ['Hello from page one of the dist check, with enough words to pass the text threshold.'],
    ['Second page of the dist check, also with plenty of ordinary words in it.'],
  ],
});
const out = await extractText(pdf, 'application/pdf', {
  timeoutMs: 15000,
  maxMemoryMb: 256,
  maxPages: 300,
});
console.log(
  'dist child ok:',
  out.method,
  out.version,
  'pages',
  out.pages.length,
  'chars',
  out.pages.reduce((n, p) => n + p.text.length, 0),
);
