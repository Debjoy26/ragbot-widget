// P8 E2E: embed contract, hostile-CSS isolation, XSS-as-text, handoff card.
// NOT RUN here (no browsers / no running stack on this machine; recorded in
// docs/evidence/P8/SUMMARY.md). Offline by design: the widget bundle is served
// from dist/ via route interception and the API is mocked, so the suite needs
// only `npx playwright install` browsers, no backend.
//
// Run: npm run build -w widget && npx playwright test tests/e2e/widget.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const WIDGET_JS = 'https://client-a-widget.example.com/v1.0.0/widget.js';
const API = 'https://client-a-api.example.com';
const SUPABASE = 'https://xyz.supabase.co';

const SNIPPET = (extraCss = '') => `
<!doctype html><html><head><style>${extraCss}</style></head><body>
<h1>host page</h1>
<script src="${WIDGET_JS}"
  data-bot-slug="website-support"
  data-api-url="${API}"
  data-supabase-url="${SUPABASE}"
  data-supabase-publishable-key="sb_publishable_TEST_KEY_FOR_TESTS"
  defer></script>
</body></html>`;

const PUBLIC_CONFIG = {
  bot_id: '123e4567-e89b-12d3-a456-426614174000',
  bot_slug: 'website-support',
  display_name: 'Acme Assistant',
  greeting: 'Ask about our products.',
  suggested_questions: ['What services do you offer?'],
  primary_color: '#3155D9',
  position: 'bottom-right',
  supported_languages: ['en'],
  escalation_label: 'Contact support',
  escalation_messages: { en: 'Our team can help:' },
  contact_email: 'support@client.example.com',
  contact_page_url: 'https://client.example.com/contact',
};

async function waitForUi(page: Page, selector: string): Promise<void> {
  // The widget boots asynchronously (config fetch), and streams resolve over
  // mocked routes: poll the shadow tree instead of sleeping.
  await page.waitForFunction(
    (sel) => document.querySelector('ragbot-widget')?.shadowRoot?.querySelector(sel) !== null,
    selector,
    { timeout: 10000 },
  );
}

