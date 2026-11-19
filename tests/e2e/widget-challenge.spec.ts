// Offline A05 regression: built widget and fake Turnstile/API. No live verification.
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.setTimeout(90_000);
const HOST = 'https://challenge.invalid/';
const API = 'https://api.invalid';

async function setup(
  page: Page,
  options: {
    rejectFirst?: boolean;
    noKey?: boolean;
    scriptFails?: boolean;
    holdSession?: boolean;
  } = {},
) {
  const bundle = await readFile(
    new URL('../../widget/dist/v1.0.0/widget.js', import.meta.url),
    'utf8',
  );
  const posts: Record<string, unknown>[] = [];
  let scripts = 0;
  let releaseSession = () => {};
  const sessionGate = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url === HOST) {
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><script src="${HOST}widget.js"
        data-bot-slug="challenge" data-api-url="${API}" data-supabase-url="https://config.invalid"
        data-supabase-publishable-key="sb_publishable_TEST_KEY_FOR_TESTS"
        ${options.noKey ? '' : `data-turnstile-site-key="fake_site_${Date.now()}"`} defer></script>`,
      });
    } else if (url === `${HOST}widget.js`) {
      await route.fulfill({ contentType: 'application/javascript', body: bundle });
    } else if (url.startsWith('https://config.invalid/rest/v1/public_bot_config')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([
          {
            bot_id: '123e4567-e89b-12d3-a456-426614174000',
            bot_slug: 'challenge',
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
    } else if (url.startsWith('https://challenges.cloudflare.com/turnstile/v0/api.js')) {
      scripts++;
      if (options.scriptFails && scripts === 1) return route.abort();
      await route.fulfill({
        contentType: 'application/javascript',
        body: `
        // Synthetic vendor adapter; tokens are generated only at runtime.
        window.turnstile = {
          render(container, options) {
            window.fakeChallenge = options;
            const button = document.createElement('button');
            button.textContent = 'Complete fake verification';
            button.onclick = () => options.callback('fake_' + crypto.randomUUID());
            container.append(button);
            container.dataset.action = options.action;
            return container;
          },
          remove(container) { container.replaceChildren(); }
        };
      `,
      });
    } else if (url === `${API}/v1/sessions`) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      posts.push(body);
      if (options.holdSession && posts.length === 1) await sessionGate;
      const rejected = !body['challenge_token'] || (options.rejectFirst && posts.length === 1);
      await route.fulfill({
        status: rejected ? 403 : 200,
        contentType: 'application/json',
        body: JSON.stringify(
          rejected
            ? { error: { code: 'FORBIDDEN' } }
            : {
                token: crypto.randomUUID(),
                expires_at: new Date(Date.now() + 60000).toISOString(),
              },
        ),
      });
    } else if (url === `${API}/v1/chat`) {
      await route.fulfill({
        contentType: 'text/event-stream',
        body: 'event: done\ndata: {"status":"complete"}\n\n',
      });
    } else await route.abort();
  });
  await page.goto(HOST);
  const host = page.locator('ragbot-widget');
  await host.locator('.launcher').click();
  return { host, posts, errors, scripts: () => scripts, releaseSession };
}

async function send(page: Page) {
  await page.locator('ragbot-widget textarea').fill('FAKE question');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test('fresh challenge uses the shared action and live sessions skip a second challenge', async ({
  page,
}) => {
  const state = await setup(page);
  await send(page);
  const verify = page.getByRole('button', { name: 'Complete fake verification' });
  await expect(verify).toBeVisible();
  expect(state.posts).toHaveLength(0);
  await expect(page.locator('[data-action="session_create"]')).toBeVisible();
  await verify.click();
  await expect(state.host.locator('.msg.assistant[data-status="complete"]')).toHaveCount(1);
  expect(typeof state.posts[0]?.['challenge_token']).toBe('string');
  expect(state.posts[0]?.['bot_slug']).toBe('challenge');
  await expect(verify).toHaveCount(0);
  await send(page);
  await expect(state.host.locator('.msg.assistant[data-status="complete"]')).toHaveCount(2);
  expect(state.posts).toHaveLength(1);
  expect(state.scripts()).toBe(1);
  expect(state.errors).toEqual([]);
});

test('a rejected token offers retry and the next attempt gets a fresh token', async ({ page }) => {
  const state = await setup(page, { rejectFirst: true });
  await send(page);
  await page.getByRole('button', { name: 'Complete fake verification' }).click();
  await expect(state.host.locator('.transcript')).toContainText(
    'Verification or session access was refused',
  );
  await expect(state.host.locator('.transcript')).not.toContainText('Session expired');
  await send(page);
  await page.getByRole('button', { name: 'Complete fake verification' }).click();
  await expect(state.host.locator('.msg.assistant[data-status="complete"]')).toHaveCount(1);
  expect(state.posts).toHaveLength(2);
  expect(state.posts[0]?.['challenge_token'] === state.posts[1]?.['challenge_token']).toBe(false);
  expect(state.errors).toEqual([]);
});

for (const callback of [
  'error-callback',
  'expired-callback',
  'timeout-callback',
  'unsupported-callback',
  'empty',
  'oversized',
]) {
  test(`${callback} fails closed and allows a fresh verification`, async ({ page }) => {
    const state = await setup(page);
    await send(page);
    await expect(page.getByRole('button', { name: 'Complete fake verification' })).toBeVisible();
    await page.evaluate((name) => {
      const fake = (
        window as unknown as { fakeChallenge: Record<string, (...args: string[]) => void> }
      ).fakeChallenge;
      if (name === 'empty') fake['callback']?.('');
      else if (name === 'oversized') fake['callback']?.('x'.repeat(4097));
      else fake[name]?.();
    }, callback);
    await expect(state.host.locator('.transcript')).toContainText('Verification could not finish');
    expect(state.posts).toHaveLength(0);
    await send(page);
    await page.getByRole('button', { name: 'Complete fake verification' }).click();
    await expect(state.host.locator('.msg.assistant[data-status="complete"]')).toHaveCount(1);
    expect(state.errors).toEqual([]);
  });
}

test('vendor script failure can be retried', async ({ page }) => {
  const state = await setup(page, { scriptFails: true });
  await send(page);
  await expect(state.host.locator('.transcript')).toContainText('Verification could not finish');
  expect(state.posts).toHaveLength(0);
  await send(page);
  await page.getByRole('button', { name: 'Complete fake verification' }).click();
  await expect(state.host.locator('.msg.assistant[data-status="complete"]')).toHaveCount(1);
  expect(state.scripts()).toBe(2);
  expect(state.errors).toEqual([]);
});

test('a challenge with no callback times out and permits retry', async ({ page }) => {
  const state = await setup(page);
  await page.clock.install();
  await send(page);
  await expect(page.getByRole('button', { name: 'Complete fake verification' })).toBeVisible();
  await page.clock.fastForward(120_001);
  await expect(state.host.locator('.transcript')).toContainText('Verification could not finish');
  expect(state.posts).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Complete fake verification' })).toHaveCount(0);
  await send(page);
  await page.getByRole('button', { name: 'Complete fake verification' }).click();
  await expect(state.host.locator('.msg.assistant[data-status="complete"]')).toHaveCount(1);
  expect(state.errors).toEqual([]);
});

test('Stop and close cancel a pending challenge without creating a session', async ({ page }) => {
  const state = await setup(page);
  await send(page);
  const verify = page.getByRole('button', { name: 'Complete fake verification' });
  await expect(verify).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(verify).toHaveCount(0);
  await send(page);
  await expect(verify).toBeVisible();
  await page.getByRole('button', { name: 'Close chat' }).click();
  await expect(verify).toHaveCount(0);
  await expect(state.host.locator('.launcher')).toBeVisible();
  expect(state.posts).toHaveLength(0);
  expect(state.errors).toEqual([]);
});

test('missing site key leaves server refusal intact and does not claim session expiry', async ({
  page,
}) => {
  const state = await setup(page, { noKey: true });
  await send(page);
  await expect(state.host.locator('.transcript')).toContainText(
    'Verification or session access was refused',
  );
  expect(state.posts).toHaveLength(1);
  expect(state.posts[0]?.['challenge_token']).toBeUndefined();
  expect(state.scripts()).toBe(0);
});

for (const cancel of ['Stop', 'Close chat']) {
  test(`${cancel} cancels a pending session POST and the next send works`, async ({ page }) => {
    const state = await setup(page, { holdSession: true });
    await send(page);
    await page.getByRole('button', { name: 'Complete fake verification' }).click();
    await expect.poll(() => state.posts.length).toBe(1);
    await page.getByRole('button', { name: cancel, exact: true }).click();
    try {
      await expect(state.host.locator('.msg.assistant[data-status="partial"]')).toHaveCount(1);
    } finally {
      state.releaseSession();
    }
    expect(
      await page.evaluate(() => sessionStorage.getItem('ragbot.session.challenge')),
    ).toBeNull();
    if (cancel === 'Close chat') await state.host.locator('.launcher').click();
    await send(page);
    await page.getByRole('button', { name: 'Complete fake verification' }).click();
    await expect(state.host.locator('.msg.assistant[data-status="complete"]')).toHaveCount(1);
    expect(state.posts).toHaveLength(2);
    expect(state.errors).toEqual([]);
  });
}
