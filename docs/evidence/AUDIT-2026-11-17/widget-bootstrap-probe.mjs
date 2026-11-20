// Offline diagnostic: actual widget source, bundled in memory; no real services.
/* global document */
import { build } from 'esbuild';
import { chromium } from 'playwright';

const result = await build({
  entryPoints: ['widget/src/widget.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
});
const browser = await chromium.launch({ headless: true });
try {
  for (const deferred of [false, true]) {
    const page = await browser.newPage();
    let configRequests = 0;
    await page.route('https://audit.invalid/**', async (route) => {
      const url = route.request().url();
      if (url.endsWith('/widget.js')) {
        await route.fulfill({
          contentType: 'application/javascript',
          body: result.outputFiles[0].text,
        });
      } else if (url.includes('/rest/')) {
        configRequests++;
        await route.fulfill({ contentType: 'application/json', body: '[]' });
      } else {
        await route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><body>
          <script src="/widget.js" data-bot-slug="audit" data-api-url="https://audit.invalid"
          data-supabase-url="https://audit.invalid" data-supabase-publishable-key="sb_publishable_TEST_KEY_FOR_TESTS"
          ${deferred ? 'defer' : ''}></script></body></html>`,
        });
      }
    });
    await page.goto('https://audit.invalid/');
    await page.waitForLoadState('networkidle');
    console.log(
      JSON.stringify({
        deferred,
        configRequests,
        ...(await page.evaluate(() => ({
          host: document.querySelector('ragbot-widget') !== null,
          shadow:
            document.querySelector('ragbot-widget')?.shadowRoot !== null &&
            document.querySelector('ragbot-widget')?.shadowRoot !== undefined,
        }))),
      }),
    );
    await page.close();
  }
} finally {
  await browser.close();
}
