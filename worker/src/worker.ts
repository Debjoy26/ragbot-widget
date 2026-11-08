// Worker entry point (P6-QUEUE): wires config, clients, the job runtime and the maintenance
// scheduler. Job handlers are injected: wave 2 registers `index_document` and `cleanup` in
// `JOB_HANDLERS` below. With none registered the runtime claims nothing, but maintenance still runs.
import { pathToFileURL } from 'node:url';
import { loadWorkerConfig } from './lib/config.js';
import { createDb } from './lib/db.js';
import { createLogger, errorCode } from './lib/logger.js';
import { createStorage } from './lib/storage.js';
import { startMaintenance } from './maintenance.js';
import { startRuntime, type JobHandlers } from './runtime.js';

export function workerName(): string {
  return 'ragbot-worker';
}

/** Registered job handlers. Wave 2 (INDEX) adds `index_document` and `cleanup` here. */
export const JOB_HANDLERS: JobHandlers = {};

export interface WorkerHandle {
  /** Stops claiming, drains running jobs up to SHUTDOWN_GRACE_MS, aborts the rest, stops maintenance. */
  shutdown(): Promise<void>;
}

/**
 * Starts the worker. Refuses to start when the environment carries API-only secrets or any
 * required value is missing or invalid (throws before anything else happens).
 */
export function startWorker(
  env: Record<string, string | undefined> = process.env,
  handlers: JobHandlers = JOB_HANDLERS,
): WorkerHandle {
  const config = loadWorkerConfig(env);
  const log = createLogger({ level: config.logLevel });
  const db = createDb({
    url: config.supabaseUrl,
    secretKey: config.supabaseSecretKey,
    timeoutMs: config.dbTimeoutMs,
  });
  const storage = createStorage({
    url: config.supabaseUrl,
    secretKey: config.supabaseSecretKey,
    timeoutMs: config.storageTimeoutMs,
  });

  const runtime = startRuntime(config, handlers, { db, storage, log });
  const maintenance = startMaintenance(config, { db, storage, log });
  log.info('worker_started', {
    name: workerName(),
    worker_id: config.workerId,
    handlers: Object.keys(handlers).length,
    concurrency: config.concurrency,
  });

  let stopped: Promise<void> | undefined;
  return {
    shutdown() {
      stopped ??= (async () => {
        const [result] = await Promise.all([runtime.shutdown(), maintenance.stop()]);
        log.info('worker_stopped', { drained: result.drained, aborted: result.aborted });
      })();
      return stopped;
    },
  };
}

// Run only when executed as the entry file, not when imported (tests import this module).
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    const handle = startWorker();
    const onSignal = (): void => {
      handle.shutdown().then(
        () => process.exit(0),
        (err: unknown) => {
          console.error(`worker shutdown failed (${errorCode(err)})`);
          process.exit(1);
        },
      );
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'worker failed to start');
    process.exit(1);
  }
}
