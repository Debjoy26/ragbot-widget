// Rate-limit keys (TECH_SPECS section 8, handover.md section 4). P5-B.
//
// `record_rate_limit_attempt` accepts only a 64-char lowercase hex digest, so no plain IP address
// or identifier is ever stored. The digest is an HMAC-SHA256 under RATE_LIMIT_KEY_SECRET, not a
// bare hash: an IPv4 address has so few values that an unkeyed hash of it could be reversed by
// enumeration. Nothing in this module logs.

import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

const MIN_SECRET_BYTES = 32;
const KIND_PATTERN = /^[a-z][a-z_]{0,39}$/;

/** Kinds of counter. Part of the HMAC input, so two kinds never share a bucket. */
export type RateKeyKind = 'session_create_ip' | 'message_session' | 'message_ip';

/**
 * 64-char lowercase hex HMAC-SHA256 of `kind` and `parts` under `secret`. The input is encoded
 * with a length prefix per part, so ["ab", "c"] and ["a", "bc"] never collide.
 */
export function rateKey(secret: string, kind: RateKeyKind, parts: readonly string[]): string {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
    throw new TypeError(`rate limit key secret must be at least ${String(MIN_SECRET_BYTES)} bytes`);
  }
  if (typeof kind !== 'string' || !KIND_PATTERN.test(kind)) {
    throw new TypeError('rate key kind is invalid');
  }
  if (!Array.isArray(parts) || parts.length === 0 || parts.some((p) => typeof p !== 'string')) {
    throw new TypeError('rate key parts must be a non-empty list of strings');
  }
  const encoded = parts.map((p) => `${String(Buffer.byteLength(p, 'utf8'))}:${p}`).join('\n');
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`v1\n${kind}\n${encoded}`, 'utf8')
    .digest('hex');
}

export const UNKNOWN_BUCKET = 'unknown';

/** Eight 16-bit groups of a valid IPv6 text form, or undefined. */
function ipv6Groups(raw: string): number[] | undefined {
  let value = raw;
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (isIP(value) !== 6) return undefined;

  // An embedded dotted IPv4 tail ("::ffff:1.2.3.4") becomes two hex groups.
  const dot = value.lastIndexOf('.');
  if (dot !== -1) {
    const colon = value.lastIndexOf(':');
    const octets = value
      .slice(colon + 1)
      .split('.')
      .map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      return undefined;
    }
    const [a, b, c, d] = octets as [number, number, number, number];
    value = `${value.slice(0, colon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] === '' ? [] : (halves[0] as string).split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? (halves[1] as string).split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return undefined;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return undefined;
  const numbers = groups.map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return numbers.some(Number.isNaN) ? undefined : numbers;
}

/**
 * The bucket an address is counted in. IPv4: the address itself. IPv6: its /64 prefix (a host
 * usually controls a whole /64, so per-address counting would be trivial to dodge). IPv4-mapped
 * IPv6 (`::ffff:a.b.c.d`) is the IPv4 address. `unknown`, and anything that is not an IP address,
 * is one shared bucket: failing to find the client must not buy an unlimited allowance.
 */
export function ipBucket(ip: string): string {
  if (typeof ip !== 'string') return UNKNOWN_BUCKET;
  const trimmed = ip.trim();
  if (isIP(trimmed) === 4) return trimmed;
  const groups = ipv6Groups(trimmed);
  if (groups === undefined) return UNKNOWN_BUCKET;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `${String(g6 >> 8)}.${String(g6 & 0xff)}.${String(g7 >> 8)}.${String(g7 & 0xff)}`;
  }
  return `${[g0, g1, g2, g3].map((g) => g.toString(16)).join(':')}::/64`;
}
