import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// S-2: scripts/create-first-admin.mjs against a FAKE auth/REST server bound to loopback.
// The key is an obvious placeholder; the script can only reach 127.0.0.1 here, never a real project.

const SCRIPT = fileURLToPath(new URL('../../scripts/create-first-admin.mjs', import.meta.url));
const FAKE_KEY = 'fake-test-key-not-a-secret';
const USER_ID = '7d1f3a52-9b0e-4c68-8e21-0a5c4b9d3f17';
const EMAIL = 'owner@client.example.com';

interface Fake {
  readonly server: Server;
  readonly url: string;
  readonly calls: string[];
}

let current: Server | undefined;
afterEach(() => {
  current?.close();
  current = undefined;
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString()));
    req.on('end', () => resolve(data));
  });
}

async function startFake(user: Record<string, unknown> | null): Promise<Fake> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    void readBody(req).then(() => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      calls.push(`${req.method} ${path}`);
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && path === '/auth/v1/admin/users') {
        res.end(JSON.stringify({ users: user === null ? [] : [user] }));
      } else if (req.method === 'POST' && path === '/auth/v1/invite') {
        res.end(JSON.stringify({ id: USER_ID, email: EMAIL }));
      } else if (req.method === 'POST' && path === '/rest/v1/admin_memberships') {
        res.statusCode = 201;
        res.end('');
      } else if (req.method === 'GET' && path === '/rest/v1/admin_memberships') {
        res.end(JSON.stringify([{ role: 'owner', active: true }]));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  current = server;
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

function run(
  url: string,
  extra: string[] = [],
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--email', EMAIL, '--role', 'owner', ...extra], {
      env: { PATH: process.env['PATH'] ?? '', SUPABASE_URL: url, SUPABASE_SECRET_KEY: FAKE_KEY },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const base = { id: USER_ID, email: EMAIL };

describe('create-first-admin existing-user rule', () => {
  it('invites a new user', async () => {
    const f = await startFake(null);
    const r = await run(f.url);
    expect(r.code).toBe(0);
    expect(f.calls).toContain('POST /auth/v1/invite');
    expect(r.out).toContain('invited');
  });

  it('reuses an unanswered invite (never confirmed, never signed in)', async () => {
    const f = await startFake({
      ...base,
      invited_at: '2026-01-01T00:00:00Z',
      email_confirmed_at: null,
      last_sign_in_at: null,
    });
    const r = await run(f.url);
    expect(r.code).toBe(0);
    expect(f.calls).not.toContain('POST /auth/v1/invite');
    expect(f.calls).toContain('POST /rest/v1/admin_memberships');
  });

  it('refuses an unconfirmed account that was not created by an invite', async () => {
    const f = await startFake({ ...base, email_confirmed_at: null, last_sign_in_at: null });
    const r = await run(f.url);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('--adopt-existing');
    expect(f.calls).not.toContain('POST /rest/v1/admin_memberships');
  });

  it.each([
    ['confirmed', { email_confirmed_at: '2026-01-01T00:00:00Z' }],
    ['signed in', { last_sign_in_at: '2026-01-01T00:00:00Z' }],
    [
      'both',
      { email_confirmed_at: '2026-01-01T00:00:00Z', last_sign_in_at: '2026-01-02T00:00:00Z' },
    ],
  ])('refuses an existing user who is %s, before adding a membership', async (_n, extra) => {
    const f = await startFake({ ...base, ...extra });
    const r = await run(f.url);
    expect(r.code).toBe(1);
    expect(r.err).toContain('--adopt-existing');
    expect(f.calls).not.toContain('POST /rest/v1/admin_memberships');
    expect(f.calls).not.toContain('POST /auth/v1/invite');
    expect(r.out + r.err).not.toContain(FAKE_KEY);
  });

  it('adopts a confirmed user only with --adopt-existing', async () => {
    const f = await startFake({ ...base, email_confirmed_at: '2026-01-01T00:00:00Z' });
    const r = await run(f.url, ['--adopt-existing']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('adopted existing user');
    expect(f.calls).toContain('POST /rest/v1/admin_memberships');
  });

  it('rejects a repeated or valued --adopt-existing as bad usage', async () => {
    const f = await startFake(null);
    expect((await run(f.url, ['--adopt-existing', '--adopt-existing'])).code).toBe(2);
    expect((await run(f.url, ['--adopt-existing', 'yes'])).code).toBe(2);
    expect(f.calls).toEqual([]);
  });
});
