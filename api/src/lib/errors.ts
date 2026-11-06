import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  dbErrorFor,
  httpStatusFor,
  toErrorEnvelope,
  type DbErrorName,
  type ErrorCode,
  type ErrorEnvelope,
} from '@ragbot/shared';
import { VisitorAuthError } from '../services/auth.js';
import { DbError } from './supabase.js';

/**
 * Error handling for the public API (TECH_SPECS §5). The only thing that ever reaches a
 * client is an `ErrorEnvelope`: a stable code, the request id and an optional retry hint.
 * No message, stack or upstream body is ever sent.
 */

/** Code used for failures nobody anticipated. */
export const UNKNOWN_ERROR_CODE: ErrorCode = 'INTERNAL_ERROR';

/** Longest retry hint that will be sent: one day. */
export const MAX_RETRY_AFTER_SECONDS = 86_400;

/** A valid non-negative integer within bounds, or undefined for a missing or unusable hint. */
function clampRetryAfter(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, Math.ceil(value)));
}

export interface AppErrorOptions {
  readonly retryAfterSeconds?: number;
  /** Overrides `httpStatusFor(code)` where a more precise status exists (404, 408, 413). */
  readonly httpStatus?: number;
  /** Stable internal name (for example a DB error name), logged but never sent. */
  readonly internalName?: string;
  readonly cause?: unknown;
}

export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryAfterSeconds: number | undefined;
  readonly internalName: string | undefined;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    // The message is only the stable code: nothing free-form can end up in a log or a response.
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.httpStatus = options.httpStatus ?? httpStatusFor(code);
    this.retryAfterSeconds = clampRetryAfter(options.retryAfterSeconds);
    this.internalName = options.internalName;
  }
}

/**
 * Database error states that mean something to a visitor on a public route. Every other contract
 * state (permission, policy, argument, activation and similar) is a fault in this service or its
 * database setup, not something the caller did, so it is INTERNAL_ERROR. The internal name is
 * still logged. Later admin routes that need the wider mapping must map it themselves.
 */
function fromDbName(name: DbErrorName): AppError {
  const internalName = `db:${name}`;
  if (name === 'budget_exceeded') return new AppError('BUDGET_EXCEEDED', { internalName });
  if (name === 'request_conflict') return new AppError('INVALID_REQUEST', { internalName });
  return new AppError(UNKNOWN_ERROR_CODE, { internalName });
}

/** Maps an error carrying a contract SQLSTATE in `code` (for example a PostgREST error). */
export function mapDbError(err: unknown): AppError | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const sqlstate = (err as { code?: unknown }).code;
  if (typeof sqlstate !== 'string') return undefined;
  const name: DbErrorName | undefined = dbErrorFor(sqlstate);
  if (name === undefined) return undefined;
  return fromDbName(name);
}

function fastifyCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

/** Classifies any thrown value into an AppError. Pure; never reads the error's message. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof VisitorAuthError) {
    return new AppError(err.code, { internalName: 'visitor_auth' });
  }
  if (err instanceof DbError) {
    const name = err.sqlstate === undefined ? undefined : dbErrorFor(err.sqlstate);
    if (name !== undefined) return fromDbName(name);
    // Outage, timeout or an unmapped state: the dependency failed, not the caller.
    return new AppError('PROVIDER_UNAVAILABLE', { internalName: `db:${err.reason}` });
  }

  const db = mapDbError(err);
  if (db) return db;

  const code = fastifyCode(err);
  const status = statusOf(err);

  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE' || status === 413) {
    return new AppError('INVALID_REQUEST', { httpStatus: 413, internalName: 'payload_too_large' });
  }
  if (code === 'FST_ERR_NOT_FOUND' || status === 404) {
    return new AppError('INVALID_REQUEST', { httpStatus: 404, internalName: 'not_found' });
  }
  if (code === 'FST_ERR_HANDLER_TIMEOUT') {
    return new AppError('PROVIDER_UNAVAILABLE', { internalName: 'handler_timeout' });
  }
  if (status === 408 || code === 'FST_ERR_CTP_BODY_TIMEOUT') {
    return new AppError('INVALID_REQUEST', { httpStatus: 408, internalName: 'request_timeout' });
  }
  if ((err as { validation?: unknown } | null)?.validation !== undefined) {
    return new AppError('INVALID_REQUEST', { internalName: 'validation' });
  }
  if (code?.startsWith('FST_ERR_CTP_') || status === 415) {
    // Bad JSON, empty body, wrong content type, bad content-length: all caller faults.
    return new AppError('INVALID_REQUEST', { internalName: code?.toLowerCase() ?? 'media_type' });
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return new AppError('INVALID_REQUEST', { httpStatus: status, internalName: 'client_error' });
  }
  return new AppError(UNKNOWN_ERROR_CODE, { internalName: 'unexpected' });
}

export function envelopeFor(error: AppError, requestId: string): ErrorEnvelope {
  return toErrorEnvelope({
    code: error.code,
    request_id: requestId,
    retry_after_seconds: error.retryAfterSeconds,
  });
}

/** A static envelope body for the last resort: only a server-generated id, no client input. */
function fallbackBody(requestId: unknown): string {
  const id =
    typeof requestId === 'string' && /^[0-9a-f-]{36}$/.test(requestId) ? requestId : randomUUID();
  return JSON.stringify({ code: UNKNOWN_ERROR_CODE, request_id: id });
}

