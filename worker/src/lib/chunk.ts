// Deterministic chunking (P6, TECH_SPECS §6/§7). Same input, same output, byte for byte: no
// locale, ICU, clock or randomness is involved. Sizes are estimated tokens, not a model tokenizer.
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ExtractedPage } from './extract.js';
import type { KnowledgeMediaType } from './sniff.js';

/** Target and maximum chunk size, in estimated tokens. */
export const CHUNK_TARGET_TOKENS = 350;
/** Approximate overlap carried into the next chunk, in estimated tokens. */
export const CHUNK_OVERLAP_TOKENS = 50;
/** Longest section label kept, in code points. */
export const MAX_SECTION_CHARS = 200;

export interface Chunk {
  chunk_index: number;
  content: string;
  token_count: number;
  /** Source page for PDFs; null for Markdown and plain text. */
  page_number: number | null;
  /** Nearest preceding Markdown heading at the start of the chunk; null for plain text and PDF. */
  section: string | null;
}

export interface ChunkResult {
  chunks: Chunk[];
  version: string;
}

// Token estimate in quarter-tokens, integers only so the result never depends on float rounding:
// ASCII costs 1/4 token per character, other scripts below U+2E80 cost 1/2, CJK and above cost 1.
const Q_ASCII = 1;
const Q_ALPHABETIC = 2;
const Q_WIDE = 4;
const ASCII_LIMIT = 0x80;
const ALPHABETIC_LIMIT = 0x2e80;

function quarterTokens(text: string): number {
  let q = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    q += cp < ASCII_LIMIT ? Q_ASCII : cp < ALPHABETIC_LIMIT ? Q_ALPHABETIC : Q_WIDE;
  }
  return q;
}

/** Estimated token count of `text`: 0 for the empty string, otherwise at least 1. */
export function estimateTokens(text: string): number {
  return Math.ceil(quarterTokens(text) / 4);
}

interface Atom {
  text: string;
  /** Whitespace that preceded this piece in the source (or the paragraph separator). */
  sep: string;
  q: number;
  section: string | null;
}

const CAP_Q = CHUNK_TARGET_TOKENS * 4;
const OVERLAP_Q = CHUNK_OVERLAP_TOKENS * 4;

export interface Piece {
  text: string;
  sep: string;
}

// Every pattern and weight below shapes the chunk boundaries, so CHUNKING_VERSION hashes them all.
//
// None of these patterns is ever run over a whole document. Sentence boundaries and headings used to
// be found with backtracking regexes (a lookahead after a greedy run, a lazy `.*?` before an
// anchored end), which cost time quadratic in the length of a run of punctuation or spaces. They
// are now found by scans that only move forward; each regex below tests one character at a time.
// The scans select exactly what the old regexes selected (a unit test compares them with the old
// regexes), except that a line longer than MAX_HEADING_LINE_CHARS is never a heading.
/** Ends a sentence only when whitespace follows (after any closing quotes or brackets). */
const SENTENCE_TERMINATOR = /[.!?\u2026]/u;
const SENTENCE_CLOSER = /["'\u201D\u2019)\]]/u;
/** Full-width terminators end a sentence without needing whitespace. */
const WIDE_TERMINATOR = /[\u3002\uFF01\uFF1F\uFF0E]/u;
const WIDE_CLOSER = /[\u300D\u300F\uFF09]/u;
const WHITESPACE = /\s/u;
const WORD_SEPARATOR = /\s+/g;
const PARAGRAPH_SEPARATOR = /\n[ \t]*\n/;
/** Separator between atoms that came from different blocks. */
const BLOCK_SEPARATOR = '\n\n';

/** End of the run of characters matching `isIn` that starts at `from` (`from` itself if none). */
function runEnd(text: string, from: number, isIn: RegExp): number {
  let i = from;
  while (i < text.length && isIn.test(text.charAt(i))) i += 1;
  return i;
}

/**
 * Split into sentences, keeping the whitespace between them. One forward scan: a run of ASCII
 * terminators (`.!?` and the ellipsis) ends a sentence when closing quotes or brackets and then
 * whitespace follow it; a run that fails that test is skipped as a whole, since every later
 * position inside the run would fail identically. A run of full-width terminators ends a sentence
 * wherever it stands.
 */
export function splitSentences(text: string): Piece[] {
  const pieces: Piece[] = [];
  let pos = 0;
  let sep = '';
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    let end: number;
    if (SENTENCE_TERMINATOR.test(ch)) {
      const terminators = runEnd(text, i + 1, SENTENCE_TERMINATOR);
      const closers = runEnd(text, terminators, SENTENCE_CLOSER);
      if (closers >= text.length || !WHITESPACE.test(text.charAt(closers))) {
        i = terminators;
        continue;
      }
      end = closers;
    } else if (WIDE_TERMINATOR.test(ch)) {
      end = runEnd(text, runEnd(text, i + 1, WIDE_TERMINATOR), WIDE_CLOSER);
    } else {
      i += 1;
      continue;
    }
    pieces.push({ text: text.slice(pos, end), sep });
    const wsEnd = runEnd(text, end, WHITESPACE);
    sep = text.slice(end, wsEnd);
    pos = wsEnd;
    i = end;
  }
  if (pos < text.length) pieces.push({ text: text.slice(pos), sep });
  return pieces;
}

