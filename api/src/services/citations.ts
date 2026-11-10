// Citations and contact de-linking for model text (PRD W-07, W-16; TECH_SPECS section 6, 6.1).
//
// What the visitor sees is made in three steps, all in this module:
//  1. `[[chunk_id]]` markers are STRIPPED from the visible text (the id is never shown). Which
//     ids were cited is read from the raw text with the shared `extractCitedChunkIds`, restricted
//     to the chunks that were actually put in the prompt, so an invented id is dropped.
//  2. `SafeTextStream` releases text only up to a point where no marker, URL, email, phone number
//     or markdown link can still be incomplete, so step 3 rarely has to look across a delta
//     boundary. It also removes U+0000 and lone surrogates, which Postgres and UTF-8 cannot hold.
//  3. `delink` neutralises every email, phone number and URL that is neither one of the configured
//     contact values nor a validated source URL. APPROACH: a zero-width space (U+200B) is inserted
//     inside the token (after the scheme colon, after `www`, before the `@` or the dots of a bare
//     host, after every second digit of a phone number). The text stays readable and copyable, but
//     neither a markdown autolinker nor a phone/email detector sees a link any more. Markdown link
//     and image syntax (`[text](dest)`, `![alt](src)`, `[text][ref]`) is reduced to its text, unless
//     the destination is itself an allowed value. Allowed values are left as they are. Contact
//     values come from server configuration only (handover section 4, W-16).
//
// Detection runs on a normalised COPY of the text (HTML entities decoded, NFKC, invisible format
// characters dropped, `[at]`/`(dot)` spelled out), and only the flagged tokens are replaced in the
// output, so ordinary text (CJK punctuation, `&amp;`, `x²`) is never rewritten.
//
// DEFENCE IN DEPTH. This is a best-effort filter, not a guarantee. An attacker who controls
// document text can try obfuscations this module does not know. The widget MUST also render model
// text with `textContent` and must only ever build an `href` from an http(s) URL on an allowlist
// (a P8 obligation, TECH_SPECS section 8); it must never trust that `delink` removed every link.
//
// Known limits: digits of non-Latin scripts that NFKC leaves alone (Arabic-Indic and the like) are
// not read as phone digits; spelled-out obfuscation ("name at host dot com") is not detected;
// bare hosts are recognised only for a curated list of top-level domains.
//
// Every scan below is linear in the input (bounded quantifiers or hand scans, no nested
// unbounded repetition); the unit tests time the worst-case shapes. Nothing here logs or throws on
// model text.

import {
  extractCitedChunkIds,
  normaliseExcerpt,
  type HandoffContact,
  type SourceRef,
} from '@ragbot/shared';
import type { RetrievedChunk } from './retrieval.js';

const ZWSP = '\u200B';
const MAX_SOURCES = 20;
/** `message_sources.excerpt` allows 500 characters, `source_label` and `section` 300 (migration 013). */
const MAX_EXCERPT_CHARS = 500;
const MAX_LABEL_CHARS = 300;
/** `SourceRef.title` and `.section` allow 200 characters of plain text. */
const MAX_REF_TITLE_CHARS = 200;

// ---------------------------------------------------------------------------
// Text hygiene: NUL and lone surrogates
// ---------------------------------------------------------------------------

function hasNulOrSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 0 || (c >= 0xd800 && c <= 0xdfff)) return true;
  }
  return false;
}

/**
 * Removes U+0000 and UTF-16 surrogates that are not half of a valid pair. Postgres `text` cannot
 * hold NUL and a lone surrogate is not valid UTF-8, so either would fail the insert of the answer.
 */
export function sanitiseModelText(text: string): string {
  if (!hasNulOrSurrogate(text)) return text;
  let out = '';
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 0) {
      out += text.slice(from, i);
      from = i + 1;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
      } else {
        out += text.slice(from, i);
        from = i + 1;
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out += text.slice(from, i);
      from = i + 1;
    }
  }
  return out + text.slice(from);
}

// ---------------------------------------------------------------------------
// Citation markers
// ---------------------------------------------------------------------------

/** A marker with at most one whitespace character before it, so removal leaves no gap before punctuation. */
const MARKER = /\s?\[\[[A-Za-z0-9_-]{1,64}\]\]/g;

/** Removes every well-formed `[[id]]` marker (valid or invalid). */
export function stripCitationMarkers(text: string): string {
  return text.replace(MARKER, '');
}

/** Cited ids in order of first appearance, restricted to the ids that were given to the model. */
export function citedChunkIds(rawText: string, evidenceIds: ReadonlySet<string>): string[] {
  return extractCitedChunkIds(rawText, evidenceIds).slice(0, MAX_SOURCES);
}

// ---------------------------------------------------------------------------
// Boundary-safe release
// ---------------------------------------------------------------------------

/**
 * The most that is held back at the end of the pending text. A longer token is not a URL, email
 * or phone number; it is released in pieces with a zero-width space between them, so the pieces
 * can never be joined into a link by the receiver.
 */
