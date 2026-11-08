import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  FakeEmbeddingBackend,
  startFakeEmbeddingsServer,
  type FakeEmbeddingsServer,
} from './helpers/fake-embeddings.ts';
import {
  IngestionHarness,
  makeText,
  sleep,
  utf8,
  waitFor,
  workerEnv,
  WORKER_ENTRY,
  type TestBot,
} from './helpers/ingestion-fixtures.ts';

// P6 cases that need a REAL worker process: A3 (kill -9 mid-job, restart), C1 (configuration refusals) and
// C2 (SIGTERM drain). The process is `node worker/dist/worker.js` with a full test environment. Its
// embedding provider is `openai_compatible`, pointed at a loopback FAKE embeddings server started here; no
// real provider is ever called. Needs `npm run build` first (checked below) and the local stack. Run this
// file alone, not in parallel with other integration files: the worker claims any queued index or cleanup
// job (see helpers/ingestion-fixtures.ts). The worker's maintenance pass also runs once against the local
// database (expired-data purges only).

const TEST_TIMEOUT = 150_000;
const t = (name: string, fn: () => Promise<void>, timeout = TEST_TIMEOUT): void => {
  it(name, fn, timeout);
};

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Spawned {
  readonly child: ChildProcess;
  /** Everything written to stdout and stderr so far. */
  output(): string;
  readonly exited: Promise<Exit>;
  /** Resolves when an output line matches; rejects on timeout or early exit. */
  waitForLine(re: RegExp, timeoutMs?: number): Promise<void>;
  kill(signal: NodeJS.Signals): void;
}

const live: Spawned[] = [];

