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

// ---------------------------------------------------------------------------
// Database error states (SQLSTATEs raised by the SQL functions). These are internal:
// they never cross the API boundary as-is. A caller maps the stable name to an
// `ErrorCode` or to its own handling (CONTRACT-P3D5, migrations 001-010).
// ---------------------------------------------------------------------------

export const DB_ERROR_STATES = Object.freeze({
  RB001: 'budget_exceeded',
  RB002: 'budget_policy_missing',
  RB003: 'reservation_not_active',
  RB004: 'request_conflict',
  RB010: 'document_not_found',
  RB011: 'activation_failed',
  RB012: 'embedding_change_requires_reindex',
  RB013: 'lease_not_held',
  RB020: 'retention_policy_missing',
  RB030: 'conflict',
  RB031: 'file_too_large',
  RB032: 'mfa_required',
  RB033: 'forbidden',
  RB034: 'quota_exceeded',
  RB035: 'settings_invalid',
  RB036: 'policy_missing',
  RB037: 'not_found',
  RB038: 'upload_missing',
  '22023': 'invalid_argument',
  '23514': 'check_violation',
  '42501': 'permission_denied',
} as const);

export type DbErrorState = keyof typeof DB_ERROR_STATES;
export type DbErrorName = (typeof DB_ERROR_STATES)[DbErrorState];

/**
 * Total map from each database error name to the public `ErrorCode` an API route answers with.
 * The compiler enforces totality: a new DB error name without an entry here does not build.
 * Names with no better public code map to INVALID_REQUEST (caller error) and the route may
 * still log the specific name internally; internal/operator failures map to INDEXING_FAILED
 * or PROVIDER_UNAVAILABLE only where the failure is genuinely of that kind.
 */
export const DB_ERROR_API_CODE: Readonly<Record<DbErrorName, ErrorCode>> = Object.freeze({
  budget_exceeded: 'BUDGET_EXCEEDED',
  budget_policy_missing: 'BUDGET_EXCEEDED',
  reservation_not_active: 'INVALID_REQUEST',
  request_conflict: 'INVALID_REQUEST',
  document_not_found: 'INVALID_REQUEST',
  activation_failed: 'INDEXING_FAILED',
  embedding_change_requires_reindex: 'INVALID_REQUEST',
  lease_not_held: 'INDEXING_FAILED',
  retention_policy_missing: 'INVALID_REQUEST',
  conflict: 'INVALID_REQUEST',
  file_too_large: 'INVALID_REQUEST',
  mfa_required: 'FORBIDDEN',
  forbidden: 'FORBIDDEN',
  quota_exceeded: 'RATE_LIMITED',
  settings_invalid: 'INVALID_REQUEST',
  policy_missing: 'INVALID_REQUEST',
  not_found: 'INVALID_REQUEST',
  upload_missing: 'INVALID_REQUEST',
  invalid_argument: 'INVALID_REQUEST',
  check_violation: 'INVALID_REQUEST',
  permission_denied: 'FORBIDDEN',
});

/** Stable name for a contract SQLSTATE, or undefined for any other state (treat as internal error). */
export function dbErrorFor(sqlstate: string): DbErrorName | undefined {
  return Object.hasOwn(DB_ERROR_STATES, sqlstate)
    ? DB_ERROR_STATES[sqlstate as DbErrorState]
    : undefined;
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
