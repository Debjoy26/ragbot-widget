// Built IIFE with synthetic HTTP responses only; no backend/provider calls.
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.setTimeout(90_000);
const HOST = 'https://lifecycle.invalid/';
const API = 'https://api.invalid';
const meta = 'event: meta\ndata: {"request_id":"r","conversation_id":"c","message_id":"m"}\n\n';
const delta = 'event: delta\ndata: {"text":"FAKE partial"}\n\n';
const done = 'event: sources\ndata: {"sources":[]}\n\nevent: done\ndata: {"status":"complete"}\n\n';

async function setup(page: Page, firstResponse: string) {
  const bundle = await readFile(
    new URL('../../widget/dist/v1.0.0/widget.js', import.meta.url),
    'utf8',
  );
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url === HOST)
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><script src="${HOST}widget.js"
      data-bot-slug="lifecycle" data-api-url="${API}" data-supabase-url="https://config.invalid"
      data-supabase-publishable-key="sb_publishable_TEST_KEY_FOR_TESTS" defer></script>`,
      });
    else if (url === `${HOST}widget.js`)
      await route.fulfill({ contentType: 'application/javascript', body: bundle });
    else if (url.startsWith('https://config.invalid/rest/v1/public_bot_config'))
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([
          {
            bot_id: '123e4567-e89b-12d3-a456-426614174000',
            bot_slug: 'lifecycle',
            display_name: 'FAKE support',
            greeting: 'FAKE greeting',
            suggested_questions: [],
            primary_color: '#3155D9',
            position: 'bottom-right',
            supported_languages: ['en'],
            escalation_label: 'Contact',
            escalation_messages: { en: 'FAKE help' },
            contact_email: 'help@example.com',
          },
        ]),
      });
    else if (url === `${API}/v1/sessions`)
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          token: crypto.randomUUID(),
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
      });
    else if (url === `${API}/v1/chat`) {
      requests.push(route.request().headers()['idempotency-key'] ?? '');
      await route.fulfill({
        contentType: 'text/event-stream',
        body: requests.length === 1 ? firstResponse : meta + done,
      });
    } else await route.abort();
  });
  await page.goto(HOST);
  const host = page.locator('ragbot-widget');
  await host.locator('.launcher').click();
  return { host, requests, errors };
}

async function send(page: Page) {
  await page.locator('ragbot-widget textarea').fill('FAKE question');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

for (const [name, response] of [
  ['empty', ''],
  ['meta', meta],
  ['partial', meta + delta + delta],
] as const) {
  test(`${name} premature EOF preserves text and restores sending without replay`, async ({
    page,
  }) => {
    const state = await setup(page, response);
    await send(page);
    await expect(state.host.locator('.msg.assistant[data-status="partial"]')).toHaveCount(1);
    await expect(state.host.locator('.transcript')).toContainText(
      'The connection ended before the answer finished',
    );
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    if (name === 'partial')
      await expect(state.host.locator('.msg.assistant[data-status="partial"]')).toHaveText(
        'FAKE partialFAKE partial',
      );
    expect(state.requests).toHaveLength(1);
    await send(page);
    await expect(state.host.locator('.msg.assistant[data-status="complete"]')).toHaveCount(1);
    expect(state.requests).toHaveLength(2);
    expect(state.requests[0] === state.requests[1]).toBe(false);
    expect(state.errors).toEqual([]);
  });
}
