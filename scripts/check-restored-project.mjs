#!/usr/bin/env node
// Read-only restore evidence collector. Never runs a restore or a provider call.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PROTECTED = 'rbejeqwxyxtklehuzibv';
export const LIMITS = Object.freeze({
  tables: 200,
  objects: 10000,
  objectBytes: 100 * 1024 * 1024,
  totalBytes: 1024 ** 3,
  jsonBytes: 64 * 1024,
});
const CATALOG_SECTIONS = [
  'columns',
  'grants',
  'column_grants',
  'policies',
  'functions',
  'triggers',
  'constraints',
  'indexes',
  'relations',
  'views',
  'schemas',
  'default_acls',
];
const fail = () => {
  throw new Error('restore check failed');
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const ident = (name) => {
  if (typeof name !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(name)) fail();
  return `"${name}"`;
};

export function validateTarget({ ref, url, confirm }, env) {
  if (!/^[a-z]{20}$/.test(ref ?? '') || ref === PROTECTED || confirm !== ref) fail();
  if (url !== `https://${ref}.supabase.co`) fail();
  if (!env.RESTORE_DATABASE_URL || !env.RESTORE_SERVICE_KEY || !env.RESTORE_PUBLISHABLE_KEY) fail();
  let db;
  try {
    db = new URL(env.RESTORE_DATABASE_URL);
  } catch {
    fail();
  }
  if (
    !['postgres:', 'postgresql:'].includes(db.protocol) ||
    !db.password ||
    db.pathname !== '/postgres' ||
    db.hash
  )
    fail();
  const user = decodeURIComponent(db.username);
  const direct = db.hostname === `db.${ref}.supabase.co` && user === 'postgres';
  const pooler =
    /^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(db.hostname) && user === `postgres.${ref}`;
  if (!direct && !pooler) fail();
  if (
    [...db.searchParams].some(
      ([key, value]) => key !== 'sslmode' || !['require', 'verify-full'].includes(value),
    )
  )
    fail();
  return {
    ref,
    url,
    database: {
      host: db.hostname,
      port: db.port || '5432',
      user,
      password: decodeURIComponent(db.password),
      sslmode: db.searchParams.get('sslmode') || 'require',
    },
  };
}

// No manifest-provided SQL. Catalog definitions are data; they are never executed.
export const SQL = Object.freeze({
  migrations: `SELECT coalesce(json_agg(version ORDER BY version),'[]'::json) FROM supabase_migrations.schema_migrations`,
  tables: `SELECT coalesce(json_agg(name ORDER BY name),'[]'::json) FROM (SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') ORDER BY c.relname LIMIT 201) t`,
  catalog: `SELECT json_build_object(
    'columns',(SELECT coalesce(json_agg(t ORDER BY table_schema,table_name,ordinal_position),'[]'::json) FROM information_schema.columns t WHERE table_schema IN ('public','storage')),
    'grants',(SELECT coalesce(json_agg(t ORDER BY table_schema,table_name,grantee,privilege_type),'[]'::json) FROM information_schema.table_privileges t WHERE table_schema IN ('public','storage')),
    'column_grants',(SELECT coalesce(json_agg(t ORDER BY table_schema,table_name,column_name,grantee,privilege_type),'[]'::json) FROM information_schema.column_privileges t WHERE table_schema IN ('public','storage')),
    'policies',(SELECT coalesce(json_agg(t ORDER BY schemaname,tablename,policyname),'[]'::json) FROM pg_catalog.pg_policies t WHERE schemaname IN ('public','storage')),
    'functions',(SELECT coalesce(json_agg(t ORDER BY identity),'[]'::json) FROM (SELECT p.oid::regprocedure::text AS identity, pg_get_functiondef(p.oid) AS definition, p.proacl::text AS acl, p.proowner::regrole::text AS owner FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','storage') AND p.prokind='f') t),
    'triggers',(SELECT coalesce(json_agg(t ORDER BY identity),'[]'::json) FROM (SELECT n.nspname || '.' || c.relname || '.' || t.tgname AS identity, pg_get_triggerdef(t.oid) AS definition, t.tgenabled AS enabled FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','storage') AND NOT t.tgisinternal) t),
    'constraints',(SELECT coalesce(json_agg(t ORDER BY identity),'[]'::json) FROM (SELECT n.nspname || '.' || c.relname || '.' || k.conname AS identity, pg_get_constraintdef(k.oid) AS definition, k.convalidated AS validated FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','storage')) t),
    'indexes',(SELECT coalesce(json_agg(t ORDER BY identity),'[]'::json) FROM (SELECT n.nspname || '.' || c.relname AS identity, pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid, i.indisready AS ready, i.indislive AS live FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','storage')) t),
    'relations',(SELECT coalesce(json_agg(t ORDER BY identity),'[]'::json) FROM (SELECT n.nspname || '.' || c.relname AS identity, c.relkind AS kind, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls, c.relowner::regrole::text AS owner, c.relacl::text AS acl, c.reloptions AS options FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','storage') AND c.relkind IN ('r','p','v','m','S')) t),
    'views',(SELECT coalesce(json_agg(t ORDER BY identity),'[]'::json) FROM (SELECT n.nspname || '.' || c.relname AS identity, pg_get_viewdef(c.oid,true) AS definition FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','storage') AND c.relkind IN ('v','m')) t),
    'schemas',(SELECT coalesce(json_agg(t ORDER BY name),'[]'::json) FROM (SELECT nspname AS name, nspowner::regrole::text AS owner, nspacl::text AS acl FROM pg_catalog.pg_namespace WHERE nspname IN ('public','storage')) t),
    'default_acls',(SELECT coalesce(json_agg(t ORDER BY namespace,owner,kind),'[]'::json) FROM (SELECT coalesce(n.nspname,'*') AS namespace, d.defaclrole::regrole::text AS owner, d.defaclobjtype AS kind, d.defaclacl::text AS acl FROM pg_catalog.pg_default_acl d LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace WHERE d.defaclnamespace=0 OR n.nspname IN ('public','storage')) t))`,
  bucket: `SELECT json_build_object('id',id,'public',public,'file_size_limit',file_size_limit,'allowed_mime_types',allowed_mime_types) FROM storage.buckets WHERE id='knowledge'`,
  objects: `SELECT coalesce(json_agg(t ORDER BY name),'[]'::json) FROM (SELECT name FROM storage.objects WHERE bucket_id='knowledge' ORDER BY name LIMIT 10001) t`,
});

export function countSql(table) {
  return `SELECT to_json(count(*)::text) FROM public.${ident(table)}`;
}

export function createSqlReader(target, environment = process.env, execute = execFileSync) {
  const db = target.database;
  return (sql) => {
    if (!sql.startsWith('SELECT ') || sql.includes(';')) fail();
    try {
      const output = execute('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
        input: sql,
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: environment.PATH ?? '',
          SystemRoot: environment.SystemRoot ?? '',
          PGHOST: db.host,
          PGPORT: db.port,
          PGUSER: db.user,
          PGPASSWORD: db.password,
          PGDATABASE: 'postgres',
          PGSSLMODE: db.sslmode,
          PGCONNECT_TIMEOUT: '10',
          PGOPTIONS:
            '-c default_transaction_read_only=on -c statement_timeout=30000 -c search_path=pg_catalog',
        },
      });
      return JSON.parse(output.trim());
    } catch {
      fail();
    }
  };
}

