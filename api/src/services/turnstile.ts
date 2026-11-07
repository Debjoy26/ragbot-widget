// Cloudflare Turnstile server-side verification (ADR 0010, TECH_SPECS section 8). P5-B.
//
// Fail closed: the answer is `true` only when Cloudflare replied 200 with a JSON object whose
// `success` is exactly `true`, whose `hostname` is one of the allowed hosts and whose `action` is
// the one the widget requests (a token minted for another site or another action is refused). A
// timeout, network error, redirect, non-200, oversized or malformed body, or anything else is `false`. The token and the secret are never logged and never placed in
// an error: this module does not log at all.

import { UNKNOWN_IP } from '../lib/client-ip.js';

/** Cloudflare's siteverify endpoint. */
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** A siteverify answer is a few hundred bytes. Anything larger is not trusted. */
const MAX_RESPONSE_CHARS = 16_384;
const MAX_TOKEN_CHARS = 4096;

/** The Turnstile action of a session-create challenge. Set by the widget, required back in the response. */
export const TURNSTILE_SESSION_ACTION = 'session_create';

export interface TurnstileVerifier {
  /** True only for an explicit `success: true`. Never throws. */
  verify(token: string, clientIp: string): Promise<boolean>;
}

export interface CreateTurnstileVerifierOptions {
  /** Turnstile secret key. Required. */
  secret: string;
  /**
   * Hostnames (no scheme or port) a valid challenge may report, derived from ALLOWED_ORIGINS.
   * Required and non-empty: with none, every challenge would be refused.
   */
  allowedHostnames: readonly string[];
  /** Bound on the whole call, in milliseconds. A positive integer; required, no default. */
  timeoutMs: number;
  /** Injected for tests only (a labelled fake). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const lower = (s: string): string => s.toLowerCase();

export function createTurnstileVerifier(
  options: CreateTurnstileVerifierOptions,
): TurnstileVerifier {
  const { secret, timeoutMs } = options;
  const hostnames = new Set(
    Array.isArray(options.allowedHostnames)
      ? options.allowedHostnames.filter((h) => typeof h === 'string' && h !== '').map(lower)
      : [],
  );
  if (hostnames.size === 0) {
    throw new TypeError('turnstile allowed hostnames are required');
  }
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
        // No `action` in the request: siteverify ignores it. The widget must render Turnstile with
        // action `session_create` (TURNSTILE_SESSION_ACTION); that is enforced only by the check on
        // the response's `action` below.
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
        if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
        const { success, hostname, action } = body as Record<string, unknown>;
        return (
          success === true &&
          typeof hostname === 'string' &&
          hostnames.has(lower(hostname)) &&
          action === TURNSTILE_SESSION_ACTION
        );
      } catch {
        return false;
      }
    },
  };
}
