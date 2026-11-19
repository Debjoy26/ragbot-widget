// Offline session-ownership boundary simulation; no real backend or provider.
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.setTimeout(90_000);
const HOST = 'https://session-lifecycle.invalid/';
const API = 'https://api.invalid';

async function setup(page: Page, options: { revoke?: boolean; holdHistory?: boolean } = {}) {
  const bundle = await readFile(
    new URL('../../widget/dist/v1.0.0/widget.js', import.meta.url),
    'utf8',
  );
  const identities = new Map<string, number>();
  const conversations: unknown[] = [];
  const errors: string[] = [];
  let historyReads = 0;
  let releaseHistory = () => {};
  const historyGate = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
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
    else if (url === `${API}/v1/sessions`) {
      const token = crypto.randomUUID();
      identities.set(token, identities.size + 1);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ token, expires_at: new Date(Date.now() + 3600_000).toISOString() }),
      });
    } else if (url === `${API}/v1/chat`) {
      const body = route.request().postDataJSON() as { conversation_id: unknown };
      const identity = identities.get((route.request().headers()['authorization'] ?? '').slice(7));
      conversations.push(body.conversation_id);
      const id = `fake-conversation-${identity}`;
      const refused =
        (options.revoke && conversations.length === 2) ||
        (body.conversation_id !== null && body.conversation_id !== id);
      if (refused)
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: '{"error":{"code":"SESSION_EXPIRED"}}',
        });
      else
        await route.fulfill({
          contentType: 'text/event-stream',
          body:
            `event: meta\ndata: ${JSON.stringify({ request_id: 'r', conversation_id: id, message_id: 'm' })}\n\n` +
            'event: delta\ndata: {"text":"FAKE answer"}\n\nevent: sources\ndata: {"sources":[]}\n\nevent: done\ndata: {"status":"complete"}\n\n',
        });
    } else if (url.startsWith(`${API}/v1/conversations/`)) {
      historyReads++;
      if (options.holdHistory) await historyGate;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          conversation_id: 'fake-conversation-1',
          messages: [{ id: 'm', role: 'assistant', content: 'FAKE restored history' }],
          has_more: false,
        }),
      });
    } else await route.abort();
  });
  await page.goto(HOST);
  await page.locator('ragbot-widget .launcher').click();
  return {
    conversations,
    errors,
    sessions: () => identities.size,
    historyReads: () => historyReads,
    releaseHistory,
  };
}

async function send(page: Page) {
  await page.locator('ragbot-widget textarea').fill('FAKE question');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function expire(page: Page, missing = false) {
  await page.evaluate((remove) => {
    const key = 'ragbot.session.lifecycle';
    if (remove) sessionStorage.removeItem(key);
    else {
      const stored = JSON.parse(sessionStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      stored['expiresAt'] = new Date(Date.now() - 1000).toISOString();
      sessionStorage.setItem(key, JSON.stringify(stored));
    }
  }, missing);
}

for (const missing of [false, true]) {
  test(`${missing ? 'missing' : 'expired'} session starts a newly authorized conversation`, async ({
    page,
  }) => {
    const state = await setup(page);
    await send(page);
    await expect(page.locator('ragbot-widget .msg.assistant[data-status="complete"]')).toHaveCount(
      1,
    );
    await expire(page, missing);
    await send(page);
    await expect(page.locator('ragbot-widget .msg.assistant[data-status="complete"]')).toHaveCount(
      2,
    );
    expect(state.conversations).toEqual([null, null]);
    expect(state.sessions()).toBe(2);
    await expect(page.locator('ragbot-widget .transcript')).toContainText(
      'Earlier messages are local history',
    );
    expect(state.errors).toEqual([]);
  });
}

test('revocation clears both token and conversation before the next send', async ({ page }) => {
  const state = await setup(page, { revoke: true });
  await send(page);
  await expect(page.locator('ragbot-widget .msg.assistant[data-status="complete"]')).toHaveCount(1);
  await send(page);
  await expect(page.locator('ragbot-widget .transcript')).toContainText('Session expired');
  expect(
    await page.evaluate(() => sessionStorage.getItem('ragbot.conversation.lifecycle')),
  ).toBeNull();
  await send(page);
  await expect(page.locator('ragbot-widget .msg.assistant[data-status="complete"]')).toHaveCount(2);
  expect(state.conversations).toEqual([null, 'fake-conversation-1', null]);
  expect(state.sessions()).toBe(2);
  expect(state.errors).toEqual([]);
});

test('reload restores and reuses a live session conversation', async ({ page }) => {
  const state = await setup(page);
  await send(page);
  await expect(page.locator('ragbot-widget .msg.assistant[data-status="complete"]')).toHaveCount(1);
  await page.reload();
  await page.locator('ragbot-widget .launcher').click();
  await expect(page.locator('ragbot-widget .transcript')).toContainText('FAKE restored history');
  await send(page);
  await expect(page.locator('ragbot-widget .msg.assistant[data-status="complete"]')).toHaveCount(2);
  expect(state.conversations).toEqual([null, 'fake-conversation-1']);
  expect(state.sessions()).toBe(1);
  expect(state.errors).toEqual([]);
});

test('a delayed history response cannot replace a refreshed conversation', async ({ page }) => {
  const state = await setup(page, { holdHistory: true });
  await send(page);
  await expect(page.locator('ragbot-widget .msg.assistant[data-status="complete"]')).toHaveCount(1);
  await page.reload();
  await page.locator('ragbot-widget .launcher').click();
  await expect.poll(state.historyReads).toBe(1);
  await expire(page);
  await send(page);
  try {
    await expect(page.locator('ragbot-widget .msg.assistant[data-status="complete"]')).toHaveCount(
      1,
    );
  } finally {
    state.releaseHistory();
  }
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('ragbot.conversation.lifecycle')))
    .toBe('fake-conversation-2');
  await expect(page.locator('ragbot-widget .transcript')).not.toContainText(
    'FAKE restored history',
  );
  await send(page);
  await expect(page.locator('ragbot-widget .msg.assistant[data-status="complete"]')).toHaveCount(2);
  expect(state.conversations).toEqual([null, null, 'fake-conversation-2']);
  expect(state.errors).toEqual([]);
});
