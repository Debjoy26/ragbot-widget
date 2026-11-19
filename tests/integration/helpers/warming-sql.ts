// Local-only SQL harness for pending/applied warming migrations. All fixture
// rows and any pending020 DDL are rolled back before the connection closes.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const config = readFileSync(new URL('../../../supabase/config.toml', import.meta.url), 'utf8');
const project = /^project_id\s*=\s*"([A-Za-z0-9_-]+)"/m.exec(config)?.[1];
if (project === undefined) throw Error('local project identifier is missing');

export function localWarmingSql(input: string): string {
  try {
    return execFileSync(
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
      { input, encoding: 'utf8', timeout: 60_000, maxBuffer: 1 << 20 },
    ).trim();
  } catch {
    throw Error('local warming SQL harness failed');
  }
}

export function withWarmingSchema(body: string): string {
  const version = Number(localWarmingSql('select public.schema_version();'));
  if (!Number.isInteger(version) || version < 19)
    throw Error('local schema019 or later is required');
  const pending =
    version === 19
      ? readFileSync(
          new URL('../../../supabase/migrations/020_cache_warming_queue.sql', import.meta.url),
          'utf8',
        )
      : '';
  const result = localWarmingSql(`begin; ${pending}\n${body}\nrollback;`);
  if (localWarmingSql('select public.schema_version();') !== String(version)) {
    throw Error('local warming SQL harness did not preserve schema version');
  }
  return result;
}
