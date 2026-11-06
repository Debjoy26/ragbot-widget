import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  bearerToken,
  createVisitorAuth,
  requireVisitor,
  VisitorAuthError,
  type VisitorContext,
} from '../../../api/src/services/auth.ts';

// P4-T2 unit tests for visitor token issue/verify. Every secret below is a labelled fake.

const SECRET = 'TEST-ONLY-secret-0123456789-abcdefghijklmnop';
const OTHER_SECRET = 'TEST-ONLY-other--0123456789-abcdefghijklmnop';
const BOT = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const T0_MS = 1_800_000_000_000; // fixed clock
const TTL = 900;
const NO_DB = {
  selectOne: () => {
    throw new Error('db must not be reached');
  },
};

function makeAuth(opts: { secret?: string; nowMs?: number } = {}) {
  let nowMs = opts.nowMs ?? T0_MS;
  const auth = createVisitorAuth({
    secret: opts.secret ?? SECRET,
    ttlSeconds: TTL,
    db: NO_DB,
    now: () => nowMs,
  });
  return {
    auth,
    setNow: (ms: number) => {
      nowMs = ms;
    },
  };
}

const ctx: VisitorContext = { bot_id: BOT, session_id: SESSION, token_version: 3 };

function b64(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/** Signs an arbitrary payload string with the real format, so only the claim checks can refuse it. */
function signRaw(payload: string, secret = SECRET, version = 'v1'): string {
  const input = `${version}.${b64(payload)}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

function claims(over: Record<string, unknown> = {}): string {
  const iat = T0_MS / 1000;
  return JSON.stringify({
    bot_id: BOT,
    session_id: SESSION,
    token_version: 3,
    iat,
    exp: iat + TTL,
    ...over,
  });
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

describe('createVisitorAuth configuration', () => {
  it('rejects a secret under 32 bytes and accepts exactly 32', () => {
    const make = (secret: string) => () =>
      createVisitorAuth({ secret, ttlSeconds: TTL, db: NO_DB, now: () => T0_MS });
    expect(make('a'.repeat(31))).toThrow(TypeError);
    expect(make('')).toThrow(TypeError);
    expect(make('a'.repeat(32))).not.toThrow();
  });

  it('counts bytes, not characters, for the secret length', () => {
    const make = (secret: string) => () =>
      createVisitorAuth({ secret, ttlSeconds: TTL, db: NO_DB, now: () => T0_MS });
    // 16 two-byte characters = 32 bytes but 16 characters.
    expect(make('é'.repeat(16))).not.toThrow();
    expect(make('é'.repeat(15))).toThrow(TypeError);
  });

  it('never puts the secret in the error message', () => {
    const short = 'TEST-ONLY-short';
    try {
      createVisitorAuth({ secret: short, ttlSeconds: TTL, db: NO_DB });
    } catch (err) {
      expect((err as Error).message).not.toContain(short);
      return;
    }
    throw new Error('expected a throw');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects ttlSeconds %s', (ttl) => {
    expect(() => createVisitorAuth({ secret: SECRET, ttlSeconds: ttl, db: NO_DB })).toThrow(
      TypeError,
    );
  });
});

describe('issueToken and verifyToken', () => {
  it('round-trips and takes iat and exp from the clock', () => {
    const { auth } = makeAuth();
    const issued = auth.issueToken(ctx);
    const parsed = auth.verifyToken(issued.token);
    expect(parsed).toEqual({
      bot_id: BOT,
      session_id: SESSION,
      token_version: 3,
      iat: T0_MS / 1000,
      exp: T0_MS / 1000 + TTL,
    });
    expect(issued.expires_at).toBe(new Date((T0_MS / 1000 + TTL) * 1000).toISOString());
  });

  it('uses the documented format v1.<payload>.<hmac>', () => {
    const { auth } = makeAuth();
    const parts = auth.issueToken(ctx).token.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('v1');
    const expected = createHmac('sha256', SECRET).update(`v1.${parts[1]}`).digest('base64url');
    expect(parts[2]).toBe(expected);
  });

  it('refuses to issue for malformed ids or versions', () => {
    const { auth } = makeAuth();
    expect(() => auth.issueToken({ ...ctx, bot_id: 'not-a-uuid' })).toThrow();
    expect(() => auth.issueToken({ ...ctx, token_version: 0 })).toThrow();
    expect(() => auth.issueToken({ ...ctx, token_version: 1.5 })).toThrow();
  });

  it('accepts a token until the last second before exp', () => {
    const { auth, setNow } = makeAuth();
    const { token } = auth.issueToken(ctx);
    setNow(T0_MS + TTL * 1000 - 1);
    expect(auth.verifyToken(token).token_version).toBe(3);
  });

  it('refuses at the exact exp boundary with SESSION_EXPIRED', () => {
    const { auth, setNow } = makeAuth();
    const { token } = auth.issueToken(ctx);
    setNow(T0_MS + TTL * 1000);
    expect(codeOf(() => auth.verifyToken(token))).toBe('SESSION_EXPIRED');
  });

  it('refuses after exp with SESSION_EXPIRED', () => {
    const { auth, setNow } = makeAuth();
    const { token } = auth.issueToken(ctx);
    setNow(T0_MS + (TTL + 3600) * 1000);
    expect(codeOf(() => auth.verifyToken(token))).toBe('SESSION_EXPIRED');
  });

  it('fails closed on a non-finite clock', () => {
    const { auth, setNow } = makeAuth();
    const { token } = auth.issueToken(ctx);
    setNow(Number.NaN);
    expect(codeOf(() => auth.verifyToken(token))).toBe('SESSION_EXPIRED');
  });

  it('puts only the code in the error message', () => {
    const { auth } = makeAuth();
    try {
      auth.verifyToken('v1.abc.def');
    } catch (err) {
      expect((err as Error).message).toBe('UNAUTHORIZED');
      expect((err as VisitorAuthError).statusCode).toBe(401);
      return;
    }
    throw new Error('expected a throw');
  });
});

describe('verifyToken rejects forgeries as UNAUTHORIZED', () => {
  it('a tampered payload with the original signature', () => {
    const { auth } = makeAuth();
    const [v, , sig] = auth.issueToken(ctx).token.split('.') as [string, string, string];
    const evil = b64(claims({ bot_id: '33333333-3333-4333-8333-333333333333' }));
    expect(codeOf(() => auth.verifyToken(`${v}.${evil}.${sig}`))).toBe('UNAUTHORIZED');
  });

  it('a tampered signature', () => {
    const { auth } = makeAuth();
    const [v, p, sig] = auth.issueToken(ctx).token.split('.') as [string, string, string];
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(codeOf(() => auth.verifyToken(`${v}.${p}.${flipped}`))).toBe('UNAUTHORIZED');
  });

  it('a truncated and a lengthened signature', () => {
    const { auth } = makeAuth();
    const [v, p, sig] = auth.issueToken(ctx).token.split('.') as [string, string, string];
    expect(codeOf(() => auth.verifyToken(`${v}.${p}.${sig.slice(0, -4)}`))).toBe('UNAUTHORIZED');
    expect(codeOf(() => auth.verifyToken(`${v}.${p}.${sig}AAAA`))).toBe('UNAUTHORIZED');
  });

  it('a signature swapped in from another token', () => {
    const { auth } = makeAuth();
    const a = auth.issueToken(ctx).token.split('.') as [string, string, string];
    const b = auth
      .issueToken({ ...ctx, session_id: '44444444-4444-4444-8444-444444444444' })
      .token.split('.') as [string, string, string];
    expect(codeOf(() => auth.verifyToken(`${a[0]}.${a[1]}.${b[2]}`))).toBe('UNAUTHORIZED');
  });

  it('a token signed with another secret', () => {
    const forged = makeAuth({ secret: OTHER_SECRET }).auth.issueToken(ctx).token;
    expect(codeOf(() => makeAuth().auth.verifyToken(forged))).toBe('UNAUTHORIZED');
  });

  it('a hand-forged token with a far-future exp and the wrong secret', () => {
    const forged = signRaw(claims({ exp: T0_MS / 1000 + 10 * 365 * 86400 }), OTHER_SECRET);
    expect(codeOf(() => makeAuth().auth.verifyToken(forged))).toBe('UNAUTHORIZED');
  });

  it('an expired token with a bad signature is UNAUTHORIZED, not SESSION_EXPIRED', () => {
    const { auth, setNow } = makeAuth();
    const [v, p, sig] = auth.issueToken(ctx).token.split('.') as [string, string, string];
    setNow(T0_MS + (TTL + 3600) * 1000);
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(codeOf(() => auth.verifyToken(`${v}.${p}.${flipped}`))).toBe('UNAUTHORIZED');
    const expiredForged = signRaw(claims({ iat: 1, exp: 2 }), OTHER_SECRET);
    expect(codeOf(() => auth.verifyToken(expiredForged))).toBe('UNAUTHORIZED');
  });

  it('a non-canonical spelling of a valid signature', () => {
    const { auth } = makeAuth();
    const [v, p, sig] = auth.issueToken(ctx).token.split('.') as [string, string, string];
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(sig.at(-1) as string);
    const twin = alphabet[last ^ 1] as string; // differs only in the two unused trailing bits
    expect(
      Buffer.from(sig.slice(0, -1) + twin, 'base64url').equals(Buffer.from(sig, 'base64url')),
    ).toBe(true);
    expect(codeOf(() => auth.verifyToken(`${v}.${p}.${sig.slice(0, -1)}${twin}`))).toBe(
      'UNAUTHORIZED',
    );
  });
});

describe('verifyToken structure ("alg"-style tricks)', () => {
  const good = () => makeAuth().auth.issueToken(ctx).token;

  it('rejects an extra part', () => {
    expect(codeOf(() => makeAuth().auth.verifyToken(`${good()}.AAAA`))).toBe('UNAUTHORIZED');
  });

  it('rejects a missing part', () => {
    const [v, p] = good().split('.') as [string, string];
    expect(codeOf(() => makeAuth().auth.verifyToken(`${v}.${p}`))).toBe('UNAUTHORIZED');
  });

  it('rejects an empty signature, payload and version', () => {
    const [v, p, s] = good().split('.') as [string, string, string];
    const { auth } = makeAuth();
    expect(codeOf(() => auth.verifyToken(`${v}.${p}.`))).toBe('UNAUTHORIZED');
    expect(codeOf(() => auth.verifyToken(`${v}..${s}`))).toBe('UNAUTHORIZED');
    expect(codeOf(() => auth.verifyToken(`.${p}.${s}`))).toBe('UNAUTHORIZED');
    expect(codeOf(() => auth.verifyToken(''))).toBe('UNAUTHORIZED');
    expect(codeOf(() => auth.verifyToken('..'))).toBe('UNAUTHORIZED');
  });

  it('rejects another version even when it is correctly signed over that version', () => {
    expect(codeOf(() => makeAuth().auth.verifyToken(signRaw(claims(), SECRET, 'v2')))).toBe(
      'UNAUTHORIZED',
    );
    expect(codeOf(() => makeAuth().auth.verifyToken(signRaw(claims(), SECRET, 'V1')))).toBe(
      'UNAUTHORIZED',
    );
    expect(codeOf(() => makeAuth().auth.verifyToken(signRaw(claims(), SECRET, 'none')))).toBe(
      'UNAUTHORIZED',
    );
  });

  it.each(['+', '/', '=', ' ', '%41', 'é'])('rejects non-base64url character %j', (ch) => {
    const [v, p, s] = good().split('.') as [string, string, string];
    const { auth } = makeAuth();
    expect(codeOf(() => auth.verifyToken(`${v}.${p}${ch}.${s}`))).toBe('UNAUTHORIZED');
    expect(codeOf(() => auth.verifyToken(`${v}.${p}.${s.slice(0, -1)}${ch}`))).toBe('UNAUTHORIZED');
  });

  it('rejects padding added to a valid part', () => {
    const [v, p, s] = good().split('.') as [string, string, string];
    expect(codeOf(() => makeAuth().auth.verifyToken(`${v}.${p}.${s}=`))).toBe('UNAUTHORIZED');
  });

  it('rejects an oversize token before doing any work', () => {
    const big = `v1.${'A'.repeat(5000)}.${'A'.repeat(43)}`;
    expect(codeOf(() => makeAuth().auth.verifyToken(big))).toBe('UNAUTHORIZED');
  });

  it('rejects non-string input', () => {
    const { auth } = makeAuth();
    for (const bad of [undefined, null, 42, {}, ['a']]) {
      expect(codeOf(() => auth.verifyToken(bad as unknown as string))).toBe('UNAUTHORIZED');
    }
  });
});

describe('verifyToken claim checks (correctly signed payloads)', () => {
  const verify = (payload: string) => makeAuth().auth.verifyToken(signRaw(payload));

  it('accepts the baseline payload (control for the cases below)', () => {
    expect(verify(claims()).bot_id).toBe(BOT);
  });

  it.each(['bot_id', 'session_id', 'token_version', 'iat', 'exp'])('rejects a missing %s', (k) => {
    const obj = JSON.parse(claims()) as Record<string, unknown>;
    delete obj[k];
    expect(codeOf(() => verify(JSON.stringify(obj)))).toBe('UNAUTHORIZED');
  });

  it('rejects an extra key', () => {
    expect(codeOf(() => verify(claims({ role: 'admin' })))).toBe('UNAUTHORIZED');
    expect(codeOf(() => verify(claims({ alg: 'none' })))).toBe('UNAUTHORIZED');
    expect(codeOf(() => verify(claims().replace(/}$/, ',"__proto__":{"x":1}}')))).toBe(
      'UNAUTHORIZED',
    );
  });

  it('rejects exp before or equal to iat', () => {
    const iat = T0_MS / 1000;
    expect(codeOf(() => verify(claims({ iat, exp: iat - 1 })))).toBe('UNAUTHORIZED');
    expect(codeOf(() => verify(claims({ iat, exp: iat })))).toBe('UNAUTHORIZED');
  });

  it('rejects wrongly typed or malformed claims', () => {
    expect(codeOf(() => verify(claims({ bot_id: 'nope' })))).toBe('UNAUTHORIZED');
    expect(codeOf(() => verify(claims({ session_id: 7 })))).toBe('UNAUTHORIZED');
    expect(codeOf(() => verify(claims({ token_version: 0 })))).toBe('UNAUTHORIZED');
    expect(codeOf(() => verify(claims({ token_version: '3' })))).toBe('UNAUTHORIZED');
    expect(codeOf(() => verify(claims({ exp: '9999999999' })))).toBe('UNAUTHORIZED');
    expect(codeOf(() => verify(claims({ iat: -1 })))).toBe('UNAUTHORIZED');
    expect(codeOf(() => verify(claims({ exp: 1.5e12 + 0.5 })))).toBe('UNAUTHORIZED');
  });

  it('rejects a signed payload that is not a JSON object', () => {
    for (const payload of ['not json', '[]', 'null', '"str"', '42', '']) {
      expect(codeOf(() => verify(payload))).toBe('UNAUTHORIZED');
    }
  });

  it('reports a signed, well-formed, past-exp token as SESSION_EXPIRED', () => {
    expect(codeOf(() => verify(claims({ iat: 1, exp: 2 })))).toBe('SESSION_EXPIRED');
  });
});

describe('bearerToken', () => {
  it('extracts the token', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('is case-insensitive on the scheme', () => {
    expect(bearerToken('bearer t')).toBe('t');
    expect(bearerToken('BEARER t')).toBe('t');
    expect(bearerToken('BeArEr t')).toBe('t');
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'Bearer',
    'Bearer ',
    'Bearer  two-spaces',
    ' Bearer t',
    'Bearer t ',
    'Bearer t u',
    'Bearer\tt',
    'Bearer\nt',
    'Basic dXNlcjpwYXNz',
    'Token t',
    'Bearert',
    't',
    `Bearer ${'a'.repeat(2000)}`,
  ])('rejects %j', (header) => {
    expect(codeOf(() => bearerToken(header))).toBe('UNAUTHORIZED');
  });
});

describe('requireVisitor', () => {
  it('sets req.visitor from the authenticated token', async () => {
    const expected: VisitorContext = ctx;
    const authenticate = vi.fn(() => Promise.resolve(expected));
    const hook = requireVisitor({ authenticate });
    const req = { headers: { authorization: 'Bearer abc' } } as never as Parameters<typeof hook>[0];
    await (hook as unknown as (r: unknown, p: unknown) => Promise<void>).call({}, req, {});
    expect(authenticate).toHaveBeenCalledWith('abc');
    expect((req as { visitor?: VisitorContext }).visitor).toEqual(expected);
  });

  it('refuses a missing header without touching authenticate', async () => {
    const authenticate = vi.fn();
    const hook = requireVisitor({ authenticate }) as unknown as (
      r: unknown,
      p: unknown,
    ) => Promise<void>;
    await expect(hook({ headers: {} }, {})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(authenticate).not.toHaveBeenCalled();
  });
});
