import type { FastifyReply } from 'fastify';

/**
 * Response headers every reply carries, including replies to requests Fastify itself rejects
 * (TECH_SPECS §8). The API only ever returns JSON or an empty body, so the CSP forbids everything.
 */

const HSTS = 'max-age=31536000; includeSubDomains';
const CSP = "default-src 'none'; frame-ancestors 'none'";

/** Minimal reply surface used here, so a test double does not need the whole FastifyReply. */
type HeaderReply = Pick<FastifyReply, 'header' | 'getHeader'>;

/** Sets the fixed security headers and the server-generated request id. */
export function applySecurityHeaders(reply: HeaderReply, requestId: string): void {
  void reply
    .header('x-request-id', requestId)
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header('strict-transport-security', HSTS)
    .header('content-security-policy', CSP);
}

/**
 * Adds names to `Vary` without dropping the ones already there (a later `reply.header('vary', ...)`
 * would otherwise replace them). Matching is case-insensitive; `*` is kept as is.
 */
export function addVary(reply: HeaderReply, ...names: readonly string[]): void {
  const current = reply.getHeader('vary');
  const existing = (Array.isArray(current) ? current.join(',') : String(current ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set(existing.map((s) => s.toLowerCase()));
  const merged = [...existing];
  for (const name of names) {
    if (!seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      merged.push(name);
    }
  }
  void reply.header('vary', merged.join(', '));
}