const MAX_HOLD = 2048;
/** How far back an unfinished markdown link is looked for. */
const LINK_HOLD_WINDOW = 512;
const NUMERIC_TAIL = /^[+(]?[\d().\s-]*$/;

const WHITESPACE = /\s/;

/** Characters that can be part of a marker, URL, email or phone number being written. */
function isTailChar(c: number): boolean {
  if (c >= 0x30 && c <= 0x39) return true; // digits
  if ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a) return true; // letters
  switch (c) {
    case 0x2e: // .
    case 0x5f: // _
    case 0x7e: // ~
    case 0x3a: // :
    case 0x2f: // /
    case 0x3f: // ?
    case 0x23: // #
    case 0x40: // @
    case 0x21: // !
    case 0x24: // $
    case 0x26: // &
    case 0x27: // '
    case 0x2a: // *
    case 0x2b: // +
    case 0x2c: // ,
    case 0x3b: // ;
    case 0x3d: // =
    case 0x25: // %
    case 0x5b: // [
    case 0x5d: // ]
    case 0x28: // (
    case 0x29: // )
    case 0x2d: // -
      return true;
    default:
      return false;
  }
}

function isNumberChar(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) ||
    c === 0x2e ||
    c === 0x28 ||
    c === 0x29 ||
    c === 0x2d ||
    c === 0x2b ||
    WHITESPACE.test(String.fromCharCode(c))
  );
}

/**
 * Lowers `cut` so that no markdown link in the last `LINK_HOLD_WINDOW` characters is split: a link
 * that is still open (`[text`, `[text]`, `[text](dest`, `[text][ref`) is held back whole, and so is
 * a closed link that the cut would divide. Once the link is closed and clear of the cut it is
 * released in one piece, so `delink` sees all of it.
 */
function holdLinks(pending: string, cut: number): number {
  const n = pending.length;
  const from = Math.max(0, n - LINK_HOLD_WINDOW);
  const open: number[] = [];
  let hold = cut;
  let destStart = -1;
  let refStart = -1;
  let depth = 0;
  const startOf = (bracket: number): number =>
    bracket > 0 && pending.charCodeAt(bracket - 1) === 0x21 ? bracket - 1 : bracket;
  const closed = (start: number, end: number): void => {
    if (start < cut && cut < end) hold = Math.min(hold, startOf(start));
  };
  for (let i = from; i < n; i += 1) {
    const c = pending.charCodeAt(i);
    if (destStart >= 0) {
      if (c === 0x28) depth += 1;
      else if (c === 0x29) {
        depth -= 1;
        if (depth === 0) {
          closed(destStart, i + 1);
          destStart = -1;
        }
      }
      continue;
    }
    if (refStart >= 0) {
      if (c === 0x5d) {
        closed(refStart, i + 1);
        refStart = -1;
      } else if (c === 0x5b || c === 0x0a) {
        refStart = -1;
      }
      continue;
    }
    if (c === 0x5c) {
      i += 1;
    } else if (c === 0x5b) {
      open.push(i);
    } else if (c === 0x5d) {
      const start = open.pop();
      if (start === undefined) continue;
      if (i + 1 >= n) {
        hold = Math.min(hold, startOf(start)); // `[text]` at the very end: a `(` or `[` may follow
      } else if (pending.charCodeAt(i + 1) === 0x28) {
        destStart = start;
        depth = 0;
      } else if (pending.charCodeAt(i + 1) === 0x5b) {
        refStart = start;
        i += 1;
      }
    }
  }
  if (destStart >= 0) hold = Math.min(hold, startOf(destStart));
  if (refStart >= 0) hold = Math.min(hold, startOf(refStart));
  if (open.length > 0) hold = Math.min(hold, startOf(open[0] ?? n));
  return hold;
}

/**
 * Index up to which `pending` can be released: the trailing token (and the whitespace before it)
 * stays back, and so does a run of number-like words (a phone number is written with spaces) and
 * any markdown link that is unfinished or would be cut in two. Returns `forced` when the hold
 * limit cut a long token.
 *
 * Not covered: an `name [at] host [dot] tld` obfuscation split across deltas. The word before
 * `[at]` has usually been released by then, so only the domain part is caught.
 */
function safeCut(pending: string): { cut: number; forced: boolean } {
  const n = pending.length;
  let i = n;
  while (i > 0 && n - i < MAX_HOLD && isTailChar(pending.charCodeAt(i - 1))) i -= 1;
  const capped = i > 0 && n - i >= MAX_HOLD && isTailChar(pending.charCodeAt(i - 1));
  let cut = i;
  if (cut > 0 && WHITESPACE.test(pending.charAt(cut - 1)) && n - cut < MAX_HOLD) cut -= 1;

  if (NUMERIC_TAIL.test(pending.slice(cut))) {
    let j = cut;
    while (j > 0 && cut - j < MAX_HOLD && isNumberChar(pending.charCodeAt(j - 1))) j -= 1;
    cut = j;
  }

  cut = holdLinks(pending, cut);

  let forced = capped && cut >= i;
  if (n - cut > MAX_HOLD) {
    cut = n - MAX_HOLD;
    const high = pending.charCodeAt(cut - 1);
    if (high >= 0xd800 && high <= 0xdbff) cut -= 1;
    forced = true;
  }
  return { cut: Math.max(0, cut), forced };
}

/** Strips citation markers from streamed text and releases it only at token-safe boundaries. */
export class SafeTextStream {
  #pending = '';