function splitWords(text: string): Piece[] {
  const pieces: Piece[] = [];
  let sep = '';
  let pos = 0;
  for (const m of text.matchAll(WORD_SEPARATOR)) {
    if (m.index > pos) pieces.push({ text: text.slice(pos, m.index), sep });
    sep = m[0];
    pos = m.index + m[0].length;
  }
  if (pos < text.length) pieces.push({ text: text.slice(pos), sep });
  return pieces;
}

const COMBINING = /^(?:\p{M}|\u200D|\uFE0F|[\u{E0100}-\u{E01EF}])/u;

/**
 * Last resort for one unbroken run (a long URL, CJK text with no spaces): cut by code points,
 * never inside a surrogate pair and never before a combining mark or joiner.
 *
 * Each cut point is found with a binary search over running costs and a table of the nearest
 * allowed cut at or before each position, so the work is proportional to the run's length even when
 * a piece is much shorter than the cap (a run of thousands of combining marks cuts one code point at
 * a time).
 */
export function splitHard(text: string): Piece[] {
  const points = Array.from(text);
  const count = points.length;
  // cost[i] = quarter-tokens of the first i code points.
  const cost = new Int32Array(count + 1);
  // lastCut[i] = the largest position <= i where a cut is allowed (the end counts as allowed).
  const lastCut = new Int32Array(count + 1);
  for (let i = 0; i < count; i += 1) {
    cost[i + 1] = (cost[i] as number) + quarterTokens(points[i] as string);
  }
  for (let i = 1; i <= count; i += 1) {
    const blocked =
      i < count && (COMBINING.test(points[i] as string) || points[i - 1] === '\u200D');
    lastCut[i] = blocked ? (lastCut[i - 1] as number) : i;
  }
  const pieces: Piece[] = [];
  let start = 0;
  while (start < count) {
    // The longest run that fits the cap, but never empty.
    const budget = (cost[start] as number) + CAP_Q;
    let lo = start + 1;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if ((cost[mid] as number) <= budget) lo = mid;
      else hi = mid - 1;
    }
    let end = lo;
    // Do not cut before a combining mark or joiner, or right after a zero-width joiner. Back off
    // to the nearest allowed cut, but never below one code point.
    if (end < count && end > start + 1) end = Math.max(lastCut[end] as number, start + 1);
    pieces.push({ text: points.slice(start, end).join(''), sep: '' });
    start = end;
  }
  return pieces;
}

/** A generator step the async driver may use to hand control back to the event loop. */
type Steps<T> = Generator<void, T, void>;
/** How many sentences or atoms are processed between two yield points. */
const YIELD_EVERY = 256;

