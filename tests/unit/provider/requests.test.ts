import { describe, expect, it } from 'vitest';
import {
  approveDeployment,
  createClient,
  markLive,
  requestService,
  scriptVisible,
} from '../../../provider/src/requests.mjs';
import { makeWidgetKey } from '../../../provider/src/provision.mjs';

describe('portal request/approve/script (ADR 0022)', () => {
  it('signup creates pending client; service needs approved client + https origin', () => {
    const c = createClient({ name: 'Acme', email: 'ops@acme.example' });
    expect(c.status).toBe('pending');
    expect(() =>
      requestService({
        client: c,
        botSlug: 'acme',
        botName: 'Acme',
        origin: 'https://acme.example',
        plan: 'standard',
      }),
    ).toThrow();
    const ok = requestService({
      client: { ...c, status: 'approved' },
      botSlug: 'acme',
      botName: 'Acme',
      origin: 'https://acme.example',
      plan: 'standard',
    });
    expect(ok.state).toBe('pending');
    expect(ok.allowed_host).toBe('acme.example');
  });
  it('approve -> provisioning -> live gates script visibility', () => {
    const dep = approveDeployment({ state: 'pending', bot_slug: 'acme' });
    expect(dep.state).toBe('provisioning');
    expect(scriptVisible({ state: 'provisioning' })).toBe(false);
    const live = markLive(dep, {
      supabaseRef: 'abcdefghijklmnopqrst',
      apiUrl: 'https://api.example.com',
      widgetUrl: 'https://widget.example.com/v1.0.0/widget.js',
      widgetKey: makeWidgetKey(),
    });
    expect(live.state).toBe('live');
    expect(scriptVisible(live)).toBe(true);
  });
});
