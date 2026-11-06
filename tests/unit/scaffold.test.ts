import { describe, expect, it } from 'vitest';
import { SHARED_PACKAGE_NAME } from '@ragbot/shared';
import { buildServer } from '../../api/src/server.ts';
import { workerName } from '../../worker/src/worker.ts';
import { WIDGET_GLOBAL } from '../../widget/src/widget.ts';
import { fakeDb, testConfig } from './api/helpers.ts';

// P1 scaffold smoke tests: prove workspaces resolve and compile. Not feature tests.
describe('P1 scaffold', () => {
  it('resolves the shared workspace package', () => {
    expect(SHARED_PACKAGE_NAME).toBe('@ragbot/shared');
  });

  it('builds an API app with only the health routes and an enveloped 404 elsewhere', async () => {
    const app = buildServer({ config: testConfig({ LOG_LEVEL: 'silent' }), db: fakeDb() });
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    const unknown = await app.inject({ method: 'GET', url: '/v1/chat' });
    expect(unknown.statusCode).toBe(404);
    expect(Object.keys(unknown.json()).sort()).toEqual(['code', 'request_id']);
    await app.close();
  });

  it('loads worker and widget entry modules', () => {
    expect(workerName()).toBe('ragbot-worker');
    expect(WIDGET_GLOBAL).toBe('__ragbotWidget');
  });
});
