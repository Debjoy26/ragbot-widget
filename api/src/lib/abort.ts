/**
 * Rejects when `signal` aborts, even if `promise` never settles (a provider that ignores it).
 *
 * The caller owns `promise`, but this function may stop looking at it (an early abort), and a
 * rejection nobody is listening to would be an unhandled rejection, which main.ts treats as fatal.
 * So a no-op handler is attached on every path; the returned promise still carries the real error
 * whenever the promise settles first.
 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => undefined);
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
