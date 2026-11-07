// Cloudflare Turnstile server-side verification (ADR 0010, TECH_SPECS section 8). P5-B.
//
// Fail closed: the answer is `true` only when Cloudflare replied 200 with a JSON object whose
// `success` is exactly `true`. A timeout, network error, redirect, non-200, oversized or malformed
// body, or anything else is `false`. The token and the secret are never logged and never placed in
// an error: this module does not log at all.

import { UNKNOWN_IP } from '../lib/client-ip.js';

/** Cloudflare's siteverify endpoint. */
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** A siteverify answer is a few hundred bytes. Anything larger is not trusted. */
const MAX_RESPONSE_CHARS = 16_384;
const MAX_TOKEN_CHARS = 4096;

export interface TurnstileVerifier {
  /** True only for an explicit `success: true`. Never throws. */
  verify(token: string, clientIp: string): Promise<boolean>;
}

export interface CreateTurnstileVerifierOptions {
  /** Turnstile secret key. Required. */
  secret: string;
  /** Bound on the whole call, in milliseconds. A positive integer; required, no default. */
  timeoutMs: number;
  /** Injected for tests only (a labelled fake). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export function createTurnstileVerifier(
  options: CreateTurnstileVerifierOptions,
): TurnstileVerifier {
  const { secret, timeoutMs } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError('turnstile secret is required');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('turnstile timeout must be a positive integer (milliseconds)');
  }

  return {
    async verify(token: string, clientIp: string): Promise<boolean> {
      if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_CHARS) {
        return false;
      }
      try {
        const form = new URLSearchParams({ secret, response: token });
        // The address is optional for Cloudflare; a hint we could not determine is left out.
        if (typeof clientIp === 'string' && clientIp !== '' && clientIp !== UNKNOWN_IP) {
          form.set('remoteip', clientIp);
        }
        const res = await fetchImpl(TURNSTILE_SITEVERIFY_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: form.toString(),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status !== 200) {
          await res.body?.cancel().catch(() => undefined);
          return false;
        }
        const text = await res.text();
        if (text.length === 0 || text.length > MAX_RESPONSE_CHARS) return false;
        const body: unknown = JSON.parse(text);
        return (
          typeof body === 'object' &&
          body !== null &&
          !Array.isArray(body) &&
          (body as { success?: unknown }).success === true
        );
      } catch {
        return false;
      }
    },
  };
}
