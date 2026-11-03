import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const alias = {
  '@ragbot/shared': fileURLToPath(new URL('./shared/src/index.ts', import.meta.url)),
};

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      {
        resolve: { alias },
        test: { name: 'integration', include: ['tests/integration/**/*.test.ts'] },
      },
    ],
  },
});
