// Text extraction for PDF, Markdown and plain text (P6, TECH_SPECS §7, ADR 0005, ADR 0007).
// Markdown and text are decoded in-process. PDF parsing runs in a child process with a memory cap
// and a hard timeout. This module never logs document text, and its errors carry no document text.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeUtf8Strict,
  hasLowControlRatio,
  isPdfBytes,
  type KnowledgeMediaType,
} from './sniff.js';

/** Bump when extraction output changes for the same input. Stored as `extraction_version`. */
export const EXTRACTION_VERSION = 'x1-pdfjs-6.4.299';

/** A PDF with fewer non-whitespace characters than this in total has no usable text layer. */
export const MIN_PDF_TEXT_CHARS = 20;

/** Upper bound on the child's stdout, so a hostile PDF cannot exhaust the parent's memory. */
export const MAX_CHILD_OUTPUT_BYTES = 32 * 1024 * 1024;

export type ExtractionMethod = 'pdf_text' | 'markdown' | 'plain_text';
export type ExtractErrorCode = 'FILE_UNSUPPORTED' | 'OCR_REQUIRED';

/** Internal, log-safe reasons. Only `code` goes to the document status; `reason` is for operators. */
export type ExtractFailureReason =
  | 'type_mismatch'
  | 'invalid_utf8'
  | 'empty'
  | 'encrypted'
  | 'too_many_pages'
  | 'corrupt'
  | 'timeout'
  | 'memory'
  | 'output_too_large'
  | 'child_failed'
  | 'no_text_layer';

export class ExtractError extends Error {
  readonly code: ExtractErrorCode;
  readonly reason: ExtractFailureReason;

  constructor(code: ExtractErrorCode, reason: ExtractFailureReason) {
    super(`extraction failed: ${reason}`);
    this.name = 'ExtractError';
    this.code = code;
    this.reason = reason;
  }
}

export interface ExtractLimits {
  /** Wall-clock budget for PDF parsing; the child is killed at this point. */
  timeoutMs: number;
  /** Old-space heap cap for the PDF child, in MB. */
  maxMemoryMb: number;
  /** Maximum number of pages (ADR 0007). */
  maxPages: number;
}

export interface ExtractedPage {
  number: number;
  text: string;
}

export interface ExtractResult {
  pages: ExtractedPage[];
  method: ExtractionMethod;
  version: string;
}

export interface ExtractOptions {
  /** Aborts PDF parsing (worker shutdown, lease lost). Rejects with an AbortError, not ExtractError. */
  signal?: AbortSignal;
}

