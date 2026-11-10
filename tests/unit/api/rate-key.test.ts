import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ipBucket, rateKey, UNKNOWN_BUCKET } from '../../../api/src/lib/rate-key.ts';

// FAKE secrets, random per run.
const SECRET = randomBytes(32).toString('hex');
const otherKeyMaterial = randomBytes(32).toString('hex');

describe('rateKey', () => {
  it('is a 64-char lowercase hex digest', () => {
    expect(rateKey(SECRET, 'message_ip', ['bot', '1.2.3.4'])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(rateKey(SECRET, 'message_ip', ['bot', '1.2.3.4'])).toBe(
      rateKey(SECRET, 'message_ip', ['bot', '1.2.3.4']),
    );
  });

  it('differs per kind, per secret and per part', () => {
    const base = rateKey(SECRET, 'message_ip', ['bot', '1.2.3.4']);
    expect(rateKey(SECRET, 'session_create_ip', ['bot', '1.2.3.4'])).not.toBe(base);
    expect(rateKey(otherKeyMaterial, 'message_ip', ['bot', '1.2.3.4'])).not.toBe(base);
    expect(rateKey(SECRET, 'message_ip', ['bot', '1.2.3.5'])).not.toBe(base);
    expect(rateKey(SECRET, 'message_ip', ['bot2', '1.2.3.4'])).not.toBe(base);
  });

  it('has a distinct bucket for each session kind, with the same parts', () => {
    const kinds = [
      'session_preflight',
      'session_create_ip',
      'session_create_bot',
      'history_session',
    ] as const;
    const keys = kinds.map((k) => rateKey(SECRET, k, ['203.0.113.9']));
    expect(new Set(keys).size).toBe(kinds.length);
    for (const k of keys) expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cannot be made to collide by moving a boundary between parts', () => {
    expect(rateKey(SECRET, 'message_ip', ['ab', 'c'])).not.toBe(
      rateKey(SECRET, 'message_ip', ['a', 'bc']),
    );
    expect(rateKey(SECRET, 'message_ip', ['a', 'b'])).not.toBe(
      rateKey(SECRET, 'message_ip', ['a\nb']),
    );
  });

  it('does not contain the plain identifier', () => {
    // Checks the whole identifier, as text and hex-encoded. A fragment such as '203' appears in a random
    // 64-char hex digest by chance in about 1.5% of runs (P6-D7: two CI failures), so it proved nothing.
    const ip = '203.0.113.9';
    const key = rateKey(SECRET, 'message_ip', ['bot', ip]);
    expect(key).not.toContain(ip);
    expect(key).not.toContain(Buffer.from(ip, 'utf8').toString('hex'));
  });

  it.each([['short'], ['x'.repeat(31)], ['']])('rejects a secret under 32 bytes (%j)', (secret) => {
    expect(() => rateKey(secret, 'message_ip', ['a'])).toThrow(TypeError);
  });

  it('rejects an empty or non-string parts list and a bad kind', () => {
    expect(() => rateKey(SECRET, 'message_ip', [])).toThrow(TypeError);
    expect(() => rateKey(SECRET, 'message_ip', [1 as unknown as string])).toThrow(TypeError);
    expect(() => rateKey(SECRET, 'Bad Kind' as 'message_ip', ['a'])).toThrow(TypeError);
  });

  it('never puts the secret in an error', () => {
    try {
      rateKey('too-short-marker', 'message_ip', ['a']);
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('too-short-marker');
    }
  });
});

describe('ipBucket', () => {
  it('keeps IPv4 as is', () => {
    expect(ipBucket('203.0.113.9')).toBe('203.0.113.9');
  });

  it('reduces IPv6 to its /64', () => {
    expect(ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('2001:db8:1:2:1:2:3:4')).toBe(ipBucket('2001:db8:1:2:ffff:eeee:dddd:cccc'));
    expect(ipBucket('2001:db8:1:3::1')).not.toBe(ipBucket('2001:db8:1:2::1'));
  });

  it('groups compressed and expanded spellings and any case together', () => {
    expect(ipBucket('2001:DB8::1')).toBe('2001:db8:0:0::/64');
    expect(ipBucket('2001:db8:0:0:0:0:0:1')).toBe('2001:db8:0:0::/64');
    expect(ipBucket('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(ipBucket('::1')).toBe('0:0:0:0::/64');
  });

  it('normalises IPv4-mapped IPv6 to the IPv4 address', () => {
    expect(ipBucket('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(ipBucket('::ffff:cb00:7109')).toBe('203.0.113.9');
    expect(ipBucket('::FFFF:CB00:7109')).toBe('203.0.113.9');
    expect(ipBucket('0:0:0:0:0:ffff:cb00:7109')).toBe('203.0.113.9');
  });

  it('ignores an IPv6 zone id', () => {
    expect(ipBucket('fe80::1%eth0')).toBe(ipBucket('fe80::1'));
  });

  it('keeps unknown, and anything not an IP, as one shared bucket', () => {
    expect(ipBucket('unknown')).toBe(UNKNOWN_BUCKET);
    for (const bad of [
      '',
      'not-an-ip',
      '999.1.1.1',
      '1.2.3',
      '2001:db8::zz',
      '1:2:3:4:5:6:7:8:9',
    ]) {
      expect(ipBucket(bad)).toBe(UNKNOWN_BUCKET);
    }
    expect(ipBucket(undefined as unknown as string)).toBe(UNKNOWN_BUCKET);
  });
});
