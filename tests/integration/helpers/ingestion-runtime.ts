import { fileURLToPath } from 'node:url';
import type { EmbeddingProvider } from '@ragbot/shared';
import type { WorkerConfig } from '../../../worker/src/lib/config.ts';
import type { Logger } from '../../../worker/src/lib/logger.ts';
import { startRuntime, type JobHandlers, type Runtime } from '../../../worker/src/runtime.ts';
import { FakeEmbeddingProvider, type FakeEmbeddingBackend } from './fake-embeddings.ts';

// In-process runtime for the ingestion tests. The handler map comes from the INDEX worker's frozen
// export `buildHandlers(config, {embeddings})` in worker/src/handlers.ts (wave 2 contract). It is loaded
// with a dynamic import, so these tests compile before that file exists and fail at run time with a clear
// message if it is missing. The signature below is the board's contract, declared here on purpose.

export interface HandlersModule {
  buildHandlers(config: WorkerConfig, deps?: { embeddings?: EmbeddingProvider }): JobHandlers;
}

export async function loadHandlersModule(): Promise<HandlersModule> {
  const file = fileURLToPath(new URL('../../../worker/src/handlers.ts', import.meta.url));
  let mod: unknown;
  try {
    mod = await import(file);
  } catch {
    throw new Error(
      "worker/src/handlers.ts could not be imported (the INDEX worker's buildHandlers export is required)",
    );
  }
  const build = (mod as Partial<HandlersModule>).buildHandlers;
  if (typeof build !== 'function') {
    throw new Error('worker/src/handlers.ts does not export buildHandlers');
  }
  return mod as HandlersModule;
}

export interface StartedRuntime {
  readonly runtime: Runtime;
  readonly provider: FakeEmbeddingProvider;
  readonly config: WorkerConfig;
}

/** Tracks the runtimes a test starts so they can be shut down together. */
export class RuntimePool {
  private readonly started: Runtime[] = [];

  /**
   * Starts a runtime with the real handlers and a fake embedding provider over `backend`.
   * `only` restricts the map to some job types (for example just `index_document`).
   */
  async start(
    config: WorkerConfig,
    backend: FakeEmbeddingBackend,
    options: { only?: readonly ('index_document' | 'cleanup')[]; log?: Logger } = {},
  ): Promise<StartedRuntime> {
    const { buildHandlers } = await loadHandlersModule();
    const provider = new FakeEmbeddingProvider(backend);
    const all = buildHandlers(config, { embeddings: provider });
    let handlers: JobHandlers = all;
    if (options.only !== undefined) {
      const picked: Record<string, unknown> = {};
      for (const t of options.only) picked[t] = (all as Record<string, unknown>)[t];
      handlers = picked as JobHandlers;
    }
    const runtime = startRuntime(
      config,
      handlers,
      options.log === undefined ? {} : { log: options.log },
    );
    this.started.push(runtime);
    return { runtime, provider, config };
  }

  async shutdownAll(): Promise<void> {
    const all = this.started.splice(0);
    await Promise.all(all.map((r) => r.shutdown().catch(() => undefined)));
  }
}
