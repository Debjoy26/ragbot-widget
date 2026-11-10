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

const ZWSP = '\u200B';
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
    expect(stream.push('你好\uFF0C我们的价格是十美元。')).toBe('你好\uFF0C我们的价格是十美元。');
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

// ---------------------------------------------------------------------------------------------
// P7-D1-B additions: linear time (R1-3), de-linking bypasses (R1-1), sources (R1-1), NUL and lone
// surrogates (R1-8), ordinary numbers (R1-10)
// ---------------------------------------------------------------------------------------------

const plain = (text: string): string => text.replaceAll(ZWSP, '');

/** SafeTextStream then delink on every released piece, as the chat route does. */
function streamed(parts: readonly string[], allowList = allow): string {
  const stream = new SafeTextStream();
  let out = '';
  for (const part of parts) out += delink(stream.push(part), allowList);
  return out + delink(stream.flush(), allowList);
}

function chunks(text: string, size: number): string[] {
  return text.match(new RegExp(`[\\s\\S]{1,${String(size)}}`, 'gu')) ?? [];
}

describe('linear time on hostile shapes (R1-3)', () => {
  const BOUND_MS = 500;
  const shapes: ReadonlyArray<readonly [string, string]> = [
    ['a x 200k', 'a'.repeat(200_000)],
    ['"a." x 100k', 'a.'.repeat(100_000)],
    ['"a+" x 100k', 'a+'.repeat(100_000)],
    ['"1 " x 100k', '1 '.repeat(100_000)],
    ['_ x 100k', '_'.repeat(100_000)],
    ['"x@" x 50k', 'x@'.repeat(50_000)],
    ['a x 20k then a space', `${'a'.repeat(20_000)} tail`],
    ['"[" x 100k', '['.repeat(100_000)],
    ['"](" x 50k', '[a](' + ']('.repeat(50_000)],
    ['"[a][" x 30k', '[a][b'.repeat(30_000)],
    ['"&#1" x 40k', '&#1'.repeat(40_000)],
    ['"http://" x 30k', 'http://'.repeat(30_000)],
    ['"//" x 100k', '//'.repeat(100_000)],
    ['"www." x 40k', 'www.'.repeat(40_000)],
    ['"com." x 50k', 'com.'.repeat(50_000)],
    ['"1.2." x 60k', '1.2.'.repeat(60_000)],
    ['"(at)" x 40k', '(at)'.repeat(40_000)],
    ['"a:" x 100k', 'a:'.repeat(100_000)],
  ];

  function timed(run: () => void): number {
    const t0 = performance.now();
    run();
    return performance.now() - t0;
  }

  it.each(shapes)('delink finishes quickly on %s', (_name, text) => {
    expect(timed(() => delink(text, allow))).toBeLessThan(BOUND_MS);
  });

  it.each(shapes)('SafeTextStream (one push) finishes quickly on %s', (_name, text) => {
    const ms = timed(() => {
      const stream = new SafeTextStream();
      stream.push(text);
      stream.flush();
    });
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it.each(shapes)('SafeTextStream + delink in 1000-character pieces on %s', (_name, text) => {
    const ms = timed(() => {
      streamed(chunks(text.slice(0, 60_000), 1000));
    });
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it('a stream fed one character at a time stays cheap per push', () => {
    const text = `${'x'.repeat(5000)} ${'1 '.repeat(3000)}`;
    const ms = timed(() => {
      const stream = new SafeTextStream();
      for (const ch of text) stream.push(ch);
      stream.flush();
    });
    expect(ms).toBeLessThan(2000);
  });
});

describe('de-linking bypasses (R1-1)', () => {
  const broken = (text: string): string => delink(text, allow);

  it('decodes numeric and named HTML entities before matching', () => {
    for (const text of [
      '&#104;ttps://evil.example/x',
      '&#x68;&#x74;tps://evil.example/x',
      'https&colon;&sol;&sol;evil.example/x',
      'https&#58;//evil.example/x',
      'mailto&colon;bad&commat;evil.example',
      'scam&#64;evil.example',
      '&#x77;ww&period;evil.example',
      'javascript&colon;alert(1)',
    ]) {
      const out = broken(text);
      expect(out, text).toContain(ZWSP);
      expect(out, text).not.toMatch(/https?:\/\//);
      expect(out, text).not.toMatch(/(?:mailto|javascript):[^\u200B]/);
      expect(out, text).not.toMatch(/\w@evil/);
      expect(out, text).not.toMatch(/www\.evil/);
    }
  });

  it('treats host.tld/path as a URL whatever the TLD (P7-D1, e2e A4b)', () => {
    for (const text of ['evil-bare.example/page', 'see foo.ninja/x?y=1 now', 'a.b.zzz/p']) {
      const out = broken(text);
      expect(out, text).toContain(ZWSP);
      expect(out, text).not.toContain(text.split(' ').find((w) => w.includes('/')) ?? text);
    }
    // Ordinary slashes are not URLs: no dot-separated alphabetic host before them, or no path.
    for (const text of ['and/or', 'Mon/Tue', '1.5/2', 'e.g. a/b', 'version 2.0/3.0', 'end.']) {
      expect(broken(text), text).toBe(text);
    }
  });

  it('leaves ordinary entities alone', () => {
    const text = 'Terms &amp; conditions, 5 &lt; 6, caf&eacute;, &copy; 2026';
    expect(broken(text)).toBe(text);
  });

  it('reduces markdown links, images and reference links to their text', () => {
    expect(broken('[click here](https://evil.example/x)')).toBe('click here');
    expect(broken('see [this page](https://evil.example/x "title") now')).toBe('see this page now');
    expect(broken('![logo](https://evil.example/i.png)')).toBe('logo');
    expect(broken('[a][ref] and [b][]')).toBe('a and b');
    expect(broken('[x](javascript:alert(1))')).toBe('x');
    expect(broken('[[x](https://one.example)](https://two.example)')).toBe('x');
    expect(broken('[<b>x</b>](<https://evil.example/a b>)')).toBe('<b>x</b>');
    expect(broken('[a](/relative) and [b](#anchor)')).toBe('a and b');
  });

  it('breaks a URL that is the text of a link, and a link whose text is an email', () => {
    const out = broken('[https://evil.example/a](https://evil.example/a) [a@evil.example](x)');
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).toContain(`a${ZWSP}@evil.example`);
  });

  it('keeps a markdown link whose destination is an allowed value', () => {
    for (const text of [
      '[our contact page](https://acme.example/contact)',
      '[mail us](mailto:help@acme.example)',
      '[call](tel:+14155550100)',
    ]) {
      expect(broken(text)).toBe(text);
    }
  });

  it('leaves brackets that are not links, such as [1] and arr[0][1]', () => {
    const text = 'See [1] and [2], arr[0][1], [ ] done, a ] b [ c';
    expect(broken(text)).toBe(text);
  });

  it.each([
    'whatsapp://send?phone=15551234567',
    'tg://resolve?domain=evil',
    'intent://scan/#Intent;scheme=zxing;end',
    'sms:+15551230000',
    'smsto:15551230000',
    'tel:+15551230000',
    'data:text/html,hello',
    'javascript:alert(1)',
    'vbscript:run',
    'mailto:bad@evil.example',
    'git+ssh://evil.example/repo',
    'ftp://evil.example/x',
    'myapp://open',
    'HTTPS://EVIL.EXAMPLE',
    '5https://evil.example',
    'x_https://evil.example',
    'a1b2://evil.example',
  ])('treats %s as a link', (text) => {
    const out = broken(`go ${text} now`);
    expect(out).toContain(ZWSP);
    expect(plain(out)).toBe(`go ${text} now`);
    expect(out).not.toMatch(/[A-Za-z0-9+.-]{2,}:\/\//);
    expect(out).not.toMatch(/(?:tel|sms|smsto|data|javascript|vbscript|mailto):[^\u200B ]/i);
  });

  it('does not treat words with a colon as links', () => {
    const text = 'Note: the data: below, time 10:30, ratio 3:1, and metadata:x are fine';
    expect(broken(text)).toBe(text);
  });

  it('breaks protocol-relative hosts and www hosts, with or without a separator before them', () => {
    for (const text of [
      '//evil.example/x',
      '(//evil.example)',
      '<img src=//evil.example/i.png>',
      'www.evil.example',
      '_www.evil.example',
      'www2.evil.example/path',
      'WWW.EVIL.EXAMPLE',
    ]) {
      const out = broken(text);
      expect(out, text).toContain(ZWSP);
      expect(plain(out), text).toBe(text);
      expect(out, text).not.toMatch(/\/\/evil|www\.evil/i);
    }
  });

  it('leaves slashes that are not hosts', () => {
    const text = 'and/or // note, a//b, https-only, path/to//x, 50//50';
    expect(broken(text)).toBe(text);
  });

  it('breaks bare host.tld with a plausible top-level domain', () => {
    for (const text of [
      'evil.com',
      'evil.com/path?x=1',
      'sub.evil.co.uk',
      'evil.com:8080/x',
      'EVIL.IO',
      'bücher.de',
      'a-b.xyz',
    ]) {
      const out = broken(`visit ${text}.`);
      expect(out, text).toContain(ZWSP);
      expect(plain(out), text).toBe(`visit ${text}.`);
      expect(out, text).not.toContain(text);
    }
  });

  it('does not break filenames, versions, abbreviations or decimals as hosts', () => {
    const text =
      'Open file.txt, README.md, main.py, node.js, v1.2.3, e.g. this, i.e. that, 3.14, Mr. Smith, U.S. only';
    expect(broken(text)).toBe(text);
  });

  it('allows a bare mention of the host of an allowed URL or email, nothing else on it', () => {
    const a = buildAllowList({ email: 'help@acme.com', page_url: 'https://acme.com/contact' });
    expect(delink('see acme.com or acme.com/contact', a)).toBe('see acme.com or acme.com/contact');
    expect(delink('see acme.com/other', a)).toContain(ZWSP);
    expect(delink('see evil.com', a)).toContain(ZWSP);
  });

  it('detects [at], (at), {at} and [dot] obfuscated emails', () => {
    for (const text of [
      'scam [at] evil.example',
      'scam(at)evil(dot)com',
      'scam [at] evil [dot] com',
      'scam{AT}evil.example',
      'scam ( at ) evil ( dot ) example',
    ]) {
      const out = broken(`write ${text} today`);
      expect(out, text).toContain(`${ZWSP}@`);
      expect(plain(out), text).toMatch(/^write scam@evil\.\w+ today$/);
    }
  });

  it('lets the configured email through even when it is spelled with [at]', () => {
    const text = 'write help [at] acme.example today';
    expect(broken(text)).toBe(text);
  });

  it('does not mistake ordinary (at) and [dot] for emails', () => {
    const text = 'meet (at) noon, wait [dot] until then, see [at] the end';
    expect(broken(text)).toBe(text);
  });

  it('reads fullwidth characters (NFKC) for detection', () => {
    const phone = broken(
      'call \uFF0B\uFF11 \uFF12\uFF10\uFF12 \uFF15\uFF15\uFF15 \uFF10\uFF11\uFF19\uFF19 now',
    );
    expect(phone).toContain(ZWSP);
    expect(plain(phone)).toBe('call +1 202 555 0199 now');
    expect(phone).not.toMatch(/\d{3}/);
    const email = broken('mail scam\uFF20evil.example');
    expect(email).toBe(`mail scam${ZWSP}@evil.example`);
    const url = broken('\uFF48\uFF54\uFF54\uFF50\uFF53\uFF1A\uFF0F\uFF0Fevil.example');
    expect(url).toBe(`https:${ZWSP}//evil.example`);
  });

  it('sees through invisible format characters inside a token', () => {
    for (const text of [
      'h\u200Bttps://evil.example',
      'scam@ev\u00ADil.example',
      '\u2060www.evil.example',
    ]) {
      const out = broken(text);
      expect(out.replace(/[\u00AD\u2060]/g, ''), text).toContain(ZWSP);
      expect(out, text).not.toMatch(/https:\/\/evil/);
    }
  });

  it('does not rewrite ordinary text: CJK punctuation, symbols, emoji', () => {
    const text = '价格是十美元\uFF0C请联系我们。x² ½ … \u{1F600} café';
    expect(broken(text)).toBe(text);
  });

  it('is idempotent', () => {
    const corpus = [
      'x scam@evil.example y +1 202 555 0199 z https://evil.example/a?b=1. w www.evil.example',
      '[click](https://evil.example/x) <https://evil.example/y> &#104;ttp://evil.example',
      'scam [at] evil [dot] com and evil.com/path, //evil.example',
      'Mail help@acme.example, call +1 (415) 555-0100, 2026-11-10, 1.234.567',
      '\uFF48\uFF54\uFF54\uFF50\uFF1A//evil.example \u0000 lone \uD83D end',
    ];
    for (const text of corpus) {
      const once = delink(text, allow);
      expect(delink(once, allow), text).toBe(once);
    }
  });

  it('breaks the bypass shapes even when the stream cuts them into pieces', () => {
    const text =
      'Go [click here](https://evil.example/x?a=1) or write scam [at] evil [dot] com or ' +
      'visit &#104;ttps://evil.example/y, or call +1 202 555 0199 now. Then evil.com ok. ' +
      'Real: help@acme.example +1 (415) 555-0100 https://acme.example/contact done.';
    for (let size = 1; size <= 17; size += 1) {
      const out = streamed(chunks(text, size));
      expect(out, `size ${String(size)}`).not.toMatch(/https?:\/\/evil/);
      expect(out, `size ${String(size)}`).not.toMatch(/@evil/);
      expect(out, `size ${String(size)}`).not.toMatch(/\+1 202 555/);
      expect(out, `size ${String(size)}`).not.toContain('evil.com');
      expect(out, `size ${String(size)}`).toContain('help@acme.example');
      expect(out, `size ${String(size)}`).toContain('+1 (415) 555-0100');
      expect(out, `size ${String(size)}`).toContain('https://acme.example/contact');
    }
  });

  it('holds a markdown link back until it is closed, so it is reduced to its text', () => {
    expect(streamed(['go [click ', 'here](https://evil.', 'example/x) ok'])).toBe(
      'go click here ok',
    );
    const stream = new SafeTextStream();
    expect(stream.push('go [click here](https://evil.')).toBe('go ');
  });

  it('releases a very long token in pieces with a zero-width space between them', () => {
    const stream = new SafeTextStream();
    const first = stream.push('a'.repeat(10_000));
    expect(first.endsWith(ZWSP)).toBe(true);
    expect(first.length).toBeLessThan(10_000 + 2);
    const all = first + stream.flush();
    expect(plain(all)).toBe('a'.repeat(10_000));
  });
});

describe('ordinary numbers and phone shapes (R1-10)', () => {
  it.each([
    '1.234.567',
    '12.345.678',
    '2026-11-10',
    '2026.11.10',
    '10.11.2026',
    '31-12-2026',
    '2026 11 10',
    '3.14159265',
    '192.168.100.200',
    '10.0.19045.3693',
    '12.99-14.99',
    '2020-2024',
    '1 234 567',
    '12 345 678 901',
    '1,234,567',
    '12345678',
    '1000000',
    '3 4 5 6 7 8 9',
    'abc1234567890def',
    'v2.0.1.4567',
  ])('does not break the ordinary number %s', (text) => {
    const sentence = `It is ${text} in total.`;
    expect(delink(sentence, allow)).toBe(sentence);
  });

  it.each([
    '+1 202 555 0199',
    '+44 20 7946 0958',
    '+33 1 23 45 67 89',
    '202-555-0199',
    '(202) 555-0199',
    '202.555.0199',
    '202 555 0199',
    '1 202 555 0199',
    '1-800-555-0199',
    '2025550199',
    '01 23 45 67 89',
    '0171-1234567',
    '0 800 123 456',
    '_2025550199',
    '+12025550199',
  ])('breaks the phone number %s', (text) => {
    const out = delink(`Call ${text} now`, allow);
    expect(out).toContain(ZWSP);
    expect(plain(out)).toBe(`Call ${text} now`);
  });

  it('breaks a phone number next to a sentence end without swallowing what follows', () => {
    const out = delink('Call 202 555 0199. 12 items left', allow);
    expect(out.endsWith('. 12 items left')).toBe(true);
    expect(out).toContain(ZWSP);
    expect(delink('Call 202 555 0199 - 12 items', allow).endsWith(' - 12 items')).toBe(true);
  });

  it('recognises the configured phone inside a longer run of numbers', () => {
    expect(delink('Call +1 415 555 0100 2 times', allow)).toBe('Call +1 415 555 0100 2 times');
  });

  it('builds the zero-width space from an escape, not an invisible literal', () => {
    expect(ZWSP).toBe(String.fromCharCode(0x200b));
  });
});

describe('NUL and lone surrogates (R1-8)', () => {
  it('delink removes NUL and unpaired surrogates and keeps valid pairs', () => {
    expect(delink('a\u0000b', allow)).toBe('ab');
    expect(delink('x\uD83D y', allow)).toBe('x y');
    expect(delink('x\uDE00 y', allow)).toBe('x y');
    expect(delink('ok \u{1F600} fine', allow)).toBe('ok \u{1F600} fine');
    expect(delink('\uD83D😀', allow)).toBe('\u{1F600}');
  });

  it('removing NUL does not hide a link', () => {
    expect(delink('https:\u0000//evil.example', allow)).toBe(`https:${ZWSP}//evil.example`);
  });

  it('SafeTextStream drops NUL and lone surrogates, and joins a pair split between chunks', () => {
    expect(streamed(['a\u0000b ', 'c\uD83D', ' d'])).toBe('ab c d');
    expect(streamed(['pair \uD83D', '\uDE00 end'])).toBe('pair \u{1F600} end');
    expect(streamed(['end \uD83D'])).toBe('end ');
    expect(streamed(['\uDE00 start'])).toBe(' start');
    const text = streamed(['x\u0000y\uD83Dz\uDE00 w']);
    expect(text).toBe('xyz w');
    expect(text.includes('\u0000')).toBe(false);
    expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text); // no lone surrogate
  });
});

describe('sources are de-linked like the answer (R1-1)', () => {
  const chunk = (over: Partial<RetrievedChunk>): RetrievedChunk => ({
    chunk_id: 'a',
    document_id: ID2,
    document_version_id: ID2,
    document_title: 'Guide',
    chunk_index: 0,
    content: 'Body text',
    page_number: 1,
    section: 'Intro',
    similarity: 0.8,
    ...over,
  });
  const one = (c: RetrievedChunk, a?: ReturnType<typeof buildAllowList>) =>
    a === undefined
      ? buildSources(['a'], new Map([['a', c]]))
      : buildSources(['a'], new Map([['a', c]]), a);

  it('breaks emails, phones, URLs and markdown links in titles, sections and excerpts', () => {
    const built = one(
      chunk({
        document_title: 'Visit https://evil.example now',
        section: 'Write scam@evil.example',
        content: 'Call +1 202 555 0199 or see [here](https://evil.example/x) and www.evil.example',
      }),
    );
    const ref = built.refs[0];
    const row = built.rows[0];
    for (const text of [
      ref?.title,
      ref?.section,
      ref?.excerpt,
      row?.source_label,
      row?.excerpt,
      row?.section,
    ]) {
      expect(text ?? '').not.toMatch(/https?:\/\/|scam@|www\.evil|202 555/);
    }
    expect(ref?.title).toBe(`Visit https:${ZWSP}//evil.example now`);
    expect(ref?.section).toBe(`Write scam${ZWSP}@evil.example`);
    expect(ref?.excerpt).toContain('see here and');
    expect(row?.section).toBe(`Write scam${ZWSP}@evil.example`);
  });

  it('keeps allowed values when the caller passes the allow list, and fails closed otherwise', () => {
    const c = chunk({ content: 'Mail help@acme.example or call +1 415 555 0100' });
    expect(one(c, allow).refs[0]?.excerpt).toBe('Mail help@acme.example or call +1 415 555 0100');
    expect(one(c).refs[0]?.excerpt).toContain(ZWSP);
  });

  it('still bounds the lengths after the zero-width spaces are added', () => {
    const urls = 'https://evil.example/a '.repeat(200);
    const built = one(chunk({ document_title: urls, section: urls, content: urls }));
    expect((built.refs[0]?.title ?? '').length).toBeLessThanOrEqual(200);
    expect((built.refs[0]?.section ?? '').length).toBeLessThanOrEqual(200);
    expect((built.refs[0]?.excerpt ?? '').length).toBeLessThanOrEqual(500);
    expect((built.rows[0]?.source_label ?? '').length).toBeLessThanOrEqual(300);
    expect((built.rows[0]?.excerpt ?? '').length).toBeLessThanOrEqual(500);
    expect((built.rows[0]?.section ?? '').length).toBeLessThanOrEqual(300);
  });

  it('removes NUL and lone surrogates from titles and excerpts', () => {
    const built = one(chunk({ document_title: 'T\u0000it\uD83Dle', content: 'a\uDE00b' }));
    expect(built.refs[0]?.title).toBe('Title');
    expect(built.refs[0]?.excerpt).toBe('ab');
  });
});
