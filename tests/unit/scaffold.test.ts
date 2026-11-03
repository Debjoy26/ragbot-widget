import { describe, expect, it } from 'vitest';
import { SHARED_PACKAGE_NAME } from '@ragbot/shared';
import { buildServer } from '../../api/src/server.ts';
import { workerName } from '../../worker/src/worker.ts';
import { WIDGET_GLOBAL } from '../../widget/src/widget.ts';

// P1 scaffold smoke tests: prove workspaces resolve and compile. Not feature tests.
describe('P1 scaffold', () => {
  it('resolves the shared workspace package', () => {
    expect(SHARED_PACKAGE_NAME).toBe('@ragbot/shared');
  });

  it('builds an API app with no public routes yet', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('loads worker and widget entry modules', () => {
    expect(workerName()).toBe('ragbot-worker');
    expect(WIDGET_GLOBAL).toBe('__ragbotWidget');
  });
});
