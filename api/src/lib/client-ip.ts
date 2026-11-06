import { isIP } from 'node:net';

/**
 * Canonical client address for rate-limit keys and similar signals (TECH_SPECS §8).
 * This is a hint, never identity. The server runs with Fastify `trustProxy: false`;
 * proxy handling lives here and only trusts as many hops as configured.
 */

export interface IpSource {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly socket: { readonly remoteAddress?: string | undefined };
}

export const UNKNOWN_IP = 'unknown';

/** Returns a canonical IP string, or undefined if the input is not an IP address. */
function normalise(raw: string): string | undefined {
  let value = raw.trim();
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return undefined;

  // The URL parser gives the canonical (compressed, lower-case) IPv6 form.
  let host: string;
  try {
    host = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped?.[1] !== undefined && mapped[2] !== undefined) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return host;
}

function forwardedChain(headers: IpSource['headers']): string[] {
  const raw = headers['x-forwarded-for'];
  const joined = Array.isArray(raw) ? raw.join(',') : raw;
  if (joined === undefined || joined.trim() === '') return [];
  return joined.split(',').map((s) => s.trim());
}

/**
 * `hops = 0`: socket address; `X-Forwarded-For` is ignored.
 * `hops = n`: the nth address from the right of `X-Forwarded-For` (each trusted proxy
 * appends the address it received the connection from). Entries to the left of that one
 * are client-controlled and never read. If the chain is shorter than `hops`, or the chosen
 * entry or any trusted entry to its right is not a valid IP, fall back to the socket address.
 */
export function clientIp(req: IpSource, hops: number): string {
  const socketIp = normalise(req.socket.remoteAddress ?? '') ?? UNKNOWN_IP;
  if (!Number.isInteger(hops) || hops <= 0) return socketIp;

  const chain = forwardedChain(req.headers);
  if (chain.length < hops) return socketIp;

  const trusted = chain.slice(chain.length - hops);
  const normalised = trusted.map(normalise);
  const chosen = normalised[0];
  if (chosen === undefined || normalised.some((e) => e === undefined)) return socketIp;
  return chosen;
}