/** Break a block of text into atoms that each fit the cap. */
function* toAtoms(text: string, sep: string, section: string | null): Steps<Atom[]> {
  const atoms: Atom[] = [];
  const push = (piece: Piece, forceSep?: string): void => {
    const q = quarterTokens(piece.text);
    atoms.push({ text: piece.text, sep: forceSep ?? piece.sep, q, section });
  };
  let first = true;
  const sepFor = (piece: Piece): string => {
    if (first) {
      first = false;
      return sep;
    }
    return piece.sep;
  };
  let seen = 0;
  for (const sentence of splitSentences(text)) {
    seen += 1;
    if (seen % YIELD_EVERY === 0) yield;
    if (quarterTokens(sentence.text) <= CAP_Q) {
      push(sentence, sepFor(sentence));
      continue;
    }
    for (const word of splitWords(sentence.text)) {
      const wordSep = sepFor({ text: word.text, sep: word.sep || sentence.sep });
      if (quarterTokens(word.text) <= CAP_Q) {
        push(word, wordSep);
        continue;
      }
      let firstHard = true;
      for (const hard of splitHard(word.text)) {
        push(hard, firstHard ? wordSep : '');
        firstHard = false;
      }
    }
  }
  return atoms;
}

const FENCE = /^\s{0,3}(```|~~~)/;
const SPACE_OR_TAB = /[ \t]/;
/** `.` in the old heading regex: anything but a line terminator (a line never holds `\n`). */
const LINE_TERMINATOR = /[\r\u2028\u2029]/;
/** A line longer than this is never treated as a heading, so heading detection stays cheap. */
export const MAX_HEADING_LINE_CHARS = 2000;

/**
 * ATX heading test: up to three leading whitespace characters, one to six `#`, then the end of the
 * line or a space or tab. Returns the heading text (not yet trimmed; closing `#` marks and
 * surrounding blanks removed), `''` for an empty heading, or null when the line is not a heading.
 * Same answer as the regex `^\s{0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$` on its capture
 * group, found without backtracking. A line containing `\r`, U+2028 or U+2029 after the marks
 * never matched that regex (`.` stops at them) and does not match here.
 */
export function matchHeading(line: string): string | null {
  if (line.length > MAX_HEADING_LINE_CHARS) return null;
  let i = 0;
  while (i < 3 && i < line.length && WHITESPACE.test(line.charAt(i))) i += 1;
  let marks = 0;
  while (i + marks < line.length && line.charAt(i + marks) === '#') marks += 1;
  if (marks < 1 || marks > 6) return null;
  const rest = line.slice(i + marks);
  if (rest === '') return '';
  if (!SPACE_OR_TAB.test(rest.charAt(0)) || LINE_TERMINATOR.test(rest)) return null;
  const start = runEnd(rest, 0, SPACE_OR_TAB);
  if (start === rest.length) return '';
  let end = rest.length;
  while (SPACE_OR_TAB.test(rest.charAt(end - 1))) end -= 1;
  // An optional closing run of `#`, but only when blanks separate it from the text.
  let hashes = end;
  while (hashes > start && rest.charAt(hashes - 1) === '#') hashes -= 1;
  if (hashes < end && hashes > start && SPACE_OR_TAB.test(rest.charAt(hashes - 1))) {
    let textEnd = hashes;
    while (textEnd > start && SPACE_OR_TAB.test(rest.charAt(textEnd - 1))) textEnd -= 1;
    return rest.slice(start, textEnd);
  }
  return rest.slice(start, end);
}

/** Everything that shapes the chunk boundaries, hashed into CHUNKING_VERSION. */
export interface ChunkingFingerprint {
  readonly weights: readonly number[];
  readonly sizes: readonly number[];
  readonly separators: readonly string[];
  readonly patterns: readonly RegExp[];
}

export const CHUNKING_FINGERPRINT: ChunkingFingerprint = {
  weights: [Q_ASCII, Q_ALPHABETIC, Q_WIDE, ASCII_LIMIT, ALPHABETIC_LIMIT],
  sizes: [CHUNK_TARGET_TOKENS, CHUNK_OVERLAP_TOKENS, MAX_SECTION_CHARS, MAX_HEADING_LINE_CHARS],
  separators: [BLOCK_SEPARATOR],
  patterns: [
    SENTENCE_TERMINATOR,
    SENTENCE_CLOSER,
    WIDE_TERMINATOR,
    WIDE_CLOSER,
    WHITESPACE,
    WORD_SEPARATOR,
    PARAGRAPH_SEPARATOR,
    COMBINING,
    FENCE,
    SPACE_OR_TAB,
    LINE_TERMINATOR,
  ],
};

/**
 * The version string for a fingerprint: `c1-<target>-<overlap>-<8 hex of a SHA-256 over every
 * weight, size, separator and pattern>`. `c1` is the algorithm generation: change it when the code
 * changes what it does without touching a weight or pattern.
 */
export function deriveChunkingVersion(fingerprint: ChunkingFingerprint): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        weights: fingerprint.weights,
        sizes: fingerprint.sizes,
        separators: fingerprint.separators,
        patterns: fingerprint.patterns.map((re) => `${re.source}/${re.flags}`),
      }),
    )
    .digest('hex')
    .slice(0, 8);
  return `c1-${CHUNK_TARGET_TOKENS}-${CHUNK_OVERLAP_TOKENS}-${digest}`;
}

