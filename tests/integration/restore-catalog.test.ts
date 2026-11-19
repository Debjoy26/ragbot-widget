// Real LOCAL catalog-only drift simulation. Every fixture change rolls back.
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { SQL } from '../../scripts/check-restored-project.mjs';

let digests: string[];
beforeAll(() => {
  const config = readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8');
  const project = /^project_id\s*=\s*"([A-Za-z0-9_-]+)"/m.exec(config)?.[1];
  if (!project) throw new Error('local test project missing');
  const name = `restore_${randomUUID().replaceAll('-', '')}`;
  // Hex framing keeps each potentially multiline JSON snapshot on one line.
  const snapshot = `SELECT encode(convert_to((${SQL.catalog})::text, 'UTF8'), 'hex');\n`;
  const input = `begin;
    create table public.${name}(id integer);
    create view public.${name}_view as select 1 as value;
    create function public.${name}_guard() returns trigger language plpgsql as $$begin return new; end;$$;
    create trigger restore_guard before insert on public.${name} for each row execute function public.${name}_guard();
    ${snapshot}
    alter table public.${name} enable row level security;
    ${snapshot}
    create or replace view public.${name}_view as select 2 as value;
    ${snapshot}
    alter table public.${name} disable trigger restore_guard;
    ${snapshot}
    alter default privileges in schema public grant select on tables to anon;
    ${snapshot}
    rollback;
  `;
  const output = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      `supabase_db_${project}`,
      'psql',
      '-U',
      'postgres',
      '-X',
      '-q',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      '-',
    ],
    {
      input,
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  digests = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) =>
      createHash('sha256')
        .update(JSON.stringify(JSON.parse(Buffer.from(line, 'hex').toString('utf8')) as unknown))
        .digest('hex'),
    );
  if (digests.length !== 5) throw new Error('local catalog snapshots incomplete');
}, 120_000);

it('detects changing only RLS enabled state', () => {
  expect(digests[0] === digests[1]).toBe(false);
});
it('detects changing only a view definition', () => {
  expect(digests[1] === digests[2]).toBe(false);
});
it('detects changing only trigger enabled state', () => {
  expect(digests[2] === digests[3]).toBe(false);
});
it('detects changing only default privileges', () => {
  expect(digests[3] === digests[4]).toBe(false);
});
