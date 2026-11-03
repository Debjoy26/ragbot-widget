import { defineConfig } from '@playwright/test';

// E2E suites arrive in P8. Browsers are installed separately (npx playwright install).
export default defineConfig({
  testDir: './tests/e2e',
  forbidOnly: !!process.env['CI'],
  reporter: 'list',
});