/** Stored as `chunking_version`. Editing a size, a token weight or a pattern changes it by itself. */
export const CHUNKING_VERSION = deriveChunkingVersion(CHUNKING_FINGERPRINT);

function sectionLabel(raw: string): string | null {
  const label = Array.from(raw.trim()).slice(0, MAX_SECTION_CHARS).join('');
  return label === '' ? null : label;
}

/** Split Markdown into blocks (heading lines, paragraphs) with the heading in effect for each. */
function markdownBlocks(text: string): { text: string; section: string | null }[] {
  const blocks: { text: string; section: string | null }[] = [];
  let section: string | null = null;
  let para: string[] = [];
  let fence: string | null = null;
  const flush = (): void => {
    const joined = para.join('\n').trim();
    if (joined !== '') blocks.push({ text: joined, section });
    para = [];
  };
  for (const line of text.split('\n')) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] as string;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      para.push(line);
      continue;
    }
    if (fence === null) {
      const heading = matchHeading(line);
      if (heading !== null) {
        flush();
        const label = sectionLabel(heading);
        if (label !== null) {
          section = label;
          blocks.push({ text: line.trim(), section });
        }
        continue;
      }
      if (line.trim() === '') {
        flush();
        continue;
      }
    }
    para.push(line);
  }
  flush();
  return blocks;
}

function plainBlocks(text: string): { text: string; section: string | null }[] {
  return text
    .split(PARAGRAPH_SEPARATOR)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => ({ text: p, section: null }));
}

/** Raised when the document would produce more chunks than the caller allows. */
export class ChunkLimitError extends Error {
  constructor() {
    super('document produces too many chunks');
    this.name = 'ChunkLimitError';
  }
}

