import type { FastifyInstance } from 'fastify';
import type { DbPing } from '../lib/supabase.js';

export interface HealthDeps {
  readonly db: DbPing;
  readonly readyTimeoutMs: number;
}

type ProbeResult = 'ok' | 'not_ok' | 'error' | 'timeout';

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
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (request, reply) => {
    const result = await probe(deps.db, deps.readyTimeoutMs);
    if (result === 'ok') return { status: 'ok' };
    request.log.warn({ readiness: result }, 'readiness check failed');
    return reply.status(503).send({ status: 'unavailable' });
  });
}
