import { describe, expect, it } from 'vitest';
import {
  assertWorkerEnv,
  WORKER_FORBIDDEN_ENV,
  WORKER_FORBIDDEN_ENV_PREFIXES,
} from '../../worker/src/env-guard.ts';
import { startWorker } from '../../worker/src/worker.ts';

// P3-D5 G-20: the worker must never run with the API's visitor-token secret in its environment.
// Fake values only; nothing here reads the real process environment.
describe('worker environment guard', () => {
  it('forbids VISITOR_TOKEN_SECRET', () => {
    expect(WORKER_FORBIDDEN_ENV).toContain('VISITOR_TOKEN_SECRET');
  });

  it('forbids TURNSTILE_SECRET_KEY and the VISITOR_TOKEN_SECRET_ prefix', () => {
    expect(WORKER_FORBIDDEN_ENV).toContain('TURNSTILE_SECRET_KEY');
    expect(WORKER_FORBIDDEN_ENV_PREFIXES).toContain('VISITOR_TOKEN_SECRET_');
  });

  it.each([
    'TURNSTILE_SECRET_KEY',
    'RATE_LIMIT_KEY_SECRET',
    'VISITOR_TOKEN_SECRET_PREVIOUS',
    'VISITOR_TOKEN_SECRET_2',
  ])('refuses %s by name, without echoing the value', (name) => {
    const fakeValue = 'fake-test-value-not-a-secret';
    let message = '';
    try {
      assertWorkerEnv({ LOG_LEVEL: 'info', [name]: fakeValue });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(name);
    expect(message).not.toContain(fakeValue);
  });

  it('does not refuse near-miss names', () => {
    expect(() =>
      assertWorkerEnv({
        VISITOR_TOKEN_SECRETX: 'x',
        MY_VISITOR_TOKEN_SECRET: 'x',
        VISITOR_TOKEN: 'x',
        TURNSTILE_SITE_KEY: 'x',
        TURNSTILE_SECRET: 'x',
      }),
    ).not.toThrow();
  });

  it('allows an environment without VISITOR_TOKEN_SECRET', () => {
    expect(() =>
      assertWorkerEnv({ LOG_LEVEL: 'info', SUPABASE_URL: 'http://fake.invalid' }),
    ).not.toThrow();
    expect(() => assertWorkerEnv({})).not.toThrow();
  });

  it('refuses when VISITOR_TOKEN_SECRET is set, without echoing the value', () => {
    const fakeValue = 'fake-test-value-not-a-secret';
    let message = '';
    try {
      assertWorkerEnv({ VISITOR_TOKEN_SECRET: fakeValue });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('VISITOR_TOKEN_SECRET');
    expect(message).not.toContain(fakeValue);
  });

  it('refuses when VISITOR_TOKEN_SECRET is set to an empty string', () => {
    expect(() => assertWorkerEnv({ VISITOR_TOKEN_SECRET: '' })).toThrow(/VISITOR_TOKEN_SECRET/);
  });

  it('startWorker applies the guard', () => {
    expect(() => startWorker({ VISITOR_TOKEN_SECRET: 'fake-test-value' })).toThrow(
      /VISITOR_TOKEN_SECRET/,
    );
  });
});