  /** Adds raw model text and returns the text that is now safe to release (possibly empty). */
  push(text: string): string {
    let joined = this.#pending + text;
    // A high surrogate at the very end may be completed by the next chunk: keep it back.
    let carry = '';
    const last = joined.charCodeAt(joined.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      carry = joined.slice(-1);
      joined = joined.slice(0, -1);
    }
    this.#pending = stripCitationMarkers(sanitiseModelText(joined));
    const { cut, forced } = safeCut(this.#pending);
    const out = this.#pending.slice(0, cut);
    this.#pending = this.#pending.slice(cut) + carry;
    return forced && out !== '' ? out + ZWSP : out;
  }

  /** The rest of the text, at the end of the answer. */
  flush(): string {
    const out = stripCitationMarkers(sanitiseModelText(this.#pending));
    this.#pending = '';
    return out;
  }
}

// ---------------------------------------------------------------------------
// Allow list
// ---------------------------------------------------------------------------

export interface AllowList {
  readonly emails: ReadonlySet<string>;
  readonly phoneDigits: ReadonlySet<string>;
  readonly urls: ReadonlySet<string>;
}

const EMPTY_ALLOW: AllowList = { emails: new Set(), phoneDigits: new Set(), urls: new Set() };

const TRAILING_PUNCTUATION = /[.,;:!?)\]}*_]+$/;

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