async function openPanel(page: Page): Promise<void> {
  await waitForUi(page, '.launcher');
  await page.locator('ragbot-widget').evaluate((host) => {
    const root = (host as HTMLElement).shadowRoot;
    (root?.querySelector('.launcher') as HTMLButtonElement | null)?.click();
  });
  await waitForUi(page, '.transcript');
}
async function serveWidget(page: Page): Promise<void> {
  const bundle = await readFile(
    fileURLToPath(new URL('../../widget/dist/v1.0.0/widget.js', import.meta.url)),
    'utf8',
  );
  await page.route(WIDGET_JS, (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: bundle }),
  );
  await page.route(`${SUPABASE}/rest/v1/public_bot_config*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([PUBLIC_CONFIG]),
    }),
  );
  await page.route(`${API}/v1/sessions`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        token: 'tok',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    }),
  );
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.locator('ragbot-widget').evaluate((host, msg) => {
    const root = (host as HTMLElement).shadowRoot;
    const box = root?.querySelector<HTMLTextAreaElement>('.composer textarea');
    if (box) {
      box.value = msg;
      root?.querySelector<HTMLButtonElement>('.composer button:not([hidden])')?.click();
    }
  }, text);
}

test('embed boots one launcher and opens the greeting', async ({ page }) => {
  await serveWidget(page);
  await page.setContent(SNIPPET());
  await openPanel(page);
  // Message direction follows content (UI_SCHEMA §6 RTL support).
  const dir = await page.locator('ragbot-widget').evaluate((host) => {
    const root = (host as HTMLElement).shadowRoot;
    return root?.querySelector('div.msg.assistant')?.getAttribute('dir');
  });
  expect(dir).toBe('auto');
  await expect(
    page
      .locator('ragbot-widget')
      .evaluate(
        (host) => (host as HTMLElement).shadowRoot?.querySelector('.transcript')?.textContent,
      ),
  ).resolves.toContain('Ask about our products.');
});

test('hostile host CSS does not leak into the shadow tree', async ({ page }) => {
  await serveWidget(page);
  await page.setContent(
    SNIPPET(
      'button{background:red !important; color:red !important;} div{font-size:1px !important;}',
    ),
  );
  await openPanel(page);
  const launcherBg = await page.locator('ragbot-widget').evaluate((host) => {
    const root = (host as HTMLElement).shadowRoot;
    const button = root?.querySelector('.launcher') as HTMLElement | null;
    return button === null ? null : getComputedStyle(button).backgroundColor;
  });
  // #3155D9 primary colour survives the hostile page stylesheet.
  expect(launcherBg).toBe('rgb(49, 85, 217)');
});

test('model HTML renders as text, never as markup', async ({ page }) => {
  await serveWidget(page);
  await page.route(`${API}/v1/chat`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body:
        'event: meta\ndata: {"request_id":"r","conversation_id":"c","message_id":"m"}\n\n' +
        'event: delta\ndata: {"text":"<img src=x onerror=alert(1)> click https://evil.example.com"}\n\n' +
        'event: sources\ndata: {"sources":[]}\n\n' +
        'event: done\ndata: {"status":"complete"}\n\n',
    }),
  );
  await page.setContent(SNIPPET());
  await openPanel(page);
  await sendMessage(page, 'hello');
  // Greeting div + streamed answer div (suggested questions are buttons).
  await page.waitForFunction(
    () =>
      (document.querySelector('ragbot-widget')?.shadowRoot?.querySelectorAll('div.msg.assistant')
        .length ?? 0) >= 2,
    undefined,
    { timeout: 10000 },
  );
  const markup = await page
    .locator('ragbot-widget')
    .evaluate((host) => (host as HTMLElement).shadowRoot?.querySelector('.transcript')?.innerHTML);
  expect(markup).not.toContain('<img');
  expect(markup).not.toContain('<a ');
});

test('multi-delta streams accumulate text and return to ready (P8-D4)', async ({ page }) => {
  await serveWidget(page);
  await page.route(`${API}/v1/chat`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body:
        'event: meta\ndata: {"request_id":"r","conversation_id":"c","message_id":"m"}\n\n' +
        'event: delta\ndata: {"text":"Hello "}\n\n' +
        'event: delta\ndata: {"text":"world"}\n\n' +
        'event: sources\ndata: {"sources":[]}\n\n' +
        'event: done\ndata: {"status":"complete"}\n\n',
    }),
  );
  await page.setContent(SNIPPET());
  await openPanel(page);
  await sendMessage(page, 'hi');
  await page.waitForFunction(
    () =>
      (
        document.querySelector('ragbot-widget')?.shadowRoot?.querySelector('.transcript')
          ?.textContent ?? ''
      ).includes('Hello world'),
    undefined,
    { timeout: 10000 },
  );
  // Back to ready: the Send button is visible again (no stuck transition).
  const sendVisible = await page.locator('ragbot-widget').evaluate((host) => {
    const buttons = [
      ...((host as HTMLElement).shadowRoot?.querySelectorAll('.composer button') ?? []),
    ] as HTMLButtonElement[];
    return buttons.some((b) => b.textContent === 'Send' && !b.hidden);
  });
  expect(sendVisible).toBe(true);
});

test('handoff appends a contact card with safe links', async ({ page }) => {
  await serveWidget(page);
  await page.route(`${API}/v1/chat`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body:
        'event: meta\ndata: {"request_id":"r","conversation_id":"c","message_id":"m"}\n\n' +
        'event: sources\ndata: {"sources":[]}\n\n' +
        'event: handoff\ndata: {"reason":"no_knowledge","message":"Our team can help:","prominent":false,"contact":{}}\n\n' +
        'event: done\ndata: {"status":"complete"}\n\n',
    }),
  );
  await page.setContent(SNIPPET());
  await openPanel(page);
  await sendMessage(page, 'do you sell rocket ships?');
  await waitForUi(page, '.contact-card');
  await expect(
    page
      .locator('ragbot-widget')
      .evaluate(
        (host) => (host as HTMLElement).shadowRoot?.querySelector('.contact-card')?.textContent,
      ),
  ).resolves.toContain('Our team can help:');
  const hrefs = await page
    .locator('ragbot-widget')
    .evaluate((host) =>
      [...((host as HTMLElement).shadowRoot?.querySelectorAll('.contact-card a') ?? [])].map(
        (a) => (a as HTMLAnchorElement).href,
      ),
    );
  expect(hrefs).toContain('mailto:support@client.example.com');
  for (const href of hrefs) expect(href).not.toMatch(/^javascript:/i);
});
