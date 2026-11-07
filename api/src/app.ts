import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { loadConfig, type AppConfig } from './lib/config.js';
import { createDb, type Db } from './lib/supabase.js';
import { buildServer } from './server.js';
import { createVisitorAuth, type VisitorAuth } from './services/auth.js';
import { createLimits, type Limits } from './services/limits.js';
import { createRuns, type Runs } from './services/runs.js';
import { createTurnstileVerifier, type TurnstileVerifier } from './services/turnstile.js';

export interface App {
  readonly app: FastifyInstance;
  readonly config: AppConfig;
  readonly db: Db;
  readonly auth: VisitorAuth;
  readonly limits: Limits;
  readonly runs: Runs;
  readonly turnstile: TurnstileVerifier;
}

/** Wires the real dependencies. Throws on invalid configuration; never listens. */
export function createApp(
  env: Record<string, string | undefined>,
  logger?: FastifyServerOptions['logger'],
): App {
  const config = loadConfig(env);
  const db = createDb({
    url: config.supabaseUrl,
    secretKey: config.supabaseSecretKey,
    timeoutMs: config.dbTimeoutMs,
  });
  const auth = createVisitorAuth({
    secret: config.visitorTokenSecret,
    previousSecret: config.visitorTokenSecretPrevious,
    ttlSeconds: config.visitorTokenTtlSeconds,
    db,
  });
  const limits = createLimits({ db, rateKeySecret: config.rateLimitKeySecret });
  const runs = createRuns({ db });
  const turnstile = createTurnstileVerifier({
    secret: config.turnstileSecretKey,
    timeoutMs: config.turnstileTimeoutMs,
  });
  const deps = { config, db, auth, limits, runs, turnstile };
  const app = buildServer(logger === undefined ? deps : { ...deps, logger });
  return { app, config, db, auth, limits, runs, turnstile };
}