/** `scheme://host/path?query` with a lower-case host and no trailing slash; null when unparseable. */
export function normaliseUrl(raw: string): string | null {
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}${url.search}`.toLowerCase();
}

/** Builds the allow list from the configured contact card and the validated source URLs. */
export function buildAllowList(
  contact: HandoffContact,
  sourceUrls: readonly string[] = [],
): AllowList {
  const emails = new Set<string>();
  const phoneDigits = new Set<string>();
  const urls = new Set<string>();
  if (contact.email !== undefined) emails.add(contact.email.toLowerCase());
  if (contact.phone !== undefined) phoneDigits.add(digitsOf(contact.phone));
  for (const raw of [contact.whatsapp_url, contact.page_url, ...sourceUrls]) {
    if (raw === undefined) continue;
    const normal = normaliseUrl(raw);
    if (normal !== null) urls.add(normal);
  }
  return { emails, phoneDigits, urls };
}

const hostCache = new WeakMap<AllowList, ReadonlySet<string>>();

/** Hosts of the allowed URLs and the domains of the allowed emails (a bare mention of them is fine). */
function allowedHosts(allow: AllowList): ReadonlySet<string> {
  let hosts = hostCache.get(allow);
  if (hosts === undefined) {
    const set = new Set<string>();
    for (const url of allow.urls) {
      const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/.exec(url)?.[1];
      if (host !== undefined && host !== '') set.add(host);
    }
    for (const email of allow.emails) {
      const at = email.lastIndexOf('@');
      if (at >= 0) set.add(email.slice(at + 1));
    }
    hosts = set;
    hostCache.set(allow, hosts);
  }
  return hosts;
}

function urlAllowed(url: string, allow: AllowList): boolean {
  if (/^mailto:/i.test(url))
    return allow.emails.has(url.slice(7).split('?')[0]?.toLowerCase() ?? '');
  if (/^tel:/i.test(url)) return allow.phoneDigits.has(digitsOf(url.slice(4)));
  const normal = normaliseUrl(url);
  return normal !== null && allow.urls.has(normal);
}

// ---------------------------------------------------------------------------
// De-linking: step 1, markdown links
// ---------------------------------------------------------------------------

const MAX_DEST_CHARS = 1024;
const MAX_REF_LABEL_CHARS = 100;

function isWordCode(c: number): boolean {
  return isAsciiLetter(c) || isDigit(c) || c === 0x5f || c === 0x5d || c === 0x29;
}

function destinationAllowed(dest: string, allow: AllowList): boolean {
  let value = dest.trim();
  if (value.startsWith('<')) {
    const close = value.indexOf('>');
    value = close === -1 ? value.slice(1) : value.slice(1, close);
  } else {
    const space = value.search(/\s/);
    if (space !== -1) value = value.slice(0, space);
  }
  return value !== '' && urlAllowed(value, allow);
}

/**
 * `[text](dest)` becomes `text`, `![alt](src)` becomes `alt`, `[text][ref]` becomes `text`, unless
 * the destination is an allowed value. Nested links are handled inner first. A hand scan with a
 * bound on every look-ahead and a bound on the total work, so it is linear.
 */
function neutraliseMarkdown(text: string, allow: AllowList): string {
  const n = text.length;
  if (text.indexOf(']') === -1) return text;
  let budget = 64 * n + 4096;
  const open: number[] = [];
  const cuts: Array<[number, number]> = [];
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 0x5c) {
      i += 2;
      continue;
    }
    if (c === 0x5b) {
      open.push(i);
    } else if (c === 0x5d) {
      const start = open.pop();
      if (start !== undefined) {
        const next = text.charCodeAt(i + 1);
        const bang = start > 0 && text.charCodeAt(start - 1) === 0x21 ? 1 : 0;
        if (next === 0x28) {
          let depth = 1;
          let j = i + 2;
          const limit = Math.min(n, i + 2 + MAX_DEST_CHARS);
          while (j < limit && budget > 0) {
            budget -= 1;
            const d = text.charCodeAt(j);
            if (d === 0x5c) {
              j += 2;
              continue;
            }
            if (d === 0x28) depth += 1;
            else if (d === 0x29) {
              depth -= 1;
              if (depth === 0) break;
            }
            j += 1;
          }
          if (j < limit && depth === 0 && text.charCodeAt(j) === 0x29) {
            if (!destinationAllowed(text.slice(i + 2, j), allow)) {
              cuts.push([start - bang, start + 1], [i, j + 1]);
            }
            i = j + 1;
            continue;
          }
        } else if (next === 0x5b && !isWordCode(text.charCodeAt(start - bang - 1))) {
          let k = i + 2;
          const limit = Math.min(n, i + 2 + MAX_REF_LABEL_CHARS);
          while (k < limit && budget > 0) {
            budget -= 1;
            const d = text.charCodeAt(k);
            if (d === 0x5d || d === 0x5b || d === 0x0a) break;
            k += 1;
          }
          if (k < limit && text.charCodeAt(k) === 0x5d) {
            cuts.push([start - bang, start + 1], [i, k + 1]);
            i = k + 1;
            continue;
          }
        }
      }
    }
    i += 1;
  }
  if (cuts.length === 0) return text;
  cuts.sort((a, b) => a[0] - b[0]);
  let out = '';
  let from = 0;
  for (const [a, b] of cuts) {
    if (a < from) continue;
    out += text.slice(from, a);
    from = b;
  }
  return out + text.slice(from);
}

// ---------------------------------------------------------------------------
// De-linking: step 2, a normalised copy for detection
// ---------------------------------------------------------------------------

/** Named character references that matter for links, emails and phone numbers (case-sensitive). */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  colon: ':',
  period: '.',
  comma: ',',
  semi: ';',
  sol: '/',
  bsol: '\\',
  commat: '@',
  lpar: '(',
  rpar: ')',
  lsqb: '[',
  rsqb: ']',
  lbrack: '[',
  rbrack: ']',
  lbrace: '{',
  rbrace: '}',
  lcub: '{',
  rcub: '}',
  num: '#',
  excl: '!',
  quest: '?',
  equals: '=',
  plus: '+',
  hyphen: '-',
  dash: '-',
  minus: '-',
  lowbar: '_',
  UnderBar: '_',
  percnt: '%',
  dollar: '$',
  ast: '*',
  midast: '*',
  Tab: '\t',
  NewLine: '\n',
};

const ENTITY = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));?/y;
const OBFUSCATED = /[[({]\s{0,3}(at|dot)\s{0,3}[\])}]\s{0,3}/iy;

/** Invisible format characters: dropped for detection so they cannot split a token. */
function isInvisible(cp: number): boolean {
  return (
    cp === 0xad ||
    cp === 0x34f ||
    cp === 0x61c ||
    cp === 0x115f ||
    cp === 0x1160 ||
    cp === 0x17b4 ||
    cp === 0x17b5 ||
    (cp >= 0x180b && cp <= 0x180f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0x3164 ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff ||
    cp === 0xffa0 ||
    (cp >= 0xe0000 && cp <= 0xe007f)
  );
}

interface Work {
  /** Normalised text used for detection. */
  readonly text: string;
  /** For every code unit of `text`: the range of the source text it came from. */
  readonly start: readonly number[];
  readonly end: readonly number[];
}

function buildWork(source: string): Work {
  const chars: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  const emitChar = (ch: string, a: number, b: number): void => {
    chars.push(ch);
    start.push(a);
    end.push(b);
  };
  const emitCodePoint = (cp: number, a: number, b: number): void => {
    if (cp < 0x80) {
      emitChar(String.fromCharCode(cp), a, b);
      return;
    }
    if (isInvisible(cp)) return;
    if ((cp >= 0x2010 && cp <= 0x2015) || cp === 0x2212) {
      emitChar('-', a, b);
      return;
    }
    const mapped = String.fromCodePoint(cp).normalize('NFKC');
    for (let k = 0; k < mapped.length; k += 1) {
      const code = mapped.charCodeAt(k);
      if (code < 0x80 || !isInvisible(code)) emitChar(mapped.charAt(k), a, b);
    }
  };

  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source.charCodeAt(i);
    if (c === 0x26) {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(source);
      if (m !== null) {
        const [whole, dec, hex, name] = m;
        let cp: number | undefined;
        let named: string | undefined;
        if (dec !== undefined) cp = Number(dec);
        else if (hex !== undefined) cp = Number.parseInt(hex, 16);
        else if (name !== undefined && whole.endsWith(';')) named = NAMED_ENTITIES[name];
        const stop = i + whole.length;
        if (named !== undefined) {
          emitCodePoint(named.charCodeAt(0), i, stop);
          i = stop;
          continue;
        }
        if (cp !== undefined) {
          if (cp === 0) {
            i = stop;
            continue;
          }
          if (cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
            emitCodePoint(cp, i, stop);
            i = stop;
            continue;
          }
        }
      }
      emitChar('&', i, i + 1);
      i += 1;
      continue;
    }
    if (c === 0x5b || c === 0x28 || c === 0x7b) {
      OBFUSCATED.lastIndex = i;
      const m = OBFUSCATED.exec(source);
      let neighbours = false;
      if (m !== null) {
        let back = chars.length - 1;
        while (back >= 0 && chars.length - 1 - back < 3 && WHITESPACE.test(chars[back] ?? '')) {
          back -= 1;
        }
        const before = chars[back]?.charCodeAt(0) ?? 0;
        const after = source.charCodeAt(i + m[0].length);
        neighbours =
          (isAsciiLetter(before) || isDigit(before)) && (isAsciiLetter(after) || isDigit(after));
      }
      if (m !== null && neighbours) {
        let from = i;
        for (let back = 0; back < 3 && chars.length > 0; back += 1) {
          const prev = chars[chars.length - 1] ?? '';
          if (!WHITESPACE.test(prev)) break;
          from = start[start.length - 1] ?? from;
          chars.pop();
          start.pop();
          end.pop();
        }
        const stop = i + m[0].length;
        emitChar(m[1]?.toLowerCase() === 'at' ? '@' : '.', from, stop);
        i = stop;
        continue;
      }
    }
    const cp = source.codePointAt(i) ?? c;
    const len = cp > 0xffff ? 2 : 1;
    emitCodePoint(cp, i, i + len);
    i += len;
  }
  return { text: chars.join(''), start, end };
}

// ---------------------------------------------------------------------------
// De-linking: step 3, detectors (all linear)
// ---------------------------------------------------------------------------

type SpanKind = 'url' | 'email' | 'phone';

interface Span {
  /** Range in the normalised text. */
  readonly s: number;
  readonly e: number;
  readonly kind: SpanKind;
  /** The allow list matched: leave the source text alone. */
  readonly allowed: boolean;
  /** How to break it. */
  readonly how: 'scheme' | 'slashes' | 'www' | 'host' | 'email' | 'phone';
}

const NON_HIERARCHICAL = new Set([
  'mailto',
  'tel',
  'whatsapp',
  'tg',
  'sms',
  'smsto',
  'mms',
  'intent',
  'javascript',
  'vbscript',
  'data',
  'file',
  'callto',
  'skype',
  'facetime',
  'viber',
  'sip',
  'sips',
  'geo',
]);

/** Top-level domains accepted for a bare `host.tld` (curated: common generic and country codes). */
const TLDS = new Set(
  (
    'com net org edu gov mil int info biz name pro mobi asia tel jobs travel museum coop aero ' +
    'app dev io ai co me tv us uk de fr es it nl be ch at se no dk fi ie pt gr ru cn jp kr in br ' +
    'au nz ca mx ar cl za tr il sg hk tw id my ph vn th ua cz sk hu ro bg hr si lt lv ee is eu to ' +
    'ly fm gg im xyz online site shop store tech cloud link click top club live life world today ' +
    'news email blog page website space fun icu vip work agency digital network solutions ' +
    'systems services company group media studio design art gl cx ws vc tk ga cf gq pw su by kz ' +
    'ir pk bd lk ng ke eg ma dz sa ae qa kw'
  ).split(' '),
);

function isAsciiLetter(c: number): boolean {
  return (c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

const NON_ASCII_LABEL = /^[\p{L}\p{N}\p{M}]$/u;

function isLabelUnit(text: string, i: number): boolean {
  const c = text.charCodeAt(i);
  if (c !== c) return false; // NaN: past the end
  if (c < 0x80) return isAsciiLetter(c) || isDigit(c) || c === 0x2d;
  if (c >= 0xd800 && c <= 0xdfff) return false;
  return NON_ASCII_LABEL.test(text.charAt(i));
}

/** A character that ends a URL: whitespace, controls, quotes, angle brackets, anything non-ASCII. */
function isUrlStop(c: number): boolean {
  return (
    c <= 0x20 || c >= 0x7f || c === 0x3c || c === 0x3e || c === 0x22 || c === 0x27 || c === 0x60
  );
}

/** End of a URL that starts at or before `from`, without trailing sentence punctuation. */
function urlEnd(text: string, from: number): number {
  const n = text.length;
  let e = from;
  while (e < n && !isUrlStop(text.charCodeAt(e))) e += 1;
  for (;;) {
    const last = text.charAt(e - 1);
    if (e <= from || !TRAILING_PUNCTUATION.test(last)) break;
    if (last === ')') {
      // Keep a closing parenthesis that balances one inside the URL.
      let balance = 0;
      for (let k = from; k < e; k += 1) {
        const c = text.charCodeAt(k);
        if (c === 0x28) balance += 1;
        else if (c === 0x29) balance -= 1;
      }
      if (balance >= 0) break;
    }
    e -= 1;
  }
  return e;
}

interface HostChain {
  /** End of the last label. */
  readonly end: number;
  readonly labels: ReadonlyArray<readonly [number, number]>;
}

/** Reads `label(.label)*` from `from` with labels of 1..63 characters and at most 253 in all. */
function hostChain(text: string, from: number): HostChain {
  const labels: Array<readonly [number, number]> = [];
  let pos = from;
  for (;;) {
    const labelStart = pos;
    while (pos < text.length && pos - labelStart <= 63 && isLabelUnit(text, pos)) pos += 1;
    if (pos === labelStart || pos - labelStart > 63 || pos - from > 253) break;
    labels.push([labelStart, pos]);
    if (text.charCodeAt(pos) === 0x2e && isLabelUnit(text, pos + 1)) pos += 1;
    else break;
  }
  const last = labels[labels.length - 1];
  return { end: last === undefined ? from : last[1], labels };
}

function pushUrlSpan(
  text: string,
  s: number,
  e: number,
  how: Span['how'],
  allow: AllowList,
  out: Span[],
  hostOnly: boolean,
): void {
  if (e <= s) return;
  const token = text.slice(s, e);
  let allowed = urlAllowed(token, allow);
  if (!allowed && hostOnly) allowed = allowedHosts(allow).has(token.toLowerCase());
  out.push({ s, e, kind: 'url', allowed, how });
}

/** `scheme://...` and the known non-hierarchical schemes (`mailto:`, `javascript:`, ...). */
function findSchemeUrls(text: string, allow: AllowList, out: Span[]): void {
  const n = text.length;
  let colon = text.indexOf(':');
  while (colon !== -1) {
    let s = colon;
    while (s > 0 && colon - s < 32) {
      const c = text.charCodeAt(s - 1);
      if (isAsciiLetter(c) || isDigit(c) || c === 0x2b || c === 0x2e || c === 0x2d) s -= 1;
      else break;
    }
    while (s < colon && !isAsciiLetter(text.charCodeAt(s))) s += 1;
    let next = colon + 1;
    if (colon - s >= 2) {
      const scheme = text.slice(s, colon).toLowerCase();
      const hierarchical =
        text.charCodeAt(colon + 1) === 0x2f && text.charCodeAt(colon + 2) === 0x2f;
      const after = text.charCodeAt(colon + 1);
      const flagged =
        hierarchical || (NON_HIERARCHICAL.has(scheme) && colon + 1 < n && !isUrlStop(after));
      if (flagged) {
        const e = urlEnd(text, colon + 1);
        if (e > colon) {
          pushUrlSpan(text, s, e, 'scheme', allow, out, false);
          next = Math.max(next, e);
        }
      }
    }
    colon = text.indexOf(':', next);
  }
}