/**
 * Last resort when building or sending the normal envelope failed: write a static 500 envelope
 * straight to the socket, or drop the connection if a response is already under way. Nothing is
 * left to Fastify's default error handler, which would echo the error message.
 */
function sendFallback(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  try {
    const res = reply.raw;
    if (res.headersSent || res.writableEnded) {
      res.destroy();
    } else {
      const body = fallbackBody(request.id);
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('content-length', Buffer.byteLength(body));
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('cache-control', 'no-store');
      res.end(body);
    }
  } catch {
    try {
      reply.raw.destroy();
    } catch {
      // nothing left to do
    }
  }
  return reply;
}

/** Sends the envelope for an AppError. Exported for framework-level error paths. */
export function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: AppError,
): FastifyReply {
  try {
    if (error.retryAfterSeconds !== undefined) {
      void reply.header('retry-after', String(error.retryAfterSeconds));
    }
    return reply
      .status(error.httpStatus)
      .type('application/json')
      .send(envelopeFor(error, request.id));
  } catch {
    return sendFallback(request, reply);
  }
}

/**
 * Classifies, logs and answers any error. Logging rule for this and every later route: log only
 * ids, counts and codes. Never a message, prompt, question, chunk, history, token or header value.
 * Nothing in here can throw out to Fastify's own handler.
 */
export function handleError(
  err: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  try {
    const error = toAppError(err);
    const fields = {
      err,
      error_code: error.code,
      internal: error.internalName,
      status: error.httpStatus,
      // The HTTP status the database answered with, when the failure came from it.
      db_status: err instanceof DbError ? err.status : undefined,
    };
    if (error.httpStatus >= 500) request.log.error(fields, 'request failed');
    else request.log.warn(fields, 'request rejected');
    if (reply.sent) return reply;
    return sendError(request, reply, error);
  } catch {
    return sendFallback(request, reply);
  }
}

const CLIENT_ERROR_STATUS: Readonly<Record<string, number>> = {
  ERR_HTTP_REQUEST_TIMEOUT: 408,
  HPE_HEADER_OVERFLOW: 431,
};

/**
 * Handler for `clientError` (a request that never became a request: bad request line, oversized
 * headers, header timeout). Answers with a static envelope and closes. Nothing from the
 * client or from the parser's error is echoed, and no route runs.
 */
export function clientErrorHandler(err: Error & { code?: string }, socket: Duplex): void {
  // A reset connection has nobody to answer.
  if (err.code === 'ECONNRESET' || socket.destroyed) return;
  const status = (err.code !== undefined ? CLIENT_ERROR_STATUS[err.code] : undefined) ?? 400;
  if (socket.writable) {
    const id = randomUUID();
    const body = JSON.stringify({ code: 'INVALID_REQUEST', request_id: id });
    socket.write(
      `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? 'Bad Request'}\r\n` +
        'Content-Type: application/json; charset=utf-8\r\n' +
        `Content-Length: ${String(Buffer.byteLength(body))}\r\n` +
        `X-Request-Id: ${id}\r\n` +
        'X-Content-Type-Options: nosniff\r\n' +
        'Cache-Control: no-store\r\n' +
        'Connection: close\r\n\r\n' +
        body,
    );
  }
  socket.destroy();
}

/** Installs the global error and not-found handlers. */
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, request, reply) =>
    handleError(err, request, reply),
  );

  app.setNotFoundHandler((request, reply) =>
    sendError(
      request,
      reply,
      new AppError('INVALID_REQUEST', { httpStatus: 404, internalName: 'not_found' }),
    ),
  );
}
