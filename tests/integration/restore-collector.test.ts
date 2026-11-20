// Actual local SQL with explicitly FAKE HTTP; proves collector query compatibility,
// not a remote restore, Storage checksum or anonymous-access release gate.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { collect, createSqlReader, validateTarget } from '../../scripts/check-restored-project.mjs';

it('executes all collector SQL and relation counts on local Postgres', async () => {
  const config = readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8');
  const project = /^project_id\s*=\s*"([A-Za-z0-9_-]+)"/m.exec(config)?.[1];
  if (!project) throw new Error('local test project missing');
  const ref = 'abcdefghijklmnopqrst';
  const pw = randomBytes(12).toString('hex');
  const env = {
    RESTORE_DATABASE_URL: `postgresql://postgres:${pw}@db.${ref}.supabase.co/postgres`,
    RESTORE_SERVICE_KEY: randomBytes(16).toString('hex'),
    RESTORE_PUBLISHABLE_KEY: randomBytes(16).toString('hex'),
  };
  const target = validateTarget({ ref, confirm: ref, url: `https://${ref}.supabase.co` }, env);
  let queries = 0;
  const sql = createSqlReader(target, {}, (_command, args, options) => {
    queries++;
    return execFileSync(
      'docker',
      [
        'exec',
        '-e',
        `PGOPTIONS=${options.env['PGOPTIONS']}`,
        '-i',
        `supabase_db_${project}`,
        'psql',
        '-U',
        'postgres',
        ...args,
      ],
      {
        input: options.input,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  });
  const snapshot = await collect(target, env, {
    sql,
    fetchFn: async (url, init) => {
      if ((init.headers as Record<string, string>)['apikey'] === env.RESTORE_SERVICE_KEY)
        return new Response('FAKE original bytes');
      return url.includes('/rest/v1/public_bot_config?')
        ? new Response('[]')
        : new Response('', { status: 403 });
    },
  });
  expect(queries).toBeGreaterThan(5);
  expect(snapshot.bucket.public).toBe(false);
  expect(snapshot.catalogSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(snapshot.migrations).toContain('019');
  expect(Object.keys(snapshot.counts)).toContain('public_bot_config');
}, 180_000);
