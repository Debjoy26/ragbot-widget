import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DB_ERROR_API_CODE,
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
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.internalName = options.internalName;
  }
}

/** Maps an error carrying a contract SQLSTATE in `code` (for example a PostgREST error). */
export function mapDbError(err: unknown): AppError | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const sqlstate = (err as { code?: unknown }).code;
  if (typeof sqlstate !== 'string') return undefined;
  const name: DbErrorName | undefined = dbErrorFor(sqlstate);
  if (name === undefined) return undefined;
  return new AppError(DB_ERROR_API_CODE[name], { internalName: `db:${name}` });
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
    if (name !== undefined) {
      return new AppError(DB_ERROR_API_CODE[name], { internalName: `db:${name}` });
    }
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

function sendError(request: FastifyRequest, reply: FastifyReply, error: AppError): FastifyReply {
  if (error.retryAfterSeconds !== undefined) {
    void reply.header('retry-after', String(error.retryAfterSeconds));
  }
  return reply
    .status(error.httpStatus)
    .type('application/json')
    .send(envelopeFor(error, request.id));
}

/** Installs the global error and not-found handlers. */
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, request, reply) => {
    const error = toAppError(err);
    const fields = {
      err,
      error_code: error.code,
      internal: error.internalName,
      status: error.httpStatus,
    };
    if (error.httpStatus >= 500) request.log.error(fields, 'request failed');
    else request.log.warn(fields, 'request rejected');
    if (reply.sent) return reply;
    return sendError(request, reply, error);
  });

  app.setNotFoundHandler((request, reply) =>
    sendError(
      request,
      reply,
      new AppError('INVALID_REQUEST', { httpStatus: 404, internalName: 'not_found' }),
    ),
  );
}
