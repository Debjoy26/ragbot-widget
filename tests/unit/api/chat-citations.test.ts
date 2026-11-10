import { describe, expect, it } from 'vitest';
import {
  SafeTextStream,
  buildAllowList,
  buildSources,
  citedChunkIds,
  delink,
  normaliseUrl,
  stripCitationMarkers,
} from '../../../api/src/services/citations.ts';
import type { RetrievedChunk } from '../../../api/src/services/retrieval.ts';

const ZWSP = '​';
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const allow = buildAllowList({
  email: 'Help@Acme.example',
  phone: '+14155550100',
  whatsapp_url: 'https://wa.me/14155550100',
  page_url: 'https://acme.example/contact',
});

describe('citation markers', () => {
  it('strips well-formed markers and the space before them, keeps other brackets', () => {
    expect(stripCitationMarkers(`Ten dollars [[${ID1}]]. See [1] and [[not a marker]].`)).toBe(
      'Ten dollars. See [1] and [[not a marker]].',
    );
  });

  it('cites only ids that were given to the model, in order of first use, once', () => {
    const text = `a [[${ID2}]] b [[invented]] c [[${ID1}]] d [[${ID2}]]`;
    expect(citedChunkIds(text, new Set([ID1, ID2]))).toEqual([ID2, ID1]);
    expect(citedChunkIds(text, new Set([ID1]))).toEqual([ID1]);
    expect(citedChunkIds(text, new Set())).toEqual([]);
  });
});

