// Citations and contact de-linking for model text (PRD W-07, W-16; TECH_SPECS section 6, 6.1).
//
// What the visitor sees is made in three steps, all in this module:
//  1. `[[chunk_id]]` markers are STRIPPED from the visible text (the id is never shown). Which
//     ids were cited is read from the raw text with the shared `extractCitedChunkIds`, restricted
//     to the chunks that were actually put in the prompt, so an invented id is dropped.
//  2. `SafeTextStream` releases text only up to a point where no marker, URL, email or phone
//     number can still be incomplete, so step 3 never has to look across a delta boundary.
//  3. `delink` neutralises every email, phone number and URL that is neither one of the configured
//     contact values nor a validated source URL. APPROACH: a zero-width space (U+200B) is inserted
//     inside the token (after the scheme colon, after `www`, before the `@`, after every second
//     digit of a phone number). The text stays readable and copyable, but neither a markdown
//     autolinker nor a phone/email detector sees a link any more. Allowed values are left as they
//     are. Contact values come from server configuration only (handover section 4, W-16).
//
// Nothing here logs or throws on model text.

import {
  extractCitedChunkIds,
  normaliseExcerpt,
  type HandoffContact,
  type SourceRef,
} from '@ragbot/shared';
import type { RetrievedChunk } from './retrieval.js';

const ZWSP = '​';
const MAX_SOURCES = 20;
/** `message_sources.excerpt` allows 500 characters, `source_label` and `section` 300 (migration 013). */
const MAX_EXCERPT_CHARS = 500;
const MAX_LABEL_CHARS = 300;
/** `SourceRef.title` and `.section` allow 200 characters of plain text. */
const MAX_REF_TITLE_CHARS = 200;

// ---------------------------------------------------------------------------
// Citation markers
// ---------------------------------------------------------------------------

/** A marker with at most one whitespace character before it, so removal leaves no gap before punctuation. */
const MARKER = /\s?\[\[[A-Za-z0-9_-]{1,64}\]\]/g;

/** Removes every well-formed `[[id]]` marker (valid or invented). */
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

