import Fastify, { type FastifyInstance } from 'fastify';

// P1 scaffold: builds an app with no routes. Health, auth, chat etc. arrive in P4+.
export function buildServer(): FastifyInstance {
  return Fastify({ logger: false });
}
