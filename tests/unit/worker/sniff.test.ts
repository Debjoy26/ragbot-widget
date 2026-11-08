import { describe, expect, it } from 'vitest';
import {
  declaredMatchesSniffed,
  sniffMediaType,
  type SniffedType,
} from '../../../worker/src/lib/sniff.ts';
import { buildPdf, utf8 } from './fixtures/pdf.ts';

describe('sniffMediaType', () => {
  it('recognises a PDF by its header', () => {
    expect(sniffMediaType(buildPdf({ pages: [['hello']] }))).toBe('pdf');
  });

  it('recognises UTF-8 text, with and without a BOM, and Markdown as text', () => {
    expect(sniffMediaType(utf8('# Title\n\nSome *markdown* text.\r\n'))).toBe('text');
    expect(sniffMediaType(utf8('Plain text with accents: caf\u00E9, \u65E5\u672C\u8A9E'))).toBe(
      'text',
    );
    expect(sniffMediaType(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('with bom')]))).toBe('text');
  });

  it('rejects binary content, NUL bytes, invalid UTF-8 and empty input', () => {
    expect(sniffMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'unknown',
    );
    expect(sniffMediaType(new Uint8Array([0x68, 0x69, 0x00, 0x21]))).toBe('unknown');
    expect(sniffMediaType(new Uint8Array([0x68, 0x69, 0xff, 0xfe, 0x21]))).toBe('unknown');
    expect(sniffMediaType(new Uint8Array(0))).toBe('unknown');
  });

  it('rejects UTF-16 text (NUL bytes) and text with many control characters', () => {
    expect(sniffMediaType(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBe('unknown');
    expect(sniffMediaType(utf8('ab\u0001\u0002\u0003\u0004\u0005cd'))).toBe('unknown');
  });

  it('requires the PDF header at byte 0', () => {
    expect(sniffMediaType(utf8('junk\n%PDF-1.4\n'))).toBe('text'); // plain text that mentions PDF
    expect(sniffMediaType(utf8('%PDF-1.4 but then text only'))).toBe('pdf');
  });
});

describe('declaredMatchesSniffed', () => {
  const cases: [string, SniffedType, boolean][] = [
    ['application/pdf', 'pdf', true],
    ['text/markdown', 'text', true],
    ['text/plain', 'text', true],
    ['text/plain', 'pdf', false], // PDF declared as text
    ['text/markdown', 'pdf', false],
    ['application/pdf', 'text', false], // text declared as PDF
    ['application/pdf', 'unknown', false],
    ['text/plain', 'unknown', false],
    ['image/png', 'text', false],
    ['application/octet-stream', 'pdf', false],
  ];
  it.each(cases)('declared %s with sniffed %s -> %s', (declared, sniffed, expected) => {
    expect(declaredMatchesSniffed(declared, sniffed)).toBe(expected);
  });
});