/** `//host/...` (protocol-relative): after the start of the text or a non-word character. */
function findProtocolRelative(text: string, allow: AllowList, out: Span[]): void {
  let at = text.indexOf('//');
  while (at !== -1) {
    const prev = at === 0 ? 0x20 : text.charCodeAt(at - 1);
    let next = at + 1;
    if (!isAsciiLetter(prev) && !isDigit(prev) && prev !== 0x3a && prev !== 0x2f && prev !== 0x5f) {
      const chain = hostChain(text, at + 2);
      if (chain.labels.length >= 2) {
        const e = urlEnd(text, chain.end);
        pushUrlSpan(text, at, e, 'slashes', allow, out, false);
        next = Math.max(next, e);
      }
    }
    at = text.indexOf('//', next);
  }
}

const WWW = /(?<![A-Za-z])www\d{0,3}\./gi;

function findWww(text: string, allow: AllowList, out: Span[]): void {
  WWW.lastIndex = 0;
  for (let m = WWW.exec(text); m !== null; m = WWW.exec(text)) {
    const chain = hostChain(text, m.index);
    if (chain.labels.length < 2) continue;
    const e = urlEnd(text, chain.end);
    pushUrlSpan(text, m.index, e, 'www', allow, out, false);
    WWW.lastIndex = Math.max(WWW.lastIndex, e);
  }
}

