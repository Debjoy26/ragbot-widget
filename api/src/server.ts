import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import type { AppConfig } from './lib/config.js';
import { clientIp } from './lib/client-ip.js';
import {
  AppError,
  clientErrorHandler,
  handleError,
  registerErrorHandlers,
  sendError,
} from './lib/errors.js';
import { addVary, applySecurityHeaders } from './lib/headers.js';
import { buildLoggerOptions, generateRequestId } from './lib/logger.js';
import type { Db } from './lib/supabase.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerSessionRoutes } from './routes/sessions.js';
import type { VisitorAuth } from './services/auth.js';
import type { Limits } from './services/limits.js';
import type { Runs } from './services/runs.js';
import type { TurnstileVerifier } from './services/turnstile.js';

export interface ServerDeps {
  readonly config: AppConfig;
  readonly db: Db;
  /**
   * The visitor-facing services (P5). All four are required: a server without them could not
   * answer `POST /v1/sessions` and must not start quietly without it. `runs` is held for the chat
   * route (P7). Tests that only exercise the server shell pass labelled fakes.
   */
  readonly auth: VisitorAuth;
  readonly limits: Limits;
  readonly runs: Runs;
  readonly turnstile: TurnstileVerifier;
  readonly logger?: FastifyServerOptions['logger'];
  /** Monotonic clock in milliseconds for the readiness cache. Injected for tests only. */
  readonly now?: () => number;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Best-effort client address (see lib/client-ip.ts), driven by TRUSTED_PROXY_HOPS. A hint,
     * never identity. Rate-limit on bot and session first, IP second: an address is shared
     * (NAT, mobile carriers) and spoofable wherever a hop is not really ours.
     */
    readonly clientIp: string;
  }
  interface FastifyInstance {
    /** Flips the server to draining: /health/ready answers 503 at once. Idempotent. */
    beginDrain(): void;
  }
}

const CORS_METHODS = 'GET, POST';
const CORS_HEADERS = 'authorization, content-type, idempotency-key';
const CORS_MAX_AGE_SECONDS = '600';

/** Builds the Fastify instance without listening. */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const { config, db } = deps;
  const allowedOrigins = new Set(config.allowedOrigins);
  let draining = false;

  /** Security headers plus the CORS decision, shared by hooks and framework-level errors. */
  function commonHeaders(request: FastifyRequest, reply: FastifyReply): boolean {
    applySecurityHeaders(reply, request.id);
    addVary(reply, 'Origin');
    // CORS is a supplementary control, not authentication (TECH_SPECS §8). Exact match only;
    // an unknown origin gets no CORS headers; credentials are never allowed.
    const origin = request.headers.origin;
    const allowed = typeof origin === 'string' && allowedOrigins.has(origin);
    if (allowed) {
      void reply.header('access-control-allow-origin', origin);
      void reply.header('access-control-expose-headers', 'x-request-id, retry-after');
    }
    return allowed;
  }

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
    // While closing, Fastify would answer a request on a kept-alive connection with its own 503
    // body. The onRequest hook below answers with the error envelope instead.
    return503OnClosing: false,
    // Fastify answers a bad URL (for example `/%zz`) before any hook runs, and the parser answers
    // a bad request line or oversized headers before Fastify sees a request at all. Both get the
    // envelope (or a static equivalent), never a Fastify default body that echoes client input.
    frameworkErrors: (err, request, reply) => {
      commonHeaders(request, reply);
      return handleError(err, request, reply);
    },
    clientErrorHandler,
  });

  // JSON only: drop the default text/plain parser. Anything else is rejected as INVALID_REQUEST.
  app.removeContentTypeParser('text/plain');

  app.decorateRequest('visitor', undefined);
  app.decorateRequest('clientIp', {
    getter(this: FastifyRequest) {
      return clientIp(this, config.trustedProxyHops);
    },
  });
  app.decorate('beginDrain', () => {
    draining = true;
  });
  // A closing server reports not-ready even if nobody called beginDrain().
  app.addHook('preClose', () => {
    draining = true;
  });
  registerErrorHandlers(app);

  app.addHook('onRequest', async (request, reply) => {
    const allowed = commonHeaders(request, reply);
    if (draining) {
      // Work on an already open connection: finish this response, then close the connection.
      void reply.header('connection', 'close');
      if (!request.url.startsWith('/health/')) {
        return sendError(
          request,
          reply,
          new AppError('PROVIDER_UNAVAILABLE', { internalName: 'draining' }),
        );
      }
    }
    const preflight =
      request.method === 'OPTIONS' &&
      request.headers['access-control-request-method'] !== undefined;
    if (preflight) {
      addVary(reply, 'Access-Control-Request-Method', 'Access-Control-Request-Headers');
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

  // A route that sets its own `Vary` must not drop `Origin`: put it back just before sending.
  app.addHook('onSend', async (_request, reply, payload) => {
    addVary(reply, 'Origin');
    return payload;
  });

  registerHealthRoutes(app, {
    db,
    readyTimeoutMs: config.readyTimeoutMs,
    isDraining: () => draining,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  registerSessionRoutes(app, {
    db,
    auth: deps.auth,
    limits: deps.limits,
    turnstile: deps.turnstile,
    ttlSeconds: config.visitorTokenTtlSeconds,
  });
  return app;
}
