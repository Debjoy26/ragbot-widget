import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { loadConfig, type AppConfig } from './lib/config.js';
import { createDb, type Db } from './lib/supabase.js';
import { buildServer } from './server.js';
import { createVisitorAuth, type VisitorAuth } from './services/auth.js';

export interface App {
  readonly app: FastifyInstance;
  readonly config: AppConfig;
  readonly db: Db;
  readonly auth: VisitorAuth;
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
    ttlSeconds: config.visitorTokenTtlSeconds,
    db,
  });
  const app = buildServer(logger === undefined ? { config, db } : { config, db, logger });
  return { app, config, db, auth };
}
