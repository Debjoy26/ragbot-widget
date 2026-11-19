// Offline browser regression: actual built widget, fake public config, no backend.
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Allow Windows browser/context startup without relaxing the UI assertions.
test.setTimeout(90_000);

const HOST = 'https://bootstrap.invalid/';
const SCRIPT = `${HOST}widget.js`;
const CONFIG = 'https://config.invalid/rest/v1/public_bot_config';
const tag = (mode = '') => `<script src="${SCRIPT}" data-bot-slug="bootstrap"
  data-api-url="https://api.invalid" data-supabase-url="https://config.invalid"
  data-supabase-publishable-key="sb_publishable_TEST_KEY_FOR_TESTS" ${mode}></script>`;
const config = {
  bot_id: '123e4567-e89b-12d3-a456-426614174000',
  bot_slug: 'bootstrap',
  display_name: 'Bootstrap test',
  greeting: 'FAKE bootstrap greeting',
  suggested_questions: [],
  primary_color: '#3155D9',
  position: 'bottom-right',
  supported_languages: ['en'],
  escalation_label: 'Contact support',
  escalation_messages: { en: 'FAKE help message' },
  contact_email: 'help@example.com',
  // PostgREST select=* includes SQL NULL for absent optional fields.
  privacy_url: null,
  contact_phone: null,
  contact_whatsapp_url: null,
  contact_page_url: null,
  business_hours: null,
  timezone: null,
};

for (const scenario of [
  { name: 'parser-loaded head script', head: tag(), body: '' },
  { name: 'parser-loaded body script', head: '', body: tag() },
  { name: 'deferred head script', head: tag('defer'), body: '' },
  { name: 'deferred body script', head: '', body: tag('defer') },
  { name: 'async script', head: tag('async'), body: '' },
  { name: 'author host before script', head: '', body: `<ragbot-widget></ragbot-widget>${tag()}` },
  { name: 'author host after script', head: '', body: `${tag()}<ragbot-widget></ragbot-widget>` },
  { name: 'duplicate parser scripts', head: tag(), body: tag() },
  { name: 'dynamic script after load', head: '', body: '', dynamic: true },
]) {
  test(`${scenario.name} boots exactly one configured widget`, async ({ page }) => {
    const bundle = await readFile(
      fileURLToPath(new URL('../../widget/dist/v1.0.0/widget.js', import.meta.url)),
      'utf8',
    );
    let configReads = 0;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.name));
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url === SCRIPT) {
        await route.fulfill({ contentType: 'application/javascript', body: bundle });
      } else if (url.startsWith(CONFIG)) {
        configReads++;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify([config]) });
      } else if (url === HOST) {
        await route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head>${scenario.head}</head><body>${scenario.body}</body></html>`,
        });
      } else {
        await route.abort();
      }
    });
    await page.goto(HOST);
    if ('dynamic' in scenario) {
      await page.evaluate(
        ({ src }) => {
          const script = document.createElement('script');
          script.src = src;
          script.dataset['botSlug'] = 'bootstrap';
          script.dataset['apiUrl'] = 'https://api.invalid';
          script.dataset['supabaseUrl'] = 'https://config.invalid';
          script.dataset['supabasePublishableKey'] = 'sb_publishable_TEST_KEY_FOR_TESTS';
          document.body.appendChild(script);
        },
        { src: SCRIPT },
      );
    }
    const host = page.locator('ragbot-widget');
    await expect(host.locator('.launcher')).toHaveCount(1, { timeout: 4000 });
    await expect(host).toHaveCount(1);
    await host.locator('.launcher').click();
    await expect(host.locator('.transcript')).toContainText('FAKE bootstrap greeting');
    // A second tag after initialization must reuse the existing instance too.
    await page.evaluate(
      (src) =>
        new Promise<void>((resolve, reject) => {
          const duplicate = document.createElement('script');
          duplicate.src = src;
          duplicate.onload = () => resolve();
          duplicate.onerror = () => reject(new Error('fixture script load failed'));
          document.body.appendChild(duplicate);
        }),
      SCRIPT,
    );
    await expect(host).toHaveCount(1);
    await expect(host.locator('.launcher')).toHaveCount(1);
    expect(configReads).toBe(1);
    expect(errors).toEqual([]);
  });
}
