// Synthetic fetch/storage regression; no backend or provider calls.
import { describe, expect, it, vi } from 'vitest';
import { createSession } from '../../../widget/src/session.ts';

function args(signal: AbortSignal) {
  return {
    apiUrl: 'https://api.invalid',
    botSlug: 'challenge',
    nowMs: Date.now(),
    signal,
    storage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    getChallengeToken: vi.fn(async () => crypto.randomUUID()),
  };
}

describe('session creation cancellation', () => {
  it('an already aborted attempt starts no challenge or POST', async () => {
    const stop = new AbortController();
    stop.abort();
    const input = args(stop.signal);
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await expect(createSession({ ...input, fetchFn })).rejects.toThrow('SESSION_CANCELLED');
    expect(input.getChallengeToken).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('abort during challenge acquisition prevents the POST', async () => {
    const stop = new AbortController();
    const input = args(stop.signal);
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    input.getChallengeToken.mockImplementation(async () => {
      stop.abort();
      return crypto.randomUUID();
    });
    await expect(createSession({ ...input, fetchFn })).rejects.toThrow('SESSION_CANCELLED');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('passes the signal to fetch and never stores a late cancelled response', async () => {
    const stop = new AbortController();
    const input = args(stop.signal);
    let passedSignal: AbortSignal | undefined;
    const fetchFn = vi.fn(
      async (_url: string, init: { readonly signal?: AbortSignal | undefined }) => {
        passedSignal = init.signal;
        return {
          ok: true,
          status: 200,
          json: async () => {
            stop.abort();
            return {
              token: crypto.randomUUID(),
              expires_at: new Date(Date.now() + 60000).toISOString(),
            };
          },
        };
      },
    );
    let failure: string | undefined;
    try {
      await createSession({ ...input, fetchFn });
    } catch (error) {
      failure = error instanceof Error ? error.message : 'unknown';
    }
    expect(failure).toBe('SESSION_CANCELLED');
    expect(passedSignal).toBe(stop.signal);
    expect(input.storage.setItem).not.toHaveBeenCalled();
  });
});