async function request(fetchFn, url, headers) {
  try {
    return await fetchFn(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    fail();
  }
}

function keyHeaders(key) {
  const headers = { apikey: key };
  if (key.split('.').length === 3) headers.authorization = `Bearer ${key}`;
  return headers;
}

async function boundedJson(response, maxBytes) {
  if (!response.body) fail();
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) fail();
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

export async function digestObject(response, limits = LIMITS) {
  if (!response.ok || !response.body) fail();
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > limits.objectBytes) fail();
      digest.update(chunk);
    }
  } catch {
    fail();
  }
  return { bytes, sha256: digest.digest('hex') };
}

export async function collect(
  target,
  env,
  { sql = createSqlReader(target), fetchFn = fetch, limits = LIMITS } = {},
) {
  try {
    const migrations = await sql(SQL.migrations);
    const tables = await sql(SQL.tables);
    const catalog = await sql(SQL.catalog);
    const bucket = await sql(SQL.bucket);
    const inventory = await sql(SQL.objects);
    if (
      !Array.isArray(migrations) ||
      !migrations.length ||
      !migrations.every((v) => typeof v === 'string')
    )
      fail();
    if (
      !Array.isArray(tables) ||
      !tables.length ||
      tables.length > limits.tables ||
      new Set(tables).size !== tables.length
    )
      fail();
    if (
      !catalog ||
      typeof catalog !== 'object' ||
      Array.isArray(catalog) ||
      Object.keys(catalog).length !== CATALOG_SECTIONS.length ||
      CATALOG_SECTIONS.some((key) => !Array.isArray(catalog[key]))
    )
      fail();
    if (!bucket || bucket.id !== 'knowledge' || bucket.public !== false) fail();
    if (!Array.isArray(inventory) || inventory.length > limits.objects) fail();
    const counts = Object.create(null);
    for (const table of tables) {
      const count = await sql(countSql(table));
      if (!/^\d+$/.test(String(count))) fail();
      counts[table] = String(count);
    }
    const objects = [];
    let total = 0;
    const seen = new Set();
    for (const row of inventory) {
      const name = row?.name;
      if (
        typeof name !== 'string' ||
        !name ||
        name.length > 1024 ||
        seen.has(name) ||
        name.split('/').some((p) => !p || p === '.' || p === '..') ||
        Array.from(name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      )
        fail();
      seen.add(name);
      const path = name.split('/').map(encodeURIComponent).join('/');
      const response = await request(
        fetchFn,
        `${target.url}/storage/v1/object/authenticated/knowledge/${path}`,
        keyHeaders(env.RESTORE_SERVICE_KEY),
      );
      const content = await digestObject(response, limits);
      total += content.bytes;
      if (total > limits.totalBytes) fail();
      objects.push({ name, ...content });
      for (const route of ['public', 'authenticated']) {
        const anonymous = await request(
          fetchFn,
          `${target.url}/storage/v1/object/${route}/knowledge/${path}`,
          keyHeaders(env.RESTORE_PUBLISHABLE_KEY),
        );
        if (![400, 401, 403, 404].includes(anonymous.status)) fail();
        await anonymous.body?.cancel().catch(() => {});
      }
    }
    // Use the actual table inventory: a newly exposed table must fail too.
    for (const table of tables) {
      const response = await request(
        fetchFn,
        `${target.url}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`,
        keyHeaders(env.RESTORE_PUBLISHABLE_KEY),
      );
      if (table === 'public_bot_config') {
        if (response.status !== 200) fail();
        const body = await boundedJson(response, limits.jsonBytes);
        if (!Array.isArray(body)) fail();
      } else if (![401, 403, 404].includes(response.status)) fail();
      await response.body?.cancel().catch(() => {});
    }
    if (!tables.includes('public_bot_config')) fail();
    return {
      version: 1,
      projectRef: target.ref,
      migrations,
      catalogSha256: hash(canonical(catalog)),
      bucket,
      counts,
      objects,
    };
  } catch {
    fail();
  }
}

export function compareManifest(expected, actual) {
  // Exact shape comparison also rejects omitted inventory/count/catalog fields.
  if (
    !expected ||
    !actual ||
    expected.version !== 1 ||
    actual.version !== 1 ||
    !/^[a-z]{20}$/.test(expected.projectRef ?? '') ||
    !/^[a-z]{20}$/.test(actual.projectRef ?? '') ||
    expected.projectRef === actual.projectRef
  )
    fail();
  const { projectRef: sourceRef, ...source } = expected;
  const { projectRef: targetRef, ...restored } = actual;
  if (sourceRef === targetRef || canonical(source) !== canonical(restored)) fail();
  return { tables: Object.keys(actual.counts).length, objects: actual.objects.length };
}

export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (
      !['--ref', '--url', '--confirm', '--manifest', '--capture'].includes(key) ||
      !args[i + 1] ||
      options[key.slice(2)] !== undefined
    )
      fail();
    options[key.slice(2)] = args[i + 1];
  }
  if (Boolean(options.manifest) === Boolean(options.capture)) fail();
  return options;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  try {
    const options = parseArgs(args);
    const target = validateTarget(options, env);
    const actual = await collect(target, env);
    if (options.capture) {
      writeFileSync(options.capture, `${JSON.stringify(actual, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      console.log(
        `PASS capture tables=${Object.keys(actual.counts).length} objects=${actual.objects.length}`,
      );
    } else {
      const expected = JSON.parse(readFileSync(options.manifest, 'utf8'));
      const result = compareManifest(expected, actual);
      console.log(`PASS restored-project tables=${result.tables} objects=${result.objects}`);
    }
    return 0;
  } catch {
    // Never print exception messages: psql/fetch/filesystem errors may contain secrets or object keys.
    console.error('FAIL restored-project');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
