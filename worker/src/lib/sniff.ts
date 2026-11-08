// Content sniffing for uploaded knowledge files (TECH_SPECS §7, P6).
// The declared type is never trusted: the caller compares it with what the bytes look like.

export type SniffedType = 'pdf' | 'text' | 'unknown';

/** Media types the knowledge bucket accepts (DATABASE_SCHEMA `document_versions.media_type` CHECK). */
export type KnowledgeMediaType = 'application/pdf' | 'text/markdown' | 'text/plain';

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** Share of control characters above which a file is not treated as text. */
export const MAX_CONTROL_CHAR_RATIO = 0.01;

/**
 * True when `text` has no NUL and few control characters. Tab, LF, CR and form feed are normal;
 * other C0 controls, DEL and C1 controls count against the file.
 */
export function hasLowControlRatio(text: string): boolean {
  let controls = 0;
  let total = 0;
  for (const ch of text) {
    total += 1;
    const cp = ch.codePointAt(0) as number;
    if (cp === 0) return false;
    const isWhitespaceControl = cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x0c;
    if (!isWhitespaceControl && (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f))) controls += 1;
  }
  return total > 0 && controls / total <= MAX_CONTROL_CHAR_RATIO;
}

/** Strict UTF-8 decode. Returns null for invalid UTF-8. A leading BOM is kept as U+FEFF. */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function isPdfBytes(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  return PDF_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * Classify bytes by content. `pdf` needs the `%PDF-` header at byte 0. `text` needs valid UTF-8
 * with no NUL and a low control-character ratio. Markdown and plain text cannot be told apart by
 * bytes, so both come back as `text`. Everything else, including empty input, is `unknown`.
 */
export function sniffMediaType(bytes: Uint8Array): SniffedType {
  if (isPdfBytes(bytes)) return 'pdf';
  if (bytes.length === 0) return 'unknown';
  const text = decodeUtf8Strict(bytes);
  if (text !== null && hasLowControlRatio(text)) return 'text';
  return 'unknown';
}

/**
 * Does the declared media type fit the sniffed content? PDF content only matches
 * `application/pdf`; text content matches `text/markdown` or `text/plain`. A false result is a
 * mismatch the caller fails as `FILE_UNSUPPORTED`.
 */
export function declaredMatchesSniffed(declared: string, sniffed: SniffedType): boolean {
  if (sniffed === 'pdf') return declared === 'application/pdf';
  if (sniffed === 'text') return declared === 'text/markdown' || declared === 'text/plain';
  return false;
}
