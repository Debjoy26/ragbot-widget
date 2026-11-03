/**
 * Stable public error codes (TECH_SPECS §5) and the safe error envelope.
 *
 * The envelope intentionally has no free-text message, stack or upstream body:
 * clients map `code` to localised copy themselves, and raw provider responses
 * never cross the API boundary.
 */

export const ERROR_CODES = [
  'INVALID_REQUEST',
  'SESSION_EXPIRED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'BUDGET_EXCEEDED',
  'FILE_UNSUPPORTED',
  'OCR_REQUIRED',
  'INDEXING_FAILED',
  'PROVIDER_UNAVAILABLE',
  'STREAM_INTERRUPTED',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** HTTP status used when the error happens before streaming starts. */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  INVALID_REQUEST: 400,
  SESSION_EXPIRED: 401,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  BUDGET_EXCEEDED: 429,
  FILE_UNSUPPORTED: 415,
  OCR_REQUIRED: 422,
  INDEXING_FAILED: 500,
  PROVIDER_UNAVAILABLE: 503,
  STREAM_INTERRUPTED: 502,
};

/** The only shape an error may take on the wire (HTTP body or SSE `error` payload). */
export interface ErrorEnvelope {
  readonly code: ErrorCode;
  readonly request_id: string;
  readonly retry_after_seconds?: number | undefined;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_HTTP_STATUS[code];
}

/**
 * Builds a safe envelope. Only the code, request ID and an optional retry hint are
 * copied; anything else on the input (message, stack, upstream body) is dropped.
 */
export function toErrorEnvelope(input: {
  readonly code: ErrorCode;
  readonly request_id: string;
  readonly retry_after_seconds?: number | undefined;
}): ErrorEnvelope {
  const { code, request_id, retry_after_seconds } = input;
  if (retry_after_seconds === undefined) return { code, request_id };
  if (!Number.isInteger(retry_after_seconds) || retry_after_seconds < 0) {
    throw new RangeError('retry_after_seconds must be a non-negative integer');
  }
  return { code, request_id, retry_after_seconds };
}