/** Bare `host.tld` with a top-level domain from the curated list. */
function findBareHosts(text: string, allow: AllowList, out: Span[]): void {
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (!isLabelUnit(text, i)) {
      i += 1;
      continue;
    }
    const chain = hostChain(text, i);
    let hostEnd = -1;
    for (let k = chain.labels.length - 1; k >= 1; k -= 1) {
      const label = chain.labels[k];
      if (label === undefined) continue;
      const word = text.slice(label[0], label[1]);
      if (/^[A-Za-z]+$/.test(word) && TLDS.has(word.toLowerCase())) {
        hostEnd = label[1];
        break;
      }
    }
    // `host.tld/path` is a URL whatever the TLD (P7-D1, e2e A4b): an alphabetic last label of 2–24
    // letters directly followed by `/` and a path character. A bare host with an unlisted TLD and
    // no path stays as text (documented limit; the widget renders plain text and never autolinks).
    if (hostEnd === -1 && chain.labels.length >= 2) {
      const last = chain.labels[chain.labels.length - 1];
      if (last !== undefined) {
        const word = text.slice(last[0], last[1]);
        const next = text.charCodeAt(last[1] + 1);
        if (
          /^[A-Za-z]{2,24}$/.test(word) &&
          text.charCodeAt(last[1]) === 0x2f &&
          !Number.isNaN(next) &&
          next > 0x20 &&
          next !== 0x2f
        ) {
          hostEnd = last[1];
        }
      }
    }
    if (hostEnd !== -1) {
      const tailChar = text.charCodeAt(hostEnd);
      const hasTail =
        tailChar === 0x2f ||
        tailChar === 0x3f ||
        tailChar === 0x23 ||
        (tailChar === 0x3a && isDigit(text.charCodeAt(hostEnd + 1)));
      const e = hasTail ? urlEnd(text, hostEnd) : hostEnd;
      pushUrlSpan(text, i, Math.max(e, hostEnd), 'host', allow, out, e <= hostEnd);
      i = Math.max(e, hostEnd);
    } else {
      i = Math.max(chain.end, i + 1);
    }
  }
}

function isLocalPartChar(c: number): boolean {
  return (
    isAsciiLetter(c) ||
    isDigit(c) ||
    c === 0x2e ||
    c === 0x5f ||
    c === 0x25 ||
    c === 0x2b ||
    c === 0x2d
  );
}

function findEmails(text: string, allow: AllowList, out: Span[]): void {
  let at = text.indexOf('@');
  while (at !== -1) {
    let l = at;
    while (l > 0 && at - l < 64 && isLocalPartChar(text.charCodeAt(l - 1))) l -= 1;
    while (l < at && text.charCodeAt(l) === 0x2e) l += 1;
    if (l < at) {
      const chain = hostChain(text, at + 1);
      let end = -1;
      for (let k = chain.labels.length - 1; k >= 1; k -= 1) {
        const label = chain.labels[k];
        if (label !== undefined && /^[A-Za-z]{2,}$/.test(text.slice(label[0], label[1]))) {
          end = label[1];
          break;
        }
      }
      if (end !== -1) {
        const email = text.slice(l, end);
        out.push({
          s: l,
          e: end,
          kind: 'email',
          allowed: allow.emails.has(email.toLowerCase()),
          how: 'email',
        });
        at = text.indexOf('@', end);
        continue;
      }
    }
    at = text.indexOf('@', at + 1);
  }
}

const MAX_PHONE_GROUPS = 12;
const DATE_YMD = /^\d{4}[-. ]\d{1,2}[-. ]\d{1,2}$/;
const DATE_DMY = /^\d{1,2}[-. ]\d{1,2}[-. ]\d{2,4}$/;
const THOUSANDS = /^[1-9]\d?(?:[. ]\d{3}){2,}$/;
const DIGITS_AND_DOTS = /^[\d.]+$/;