function assertLimits(limits: ExtractLimits): void {
  for (const key of ['timeoutMs', 'maxMemoryMb', 'maxPages'] as const) {
    const value = limits[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new RangeError(`extract limit ${key} must be a positive integer`);
    }
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// eslint-disable-next-line no-control-regex
const DISALLOWED_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Strip BOMs and control characters, normalise newlines, repair lone surrogates. */
export function normalizeText(input: string): string {
  return input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?|\u2028|\u2029|\u0085/g, '\n')
    .replace(DISALLOWED_CONTROLS, '')
    .replace(LONE_SURROGATE, '\uFFFD')
    .replace(/\uFEFF/g, '');
}

function extractPlain(bytes: Uint8Array, mediaType: 'text/markdown' | 'text/plain'): ExtractResult {
  const decoded = decodeUtf8Strict(bytes);
  if (decoded === null) throw new ExtractError('FILE_UNSUPPORTED', 'invalid_utf8');
  if (!hasLowControlRatio(decoded)) throw new ExtractError('FILE_UNSUPPORTED', 'type_mismatch');
  const text = normalizeText(decoded);
  if (text.trim() === '') throw new ExtractError('FILE_UNSUPPORTED', 'empty');
  return {
    pages: [{ number: 1, text }],
    method: mediaType === 'text/markdown' ? 'markdown' : 'plain_text',
    version: EXTRACTION_VERSION,
  };
}

/** Where the child script lives: the compiled sibling, or the `.ts` source when run from source. */
function childScriptPath(): string {
  const here = fileURLToPath(import.meta.url);
  const dir = dirname(here);
  return join(dir, here.endsWith('.ts') ? 'extract-child.ts' : 'extract-child.js');
}

type ChildOutcome =
  | { kind: 'pages'; pages: unknown }
  | { kind: 'refused'; reason: 'encrypted' | 'too_many_pages' | 'corrupt' }
  | { kind: 'failed'; reason: ExtractFailureReason };

const OOM_PATTERN = /out of memory|allocation failed|invalid (?:table|array) length/i;

function runPdfChild(
  bytes: Uint8Array,
  limits: ExtractLimits,
  signal: AbortSignal | undefined,
): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${limits.maxMemoryMb}`, childScriptPath(), String(limits.maxPages)],
      // Empty environment: the child never sees the worker's keys.
      { stdio: ['pipe', 'pipe', 'pipe'], env: {}, windowsHide: true },
    );

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let overflow = false;
    let outBytes = 0;
    const out: Buffer[] = [];
    let errTail = '';

    const kill = (): void => {
      if (!child.killed) child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, limits.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    child.on('error', () => finish(() => resolve({ kind: 'failed', reason: 'child_failed' })));
    child.stdin.on('error', () => undefined); // EPIPE when the child dies early
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_CHILD_OUTPUT_BYTES) {
        overflow = true;
        kill();
        return;
      }
      out.push(chunk);
    });
    // Only a short tail, only to recognise an out-of-memory abort. It is never logged or returned.
    child.stderr.on('data', (chunk: Buffer) => {
      errTail = (errTail + chunk.toString('latin1')).slice(-4096);
    });

    child.on('close', (_code, sig) => {
      finish(() => {
        if (aborted) return reject(abortError());
        if (timedOut) return resolve({ kind: 'failed', reason: 'timeout' });
        if (overflow) return resolve({ kind: 'failed', reason: 'output_too_large' });
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(out).toString('utf8'));
          if (typeof parsed === 'object' && parsed !== null) {
            const rec = parsed as Record<string, unknown>;
            if (rec.ok === true) return resolve({ kind: 'pages', pages: rec.pages });
            if (
              rec.ok === false &&
              (rec.reason === 'encrypted' ||
                rec.reason === 'too_many_pages' ||
                rec.reason === 'corrupt')
            ) {
              return resolve({ kind: 'refused', reason: rec.reason });
            }
          }
        } catch {
          // fall through to the crash classification below
        }
        const oom = sig === 'SIGABRT' || OOM_PATTERN.test(errTail);
        return resolve({ kind: 'failed', reason: oom ? 'memory' : 'child_failed' });
      });
    });

    child.stdin.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });
}

function abortError(): Error {
  const err = new Error('extraction aborted');
  err.name = 'AbortError';
  return err;
}

function validatePages(raw: unknown, maxPages: number): ExtractedPage[] {
  if (!Array.isArray(raw) || raw.length > maxPages) {
    throw new ExtractError('FILE_UNSUPPORTED', 'child_failed');
  }
  const pages: ExtractedPage[] = [];
  let previous = 0;
  for (const entry of raw as unknown[]) {
    const rec = entry as { number?: unknown; text?: unknown } | null;
    if (
      typeof rec !== 'object' ||
      rec === null ||
      typeof rec.number !== 'number' ||
      !Number.isInteger(rec.number) ||
      rec.number <= previous ||
      rec.number > maxPages ||
      typeof rec.text !== 'string'
    ) {
      throw new ExtractError('FILE_UNSUPPORTED', 'child_failed');
    }
    previous = rec.number;
    const text = normalizeText(rec.text).trim();
    if (text !== '') pages.push({ number: rec.number, text });
  }
  return pages;
}

async function extractPdf(
  bytes: Uint8Array,
  limits: ExtractLimits,
  signal: AbortSignal | undefined,
): Promise<ExtractResult> {
  if (!isPdfBytes(bytes)) throw new ExtractError('FILE_UNSUPPORTED', 'type_mismatch');
  const outcome = await runPdfChild(bytes, limits, signal);
  if (outcome.kind === 'failed') throw new ExtractError('FILE_UNSUPPORTED', outcome.reason);
  if (outcome.kind === 'refused') throw new ExtractError('FILE_UNSUPPORTED', outcome.reason);

  const pages = validatePages(outcome.pages, limits.maxPages);
  let chars = 0;
  for (const page of pages) chars += page.text.replace(/\s/g, '').length;
  if (chars < MIN_PDF_TEXT_CHARS) throw new ExtractError('OCR_REQUIRED', 'no_text_layer');
  return { pages, method: 'pdf_text', version: EXTRACTION_VERSION };
}

/**
 * Extract text from validated content. Throws `ExtractError` with code `FILE_UNSUPPORTED` (wrong or
 * unreadable content, encrypted, too many pages, timeout, memory) or `OCR_REQUIRED` (no text layer).
 * Throws `RangeError` for invalid limits (fail closed) and an `AbortError` when `signal` aborts.
 * Content that does not fit `mediaType` is `FILE_UNSUPPORTED`, even if the caller already sniffed it.
 */
export async function extractText(
  bytes: Uint8Array,
  mediaType: KnowledgeMediaType,
  limits: ExtractLimits,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  assertLimits(limits);
  switch (mediaType) {
    case 'application/pdf':
      return extractPdf(bytes, limits, options.signal);
    case 'text/markdown':
    case 'text/plain':
      if (isPdfBytes(bytes)) throw new ExtractError('FILE_UNSUPPORTED', 'type_mismatch');
      return extractPlain(bytes, mediaType);
    default:
      throw new ExtractError('FILE_UNSUPPORTED', 'type_mismatch');
  }
}
