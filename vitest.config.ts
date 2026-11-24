import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Array form, longest prefix first: '@ragbot/shared/ai' must not be caught by '@ragbot/shared'.
const alias = [
  {
    find: /^@ragbot\/shared\/server\/(.+)$/,
    replacement: fileURLToPath(new URL('./shared/src/server/$1.ts', import.meta.url)),
  },
  {
    find: /^@ragbot\/shared\/ai$/,
    replacement: fileURLToPath(new URL('./shared/src/ai/index.ts', import.meta.url)),
  },
  {
    find: /^@ragbot\/shared$/,
    replacement: fileURLToPath(new URL('./shared/src/index.ts', import.meta.url)),
  },
];

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          // One file at a time: the ingestion tests run a worker that claims every queued job, and
          // other files queue jobs of their own. All files share one local database.
          fileParallelism: false,
        },
      },
      {
        resolve: { alias },
        test: {
          // P11 live-provider evaluation. Opt-in only: without EVAL_LIVE=1 every case
          // skips and nothing is spent. Never run by default `npm test` gates.
          name: 'evaluation',
          include: ['tests/evaluation/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 600_000,
        },
      },
    ],
  },
});
