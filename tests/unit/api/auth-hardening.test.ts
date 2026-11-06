import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createVisitorAuth, VisitorAuthError } from '../../../api/src/services/auth.ts';

// P4-D1 (A-6): token lifetime limits and secret rotation. Every secret below is a labelled fake.

const SECRET = randomBytes(32).toString('hex');
const PREVIOUS = 'TEST-ONLY-previous-0123456789-abcdefghijklmn';
const THIRD = 'TEST-ONLY-third-----0123456789-abcdefghijklmn';
const BOT = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const T0_MS = 1_800_000_000_000;
const T0 = T0_MS / 1000;
const TTL = 900;
const NO_DB = {
  selectOne: () => {
    throw new Error('db must not be reached');
  },
};

function makeAuth(
  opts: { secret?: string; previousSecret?: string; nowMs?: number; ttl?: number } = {},
) {
  return createVisitorAuth({
    secret: opts.secret ?? SECRET,
    ...(opts.previousSecret === undefined ? {} : { previousSecret: opts.previousSecret }),
    ttlSeconds: opts.ttl ?? TTL,
    db: NO_DB,
    now: () => opts.nowMs ?? T0_MS,
  });
}

function signed(over: Record<string, unknown>, secret = SECRET): string {
  const payload = Buffer.from(
    JSON.stringify({
      bot_id: BOT,
      session_id: SESSION,
      token_version: 1,
      iat: T0,
      exp: T0 + TTL,
      ...over,
    }),
  ).toString('base64url');
  const input = `v1.${payload}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(VisitorAuthError);
    return (err as VisitorAuthError).code;
  }
  throw new Error('expected a VisitorAuthError');
}

describe('token lifetime (A-6)', () => {
  const auth = makeAuth();

  it('accepts iat exactly 60 seconds in the future', () => {
    expect(auth.verifyToken(signed({ iat: T0 + 60, exp: T0 + 60 + TTL })).token_version).toBe(1);
  });

  it('refuses iat 61 seconds in the future with UNAUTHORIZED', () => {
    expect(codeOf(() => auth.verifyToken(signed({ iat: T0 + 61, exp: T0 + 61 + TTL })))).toBe(
      'UNAUTHORIZED',
    );
  });

  it('refuses a far-future iat even with a valid signature', () => {
    expect(
      codeOf(() => auth.verifyToken(signed({ iat: T0 + 10 ** 8, exp: T0 + 10 ** 8 + 10 }))),
    ).toBe('UNAUTHORIZED');
  });

  it('accepts exp - iat equal to the configured TTL', () => {
    expect(auth.verifyToken(signed({ exp: T0 + TTL })).iat).toBe(T0);
  });

  it('refuses exp - iat one second above the configured TTL as SESSION_EXPIRED', () => {
    expect(codeOf(() => auth.verifyToken(signed({ exp: T0 + TTL + 1 })))).toBe('SESSION_EXPIRED');
  });

  it('refuses a ten year token signed with the right secret as SESSION_EXPIRED', () => {
    expect(codeOf(() => auth.verifyToken(signed({ exp: T0 + 10 * 365 * 86_400 })))).toBe(
      'SESSION_EXPIRED',
    );
  });

  it('an over-TTL token with an invalid signature stays UNAUTHORIZED', () => {
    const [v, payload, sig] = signed({ exp: T0 + TTL + 1 }).split('.') as [string, string, string];
    const flipped = `${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(codeOf(() => auth.verifyToken(`${v}.${payload}.${flipped}`))).toBe('UNAUTHORIZED');
    expect(codeOf(() => auth.verifyToken(signed({ exp: T0 + TTL + 1 }, THIRD)))).toBe(
      'UNAUTHORIZED',
    );
  });

  it('still reports SESSION_EXPIRED for an old but well-formed token', () => {
    const late = makeAuth({ nowMs: T0_MS + (TTL + 5) * 1000 });
    expect(codeOf(() => late.verifyToken(signed({})))).toBe('SESSION_EXPIRED');
  });

  it('a token it issued always passes its own lifetime checks', () => {
    const { token } = auth.issueToken({ bot_id: BOT, session_id: SESSION, token_version: 2 });
    expect(auth.verifyToken(token).token_version).toBe(2);
  });
});

describe('secret rotation (A-6)', () => {
  it('verifyToken accepts a token signed with the previous secret', () => {
    const auth = makeAuth({ previousSecret: PREVIOUS });
    expect(auth.verifyToken(signed({}, PREVIOUS)).bot_id).toBe(BOT);
  });

  it('still accepts the current secret', () => {
    const auth = makeAuth({ previousSecret: PREVIOUS });
    expect(auth.verifyToken(signed({}, SECRET)).bot_id).toBe(BOT);
  });

  it('refuses a token signed with a third secret', () => {
    const auth = makeAuth({ previousSecret: PREVIOUS });
    expect(codeOf(() => auth.verifyToken(signed({}, THIRD)))).toBe('UNAUTHORIZED');
  });

  it('refuses the previous secret when none is configured', () => {
    expect(codeOf(() => makeAuth().verifyToken(signed({}, PREVIOUS)))).toBe('UNAUTHORIZED');
  });

  it('issueToken never signs with the previous secret', () => {
    const rotated = makeAuth({ previousSecret: PREVIOUS });
    const { token } = rotated.issueToken({ bot_id: BOT, session_id: SESSION, token_version: 1 });
    // Verifies with the current secret alone, and not with the previous one alone.
    expect(makeAuth().verifyToken(token).bot_id).toBe(BOT);
    expect(codeOf(() => makeAuth({ secret: PREVIOUS }).verifyToken(token))).toBe('UNAUTHORIZED');
  });

  it('a previous-secret token is still subject to the lifetime limits', () => {
    const auth = makeAuth({ previousSecret: PREVIOUS });
    expect(codeOf(() => auth.verifyToken(signed({ exp: T0 + TTL + 1 }, PREVIOUS)))).toBe(
      'SESSION_EXPIRED',
    );
    expect(
      codeOf(() => auth.verifyToken(signed({ iat: T0 + 61, exp: T0 + 61 + TTL }, PREVIOUS))),
    ).toBe('UNAUTHORIZED');
  });

  it('refuses a tampered payload on a previous-secret token', () => {
    const auth = makeAuth({ previousSecret: PREVIOUS });
    const [v, , sig] = signed({}, PREVIOUS).split('.') as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({
        bot_id: BOT,
        session_id: SESSION,
        token_version: 9,
        iat: T0,
        exp: T0 + TTL,
      }),
    ).toString('base64url');
    expect(codeOf(() => auth.verifyToken(`${v}.${forged}.${sig}`))).toBe('UNAUTHORIZED');
  });

  it.each([
    ['too short', 'short'],
    ['equal to the current one', SECRET],
  ])('createVisitorAuth rejects a previous secret that is %s, without echoing it', (_l, value) => {
    try {
      makeAuth({ previousSecret: value });
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message).not.toContain(value);
      return;
    }
    throw new Error('expected a throw');
  });
});
