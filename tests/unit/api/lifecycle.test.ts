import { describe, expect, it } from 'vitest';
import {
  errorClassName,
  forceExitDelayMs,
  SHUTDOWN_MARGIN_MS,
} from '../../../api/src/lib/lifecycle.ts';

// P4-D1 (B-1, A-9): shutdown bound and crash-log content.

describe('forceExitDelayMs', () => {
  it('is the longer of the request timeout and the chat deadline, plus the margin', () => {
    expect(forceExitDelayMs({ requestTimeoutMs: 30_000, chatDeadlineMs: 60_000 })).toBe(
      60_000 + SHUTDOWN_MARGIN_MS,
    );
    expect(forceExitDelayMs({ requestTimeoutMs: 90_000, chatDeadlineMs: 60_000 })).toBe(
      90_000 + SHUTDOWN_MARGIN_MS,
    );
  });

  it('has a positive margin', () => {
    expect(SHUTDOWN_MARGIN_MS).toBeGreaterThan(0);
  });
});

describe('errorClassName', () => {
  it('returns the class and nothing of the message', () => {
    class UpstreamFailure extends Error {}
    const name = errorClassName(new UpstreamFailure('Bearer secret-token-in-message'));
    expect(name).toBe('UpstreamFailure');
    expect(name).not.toContain('secret');
  });

  it('does not describe a non-Error value', () => {
    expect(errorClassName('secret string')).toBe('non-error value');
    expect(errorClassName({ message: 'secret' })).toBe('non-error value');
    expect(errorClassName(undefined)).toBe('non-error value');
  });

  it('falls back to Error for an odd constructor name', () => {
    const err = new Error('x');
    Object.defineProperty(err, 'constructor', { value: { name: 'bad name with spaces' } });
    expect(errorClassName(err)).toBe('Error');
  });
});
