import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  anonHeaders,
  getLocalPrivilegedKey,
  getLocalStack,
  keyHeaders,
  type LocalStack,
} from './helpers/local-stack.ts';

// G-23: scripts/create-first-admin.mjs against the LOCAL stack. It invites a user, adds the membership,
// is safe to run again, and refuses unsafe input before any request is made. The user it creates can
// read nothing at aal1 (no TOTP yet). No mocks. Needs `npm run db:start` and migrations applied.
// The service key is read from `supabase status` at run time and is never printed.

const SCRIPT = fileURLToPath(new URL('../../scripts/create-first-admin.mjs', import.meta.url));
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const REMOTE_REF = 'abcdefghijklmnopqrst';

let stack: LocalStack;
let key: string;
let userId = '';
const email = `first-admin-${randomUUID().slice(0, 8)}@example.test`;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the script with a clean environment containing only what the test gives it. */
function run(args: string[], env: Record<string, string | undefined>): RunResult {
  const clean: Record<string, string> = { PATH: process.env['PATH'] ?? '' };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: clean,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function localEnv(): Record<string, string> {
  return { SUPABASE_URL: stack.apiUrl, SUPABASE_SECRET_KEY: key };
}

beforeAll(() => {
  stack = getLocalStack();
  key = getLocalPrivilegedKey();
});

afterAll(async () => {
  if (userId === '') return;
  // Removing the auth user removes the membership with it (ON DELETE CASCADE).
  await fetch(`${stack.apiUrl}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: keyHeaders(key),
  });
});

describe('create-first-admin refuses unsafe input before any request', () => {
  it('stops when SUPABASE_URL is missing', () => {
    const r = run(['--email', email, '--role', 'owner'], { SUPABASE_SECRET_KEY: key });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('SUPABASE_URL is not set');
    expect(r.stdout + r.stderr).not.toContain(key);
  });

  it('stops when SUPABASE_SECRET_KEY is missing', () => {
    const r = run(['--email', email, '--role', 'owner'], { SUPABASE_URL: stack.apiUrl });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('SUPABASE_SECRET_KEY is not set');
  });

  it('stops when the key is empty', () => {
    const r = run(['--email', email, '--role', 'owner'], {
      SUPABASE_URL: stack.apiUrl,
      SUPABASE_SECRET_KEY: '',
    });
    expect(r.status).toBe(2);
  });

  it.each([
    ['a role other than owner', ['--email', 'a@example.test', '--role', 'admin']],
    ['a missing role', ['--email', 'a@example.test']],
    ['a missing email', ['--role', 'owner']],
    ['a bad email', ['--email', 'not-an-email', '--role', 'owner']],
    ['an unknown flag', ['--email', 'a@example.test', '--role', 'owner', '--password', 'x']],
    ['a flag without a value', ['--email', '--role', 'owner']],
  ])('stops on %s', (_name, args) => {
    const r = run(args, localEnv());
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).not.toContain(key);
  });

  it('refuses a remote URL without --confirm-project (no request is made)', () => {
    const r = run(['--email', 'a@example.test', '--role', 'owner'], {
      SUPABASE_URL: `https://${REMOTE_REF}.supabase.co`,
      SUPABASE_SECRET_KEY: key,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--confirm-project');
  });

  it('refuses a remote URL when --confirm-project names another project', () => {
    const r = run(
      ['--email', 'a@example.test', '--role', 'owner', '--confirm-project', 'tsrqponmlkjihgfedcba'],
      { SUPABASE_URL: `https://${REMOTE_REF}.supabase.co`, SUPABASE_SECRET_KEY: key },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('does not match');
  });

  it.each([
    ['http for a remote host', `http://${REMOTE_REF}.supabase.co`],
    ['a host that is not a Supabase project', 'https://example.test'],
    ['a URL with credentials', `https://user:pass@${REMOTE_REF}.supabase.co`],
    ['a URL with a path', `https://${REMOTE_REF}.supabase.co/auth`],
    ['a ref of the wrong shape', 'https://short.supabase.co'],
  ])('refuses %s even with a matching confirmation', (_name, url) => {
    const r = run(
      ['--email', 'a@example.test', '--role', 'owner', '--confirm-project', REMOTE_REF],
      { SUPABASE_URL: url, SUPABASE_SECRET_KEY: key },
    );
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).not.toContain(key);
  });
});

