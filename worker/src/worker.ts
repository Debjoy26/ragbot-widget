// P1 scaffold placeholder. Queue poller and jobs arrive in P6/P9.
import { pathToFileURL } from 'node:url';
import { assertWorkerEnv } from './env-guard.js';

export function workerName(): string {
  return 'ragbot-worker';
}

/** Worker entry point. Refuses to start when the environment carries API-only secrets. */
export function startWorker(env: Record<string, string | undefined> = process.env): void {
  assertWorkerEnv(env);
  console.log(`${workerName()} started (no jobs until P6/P9)`);
}

// Run only when executed as the entry file, not when imported (tests import this module).
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    startWorker();
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'worker failed to start');
    process.exit(1);
  }
}