function isPhoneSeparator(c: number): boolean {
  return c === 0x20 || c === 0x28 || c === 0x29 || c === 0x2e || c === 0x2d;
}

/** Whether digit groups `[first, last]` (with the text between them) have the shape of a phone number. */
function phoneShape(slice: string, groups: readonly number[], hasPlus: boolean): boolean {
  const k = groups.length / 2;
  let digits = 0;
  for (let g = 0; g < k; g += 1) digits += (groups[2 * g + 1] ?? 0) - (groups[2 * g] ?? 0);
  if (digits < 7 || digits > 15) return false;
  if (k === 1) return hasPlus || digits >= 10;
  if (hasPlus) return true;
  if (DATE_YMD.test(slice) || DATE_DMY.test(slice) || THOUSANDS.test(slice)) return false;
  if (DIGITS_AND_DOTS.test(slice) && k !== 3) return false; // decimals, IP addresses, versions
  const firstLen = (groups[1] ?? 0) - (groups[0] ?? 0);
  if (k === 2 && slice.charAt(firstLen) === '-' && firstLen >= 4 && !slice.startsWith('0')) {
    return false; // a range such as 1000-2000
  }
  let shortAfterDot = false;
  for (let g = 1; g < k; g += 1) {
    const len = (groups[2 * g + 1] ?? 0) - (groups[2 * g] ?? 0);
    if (len < 2) return false;
    if (len === 2 && slice.includes('.')) shortAfterDot = true;
  }
  if (shortAfterDot && k <= 4 && digits <= 10) return false; // prices and decimals such as 12.99-14.99
  return true;
}

function findPhones(text: string, allow: AllowList, out: Span[]): void {
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (!isDigit(text.charCodeAt(i))) {
      i += 1;
      continue;
    }
    const groups: number[] = [];
    let count = 0;
    let j = i;
    for (;;) {
      const groupStart = j;
      while (j < n && isDigit(text.charCodeAt(j))) j += 1;
      if (count <= MAX_PHONE_GROUPS) groups.push(groupStart, j);
      count += 1;
      let q = j;
      let separators = 0;
      let stop = false;
      while (q < n && separators < 3 && isPhoneSeparator(text.charCodeAt(q))) {
        const c = text.charCodeAt(q);
        const after = text.charCodeAt(q + 1);
        // ". " ends a sentence and " - " is a dash: neither continues a phone number.
        if (c === 0x2e && after === 0x20) stop = true;
        if (c === 0x2d && after === 0x20 && q > j && text.charCodeAt(q - 1) === 0x20) stop = true;
        if (stop) break;
        q += 1;
        separators += 1;
      }
      if (!stop && separators > 0 && q < n && isDigit(text.charCodeAt(q))) {
        j = q;
        continue;
      }
      break;
    }
    const candidateEnd = j;
    const before = text.charCodeAt(i - 1);
    const hasPlus = before === 0x2b;
    let first = hasPlus ? i - 1 : i;
    if (!hasPlus && before === 0x28) first = i - 1;
    const outer = first > 0 ? text.charCodeAt(first - 1) : 0x20;
    if (
      count <= MAX_PHONE_GROUPS &&
      !isAsciiLetter(outer) &&
      !isAsciiLetter(text.charCodeAt(candidateEnd)) &&
      !isDigit(outer)
    ) {
      let chosen: Span | undefined;
      let allowedSpan: Span | undefined;
      const whole = text.slice(groups[0] ?? 0, groups[2 * count - 1] ?? 0);
      // A run that is as a whole a date or a grouped number has no phone number inside it.
      const wholeIsNumber =
        !hasPlus && (DATE_YMD.test(whole) || DATE_DMY.test(whole) || THOUSANDS.test(whole));
      // A window may start or end only where the digit groups are separated by a space.
      const spaceBefore = (g: number): boolean =>
        g === 0 ||
        g === count ||
        text.slice(groups[2 * (g - 1) + 1] ?? 0, groups[2 * g] ?? 0).includes(' ');
      for (
        let a = 0;
        a < Math.min(3, count) && allowedSpan === undefined && !wholeIsNumber;
        a += 1
      ) {
        if (!spaceBefore(a)) continue;
        for (let b = count; b > a; b -= 1) {
          if (!spaceBefore(b)) continue;
          const window = groups.slice(2 * a, 2 * b);
          const sliceStart = window[0] ?? 0;
          const sliceEnd = window[window.length - 1] ?? 0;
          const slice = text.slice(sliceStart, sliceEnd);
          const plus = a === 0 && hasPlus;
          if (!phoneShape(slice, window, plus)) continue;
          const s = a === 0 ? first : sliceStart;
          const span: Span = {
            s,
            e: sliceEnd,
            kind: 'phone',
            allowed: allow.phoneDigits.has(digitsOf(slice)),
            how: 'phone',
          };
          if (span.allowed) {
            allowedSpan = span;
            break;
          }
          chosen ??= span;
        }
      }
      const picked = allowedSpan ?? chosen;
      if (picked !== undefined) out.push(picked);
    }
    i = Math.max(candidateEnd, i + 1);
  }
}

// ---------------------------------------------------------------------------
// De-linking: breaking a flagged token
// ---------------------------------------------------------------------------