/** Characters that can be part of a marker, URL, email or phone number being written. */
const TOKEN_TAIL = /\s?[A-Za-z0-9._~:/?#@!$&'*+,;=%[\]()-]*$/;
const NUMERIC_TAIL = /^[+(]?[\d().\s-]*$/;
const NUMERIC_WORD_BEFORE = /\s?[+(]?[\d().-]+$/;

/**
 * Index up to which `pending` can be released: the trailing token (and the whitespace before it)
 * stays back, and so does a run of number-like words (a phone number is written with spaces).
 */
function safeCut(pending: string): number {
  const tail = TOKEN_TAIL.exec(pending);
  let cut = tail === null ? pending.length : tail.index;
  while (NUMERIC_TAIL.test(pending.slice(cut))) {
    const before = NUMERIC_WORD_BEFORE.exec(pending.slice(0, cut));
    if (before === null || before.index >= cut) break;
    cut = before.index;
  }
  return cut;
}

/** Strips citation markers from streamed text and releases it only at token-safe boundaries. */
export class SafeTextStream {
  #pending = '';

  /** Adds raw model text and returns the text that is now safe to release (possibly empty). */
  push(text: string): string {
    this.#pending = stripCitationMarkers(this.#pending + text);
    const cut = safeCut(this.#pending);
    const out = this.#pending.slice(0, cut);
    this.#pending = this.#pending.slice(cut);
    return out;
  }

  /** The rest of the text, at the end of the answer. */
  flush(): string {
    const out = stripCitationMarkers(this.#pending);
    this.#pending = '';
    return out;
  }
}

// ---------------------------------------------------------------------------
// De-linking
// ---------------------------------------------------------------------------

export interface AllowList {
  readonly emails: ReadonlySet<string>;
  readonly phoneDigits: ReadonlySet<string>;
  readonly urls: ReadonlySet<string>;
}

const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

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

const SCHEMES = 'https?|ftp|file|data|javascript|vbscript|mailto|tel|sms';
const URL_RE = `(?:\\b(?:${SCHEMES}):\\/{0,2}|\\bwww\\.)[^\\s<>"'\`]+`;
const EMAIL_RE = '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}';
const PHONE_RE = '(?<![\\w+])\\+?\\(?\\d[\\d\\s().-]{5,}\\d(?![\\w])';
const CONTACT_LIKE = new RegExp(
  `(?<url>${URL_RE})|(?<email>${EMAIL_RE})|(?<phone>${PHONE_RE})`,
  'giu',
);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function breakUrl(url: string): string {
  if (/^www\./i.test(url)) return `${url.slice(0, 3)}${ZWSP}${url.slice(3)}`;
  const colon = url.indexOf(':');
  return `${url.slice(0, colon + 1)}${ZWSP}${url.slice(colon + 1)}`;
}

function breakEmail(email: string): string {
  const at = email.indexOf('@');
  return `${email.slice(0, at)}${ZWSP}${email.slice(at)}`;
}

function breakPhone(phone: string): string {
  let out = '';
  let digits = 0;
  for (const ch of phone) {
    out += ch;
    if (/\d/.test(ch)) {
      digits += 1;
      if (digits % 2 === 0) out += ZWSP;
    }
  }
  return out;
}

function urlAllowed(url: string, allow: AllowList): boolean {
  if (/^mailto:/i.test(url))
    return allow.emails.has(url.slice(7).split('?')[0]?.toLowerCase() ?? '');
  if (/^tel:/i.test(url)) return allow.phoneDigits.has(digitsOf(url.slice(4)));
  const normal = normaliseUrl(url);
  return normal !== null && allow.urls.has(normal);
}

/**
 * Neutralises every email, phone number and URL in `text` that is not in the allow list. `text`
 * must end at a token-safe boundary (see SafeTextStream). Pure; never throws on any input.
 */
export function delink(text: string, allow: AllowList): string {
  return text.replace(CONTACT_LIKE, (match: string, ...rest: unknown[]) => {
    const groups = rest.at(-1) as { url?: string; email?: string; phone?: string };
    if (groups.url !== undefined) {
      // Trailing sentence punctuation is not part of the URL.
      const punctuation = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
      const url = punctuation === '' ? match : match.slice(0, -punctuation.length);
      return (urlAllowed(url, allow) ? url : breakUrl(url)) + punctuation;
    }
    if (groups.email !== undefined) {
      return allow.emails.has(match.toLowerCase()) ? match : breakEmail(match);
    }
    const digits = digitsOf(match);
    if (digits.length < 7 || digits.length > 15 || ISO_DATE.test(match)) return match;
    return allow.phoneDigits.has(digits) ? match : breakPhone(match);
  });
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

/** One line of plain text, no angle brackets (SourceRef titles reject HTML), bounded. */
function plainLine(value: string, max: number): string {
  return truncate(
    normaliseExcerpt(value).replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim(),
    max,
  ).trim();
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
 */
export function buildSources(
  cited: readonly string[],
  evidence: ReadonlyMap<string, RetrievedChunk>,
): BuiltSources {
  const refs: SourceRef[] = [];
  const rows: SourceRow[] = [];
  for (const id of cited.slice(0, MAX_SOURCES)) {
    const chunk = evidence.get(id);
    if (chunk === undefined) continue;
    const title = plainLine(chunk.document_title, MAX_REF_TITLE_CHARS) || 'Source';
    const section = chunk.section === null ? '' : plainLine(chunk.section, MAX_REF_TITLE_CHARS);
    const excerpt = plainLine(chunk.content, MAX_EXCERPT_CHARS);
    refs.push({
      chunk_id: chunk.chunk_id,
      title,
      ...(section === '' ? {} : { section }),
      ...(excerpt === '' ? {} : { excerpt }),
    });
    rows.push({
      chunk_id: chunk.chunk_id,
      document_version_id: chunk.document_version_id,
      source_label: plainLine(chunk.document_title, MAX_LABEL_CHARS) || 'Source',
      excerpt,
      page_number: chunk.page_number,
      section: chunk.section === null ? null : plainLine(chunk.section, MAX_LABEL_CHARS) || null,
    });
  }
  return { refs, rows };
}
