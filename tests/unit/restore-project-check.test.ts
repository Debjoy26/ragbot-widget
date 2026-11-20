// Synthetic transports only; no database, Storage or provider calls.
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  collect,
  compareManifest,
  countSql,
  createSqlReader,
  digestObject,
  LIMITS,
  main,
  parseArgs,
  SQL,
  validateTarget,
} from '../../scripts/check-restored-project.mjs';

const ref = 'abcdefghijklmnopqrst';
const options = () => ({ ref, confirm: ref, url: `https://${ref}.supabase.co` });
const env = () => {
  const pwd = randomBytes(20).toString('hex');
  return {
    RESTORE_DATABASE_URL: `postgresql://postgres:${pwd}@db.${ref}.supabase.co/postgres`,
    RESTORE_SERVICE_KEY: randomBytes(24).toString('hex'),
    RESTORE_PUBLISHABLE_KEY: randomBytes(24).toString('hex'),
  };
};
const manifest = () => ({
  version: 1,
  projectRef: 'tsrqponmlkjihgfedcba',
  migrations: ['001'],
  catalogSha256: 'a'.repeat(64),
  bucket: { id: 'knowledge', public: false },
  counts: { public_bot_config: '0' },
  objects: [],
});
function fakeSql(objects: unknown[] = [], tables = ['public_bot_config', 'messages']) {
  return vi.fn(async (query: string) => {
    if (query === SQL.migrations) return ['001'];
    if (query === SQL.tables) return tables;
    if (query === SQL.catalog)
      return {
        columns: [],
        grants: [],
        column_grants: [],
        policies: [],
        functions: [],
        triggers: [],
        constraints: [],
        indexes: [],
        relations: [],
        views: [],
        schemas: [],
        default_acls: [],
      };
    if (query === SQL.bucket)
      return { id: 'knowledge', public: false, file_size_limit: null, allowed_mime_types: null };
    if (query === SQL.objects) return objects;
    return '0';
  });
}

describe('restored target safety', () => {
  it('requires explicit matching target, confirmation and credentials', () => {
    for (const bad of [
      {},
      { ...options(), confirm: '' },
      { ...options(), url: 'http://invalid' },
      { ...options(), ref: '../' },
    ])
      expect(() => validateTarget(bad, env())).toThrow('restore check failed');
    expect(() => validateTarget(options(), {})).toThrow();
    expect(() => parseArgs(['--ref', ref])).toThrow();
    expect(() => parseArgs(['--capture', 'one.json', '--manifest', 'two.json'])).toThrow();
  });
  it('rejects shared dev and wrong database identity', () => {
    const protectedRef = 'rbejeqwxyxtklehuzibv';
    expect(() =>
      validateTarget(
        { ref: protectedRef, confirm: protectedRef, url: `https://${protectedRef}.supabase.co` },
        env(),
      ),
    ).toThrow();
    const password = randomBytes(20).toString('hex');
    for (const database of [
      `postgresql://postgres:${password}@unrelated.invalid/postgres`,
      `postgresql://postgres:${password}@db.${ref}.supabase.co/other`,
      `postgresql://postgres:${password}@db.${ref}.supabase.co/postgres?options=anything`,
      `postgresql://postgres.other:${password}@aws-0.pooler.supabase.com/postgres`,
    ])
      expect(() =>
        validateTarget(options(), { ...env(), RESTORE_DATABASE_URL: database }),
      ).toThrow();
  });
  it('accepts matching pooler identity', () => {
    const input = env();
    const poolerPassword = randomBytes(20).toString('hex');
    input.RESTORE_DATABASE_URL = `postgresql://postgres.${ref}:${poolerPassword}@aws-0.pooler.supabase.com/postgres`;
    expect(validateTarget(options(), input).database.user).toBe(`postgres.${ref}`);
  });
  it('uses read-only psql environment, fixed SELECTs and no credential arguments', () => {
    const input = env();
    const target = validateTarget(options(), input);
    const execute = vi.fn(() => '[]');
    const reader = createSqlReader(target, {}, execute);
    reader(SQL.migrations);
    const call = execute.mock.calls[0] as unknown as [
      string,
      string[],
      { input: string; env: Record<string, string> },
    ];
    expect(call[0]).toBe('psql');
    expect(call[1]).toContain('-X');
    expect(call[1]).toContain('ON_ERROR_STOP=1');
    expect(JSON.stringify(call[1])).not.toContain(target.database.password);
    expect(call[2].env.PGOPTIONS).toContain('default_transaction_read_only=on');
    expect(call[2].env.PGOPTIONS).toContain('statement_timeout=30000');
    expect(() => countSql('x; DELETE FROM anything')).toThrow();
    expect(() => reader('DELETE FROM anything')).toThrow();
    for (const query of [...Object.values(SQL), countSql('public_bot_config')]) {
      expect(query.startsWith('SELECT ')).toBe(true);
      expect(query.includes(';')).toBe(false);
    }
  });
  it('does not disclose subprocess errors or credentials', async () => {
    const input = env();
    const reader = createSqlReader(validateTarget(options(), input), {}, () => {
      throw new Error(input.RESTORE_SERVICE_KEY);
    });
    expect(() => reader(SQL.tables)).toThrow('restore check failed');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['--manifest', 'never-read.json'], {})).toBe(1);
      expect(error).toHaveBeenCalledWith('FAIL restored-project');
    } finally {
      error.mockRestore();
    }
  });
});

