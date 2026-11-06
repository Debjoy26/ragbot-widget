import type { FastifyInstance } from 'fastify';
import type { DbPing } from '../lib/supabase.js';

export interface HealthDeps {
  readonly db: DbPing;
  readonly readyTimeoutMs: number;
  /** True once shutdown has begun: the server answers not-ready without touching the database. */
  readonly isDraining: () => boolean;
  /** Clock in epoch milliseconds. Injected for tests only. */
  readonly now?: () => number;
}

type ProbeResult = 'ok' | 'not_ok' | 'error' | 'timeout';

/**
 * How long a readiness result is reused. /health/ready is public, so it must not turn each request
 * into a database call: concurrent requests share one probe, and its result serves everyone for
 * this long, failures included.
 */
export const READY_CACHE_MS = 2000;

/** Bounded probe: the abort signal fires at the deadline and the answer is "timeout" regardless. */
async function probe(db: DbPing, timeoutMs: number): Promise<ProbeResult> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, timeoutMs);
  });
  const ping = (async () => db.ping(controller.signal))().then(
    (ok): ProbeResult => (ok === true ? 'ok' : 'not_ok'),
    (): ProbeResult => 'error',
  );
  try {
    return await Promise.race([ping, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Responses carry no detail: no versions, hosts, error text or dependency names. */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  const now = deps.now ?? Date.now;
  let inflight: Promise<ProbeResult> | undefined;
  let cached: { readonly at: number; readonly result: ProbeResult } | undefined;

  function check(): Promise<ProbeResult> {
    if (cached !== undefined && now() - cached.at < READY_CACHE_MS) {
      return Promise.resolve(cached.result);
    }
    if (inflight !== undefined) return inflight;
    const run = probe(deps.db, deps.readyTimeoutMs)
      .then((result) => {
        cached = { at: now(), result };
        return result;
      })
      .finally(() => {
        inflight = undefined;
      });
    inflight = run;
    return run;
  }

  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (request, reply) => {
    // Draining: answer at once so the load balancer stops sending traffic before the drain ends.
    if (deps.isDraining()) return reply.status(503).send({ status: 'unavailable' });
    const result = await check();
    if (result === 'ok') return { status: 'ok' };
    request.log.warn({ readiness: result }, 'readiness check failed');
    return reply.status(503).send({ status: 'unavailable' });
  });
}
