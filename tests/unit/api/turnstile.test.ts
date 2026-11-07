import { describe, expect, it, vi } from 'vitest';
import {
  createTurnstileVerifier,
  TURNSTILE_SITEVERIFY_URL,
} from '../../../api/src/services/turnstile.ts';

// FAKE fetch: no network call is made. The secret and token are labelled test-only values.
const SECRET = 'TEST-ONLY-turnstile-secret-AAAA';
const TOKEN = 'TEST-ONLY-challenge-token-BBBB';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return Promise.resolve(respond(call));
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

const reply = (body: unknown, status = 200): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

function verifier(respond: (call: Call) => Response | Promise<Response>, timeoutMs = 1000) {
  const f = fakeFetch(respond);
  return {
    calls: f.calls,
    v: createTurnstileVerifier({ secret: SECRET, timeoutMs, fetchImpl: f.impl }),
  };
}

describe('createTurnstileVerifier', () => {
  it('posts the secret, token and client IP to the siteverify endpoint', async () => {
    const { v, calls } = verifier(() => reply({ success: true }));
    expect(await v.verify(TOKEN, '203.0.113.9')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(TURNSTILE_SITEVERIFY_URL);
    expect(TURNSTILE_SITEVERIFY_URL).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    );
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.redirect).toBe('error');
    const form = new URLSearchParams(String(calls[0]?.init.body));
    expect(form.get('secret')).toBe(SECRET);
    expect(form.get('response')).toBe(TOKEN);
    expect(form.get('remoteip')).toBe('203.0.113.9');
  });

  it('leaves remoteip out when the address is unknown', async () => {
    const { v, calls } = verifier(() => reply({ success: true }));
    await v.verify(TOKEN, 'unknown');
    expect(new URLSearchParams(String(calls[0]?.init.body)).has('remoteip')).toBe(false);
  });

  it('is true only for an explicit success: true', async () => {
    expect(
      await verifier(() => reply({ success: true, 'error-codes': [] })).v.verify(TOKEN, '1.1.1.1'),
    ).toBe(true);
    expect(await verifier(() => reply({ success: false })).v.verify(TOKEN, '1.1.1.1')).toBe(false);
  });

  it.each([
    ['success as a string', '{"success":"true"}'],
    ['success as 1', '{"success":1}'],
    ['success missing', '{"ok":true}'],
    ['not JSON', 'success=true'],
    ['empty body', ''],
    ['an array', '[{"success":true}]'],
    ['null', 'null'],
    ['a bare true', 'true'],
    ['oversized', `{"success":true,"x":"${'a'.repeat(20_000)}"}`],
  ])('is false for a malformed body: %s', async (_label, body) => {
    expect(await verifier(() => reply(body)).v.verify(TOKEN, '1.1.1.1')).toBe(false);
  });

  it.each([201, 204, 400, 403, 429, 500, 503])(
    'is false for HTTP %i even with success: true',
    async (status) => {
      const { v } = verifier(() => reply({ success: true }, status));
      expect(await v.verify(TOKEN, '1.1.1.1')).toBe(false);
    },
  );

  it('is false on a network error', async () => {
    const { v } = verifier(() => {
      throw new TypeError('fetch failed');
    });
    expect(await v.verify(TOKEN, '1.1.1.1')).toBe(false);
  });

  it('is false, and returns, when the call times out', async () => {
    const { v } = verifier(
      (call) =>
        new Promise((_resolve, reject) => {
          (call.init.signal as AbortSignal).addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
      30,
    );
    expect(await v.verify(TOKEN, '1.1.1.1')).toBe(false);
  });

  it('does not call out for an empty or oversized token', async () => {
    const { v, calls } = verifier(() => reply({ success: true }));
    expect(await v.verify('', '1.1.1.1')).toBe(false);
    expect(await v.verify('x'.repeat(5000), '1.1.1.1')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('fails closed on missing configuration', () => {
    expect(() => createTurnstileVerifier({ secret: '', timeoutMs: 1000 })).toThrow(TypeError);
    expect(() => createTurnstileVerifier({ secret: SECRET, timeoutMs: 0 })).toThrow(TypeError);
    expect(() => createTurnstileVerifier({ secret: SECRET, timeoutMs: 1.5 })).toThrow(TypeError);
    expect(() =>
      createTurnstileVerifier({ secret: SECRET, timeoutMs: undefined as unknown as number }),
    ).toThrow(TypeError);
  });

  it('writes nothing to stdout or stderr, so no token can reach a log', async () => {
    const out: string[] = [];
    const sink = (chunk: unknown): boolean => {
      out.push(String(chunk));
      return true;
    };
    const o = vi.spyOn(process.stdout, 'write').mockImplementation(sink);
    const e = vi.spyOn(process.stderr, 'write').mockImplementation(sink);
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi
        .spyOn(console, m)
        .mockImplementation((...args: unknown[]) => void out.push(args.join(' '))),
    );
    try {
      await verifier(() => reply({ success: false })).v.verify(TOKEN, '1.1.1.1');
      await verifier(() => reply('garbage', 500)).v.verify(TOKEN, '1.1.1.1');
      await verifier(() => {
        throw new Error(`boom ${TOKEN}`);
      }).v.verify(TOKEN, '1.1.1.1');
    } finally {
      o.mockRestore();
      e.mockRestore();
      for (const s of spies) s.mockRestore();
    }
    expect(out.join('')).not.toContain(TOKEN);
    expect(out.join('')).not.toContain(SECRET);
  });
});
