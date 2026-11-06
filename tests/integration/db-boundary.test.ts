import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { anonHeaders, getLocalStack, type LocalStack } from './helpers/local-stack.ts';

// P3-D5 G-19a: the anon role's reach over real HTTP (PostgREST) against the LOCAL stack.
// Needs `npm run db:start` and migrations applied (`supabase db reset`). No mocks.
// Boundary under test (handover.md section 4, DATABASE_SCHEMA grants matrix): anon can read
// public_bot_config and nothing else in the public schema.

const ALLOWED = 'public_bot_config';
const OTHER_TABLES = [
  'admin_memberships',
  'bot_profiles',
  'client_settings',
  'documents',
  'document_versions',
  'document_chunks',
  'visitor_sessions',
  'conversations',
  'request_runs',
  'messages',
  'message_sources',
  'conversation_analysis',
  'data_entries',
  'jobs',
  'usage_events',
  'rate_limit_buckets',
  'budget_reservations',
  'audit_logs',
  'query_embedding_cache',
  'moderation_cache',
  'answer_cache',
] as const;

// Statuses PostgREST uses for "refused": no grant (401/403) or relation not exposed (404).
const REFUSED = new Set([401, 403, 404]);

let stack: LocalStack;

beforeAll(() => {
  stack = getLocalStack();
});

function get(table: string): Promise<Response> {
  return fetch(`${stack.apiUrl}/rest/v1/${table}?select=*&limit=1`, {
    headers: anonHeaders(stack),
  });
}

describe('anon role boundary over HTTP (local stack)', () => {
  it('covers exactly the public tables created by the migrations', () => {
    const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
    const created = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
      const sql = readFileSync(`${dir}${file}`, 'utf8');
      for (const m of sql.matchAll(
        /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z_0-9]+)/gi,
      )) {
        created.add(m[1] as string);
      }
    }
    expect([ALLOWED, ...OTHER_TABLES].sort()).toEqual([...created].sort());
    expect(OTHER_TABLES).toHaveLength(21);
  });

  it('anon can read public_bot_config (200, JSON array)', async () => {
    const res = await get(ALLOWED);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it.each(OTHER_TABLES)('anon is refused on %s', async (table) => {
    const res = await get(table);
    const body = await res.text();
    expect(REFUSED.has(res.status), `status for ${table}: ${res.status}`).toBe(true);
    // A refusal must not carry rows.
    expect(body.trimStart().startsWith('[') && body.trim() !== '[]').toBe(false);
  });
});