describe('bounded manifest verification', () => {
  it('never sends a non-JWT secret key as a bearer token', async () => {
    const input = env();
    let bearerSent = false;
    await collect(validateTarget(options(), input), input, {
      sql: fakeSql([{ name: 'fake-object' }]),
      fetchFn: async (url, init) => {
        if (url.includes('/storage/')) {
          if ((init.headers as Record<string, string>)?.['apikey'] !== input.RESTORE_SERVICE_KEY)
            return new Response('', { status: 403 });
          bearerSent = Object.hasOwn(init.headers ?? {}, 'authorization');
          return new Response('fake bytes');
        }
        return url.includes('/public_bot_config?')
          ? new Response('[]')
          : new Response('', { status: 403 });
      },
    });
    expect(bearerSent).toBe(false);
  });
  it('refuses public knowledge buckets even with empty object inventory', async () => {
    const input = env();
    const base = fakeSql();
    await expect(
      collect(validateTarget(options(), input), input, {
        sql: async (query) =>
          /FROM storage\.buckets/i.test(query) ? { id: 'knowledge', public: true } : base(query),
        fetchFn: async (url) =>
          url.includes('/public_bot_config?')
            ? new Response('[]')
            : new Response('', { status: 403 }),
      }),
    ).rejects.toThrow('restore check failed');
  });
  it('rejects comparing a capture against its original source project', () => {
    const same = { ...manifest(), projectRef: ref };
    expect(() => compareManifest(same, same)).toThrow('restore check failed');
  });
  it('bounds chunked public-configuration JSON before parsing', async () => {
    const input = env();
    await expect(
      collect(validateTarget(options(), input), input, {
        sql: fakeSql(),
        fetchFn: async (url) =>
          url.includes('/public_bot_config?')
            ? new Response(' '.repeat(128 * 1024) + '[]')
            : new Response('', { status: 403 }),
      }),
    ).rejects.toThrow('restore check failed');
  });
  it('uses only GET, hashes bytes and rejects anonymous exposure', async () => {
    const input = env();
    const target = validateTarget(options(), input);
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('error');
      if (url.includes('/storage/'))
        return (init.headers as Record<string, string>)?.['apikey'] === input.RESTORE_SERVICE_KEY
          ? new Response(new Uint8Array([1, 2, 3]))
          : new Response('', { status: 403 });
      return url.includes('/public_bot_config?')
        ? new Response('[]')
        : new Response('', { status: 403 });
    });
    const actual = await collect(target, input, { sql: fakeSql([{ name: 'a/b' }]), fetchFn });
    expect(actual.objects[0]?.bytes).toBe(3);
    expect(actual.objects[0]?.sha256).toHaveLength(64);
    expect(compareManifest({ ...actual, projectRef: 'tsrqponmlkjihgfedcba' }, actual)).toEqual({
      tables: 2,
      objects: 1,
    });
    await expect(
      collect(target, input, { sql: fakeSql(), fetchFn: async () => new Response('[]') }),
    ).rejects.toThrow();
  });
  it('fails on missing objects, duplicate inventory, truncation and unsafe paths', async () => {
    const input = env();
    const target = validateTarget(options(), input);
    await expect(
      collect(target, input, {
        sql: fakeSql([{ name: 'missing' }]),
        fetchFn: async () => new Response('', { status: 404 }),
      }),
    ).rejects.toThrow();
    for (const objects of [[{ name: 'a' }, { name: 'a' }], [{ name: '../x' }]])
      await expect(
        collect(target, input, {
          sql: fakeSql(objects),
          fetchFn: async (_url, init) =>
            (init.headers as Record<string, string>)?.['apikey'] === input.RESTORE_SERVICE_KEY
              ? new Response('x')
              : new Response('', { status: 403 }),
        }),
      ).rejects.toThrow();
    await expect(
      collect(target, input, { sql: fakeSql([{ name: 'a' }]), limits: { ...LIMITS, objects: 0 } }),
    ).rejects.toThrow();
    await expect(
      collect(target, input, { sql: fakeSql(), limits: { ...LIMITS, tables: 1 } }),
    ).rejects.toThrow();
  });
  it('bounds object streams', async () => {
    await expect(
      digestObject(new Response('oversized'), { ...LIMITS, objectBytes: 1 }),
    ).rejects.toThrow();
  });
  it('rejects migration, catalog, count, missing and corrupt object differences', () => {
    const base = manifest();
    const restored = { ...base, projectRef: ref };
    expect(compareManifest(base, restored)).toEqual({ tables: 1, objects: 0 });
    for (const actual of [
      { ...restored, migrations: [] },
      { ...restored, catalogSha256: 'b'.repeat(64) },
      { ...restored, counts: { public_bot_config: '1' } },
      { ...restored, objects: [{ name: 'private/path', bytes: 3, sha256: 'c'.repeat(64) }] },
    ])
      expect(() => compareManifest(base, actual)).toThrow();
    const original = {
      ...base,
      objects: [{ name: 'private/path', bytes: 3, sha256: 'c'.repeat(64) }],
    };
    expect(() =>
      compareManifest(original, {
        ...original,
        projectRef: ref,
        objects: [{ ...original.objects[0], sha256: 'd'.repeat(64) }],
      }),
    ).toThrow();
  });
});
