import { describe, expect, it } from 'vitest';
import { clientIp, UNKNOWN_IP, type IpSource } from '../../../api/src/lib/client-ip.ts';

function req(socket: string | undefined, xff?: string | string[]): IpSource {
  return {
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    socket: { remoteAddress: socket },
  };
}

describe('clientIp', () => {
  it('hops = 0 uses the socket address and ignores X-Forwarded-For', () => {
    expect(clientIp(req('10.0.0.9', '203.0.113.7'), 0)).toBe('10.0.0.9');
  });

  it('a spoofed X-Forwarded-For cannot change the result when hops = 0', () => {
    expect(clientIp(req('198.51.100.2', '1.1.1.1, 2.2.2.2, 3.3.3.3'), 0)).toBe('198.51.100.2');
  });

  it('hops = 1 takes the last entry', () => {
    expect(clientIp(req('10.0.0.1', '203.0.113.7'), 1)).toBe('203.0.113.7');
  });

  it('hops = 1 ignores a spoofed entry the client put on the left', () => {
    expect(clientIp(req('10.0.0.1', '6.6.6.6, 203.0.113.7'), 1)).toBe('203.0.113.7');
  });

  it('hops = 2 takes the second entry from the right', () => {
    expect(clientIp(req('10.0.0.1', '6.6.6.6, 203.0.113.7, 10.1.1.1'), 2)).toBe('203.0.113.7');
  });

  it('joins repeated X-Forwarded-For headers', () => {
    expect(clientIp(req('10.0.0.1', ['6.6.6.6', '203.0.113.7, 10.1.1.1']), 2)).toBe('203.0.113.7');
  });

  it('falls back to the socket address when the chain is shorter than hops', () => {
    expect(clientIp(req('10.0.0.1', '203.0.113.7'), 2)).toBe('10.0.0.1');
  });

  it('falls back to the socket address when the header is absent or blank', () => {
    expect(clientIp(req('10.0.0.1'), 1)).toBe('10.0.0.1');
    expect(clientIp(req('10.0.0.1', '  '), 1)).toBe('10.0.0.1');
  });

  it.each(['not-an-ip', '203.0.113.7:4444', '999.1.1.1', '[2001:db8::1]', 'unknown', '1.2.3'])(
    'falls back to the socket address when the chosen entry is malformed (%s)',
    (bad) => {
      expect(clientIp(req('10.0.0.1', `203.0.113.7, ${bad}`), 1)).toBe('10.0.0.1');
    },
  );

  it('falls back when a trusted entry to the right of the chosen one is malformed', () => {
    expect(clientIp(req('10.0.0.1', '203.0.113.7, garbage'), 2)).toBe('10.0.0.1');
  });

  it('normalises IPv4-mapped IPv6 from the socket and the header', () => {
    expect(clientIp(req('::ffff:192.0.2.5'), 0)).toBe('192.0.2.5');
    expect(clientIp(req('10.0.0.1', '::ffff:203.0.113.7'), 1)).toBe('203.0.113.7');
    expect(clientIp(req('::FFFF:c000:0205'), 0)).toBe('192.0.2.5');
  });

  it('canonicalises IPv6 and drops zone ids', () => {
    expect(clientIp(req('2001:0DB8:0:0:0:0:0:1'), 0)).toBe('2001:db8::1');
    expect(clientIp(req('fe80::1%eth0'), 0)).toBe('fe80::1');
  });

  it('returns a fixed marker when there is no usable socket address', () => {
    expect(clientIp(req(undefined), 0)).toBe(UNKNOWN_IP);
    expect(clientIp(req('garbage'), 0)).toBe(UNKNOWN_IP);
  });

  it('treats a non-integer or negative hops value as 0', () => {
    expect(clientIp(req('10.0.0.1', '203.0.113.7'), -1)).toBe('10.0.0.1');
    expect(clientIp(req('10.0.0.1', '203.0.113.7'), 1.5)).toBe('10.0.0.1');
  });
});
