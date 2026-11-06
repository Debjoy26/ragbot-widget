import { describe, expect, it, vi } from 'vitest';
import {
  armForceExit,
  errorClassName,
  forceExitDelayMs,
  MAX_TIMER_DELAY_MS,
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

  it("never exceeds Node's 32-bit timer limit", () => {
    expect(MAX_TIMER_DELAY_MS).toBe(2_147_483_647);
    const max = 2_147_483_647;
    expect(forceExitDelayMs({ requestTimeoutMs: max, chatDeadlineMs: max })).toBe(max);
    expect(forceExitDelayMs({ requestTimeoutMs: max, chatDeadlineMs: 1 })).toBe(max);
    expect(forceExitDelayMs({ requestTimeoutMs: 1, chatDeadlineMs: max })).toBe(max);
    expect(forceExitDelayMs({ requestTimeoutMs: max - 1, chatDeadlineMs: max - 1 })).toBe(max);
  });

  it('leaves a value just under the limit unclamped', () => {
    const under = 2_147_483_647 - SHUTDOWN_MARGIN_MS;
    expect(forceExitDelayMs({ requestTimeoutMs: under, chatDeadlineMs: 1 })).toBe(2_147_483_647);
    expect(forceExitDelayMs({ requestTimeoutMs: under - 1, chatDeadlineMs: 1 })).toBe(
      2_147_483_646,
    );
  });
});

describe('armForceExit (what SIGTERM arms)', () => {
  it('does not fire at once when both timeouts are at the maximum', async () => {
    const max = 2_147_483_647;
    const exit = vi.fn();
    const warnings: unknown[] = [];
    const onWarning = (w: unknown) => warnings.push(w);
    process.on('warning', onWarning);
    const timer = armForceExit({ requestTimeoutMs: max, chatDeadlineMs: max }, exit);
    try {
      // An overflowing delay would be reset to 1 ms by Node and fire within this wait.
      await new Promise((r) => setTimeout(r, 100));
      expect(exit).not.toHaveBeenCalled();
      expect(warnings).toEqual([]);
    } finally {
      clearTimeout(timer);
      process.off('warning', onWarning);
    }
  });

  it("is unref'd so it cannot keep the process alive", () => {
    const timer = armForceExit({ requestTimeoutMs: 1000, chatDeadlineMs: 1000 }, () => undefined);
    try {
      expect(timer.hasRef()).toBe(false);
    } finally {
      clearTimeout(timer);
    }
  });

  it('fires after the computed delay', () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      armForceExit({ requestTimeoutMs: 1000, chatDeadlineMs: 2000 }, exit);
      vi.advanceTimersByTime(2000 + SHUTDOWN_MARGIN_MS - 1);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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

  it('does not throw for an error with no usable constructor', () => {
    const cases: Error[] = [];
    const undef = new Error('x');
    Object.defineProperty(undef, 'constructor', { value: undefined });
    cases.push(undef);
    const nul = new Error('x');
    Object.defineProperty(nul, 'constructor', { value: null });
    cases.push(nul);
    const noName = new Error('x');
    Object.defineProperty(noName, 'constructor', { value: {} });
    cases.push(noName);
    const numName = new Error('x');
    Object.defineProperty(numName, 'constructor', { value: { name: 42 } });
    cases.push(numName);
    const throwing = new Error('x');
    Object.defineProperty(throwing, 'constructor', {
      get() {
        throw new Error('boom');
      },
    });
    cases.push(throwing);
    const bare = Object.create(Error.prototype) as Error;
    Object.setPrototypeOf(
      bare,
      Object.create(Error.prototype, { constructor: { value: undefined } }),
    );
    cases.push(bare);
    for (const err of cases) expect(errorClassName(err)).toBe('Error');
  });
});