describe('create-first-admin against the local stack', () => {
  it('invites the user and adds an owner membership', async () => {
    const r = run(['--email', email, '--role', 'owner'], localEnv());
    expect(r.status, r.stderr).toBe(0);
    const m = new RegExp(`user_id=(${UUID.source}) role=owner`).exec(r.stdout);
    expect(m).not.toBeNull();
    userId = (m as RegExpExecArray)[1] as string;

    const res = await fetch(
      `${stack.apiUrl}/rest/v1/admin_memberships?select=user_id,role,active&user_id=eq.${userId}`,
      { headers: keyHeaders(key) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ user_id: userId, role: 'owner', active: true }]);
  });

  it('prints neither the key nor a link, and sets no password', async () => {
    const r = run(['--email', email, '--role', 'owner'], localEnv());
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).not.toContain(key);
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toMatch(/token|password=|action_link/i);

    const res = await fetch(`${stack.apiUrl}/auth/v1/admin/users/${userId}`, {
      headers: keyHeaders(key),
    });
    expect(res.status).toBe(200);
    const user = (await res.json()) as { encrypted_password?: string | null; email?: string };
    expect(user.email).toBe(email);
    expect(user.encrypted_password ?? '').toBe('');
  });

  it('is safe to run again: same user, one membership', async () => {
    const again = run(['--email', email.toUpperCase(), '--role', 'owner'], localEnv());
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain(`user_id=${userId} role=owner`);
    expect(again.stdout).toContain('existing user');

    const res = await fetch(
      `${stack.apiUrl}/rest/v1/admin_memberships?select=user_id&user_id=eq.${userId}`,
      { headers: keyHeaders(key) },
    );
    expect(await res.json()).toHaveLength(1);
  });

  it('does not change a membership that has another role', async () => {
    // Test-only change through the service key: the script itself never edits a membership.
    const patch = await fetch(`${stack.apiUrl}/rest/v1/admin_memberships?user_id=eq.${userId}`, {
      method: 'PATCH',
      headers: { ...keyHeaders(key), 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'analyst' }),
    });
    expect(patch.status).toBeLessThan(300);
    const r = run(['--email', email, '--role', 'owner'], localEnv());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not changed');
    const res = await fetch(
      `${stack.apiUrl}/rest/v1/admin_memberships?select=role&user_id=eq.${userId}`,
      { headers: keyHeaders(key) },
    );
    expect(await res.json()).toEqual([{ role: 'analyst' }]);
    // Put it back for the next test.
    await fetch(`${stack.apiUrl}/rest/v1/admin_memberships?user_id=eq.${userId}`, {
      method: 'PATCH',
      headers: { ...keyHeaders(key), 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'owner' }),
    });
  });

  it('gives a role that reads nothing at aal1 (no TOTP enrolled yet)', async () => {
    // Test-only: the script sets no password, so give this throw-away local user one to obtain an
    // aal1 session. The password is random and never leaves this test.
    const password = `${randomUUID()}-Aa1`;
    const set = await fetch(`${stack.apiUrl}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: { ...keyHeaders(key), 'content-type': 'application/json' },
      body: JSON.stringify({ password, email_confirm: true }),
    });
    expect(set.status).toBe(200);

    const login = await fetch(`${stack.apiUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { ...anonHeaders(stack), 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(login.status).toBe(200);
    const session = (await login.json()) as { access_token?: string };
    const token = session.access_token;
    expect(typeof token).toBe('string');
    const claims = JSON.parse(
      Buffer.from((token as string).split('.')[1] as string, 'base64url').toString('utf8'),
    ) as { aal?: string; sub?: string };
    expect(claims.aal).toBe('aal1');
    expect(claims.sub).toBe(userId);

    const headers = {
      apikey: anonHeaders(stack)['apikey'] as string,
      authorization: `Bearer ${token}`,
    };
    // Tables the owner could read at aal2: empty at aal1.
    for (const table of [
      'audit_logs',
      'documents',
      'document_versions',
      'conversations',
      'messages',
    ]) {
      const res = await fetch(`${stack.apiUrl}/rest/v1/${table}?select=*&limit=5`, { headers });
      const body = await res.text();
      expect(res.status === 200 ? JSON.parse(body) : [], `${table} at aal1`).toEqual([]);
    }
    // The membership table is not granted to authenticated at all.
    const mem = await fetch(`${stack.apiUrl}/rest/v1/admin_memberships?select=*`, { headers });
    const memRows: unknown = mem.status === 200 ? await mem.json() : [];
    expect(Array.isArray(memRows) && memRows.length === 0).toBe(true);

    // The admin functions refuse with the MFA code; the schema version is open to any signed-in user.
    for (const [fn, body] of [
      ['admin_list_bots', {}],
      ['admin_list_members', {}],
      ['admin_get_settings', { p_bot_id: randomUUID() }],
    ] as const) {
      const res = await fetch(`${stack.apiUrl}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      const err = (await res.json()) as { code?: string };
      expect(err.code, fn).toBe('RB032');
    }
    const ver = await fetch(`${stack.apiUrl}/rest/v1/rpc/schema_version`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(ver.status).toBe(200);
    expect(await ver.json()).toBe(11);
  });
});