function spawnWorker(env: Record<string, string>): Spawned {
  // Only the given variables: no PATH, no HOME, nothing inherited (so no stray API-only secret either).
  const child = spawn(process.execPath, [WORKER_ENTRY], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const waiters: { re: RegExp; resolve: () => void }[] = [];
  const onData = (c: Buffer): void => {
    out += c.toString('utf8');
    for (const w of [...waiters]) {
      if (w.re.test(out)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const exited = new Promise<Exit>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
  const s: Spawned = {
    child,
    output: () => out,
    exited,
    kill: (signal) => {
      child.kill(signal);
    },
    waitForLine: (re, timeoutMs = 20_000) =>
      new Promise<void>((resolve, reject) => {
        if (re.test(out)) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for worker output ${String(re)}`));
        }, timeoutMs);
        waiters.push({
          re,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
        void exited.then(() => {
          clearTimeout(timer);
          if (!re.test(out)) reject(new Error('the worker exited before the expected output'));
        });
      }),
  };
  live.push(s);
  return s;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out: ${label}`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

beforeAll(() => {
  if (!existsSync(WORKER_ENTRY)) {
    throw new Error(
      'worker/dist/worker.js does not exist: run `npm run build` before the process tests',
    );
  }
});

async function killAll(): Promise<void> {
  for (const s of live.splice(0)) {
    s.kill('SIGKILL');
    await s.exited;
  }
}

afterEach(killAll);

// ---------------------------------------------------------------------------------------------------
// C1. Configuration refusals (no database, no network)
// ---------------------------------------------------------------------------------------------------

describe('C1 configuration refusals', () => {
  /** A complete valid environment. The key is a run-time fake; refusals happen before anything uses it. */
  const base = (): Record<string, string> =>
    workerEnv({
      apiUrl: 'http://127.0.0.1:54321',
      key: `fake-secret-${randomBytes(12).toString('hex')}`,
      model: 'fake-embed-c1',
      embeddingApiKey: `fake-${randomBytes(12).toString('hex')}`,
      embeddingBaseUrl: 'http://127.0.0.1:9',
      overrides: { LOG_LEVEL: 'info' },
    });

  async function refusal(env: Record<string, string>): Promise<{ exit: Exit; output: string }> {
    const w = spawnWorker(env);
    const exit = await withTimeout(w.exited, 20_000, 'the worker should have refused to start');
    return { exit, output: w.output() };
  }

  t(
    'C1 the worker refuses to start with VISITOR_TOKEN_SECRET set: exit 1 naming the variable, never the value',
    async () => {
      const value = `vts-${randomBytes(16).toString('hex')}`;
      const env = base();
      const { exit, output } = await refusal({ ...env, VISITOR_TOKEN_SECRET: value });
      expect(exit.code).toBe(1);
      expect(output).toContain('VISITOR_TOKEN_SECRET');
      expect(output).not.toContain(value);
      expect(output).not.toContain(env['SUPABASE_SECRET_KEY'] ?? 'x');
      expect(output).not.toContain('worker_started');
    },
  );

  for (const name of [
    'JOB_LEASE_SECONDS',
    'EXTRACT_TIMEOUT_MS',
    'EMBEDDING_BATCH_SIZE',
    'SHUTDOWN_GRACE_MS',
  ]) {
    t(
      `C1 the worker refuses to start with ${name} missing: exit 1 naming the variable`,
      async () => {
        const env = base();
        const { [name]: _removed, ...rest } = env;
        void _removed;
        const { exit, output } = await refusal(rest);
        expect(exit.code).toBe(1);
        expect(output).toContain(name);
        expect(output).not.toContain(env['SUPABASE_SECRET_KEY'] ?? 'x');
        expect(output).not.toContain('worker_started');
      },
    );
  }

  t(
    'C1 the worker refuses STUCK_RUN_THRESHOLD_SECONDS below the chat deadline plus margin: exit 1 naming the variables, never the values',
    async () => {
      // Deadline 61000 ms needs a threshold of at least 121 s; 97 is below it.
      const env = { ...base(), CHAT_DEADLINE_MS: '61000', STUCK_RUN_THRESHOLD_SECONDS: '97' };
      const { exit, output } = await refusal(env);
      expect(exit.code).toBe(1);
      expect(output).toContain('STUCK_RUN_THRESHOLD_SECONDS');
      expect(output).toContain('CHAT_DEADLINE_MS');
      expect(output).not.toMatch(/\b97\b/);
      expect(output).not.toContain('61000');
      expect(output).not.toContain('worker_started');
    },
  );
});

// ---------------------------------------------------------------------------------------------------
// A3 and C2: a real worker process against the local stack
// ---------------------------------------------------------------------------------------------------

describe('worker process against the local stack', () => {
  let h: IngestionHarness;
  let backend: FakeEmbeddingBackend;
  let server: FakeEmbeddingsServer;
  const bots: TestBot[] = [];

  beforeAll(async () => {
    h = await IngestionHarness.create();
  }, 180_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  async function fixture(): Promise<void> {
    backend = new FakeEmbeddingBackend(h.model);
    server = await startFakeEmbeddingsServer({ backend, expectedKey: h.embeddingApiKey });
  }

  afterEach(async () => {
    await killAll();
    backend.releaseAll();
    await server.close();
    for (const b of bots.splice(0)) await b.dispose();
  }, 60_000);

  const env = (overrides: Record<string, string> = {}): Record<string, string> =>
    h.env(server.baseUrl, { LOG_LEVEL: 'info', ...overrides });

  function expectCleanOutput(out: string, markers: string[]): void {
    for (const secret of [h.embeddingApiKey, h.key, ...markers]) {
      expect(out.includes(secret)).toBe(false);
    }
    expect(server.authFailures()).toBe(0);
  }

  t(
    'A3 kill -9 mid-job, then restart: the job is retried, the version ends ready, no duplicate or missing chunks',
    async () => {
      await fixture();
      const bot = await h.createBot({ indexMaxAttempts: 3 });
      bots.push(bot);
      const marker = `a3${randomBytes(4).toString('hex')}`;
      const hold = backend.holdCall(2); // batch one embeds, batch two is in flight when the process dies

      const first = spawnWorker(env({ WORKER_ID: `a3-first-${h.run}` }));
      await first.waitForLine(/"event":"worker_started"/);
      const up = await bot.register({ bytes: utf8(makeText(marker)), mediaType: 'text/plain' });
      await hold.reached;
      first.kill('SIGKILL');
      const killed = await first.exited;
      expect(killed.signal).toBe('SIGKILL');

      // The dead worker left the job running under its lease and the version mid-way: not finished, not lost.
      expect((await bot.indexJob(up.versionId)).state).toBe('running');
      expect(['extracting', 'embedding']).toContain((await bot.version(up.versionId)).status);
      hold.release();
      const corpus = await bot.corpusVersion();

      const second = spawnWorker(env({ WORKER_ID: `a3-second-${h.run}` }));
      await second.waitForLine(/"event":"worker_started"/);
      const version = await bot.waitVersion(up.versionId, ['ready', 'failed'], 90_000);
      const job = await bot.waitJobDone(up.versionId, 30_000);

      expect(version.status).toBe('ready');
      expect(job.state).toBe('succeeded');
      expect(job.attempts).toBeGreaterThanOrEqual(2);
      const idx = await bot.chunkIndexes(up.versionId);
      expect(idx.length).toBeGreaterThan(2);
      expect(idx).toEqual(range(idx.length)); // contiguous, no duplicates, none missing
      expect(await bot.corpusVersion()).toBe(corpus + 1);
      expect((await bot.document(up.documentId)).active_version_id).toBe(up.versionId);

      second.kill('SIGTERM');
      expect((await withTimeout(second.exited, 20_000, 'second worker exit')).code).toBe(0);
      expectCleanOutput(first.output() + second.output(), [marker]);
    },
  );

  t(
    'C2 SIGTERM during a job: the worker stops claiming, lets the job finish inside the grace period and exits 0',
    async () => {
      await fixture();
      const bot = await h.createBot();
      bots.push(bot);
      const marker = `c2a${randomBytes(4).toString('hex')}`;
      const marker2 = `c2b${randomBytes(4).toString('hex')}`;
      const hold = backend.holdCall(1);

      const w = spawnWorker(
        env({
          WORKER_ID: `c2-drain-${h.run}`,
          SHUTDOWN_GRACE_MS: '20000',
          WORKER_CONCURRENCY: '2',
        }),
      );
      await w.waitForLine(/"event":"worker_started"/);
      const running = await bot.register({
        bytes: utf8(makeText(marker)),
        mediaType: 'text/plain',
      });
      await hold.reached;

      w.kill('SIGTERM');
      await sleep(400);
      // Queued after the signal: a free slot exists, but a stopping worker must not claim it.
      const late = await bot.register({ bytes: utf8(makeText(marker2)), mediaType: 'text/plain' });
      await sleep(600);
      hold.release();

      const exit = await withTimeout(w.exited, 40_000, 'worker exit after SIGTERM');
      expect(exit).toEqual({ code: 0, signal: null });
      expect((await bot.indexJob(running.versionId)).state).toBe('succeeded');
      expect((await bot.version(running.versionId)).status).toBe('ready');
      const untouched = await bot.indexJob(late.versionId);
      expect(untouched.state).toBe('queued');
      expect(untouched.attempts).toBe(0);
      expect((await bot.version(late.versionId)).status).toBe('uploaded');
      expect(w.output()).toContain('worker_stopped');
      expectCleanOutput(w.output(), [marker, marker2]);
    },
  );

  t(
    'C2 SIGTERM during a job that outlasts the grace period: the worker aborts it, leaves it to lease expiry and exits 0 within the bound',
    async () => {
      await fixture();
      const bot = await h.createBot();
      bots.push(bot);
      const marker = `c2c${randomBytes(4).toString('hex')}`;
      const hold = backend.holdCall(1); // never released before the exit

      const w = spawnWorker(env({ WORKER_ID: `c2-abort-${h.run}`, SHUTDOWN_GRACE_MS: '1500' }));
      await w.waitForLine(/"event":"worker_started"/);
      const up = await bot.register({ bytes: utf8(makeText(marker)), mediaType: 'text/plain' });
      await hold.reached;

      const signalled = Date.now();
      w.kill('SIGTERM');
      // Bound: the grace period (1.5 s) plus the abort settle time (2 s) plus slack.
      const exit = await withTimeout(
        w.exited,
        12_000,
        'worker exit after SIGTERM with a stuck job',
      );
      expect(exit).toEqual({ code: 0, signal: null });
      expect(Date.now() - signalled).toBeLessThan(12_000);

      // Not completed, not failed: the job is left running under its lease for another worker.
      expect((await bot.indexJob(up.versionId)).state).toBe('running');
      expect((await bot.version(up.versionId)).status).not.toBe('ready');
      expect((await bot.version(up.versionId)).status).not.toBe('failed');
      expect(w.output()).toContain('worker_stopped');
      expectCleanOutput(w.output(), [marker]);

      // Another worker picks the job up after the lease and finishes it.
      hold.release();
      const next = spawnWorker(env({ WORKER_ID: `c2-after-${h.run}` }));
      await next.waitForLine(/"event":"worker_started"/);
      await waitFor(
        'version to finish',
        async () => (await bot.version(up.versionId)).status === 'ready',
        60_000,
        250,
      );
      next.kill('SIGTERM');
      expect((await withTimeout(next.exited, 20_000, 'second worker exit')).code).toBe(0);
    },
  );
});
