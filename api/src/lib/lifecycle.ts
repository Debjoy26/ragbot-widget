import type { AppConfig } from './config.js';

/** Slack added to the drain bound for closing sockets and flushing logs. */
export const SHUTDOWN_MARGIN_MS = 5000;

/** Longest delay Node's timers take: a larger one fires after 1 ms (TimeoutOverflowWarning). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * How long a graceful shutdown may take before the process is forced to exit. A chat answer can
 * run up to CHAT_DEADLINE_MS, and the HTTP server's request timeout (REQUEST_TIMEOUT_MS, which
 * only bounds how long the server waits to RECEIVE a request, not how long a handler runs) is
 * kept in the bound as a conservative floor, so the bound is the longer of the two plus a margin.
 * (CHAT_DEADLINE_MS is not enforced yet; this only sizes the wait.) The result never exceeds
 * MAX_TIMER_DELAY_MS, or the force-exit timer would fire at once.
 */
export function forceExitDelayMs(
  config: Pick<AppConfig, 'requestTimeoutMs' | 'chatDeadlineMs'>,
): number {
  return Math.min(
    MAX_TIMER_DELAY_MS,
    Math.max(config.requestTimeoutMs, config.chatDeadlineMs) + SHUTDOWN_MARGIN_MS,
  );
}

/**
 * Arms the forced-exit timer for a shutdown. It is unref'd so it never keeps the process alive;
 * the caller clears it if it wants to cancel. `onTimeout` is what finally exits the process.
 */
export function armForceExit(
  config: Pick<AppConfig, 'requestTimeoutMs' | 'chatDeadlineMs'>,
  onTimeout: () => void,
): NodeJS.Timeout {
  const timer = setTimeout(onTimeout, forceExitDelayMs(config));
  timer.unref();
  return timer;
}

/**
 * The class name of a thrown or rejected value, and nothing else. Messages and stacks can carry
 * secrets or upstream bodies, so a crash log records the class only.
 */
export function errorClassName(value: unknown): string {
  if (value instanceof Error) {
    // `constructor` may be missing, overwritten or a getter that throws: fall back to 'Error'.
    try {
      const ctor: unknown = (value as { constructor?: unknown }).constructor;
      const name: unknown =
        typeof ctor === 'function' || (typeof ctor === 'object' && ctor !== null)
          ? (ctor as { name?: unknown }).name
          : undefined;
      return typeof name === 'string' && /^[A-Za-z0-9_$]{1,64}$/.test(name) ? name : 'Error';
    } catch {
      return 'Error';
    }
  }
  return 'non-error value';
}
