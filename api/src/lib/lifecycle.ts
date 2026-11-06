import type { AppConfig } from './config.js';

/** Slack added to the drain bound for closing sockets and flushing logs. */
export const SHUTDOWN_MARGIN_MS = 5000;

/**
 * How long a graceful shutdown may take before the process is forced to exit. A request that was
 * already running can last up to REQUEST_TIMEOUT_MS, and a chat answer up to CHAT_DEADLINE_MS, so
 * the bound is the longer of the two plus a margin. (CHAT_DEADLINE_MS is not enforced yet; this
 * only sizes the wait.)
 */
export function forceExitDelayMs(
  config: Pick<AppConfig, 'requestTimeoutMs' | 'chatDeadlineMs'>,
): number {
  return Math.max(config.requestTimeoutMs, config.chatDeadlineMs) + SHUTDOWN_MARGIN_MS;
}

/**
 * The class name of a thrown or rejected value, and nothing else. Messages and stacks can carry
 * secrets or upstream bodies, so a crash log records the class only.
 */
export function errorClassName(value: unknown): string {
  if (value instanceof Error) {
    const name = value.constructor.name;
    return /^[A-Za-z0-9_$]{1,64}$/.test(name) ? name : 'Error';
  }
  return 'non-error value';
}
