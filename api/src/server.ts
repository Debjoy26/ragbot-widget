import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { AppConfig } from './lib/config.js';
import { registerErrorHandlers } from './lib/errors.js';
import { buildLoggerOptions, generateRequestId } from './lib/logger.js';
import type { DbPing } from './lib/supabase.js';
import { registerHealthRoutes } from './routes/health.js';

export interface ServerDeps {
  readonly config: AppConfig;
  readonly db: DbPing;
  readonly logger?: FastifyServerOptions['logger'];
}

const CORS_METHODS = 'GET, POST';
const CORS_HEADERS = 'authorization, content-type, idempotency-key';
const CORS_MAX_AGE_SECONDS = '600';

/** Builds the Fastify instance without listening. */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const { config, db } = deps;
  const allowedOrigins = new Set(config.allowedOrigins);

  const app = Fastify({
    logger: deps.logger ?? buildLoggerOptions(config.logLevel),
    // Never trusted from the client; the same id is returned in `x-request-id`.
    genReqId: generateRequestId,
    requestIdHeader: false,
    bodyLimit: config.bodyLimitBytes,
    requestTimeout: config.requestTimeoutMs,
    connectionTimeout: config.connectionTimeoutMs,
    // Proxy handling is explicit in lib/client-ip.ts, driven by TRUSTED_PROXY_HOPS.
    trustProxy: false,
  });

  // JSON only: drop the default text/plain parser. Anything else is rejected as INVALID_REQUEST.
  app.removeContentTypeParser('text/plain');

  app.decorateRequest('visitor', undefined);
  registerErrorHandlers(app);

  app.addHook('onRequest', async (request, reply) => {
    void reply
      .header('x-request-id', request.id)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header('vary', 'Origin');

    // CORS is a supplementary control, not authentication (TECH_SPECS §8). Exact match only;
    // an unknown origin gets no CORS headers; credentials are never allowed.
    const origin = request.headers.origin;
    const allowed = typeof origin === 'string' && allowedOrigins.has(origin);
    if (allowed) {
      void reply.header('access-control-allow-origin', origin);
      void reply.header('access-control-expose-headers', 'x-request-id, retry-after');
    }
    const preflight =
      request.method === 'OPTIONS' &&
      request.headers['access-control-request-method'] !== undefined;
    if (preflight) {
      if (allowed) {
        void reply
          .header('access-control-allow-methods', CORS_METHODS)
          .header('access-control-allow-headers', CORS_HEADERS)
          .header('access-control-max-age', CORS_MAX_AGE_SECONDS);
      }
      return reply.status(204).send();
    }
    return undefined;
  });

  registerHealthRoutes(app, { db, readyTimeoutMs: config.readyTimeoutMs });
  return app;
}
