import { describe, expect, it } from 'vitest';
import { SafeTextStream, buildAllowList, delink } from '../../../api/src/services/citations.ts';

// P7-D2: F3 (urlEnd was quadratic), F4 (orphan link tails), F5 (mailto with a query), F9 (partial
// marker at the output cap, capitalised sentence starts read as hosts). Separate from
// chat-citations.test.ts so the earlier expectations there stay exactly as they were.

const ZWSP = '​';
const ID1 = '11111111-1111-4111-8111-111111111111';
const allow = buildAllowList({
  email: 'Help@Acme.example',
  phone: '+14155550100',
  whatsapp_url: 'https://wa.me/14155550100',
  page_url: 'https://acme.example/contact',
});

function chunks(text: string, size: number): string[] {
  return text.match(new RegExp(`[\\s\\S]{1,${String(size)}}`, 'gu')) ?? [];
}

/** SafeTextStream then delink on every released piece, as the chat route does. */
function streamed(parts: readonly string[]): string {
  const stream = new SafeTextStream();
  let out = '';
  for (const part of parts) out += delink(stream.push(part), allow);
  return out + delink(stream.flush(), allow);
}

describe('P7-D2 F3: trailing parentheses and the other worst shapes stay linear', () => {
  const BOUND_MS = 500;
  const shapes: ReadonlyArray<readonly [string, string]> = [
    ['"http://x" + ")" x 200k', `http://x${')'.repeat(200_000)}`],
    ['"a.com/" + ")" x 200k', `a.com/${')'.repeat(200_000)}`],
    ['"(" x 200k', '('.repeat(200_000)],
    ['"[" + "](" x 100k', `[${']('.repeat(100_000)}`],
    ['"a." + ")" x 100k', `a.${')'.repeat(100_000)}`],
    ['"www.a.b" + ")" x 200k', `www.a.b${')'.repeat(200_000)}`],
    ['"//a.b" + ")" x 200k', `//a.b${')'.repeat(200_000)}`],
    ['"http://x" + ").," x 70k', `http://x${').,'.repeat(70_000)}`],
    ['"(http://x" + ")" x 200k', `(http://x${')'.repeat(200_000)}`],
    ['"](x" x 60k (orphan tails)', ']((x'.repeat(60_000)],
    ['"](" + "[a](" x 40k', `](${'[a]('.repeat(40_000)}`],
  ];

  function timed(run: () => void): number {
    const t0 = performance.now();
    run();
    return performance.now() - t0;
  }

  it.each(shapes)('delink finishes quickly on %s', (_name, text) => {
    expect(timed(() => delink(text, allow))).toBeLessThan(BOUND_MS);
  });

  it.each(shapes)('SafeTextStream (one push) and delink finish quickly on %s', (_name, text) => {
    const ms = timed(() => {
      const stream = new SafeTextStream();
      delink(stream.push(text), allow);
      delink(stream.flush(), allow);
    });
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it('a URL still keeps a balancing parenthesis and loses the unbalanced ones', () => {
    expect(delink('see http://x/a_(b) now', allow)).toBe(`see http:${ZWSP}//x/a_(b) now`);
    expect(delink('(see http://x/a)', allow)).toBe(`(see http:${ZWSP}//x/a)`);
    expect(delink('http://x/a))) ok', allow)).toBe(`http:${ZWSP}//x/a))) ok`);
    expect(delink('http://x/a_(b)).', allow)).toBe(`http:${ZWSP}//x/a_(b)).`);
  });
});

describe('P7-D2 F4: an orphan markdown link tail never survives', () => {
  // 600 characters with spaces: a word chain without spaces would be held back whole as one token.
  const label = 'ab '.repeat(200);

  it('delink removes ](dest) that has no opener in the text it is given', () => {
    expect(delink('tail](/admin/reset) more', allow)).toBe('tail /admin/reset more');
    expect(delink('x](https://evil.example/p) y', allow)).toBe(`x https:${ZWSP}//evil.example/p y`);
    // An allowed destination loses the link syntax too: it is plain text from here on.
    expect(delink('x](https://acme.example/contact) y', allow)).toBe(
      'x https://acme.example/contact y',
    );
    expect(delink('x](javascript:alert(1)) y', allow)).not.toContain('](');
  });

  it('a link inside the removed destination is neutralised as well', () => {
    const out = delink('t](x [a](/b/c)) end', allow);
    expect(out).not.toContain('](');
    expect(out).not.toMatch(/\]\s*\(/);
  });

  it('an unclosed orphan tail is left alone (it cannot be a link)', () => {
    expect(delink('t](/x never closed', allow)).toBe('t](/x never closed');
  });

  it('a label longer than the 512 character hold window, streamed in pieces, leaves no link', () => {
    const text = `intro [${label}](/admin/reset) and [${label}](https://evil.example/p) done`;
    for (const size of [37, 100, 400, 600, 1200]) {
      const out = streamed(chunks(text, size));
      expect(out, `chunk size ${String(size)}`).not.toMatch(/\]\s*\(/);
    }
  });

  it('rolling batches: a tail that starts the next batch is stripped on its own', () => {
    const first = delink(`before [${label}`, allow);
    const second = delink('](/admin/reset) after', allow);
    expect(`${first}${second}`).not.toContain('](');
    expect(second).toBe('/admin/reset after');
  });

  it('an ordinary full link is still reduced to its text', () => {
    expect(delink('see [the guide](/docs/start) now', allow)).toBe('see the guide now');
    expect(delink('see [pricing](https://acme.example/contact) now', allow)).toBe(
      'see [pricing](https://acme.example/contact) now',
    );
  });
});

describe('P7-D2 F5: an allowed mailto: with a query is not allowed', () => {
  const evil = 'mailto:help@acme.example?cc=evil@x.example&subject=hi';

  it('plain text: the scheme and the inner emails are broken', () => {
    const out = delink(`write ${evil} now`, allow);
    expect(out).toBe(
      `write mailto:${ZWSP}help${ZWSP}@acme.example?cc=evil${ZWSP}@x.example&subject=hi now`,
    );
  });

  it('a markdown link to it is reduced to its text', () => {
    expect(delink(`[mail us](${evil})`, allow)).toBe('mail us');
  });

  it('keeps the plain allowed mailto: and the configured email', () => {
    expect(delink('write mailto:help@acme.example now', allow)).toBe(
      'write mailto:help@acme.example now',
    );
    expect(delink('[mail us](mailto:help@acme.example)', allow)).toBe(
      '[mail us](mailto:help@acme.example)',
    );
    expect(delink('write help@acme.example now', allow)).toBe('write help@acme.example now');
  });

  it('any query, or an encoded one, is refused', () => {
    expect(delink('mailto:help@acme.example?subject=Hi', allow)).toContain(ZWSP);
    expect(delink('mailto:HELP@acme.example?subject=Hi', allow)).toContain(ZWSP);
    expect(delink('mailto:help@acme.example?bcc=evil@x.example', allow)).toContain(ZWSP);
    // A question mark at the end of a sentence is not a query.
    expect(delink('write to mailto:help@acme.example? thanks', allow)).toBe(
      'write to mailto:help@acme.example? thanks',
    );
    expect(delink('mailto:help@acme.example%3Fcc=evil@x.example', allow)).toContain(ZWSP);
  });
});

describe('P7-D2 F9: the output cap and capitalised sentence starts', () => {
  it('flush(true) never releases the start of a [[marker]]', () => {
    for (const cut of ['[[', '[[1111', '[[1111-2222-3333', `[[${ID1}`, `[[${ID1}]`]) {
      const stream = new SafeTextStream();
      const out = stream.push(`Plans cost ten dollars ${cut}`) + stream.flush(true);
      expect(out, cut).toBe('Plans cost ten dollars');
    }
  });

  it('flush(true) keeps ordinary text, and drops a lone [ at the very end', () => {
    const stream = new SafeTextStream();
    expect(stream.push('See the list') + stream.flush(true)).toBe('See the list');
    const other = new SafeTextStream();
    expect(other.push('an array[') + other.flush(true)).toBe('an array');
  });

  it('a marker split over several pushes and cut at the cap is not shown', () => {
    const stream = new SafeTextStream();
    const out = ['Ten dollars [[', '1111-', '2222'].map((p) => stream.push(p)).join('');
    expect(out + stream.flush(true)).toBe('Ten dollars');
  });

  it('flush() without the truncation flag behaves as before', () => {
    const stream = new SafeTextStream();
    expect(stream.push('Ten dollars [[1111') + stream.flush()).toBe('Ten dollars [[1111');
  });

  it('a capitalised TLD after a full stop is a new sentence, not a host', () => {
    for (const text of [
      'That is the end.In the morning we left.',
      'Done.It was fine.',
      'Sure.Is it open?',
      'Go.My team will help.',
      'Wait.No more.',
    ]) {
      expect(delink(text, allow), text).toBe(text);
    }
  });

  it('a lowercase TLD, or a host with a scheme or a path, is still caught', () => {
    expect(delink('see evil.com now', allow)).toBe(`see evil${ZWSP}.com now`);
    expect(delink('see evil.in now', allow)).toBe(`see evil${ZWSP}.in now`);
    expect(delink('see Evil.com now', allow)).toBe(`see Evil${ZWSP}.com now`);
    expect(delink('see EVIL.COM now', allow)).toBe(`see EVIL${ZWSP}.COM now`);
    expect(delink('see evil.In/path now', allow)).toContain(ZWSP);
    expect(delink('see https://evil.In now', allow)).toContain(ZWSP);
    expect(delink('mail x@evil.In now', allow)).toContain(ZWSP);
  });
});

describe('the markdown scan fails closed when its work budget runs out (P7-R4 #4)', () => {
  it('a link after thousands of unterminated `](` pairs is not left as a link', () => {
    const text = '[a]('.repeat(3000) + ' [click](http://evil.example/x)';
    const out = delink(text, allow);
    expect(out).not.toMatch(/\]\(http/);
    expect(out).not.toContain('http://evil.example/x');
  });
});
