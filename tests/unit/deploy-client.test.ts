import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// P10-T1: scripts/deploy-client.mjs as a child process. Fixture values are
// obviously fake; the secret-like fixture must trip the validator.

const SCRIPT = fileURLToPath(new URL('../../scripts/deploy-client.mjs', import.meta.url));
const EXAMPLE = fileURLToPath(
  new URL('../../clients/example/deployment.example.json', import.meta.url),
);

function run(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, out: `${stdout}${stderr}` });
    });
  });
}

function fixture(doc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-client-'));
  const path = join(dir, 'deployment.json');
  writeFileSync(path, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return path;
}

const VALID = {
  botSlug: 'website-support',
  apiUrl: 'https://api-client.example.com',
  supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
  adminUrl: 'https://admin-client.example.com',
  widgetVersion: 'v1.0.0',
  allowedOrigins: ['https://client.example.com'],
};

describe('deploy-client', () => {
  it('accepts the shipped example shape with concrete values', async () => {
    const { code, out } = await run(['--file', fixture(VALID)]);
    expect(code).toBe(0);
    expect(out).toContain("descriptor valid for bot 'website-support'");
    expect(out).toContain('checklist');
  });

  it('rejects the example file itself (placeholders are not deployable)', async () => {
    const { code } = await run(['--file', EXAMPLE]);
    expect(code).not.toBe(0);
  });

  it('refuses a missing file', async () => {
    const { code, out } = await run(['--file', join(tmpdir(), 'does-not-exist.json')]);
    expect(code).not.toBe(0);
    expect(out).toContain('cannot read file');
  });

  it('refuses unparsable JSON', async () => {
    const { code } = await run(['--file', fixture('{oops')]);
    expect(code).not.toBe(0);
  });

  it('refuses a secret-like value', async () => {
    const { code, out } = await run([
      // Obviously fake (11 chars: the scanner allows short values) but shaped
      // like a credential, so the validator must still refuse it.
      '--file',
      fixture({ ...VALID, apiUrl: 'https://api.example.com/?token=secret-fake' }),
    ]);
    expect(code).not.toBe(0);
    expect(out).toContain('looks like a secret');
  });

  it('refuses a bad slug, non-https admin URL and empty origins', async () => {
    const { code, out } = await run([
      '--file',
      fixture({
        ...VALID,
        botSlug: 'Website_Support!',
        adminUrl: 'http://admin.example.com',
        allowedOrigins: [],
      }),
    ]);
    expect(code).not.toBe(0);
    expect(out).toContain('botSlug');
    expect(out).toContain('adminUrl');
    expect(out).toContain('allowedOrigins');
  });

  it('warns on unknown keys but still passes', async () => {
    const { code, out } = await run(['--file', fixture({ ...VALID, extraFuture: 1 })]);
    expect(code).toBe(0);
    expect(out).toContain("unknown key 'extraFuture'");
  });

  it('requires --file', async () => {
    const { code, out } = await run([]);
    expect(code).not.toBe(0);
    expect(out).toContain('usage');
  });
});
