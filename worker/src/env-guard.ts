// Worker start-up guard (P3-D5 G-20). No provider logic here.
// The visitor-token secret (including rotated copies such as VISITOR_TOKEN_SECRET_PREVIOUS) and the
// Turnstile secret belong to the API only. If one reaches the worker's environment (for example
// through a shared .env), the worker refuses to start rather than carry it.

/** Variables the worker must never receive. Names only; values are never read or printed. */
export const WORKER_FORBIDDEN_ENV: readonly string[] = [
  'VISITOR_TOKEN_SECRET',
  'TURNSTILE_SECRET_KEY',
];

/** Any variable whose name starts with one of these is also forbidden. */
export const WORKER_FORBIDDEN_ENV_PREFIXES: readonly string[] = ['VISITOR_TOKEN_SECRET_'];

function isForbidden(name: string): boolean {
  return (
    WORKER_FORBIDDEN_ENV.includes(name) ||
    WORKER_FORBIDDEN_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** Throws if any forbidden variable is present in `env`, even with an empty value. */
export function assertWorkerEnv(env: Record<string, string | undefined> = process.env): void {
  const present = Object.keys(env).filter(isForbidden);
  if (present.length > 0) {
    throw new Error(
      `worker refuses to start: ${present.join(', ')} must not be set in the worker environment`,
    );
  }
}
