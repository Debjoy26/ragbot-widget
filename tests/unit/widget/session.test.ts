// P8 widget unit tests: session lifecycle (UI_SCHEMA §7, ADR 0009).
import { describe, expect, it, vi } from 'vitest';
import {
  clearSession,
  createSession,
  isSessionExpired,
  readSession,
  sessionStorageKey,
  writeSession,
} from '../../../widget/src/session.ts';

function memoryStorage(): {
  readonly store: Map<string, string>;
  readonly storage: {
    getItem: (k: string) => string | null;
    setItem: (k: string, v: string) => void;
    removeItem: (k: string) => void;
  };
} {
  const store = new Map<string, string>();
  return {
    store,
    storage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
}

describe('session expiry', () => {
  it('treats missing, malformed and expired records as expired', () => {
    expect(isSessionExpired(null, Date.now())).toBe(true);
    expect(
      isSessionExpired(
        { token: '', expiresAt: new Date(Date.now() + 60000).toISOString() },
        Date.now(),
      ),
    ).toBe(true);
    expect(isSessionExpired({ token: 't', expiresAt: 'not-a-date' }, Date.now())).toBe(true);
    expect(
      isSessionExpired(
        { token: 't', expiresAt: new Date(Date.now() - 1000).toISOString() },
        Date.now(),
      ),
    ).toBe(true);
    expect(
      isSessionExpired(
        { token: 't', expiresAt: new Date(Date.now() + 60000).toISOString() },
        Date.now(),
      ),
    ).toBe(false);
  });

  it('fails closed on a non-finite clock', () => {
    expect(
      isSessionExpired(
        { token: 't', expiresAt: new Date(Date.now() + 60000).toISOString() },
        Number.NaN,
      ),
    ).toBe(true);
  });
});

describe('session storage', () => {
  it('round-trips a valid session under the bot-scoped key', () => {
    const { storage } = memoryStorage();
    const record = { token: 'tok', expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() };
    writeSession(storage, 'website-support', record);
    expect(readSession(storage, 'website-support', Date.now())).toEqual(record);
    expect(sessionStorageKey('website-support')).toBe('ragbot.session.website-support');
  });

  it('ignores corrupt JSON and clears on reset', () => {
    const { store, storage } = memoryStorage();
    store.set(sessionStorageKey('website-support'), '{broken');
    expect(readSession(storage, 'website-support', Date.now())).toBe(null);
    writeSession(storage, 'website-support', {
      token: 't',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    clearSession(storage, 'website-support');
    expect(readSession(storage, 'website-support', Date.now())).toBe(null);
  });
});

describe('createSession', () => {
  it('reuses a live session without a network call', async () => {
    const { storage } = memoryStorage();
    const record = { token: 'live', expiresAt: new Date(Date.now() + 60000).toISOString() };
    writeSession(storage, 'website-support', record);
    const fetchFn = vi.fn(async () => {
      throw new Error('must not fetch');
    });
    const result = await createSession({
      apiUrl: 'https://api.example.com',
      botSlug: 'website-support',
      fetchFn,
      storage,
      nowMs: Date.now(),
    });
    expect(result).toEqual(record);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('posts bot_slug and stores the returned token', async () => {
    const { storage } = memoryStorage();
    const fetchFn = vi.fn(async (_url: string, _init: { body: string }) => ({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'new-token',
        expires_at: new Date(Date.now() + 60000).toISOString(),
      }),
    }));
    const result = await createSession({
      apiUrl: 'https://api.example.com/',
      botSlug: 'website-support',
      fetchFn,
      storage,
      nowMs: Date.now(),
    });
    expect(result.token).toBe('new-token');
    expect(fetchFn).toHaveBeenCalledOnce();
    const init = (fetchFn.mock.calls[0] as readonly unknown[])[1] as { readonly body: string };
    expect(JSON.parse(init.body) as unknown).toMatchObject({ bot_slug: 'website-support' });
    expect(readSession(storage, 'website-support', Date.now())?.token).toBe('new-token');
  });

  it('maps 429/403 to stable code words', async () => {
    const { storage } = memoryStorage();
    const limited = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    await expect(
      createSession({
        apiUrl: 'https://api.example.com',
        botSlug: 'website-support',
        fetchFn: limited,
        storage,
        nowMs: Date.now(),
      }),
    ).rejects.toThrow('RATE_LIMITED');
    const forbidden = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    await expect(
      createSession({
        apiUrl: 'https://api.example.com',
        botSlug: 'website-support',
        fetchFn: forbidden,
        storage,
        nowMs: Date.now(),
      }),
    ).rejects.toThrow('FORBIDDEN');
  });
});