function breakToken(token: string, how: Span['how']): string {
  switch (how) {
    case 'scheme': {
      const colon = token.indexOf(':');
      // An email inside (mailto:, user@host) is broken too: it could be linked on its own.
      return `${token.slice(0, colon + 1)}${ZWSP}${token.slice(colon + 1).replaceAll('@', `${ZWSP}@`)}`;
    }
    case 'slashes':
      return `/${ZWSP}${token.slice(1)}`;
    case 'www': {
      const dot = token.indexOf('.');
      return `${token.slice(0, dot)}${ZWSP}${token.slice(dot)}`;
    }
    case 'host': {
      const stop = token.search(/[/?#:]/);
      const host = stop === -1 ? token : token.slice(0, stop);
      const rest = stop === -1 ? '' : token.slice(stop);
      return `${host.replaceAll('.', `${ZWSP}.`)}${rest}`;
    }
    case 'email': {
      const at = token.indexOf('@');
      return `${token.slice(0, at)}${ZWSP}${token.slice(at)}`;
    }
    case 'phone': {
      let out = '';
      let digits = 0;
      for (const ch of token) {
        out += ch;
        if (ch >= '0' && ch <= '9') {
          digits += 1;
          if (digits % 2 === 0) out += ZWSP;
        }
      }
      return out;
    }
  }
}

function resolveOverlaps(spans: Span[]): Span[] {
  spans.sort((a, b) => a.s - b.s || b.e - a.e);
  const kept: Span[] = [];
  let lastEnd = -1;
  for (const span of spans) {
    if (span.s < lastEnd) continue;
    kept.push(span);
    lastEnd = span.e;
  }
  return kept;
}

/**
 * Neutralises every email, phone number and URL in `text` that is not in the allow list. `text`
 * should end at a token-safe boundary (see SafeTextStream). Pure; never throws on any input.
 * See the file header for what is detected and for the limits of this filter.
 */
export function delink(text: string, allow: AllowList): string {
  const clean = neutraliseMarkdown(sanitiseModelText(text), allow);
  if (clean === '') return clean;
  const work = buildWork(clean);
  const found: Span[] = [];
  findSchemeUrls(work.text, allow, found);
  findProtocolRelative(work.text, allow, found);
  findWww(work.text, allow, found);
  findBareHosts(work.text, allow, found);
  findEmails(work.text, allow, found);
  findPhones(work.text, allow, found);
  if (found.length === 0) return clean;

  let out = '';
  let cursor = 0;
  for (const span of resolveOverlaps(found)) {
    const from = Math.max(work.start[span.s] ?? cursor, cursor);
    const to = work.end[span.e - 1] ?? from;
    if (to <= from) continue;
    out += clean.slice(cursor, from);
    out += span.allowed
      ? clean.slice(from, to)
      : breakToken(work.text.slice(span.s, span.e), span.how);
    cursor = to;
  }
  return out + clean.slice(cursor);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Cuts to `max` UTF-16 units without splitting a surrogate pair. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const code = value.charCodeAt(max - 1);
  const cut = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return value.slice(0, cut);
}

/**
 * One line of plain text, no angle brackets (SourceRef titles reject HTML), de-linked like the
 * answer text (a document can carry an email, phone or URL too), then bounded.
 */
function plainLine(value: string, max: number, allow: AllowList): string {
  const flat = normaliseExcerpt(sanitiseModelText(value))
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ');
  return truncate(delink(flat.trim(), allow), max).trim();
}

/** The snapshot stored with the assistant message (`finish_chat_turn.p_sources`). */
export interface SourceRow {
  readonly chunk_id: string;
  readonly document_version_id: string;
  readonly source_label: string;
  readonly excerpt: string;
  readonly page_number: number | null;
  readonly section: string | null;
}

export interface BuiltSources {
  /** For the `sources` event. */
  readonly refs: readonly SourceRef[];
  /** For `finish_chat_turn`. */
  readonly rows: readonly SourceRow[];
}

/**
 * Display references for the cited chunks. Only ids present in `evidence` are accepted, so a
 * citation can never name a chunk that was not retrieved for this bot. No public URL is attached:
 * documents are private (a source URL would need an explicit public flag, which does not exist).
 * Titles, sections and excerpts are de-linked with `allow` (default: nothing is allowed, so a
 * caller that forgets it fails closed), then cut to the lengths migration 013 allows.
 */
export function buildSources(
  cited: readonly string[],
  evidence: ReadonlyMap<string, RetrievedChunk>,
  allow: AllowList = EMPTY_ALLOW,
): BuiltSources {
  const refs: SourceRef[] = [];
  const rows: SourceRow[] = [];
  for (const id of cited.slice(0, MAX_SOURCES)) {
    const chunk = evidence.get(id);
    if (chunk === undefined) continue;
    const title = plainLine(chunk.document_title, MAX_REF_TITLE_CHARS, allow) || 'Source';
    const section =
      chunk.section === null ? '' : plainLine(chunk.section, MAX_REF_TITLE_CHARS, allow);
    const excerpt = plainLine(chunk.content, MAX_EXCERPT_CHARS, allow);
    refs.push({
      chunk_id: chunk.chunk_id,
      title,
      ...(section === '' ? {} : { section }),
      ...(excerpt === '' ? {} : { excerpt }),
    });
    rows.push({
      chunk_id: chunk.chunk_id,
      document_version_id: chunk.document_version_id,
      source_label: plainLine(chunk.document_title, MAX_LABEL_CHARS, allow) || 'Source',
      excerpt,
      page_number: chunk.page_number,
      section:
        chunk.section === null ? null : plainLine(chunk.section, MAX_LABEL_CHARS, allow) || null,
    });
  }
  return { refs, rows };
}
