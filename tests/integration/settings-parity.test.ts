import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// P3.5 settings parity (ADR 0017), SQL side. Runs every case of tests/fixtures/settings-parity.json
// through public.admin_validate_settings_patch on the LOCAL database (psql inside the DB container) and
// compares with the expected outcome the Zod side asserts too (tests/unit/shared/settings-parity.test.ts).
// Fixture JSON travels as base64 on stdin, avoiding Windows' command-line limit.
// Only the base64 alphabet is interpolated into a SQL literal, never submitted text.
// Needs the local stack with migrations applied (supabase db reset). No mocks.

interface ParityCase {
  name: string;
  valid: boolean;
  patch: unknown;
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const cases = JSON.parse(
  readFileSync(`${ROOT}tests/fixtures/settings-parity.json`, 'utf8'),
) as ParityCase[];

function containerName(): string {
  const config = readFileSync(`${ROOT}supabase/config.toml`, 'utf8');
  const m = /^project_id\s*=\s*"([^"]+)"/m.exec(config);
  if (!m) throw new Error('no project_id in supabase/config.toml');
  return `supabase_db_${m[1]}`;
}

/** First error key per case ('' when valid), in fixture order. */
let results: string[];

beforeAll(() => {
  const container = containerName();
  const out = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'psql',
      '-U',
      'postgres',
      '-X',
      '-q',
      '-At',
      '-F',
      '|',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      '-',
    ],
    {
      input:
        "select t.ord, coalesce(public.admin_validate_settings_patch(t.c), '') " +
        "from jsonb_array_elements(convert_from(decode('" +
        Buffer.from(JSON.stringify(cases.map((c) => c.patch)), 'utf8').toString('base64') +
        "', 'base64'), 'UTF8')::jsonb) with ordinality t(c, ord) order by t.ord;\n",
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 1 << 20,
    },
  );
  results = new Array<string>(cases.length).fill('<missing>');
  for (const line of out.split('\n')) {
    const m = /^(\d+)\|(.*)$/.exec(line);
    if (m) results[Number(m[1]) - 1] = m[2] as string;
  }
});

describe('settings parity fixture (SQL side, local database)', () => {
  it('returned one result per case', () => {
    expect(results).toHaveLength(cases.length);
    expect(results.includes('<missing>')).toBe(false);
  });

  it.each(cases.map((c, i) => [c.name, c, i] as const))('%s', (_name, c, i) => {
    const error = results[i];
    expect(error === '', `SQL result for this case: ${error ?? '<none>'}`).toBe(c.valid);
  });

  it('never echoes a submitted value in the error key', () => {
    for (const r of results) {
      expect(r === '' || /^_?[a-z_]+$/.test(r)).toBe(true);
    }
  });
});