function* packAtoms(
  atoms: Atom[],
  pageNumber: number | null,
  out: Chunk[],
  maxChunks: number,
): Steps<void> {
  let cur: Atom[] = [];
  let curQ = 0;

  const addCost = (a: Atom): number => (cur.length === 0 ? a.q : quarterTokens(a.sep) + a.q);
  const emit = (): void => {
    const content = cur.map((a, i) => (i === 0 ? a.text : a.sep + a.text)).join('');
    if (content.trim() === '') return;
    if (out.length >= maxChunks) throw new ChunkLimitError();
    out.push({
      chunk_index: out.length,
      content,
      token_count: estimateTokens(content),
      page_number: pageNumber,
      section: (cur[0] as Atom).section,
    });
  };
  const total = (list: Atom[]): number =>
    list.reduce((sum, a, i) => sum + (i === 0 ? a.q : quarterTokens(a.sep) + a.q), 0);

  let seen = 0;
  for (const atom of atoms) {
    seen += 1;
    if (seen % YIELD_EVERY === 0) yield;
    if (cur.length > 0 && curQ + addCost(atom) > CAP_Q) {
      emit();
      // Carry the longest tail of the emitted chunk that fits the overlap budget.
      let start = cur.length;
      let overlapQ = 0;
      for (let i = cur.length - 1; i >= 0; i -= 1) {
        const next = cur[i + 1];
        const cost = (cur[i] as Atom).q + (next ? quarterTokens(next.sep) : 0);
        if (overlapQ + cost > OVERLAP_Q) break;
        overlapQ += cost;
        start = i;
      }
      cur = cur.slice(start);
      // Overlap never reaches back across a heading, so a chunk's label matches its new content.
      while (cur.length > 0 && (cur[0] as Atom).section !== atom.section) cur.shift();
      // The new atom must fit beside the overlap; otherwise shorten the overlap.
      while (cur.length > 0 && total(cur) + quarterTokens(atom.sep) + atom.q > CAP_Q) {
        cur.shift();
      }
      curQ = total(cur);
    }
    curQ += addCost(atom);
    cur.push(atom);
  }
  if (cur.length > 0) emit();
}

function* chunkSteps(
  pages: ExtractedPage[],
  mediaType: KnowledgeMediaType,
  maxChunks: number,
): Steps<ChunkResult> {
  const chunks: Chunk[] = [];
  const isPdf = mediaType === 'application/pdf';
  const isMarkdown = mediaType === 'text/markdown';

  for (const page of pages) {
    const blocks = isMarkdown ? markdownBlocks(page.text) : plainBlocks(page.text);
    yield;
    const atoms: Atom[] = [];
    for (const block of blocks) {
      for (const atom of yield* toAtoms(
        block.text,
        BLOCK_SEPARATOR,
        isMarkdown ? block.section : null,
      )) {
        atoms.push(atom);
      }
    }
    yield* packAtoms(atoms, isPdf ? page.number : null, chunks, maxChunks);
  }
  return { chunks, version: CHUNKING_VERSION };
}

/**
 * Chunk extracted pages. PDF chunks never span pages, so every chunk has one `page_number`.
 * Markdown chunks carry the nearest preceding heading as `section`. `chunk_index` runs from 0
 * without gaps across the whole document. Empty or whitespace-only pages produce no chunks.
 * Synchronous and unbounded: for tests and small inputs. The worker uses `chunkDocumentAsync`.
 */
export function chunkDocument(pages: ExtractedPage[], mediaType: KnowledgeMediaType): ChunkResult {
  const steps = chunkSteps(pages, mediaType, Number.POSITIVE_INFINITY);
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
  }
}

export interface ChunkOptions {
  /** Throws ChunkLimitError as soon as a chunk beyond this count would be produced. */
  readonly maxChunks: number;
  /** Aborts chunking with an AbortError at the next yield point. */
  readonly signal?: AbortSignal;
}

/** Longest stretch of chunking work before control goes back to the event loop (heartbeats). */
export const YIELD_SLICE_MS = 5;

/**
 * Same output as `chunkDocument`, byte for byte, but it hands control back to the event loop every
 * few milliseconds so the job's heartbeat timer keeps firing on a very large document, it stops at
 * `maxChunks`, and it honours an abort.
 */
export async function chunkDocumentAsync(
  pages: ExtractedPage[],
  mediaType: KnowledgeMediaType,
  options: ChunkOptions,
): Promise<ChunkResult> {
  const { maxChunks, signal } = options;
  if (!Number.isInteger(maxChunks) || maxChunks < 1) {
    throw new RangeError('maxChunks must be a positive integer');
  }
  const steps = chunkSteps(pages, mediaType, maxChunks);
  let sliceStart = performance.now();
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
    if (performance.now() - sliceStart >= YIELD_SLICE_MS) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal?.aborted === true) {
        const err = new Error('chunking aborted');
        err.name = 'AbortError';
        throw err;
      }
      sliceStart = performance.now();
    }
  }
}