describe('SafeTextStream', () => {
  function feed(parts: string[]): { released: string[]; all: string } {
    const stream = new SafeTextStream();
    const released = parts.map((p) => stream.push(p));
    released.push(stream.flush());
    return { released, all: released.join('') };
  }

  it('gives the same text whatever the chunking, markers removed', () => {
    const text = `Plans cost ten dollars [[${ID1}]]. Call +1 415 555 0100 or mail a@b.example now [[${ID2}]]`;
    const whole = feed([text]).all;
    expect(whole).toBe('Plans cost ten dollars. Call +1 415 555 0100 or mail a@b.example now');
    for (let size = 1; size <= 9; size += 1) {
      const parts = text.match(new RegExp(`.{1,${size}}`, 'gs')) ?? [];
      expect(feed(parts).all, `chunk size ${size}`).toBe(whole);
    }
  });

  it('never releases text that ends inside a marker, URL, email or phone number', () => {
    const stream = new SafeTextStream();
    const out: string[] = [];
    for (const part of [
      'see https://acme.ex',
      'ample/contact now and +1 415',
      ' 555 0100 ok [[',
      ID1,
      ']] fin',
    ]) {
      out.push(stream.push(part));
    }
    expect(out.join('')).not.toContain('[[');
    for (const piece of out) {
      expect(piece).not.toMatch(/https:\/\/acme\.ex$/);
      expect(piece).not.toMatch(/\+1 415$/);
      expect(piece).not.toMatch(/\[\[?$/);
    }
    expect(out.join('') + stream.flush()).toBe(
      'see https://acme.example/contact now and +1 415 555 0100 ok fin',
    );
  });

  it('streams text without spaces (CJK) instead of holding it all', () => {
    const stream = new SafeTextStream();
    expect(stream.push('你好，我们的价格是十美元。')).toBe('你好，我们的价格是十美元。');
  });

  it('leaves an unfinished marker as text at the end', () => {
    const stream = new SafeTextStream();
    const first = stream.push('end [[abc');
    expect(first + stream.flush()).toBe('end [[abc');
  });
});

describe('delink (A4, W-16)', () => {
  it('leaves configured contact values alone, case and format insensitively', () => {
    const text =
      'Mail help@acme.example, call +1 (415) 555-0100, chat https://wa.me/14155550100 or visit https://ACME.example/contact/.';
    expect(delink(text, allow)).toBe(text);
  });

  it('breaks other emails, phones and URLs with a zero-width space and keeps the text', () => {
    const text =
      'x scam@evil.example y +1 202 555 0199 z https://evil.example/a?b=1. w www.evil.example';
    const out = delink(text, allow);
    expect(out).not.toBe(text);
    expect(out.replaceAll(ZWSP, '')).toBe(text);
    expect(out).not.toContain('scam@evil.example');
    expect(out).not.toContain('https://evil.example');
    expect(out).not.toContain('www.evil.example');
    expect(out).not.toContain('202 555 0199');
    expect(out).toContain(`https:${ZWSP}//evil.example/a?b=1.`);
    expect(out).toContain(`www${ZWSP}.evil.example`);
    expect(out).toContain(`scam${ZWSP}@evil.example`);
  });

  it('breaks markdown link destinations, autolinks, javascript: and mailto: of others', () => {
    const out = delink(
      '[click](https://evil.example/x) <https://evil.example/y> [a](javascript:alert) mailto:bad@evil.example',
      allow,
    );
    expect(out).not.toMatch(/https:\/\//);
    expect(out).not.toContain('javascript:alert');
    expect(out).not.toContain('mailto:bad');
  });

  it('allows mailto: and tel: of the configured values', () => {
    const text = 'mailto:help@acme.example tel:+14155550100';
    expect(delink(text, allow)).toBe(text);
  });

  it('allows validated source URLs, nothing else on the same host', () => {
    const withSource = buildAllowList({}, ['https://docs.acme.example/guide']);
    expect(delink('https://docs.acme.example/guide', withSource)).toBe(
      'https://docs.acme.example/guide',
    );
    expect(delink('https://docs.acme.example/other', withSource)).toContain(ZWSP);
  });

  it('does not touch dates, years, prices or short numbers', () => {
    const text = 'On 2026-11-10 the price was 1,000 or 12345 in 2024.';
    expect(delink(text, allow)).toBe(text);
  });

  it('never throws, and never changes text without contact-like tokens', () => {
    for (const text of ['', ' ', '\u0000', 'a'.repeat(5000), '@@@', 'http:', '+', '((((']) {
      expect(() => delink(text, allow)).not.toThrow();
    }
    expect(delink('Plain text.', allow)).toBe('Plain text.');
  });

  it('normalises URLs for comparison', () => {
    expect(normaliseUrl('HTTPS://Acme.Example/a/')).toBe('https://acme.example/a');
    expect(normaliseUrl('www.acme.example')).toBe('https://www.acme.example');
    expect(normaliseUrl('http://[bad')).toBeNull();
  });
});

describe('buildSources', () => {
  const chunk = (id: string, over: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
    chunk_id: id,
    document_id: ID2,
    document_version_id: ID2,
    document_title: 'Guide',
    chunk_index: 0,
    content: 'Body text',
    page_number: 2,
    section: 'Intro',
    similarity: 0.8,
    ...over,
  });

  it('accepts only retrieved ids and caps the list at 20', () => {
    const evidence = new Map(
      Array.from({ length: 30 }, (_, i) => {
        const id = `c${String(i)}`;
        return [id, chunk(id)] as const;
      }),
    );
    const cited = [...evidence.keys(), 'not-retrieved'];
    const built = buildSources(cited, evidence);
    expect(built.refs).toHaveLength(20);
    expect(built.rows).toHaveLength(20);
    expect(built.refs.map((r) => r.chunk_id)).not.toContain('not-retrieved');
  });

  it('makes titles and sections plain text within bounds, and the excerpt one bounded line', () => {
    const built = buildSources(
      ['a'],
      new Map([
        [
          'a',
          chunk('a', {
            document_title: `<script>x</script>${'t'.repeat(400)}`,
            section: '<b>Sec</b>\n tion',
            content: `line one\n\n\tline two ${'z'.repeat(900)}`,
          }),
        ],
      ]),
    );
    const ref = built.refs[0];
    expect(ref?.title).not.toMatch(/[<>]/);
    expect((ref?.title ?? '').length).toBeLessThanOrEqual(200);
    expect(ref?.section).not.toMatch(/[<>\n]/);
    expect(ref?.excerpt).toMatch(/^line one line two z+$/);
    expect((ref?.excerpt ?? '').length).toBeLessThanOrEqual(500);
    expect(built.rows[0]?.source_label.length).toBeLessThanOrEqual(300);
    expect(built.rows[0]?.excerpt.length).toBeLessThanOrEqual(500);
  });

  it('does not cut a surrogate pair in half', () => {
    const built = buildSources(
      ['a'],
      new Map([['a', chunk('a', { document_title: '😀'.repeat(150) })]]),
    );
    expect(built.refs[0]?.title).toMatch(/^(?:😀)+$/u);
  });
});
