import { describe, expect, it, vi } from 'vitest';
import { createVisitorAuth, VisitorAuthError } from '../../../api/src/services/auth.ts';

// P4-T2 unit tests for authenticate() with a STUBBED database (labelled fake; the real rows are
// exercised in tests/integration/visitor-auth.test.ts).

const SECRET = 'TEST-ONLY-secret-0123456789-abcdefghijklmnop';
const BOT = '11111111-1111-4111-8111-111111111111';
const OTHER_BOT = '33333333-3333-4333-8333-333333333333';
const SESSION = '22222222-2222-4222-8222-222222222222';
const T0_MS = 1_800_000_000_000;
const TTL = 900;
const ctx = { bot_id: BOT, session_id: SESSION, token_version: 2 };

interface Row {
  token_version: number;
  expires_at: string;
  revoked_at: string | null;
}

const liveRow = (over: Partial<Row> = {}): Row => ({
  token_version: 2,
  expires_at: new Date(T0_MS + 3600_000).toISOString(),
  revoked_at: null,
  ...over,
});

function setup(result: () => unknown, clock = { ms: T0_MS }) {
  const selectOne = vi.fn(() => Promise.resolve().then(result));
  const auth = createVisitorAuth({
    secret: SECRET,
    ttlSeconds: TTL,
    db: { selectOne: selectOne as never },
    now: () => clock.ms,
  });
  return { auth, selectOne, clock, token: auth.issueToken(ctx).token };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(VisitorAuthError);
    return (err as VisitorAuthError).code;
  }
  throw new Error('expected a VisitorAuthError');
}

describe('authenticate (stubbed db)', () => {
  it('passes a live session and returns the context', async () => {
    const { auth, token } = setup(() => liveRow());
    await expect(auth.authenticate(token)).resolves.toEqual(ctx);
  });

  it('looks the session up by id AND bot_id taken from the claims', async () => {
    const { auth, selectOne, token } = setup(() => liveRow());
    await auth.authenticate(token);
    expect(selectOne).toHaveBeenCalledTimes(1);
    expect(selectOne).toHaveBeenCalledWith('visitor_sessions', { id: SESSION, bot_id: BOT }, [
      'token_version',
      'expires_at',
      'revoked_at',
    ]);
  });

  it('accepts a matching expectedBotId', async () => {
    const { auth, token } = setup(() => liveRow());
    await expect(auth.authenticate(token, BOT)).resolves.toEqual(ctx);
  });

  it('refuses a different expectedBotId with FORBIDDEN', async () => {
    const { auth, token } = setup(() => liveRow());
    expect(await codeOf(auth.authenticate(token, OTHER_BOT))).toBe('FORBIDDEN');
  });

  it('refuses a missing row (also the wrong-bot case: no row for this id and bot) as UNAUTHORIZED', async () => {
    const { auth, token } = setup(() => null);
    expect(await codeOf(auth.authenticate(token))).toBe('UNAUTHORIZED');
  });

  it('refuses a revoked session as UNAUTHORIZED even though the token is still valid', async () => {
    const { auth, token } = setup(() => liveRow({ revoked_at: new Date(T0_MS).toISOString() }));
    expect(await codeOf(auth.authenticate(token))).toBe('UNAUTHORIZED');
  });

  it.each([1, 3, 99])('refuses a token_version mismatch (row has %i, token has 2)', async (v) => {
    const { auth, token } = setup(() => liveRow({ token_version: v }));
    expect(await codeOf(auth.authenticate(token))).toBe('UNAUTHORIZED');
  });

  it('refuses a session past its expires_at as SESSION_EXPIRED', async () => {
    const { auth, token } = setup(() =>
      liveRow({ expires_at: new Date(T0_MS - 1000).toISOString() }),
    );
    expect(await codeOf(auth.authenticate(token))).toBe('SESSION_EXPIRED');
  });

  it('treats the exact expires_at instant as expired', async () => {
    const { auth, token } = setup(() => liveRow({ expires_at: new Date(T0_MS).toISOString() }));
    expect(await codeOf(auth.authenticate(token))).toBe('SESSION_EXPIRED');
  });

  it('parses a PostgREST-style timestamptz', async () => {
    const { auth, token } = setup(() =>
      liveRow({ expires_at: '2027-06-01T00:00:00.123456+00:00' }),
    );
    await expect(auth.authenticate(token)).resolves.toEqual(ctx);
  });

  it('checks the row clock at call time, after the token itself is still valid', async () => {
    const clock = { ms: T0_MS };
    const { auth, token } = setup(
      () => liveRow({ expires_at: new Date(T0_MS + 5_000).toISOString() }),
      clock,
    );
    await expect(auth.authenticate(token)).resolves.toEqual(ctx);
    clock.ms = T0_MS + 5_000;
    expect(await codeOf(auth.authenticate(token))).toBe('SESSION_EXPIRED');
  });

  it('fails closed as PROVIDER_UNAVAILABLE when the database throws', async () => {
    const { auth, token } = setup(() => {
      throw new Error('boom');
    });
    expect(await codeOf(auth.authenticate(token))).toBe('PROVIDER_UNAVAILABLE');
  });

  it.each([
    ['an empty object', {}],
    ['a string token_version', liveRow({ token_version: '2' as never })],
    ['a missing expires_at', { token_version: 2, revoked_at: null }],
    ['an unparseable expires_at', liveRow({ expires_at: 'not a date' })],
    [
      'an undefined revoked_at',
      { token_version: 2, expires_at: new Date(T0_MS + 1e6).toISOString() },
    ],
    ['a non-object row', 'row'],
  ])('fails closed on a malformed row: %s', async (_name, row) => {
    const { auth, token } = setup(() => row);
    expect(await codeOf(auth.authenticate(token))).toBe('PROVIDER_UNAVAILABLE');
  });

  it('does not reach the database for a forged or expired token', async () => {
    const { auth, selectOne, clock, token } = setup(() => liveRow());
    expect(await codeOf(auth.authenticate('v1.AAAA.BBBB'))).toBe('UNAUTHORIZED');
    clock.ms = T0_MS + (TTL + 1) * 1000;
    expect(await codeOf(auth.authenticate(token))).toBe('SESSION_EXPIRED');
    expect(selectOne).not.toHaveBeenCalled();
  });

  it('never lets a database fault outrank a bad signature', async () => {
    const { auth } = setup(() => {
      throw new Error('boom');
    });
    expect(await codeOf(auth.authenticate('garbage'))).toBe('UNAUTHORIZED');
  });
});
