import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROLES,
  ANALYSIS_STATUSES,
  BUDGET_RESERVATION_STATES,
  CONVERSATION_STATUSES,
  DISCLOSURE_POLICIES,
  DOCUMENT_STATUSES,
  DOCUMENT_VERSION_STATUSES,
  EXTRACTION_METHODS,
  FAILURE_CODES,
  HANDOFF_REASONS,
  JOB_STATES,
  JOB_TYPES,
  MEDIA_TYPES,
  MESSAGE_ROLES,
  MESSAGE_STATUSES,
  MODERATION_VERDICTS,
  REQUEST_RUN_STATES,
  SENTIMENTS,
  USAGE_OPERATIONS,
  WIDGET_POSITIONS,
} from '@ragbot/shared';

// G-12: compares the TypeScript value lists with the enum-like CHECK constraints in the
// migrations on disk.
export interface EnumCheck {
  readonly constraint: string;
  readonly column: string;
  readonly values: readonly string[];
}

/** Extracts `constraint <name> check (<col> [is null or <col>] in ('a', 'b', ...))` definitions. */
export function parseEnumChecks(sql: string): EnumCheck[] {
  const text = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');
  const re =
    /constraint (\w+) check ?\( ?(?:(\w+) is null or )?(\w+) in ?\( ?((?:'[^']*' ?,? ?)+)\) ?\)/gi;
  const out: EnumCheck[] = [];
  for (const m of text.matchAll(re)) {
    if (m[2] !== undefined && m[2] !== m[3]) continue;
    const values = [...(m[4] as string).matchAll(/'([^']*)'/g)].map((v) => v[1] as string);
    out.push({ constraint: (m[1] as string).toLowerCase(), column: m[3] as string, values });
  }
  return out;
}

export function diffLists(
  sql: readonly string[],
  ts: readonly string[],
): { onlyInSql: string[]; onlyInTs: string[]; duplicates: string[] } {
  const s = new Set(sql);
  const t = new Set(ts);
  return {
    onlyInSql: sql.filter((v) => !t.has(v)),
    onlyInTs: ts.filter((v) => !s.has(v)),
    duplicates: [...new Set([sql, ts].flatMap((l) => l.filter((v, i) => l.indexOf(v) !== i)))],
  };
}

describe('SQL CHECK parser', () => {
  const sample = `
    create table t (
      -- constraint commented_out_check check (x in ('no'))
      constraint a_status_check check (status in ('one', 'two',
        'three')),
      constraint b_method_check check (method is null or method in ('m1', 'm2')),
      constraint c_other_check check (amount >= 0),
      constraint d_mismatch_check check (x is null or y in ('p', 'q'))
    );
    alter table t add constraint e_added_check check (kind in ('k'));
  `;

  it('extracts multi-line, nullable and added constraints, and skips the rest', () => {
    expect(parseEnumChecks(sample)).toEqual([
      { constraint: 'a_status_check', column: 'status', values: ['one', 'two', 'three'] },
      { constraint: 'b_method_check', column: 'method', values: ['m1', 'm2'] },
      { constraint: 'e_added_check', column: 'kind', values: ['k'] },
    ]);
  });

  it('finds nothing in SQL without enum checks', () => {
    expect(parseEnumChecks('create table t (id int);')).toEqual([]);
  });
});

describe('list comparison', () => {
  it('passes for equal sets in any order', () => {
    const d = diffLists(['a', 'b'], ['b', 'a']);
    expect(d).toEqual({ onlyInSql: [], onlyInTs: [], duplicates: [] });
  });

  it('reports a value added in SQL only', () => {
    expect(diffLists(['a', 'b', 'c'], ['a', 'b']).onlyInSql).toEqual(['c']);
  });

  it('reports a value added in TypeScript only', () => {
    expect(diffLists(['a'], ['a', 'z']).onlyInTs).toEqual(['z']);
  });

  it('reports duplicates', () => {
    expect(diffLists(['a', 'a'], ['a']).duplicates).toEqual(['a']);
  });
});

/** Constraint name (as declared in the migrations) to the TypeScript list it must equal. */
const EXPECTED: Record<string, readonly string[]> = {
  admin_memberships_role_check: ADMIN_ROLES,
  public_bot_config_position_check: WIDGET_POSITIONS,
  documents_status_check: DOCUMENT_STATUSES,
  documents_disclosure_policy_check: DISCLOSURE_POLICIES,
  document_versions_media_type_check: MEDIA_TYPES,
  document_versions_extraction_method_check: EXTRACTION_METHODS,
  document_versions_status_check: DOCUMENT_VERSION_STATUSES,
  document_versions_failure_code_check: FAILURE_CODES,
  conversations_status_check: CONVERSATION_STATUSES,
  request_runs_state_check: REQUEST_RUN_STATES,
  messages_role_check: MESSAGE_ROLES,
  messages_status_check: MESSAGE_STATUSES,
  messages_handoff_reason_check: HANDOFF_REASONS,
  answer_cache_handoff_reason_check: HANDOFF_REASONS,
  conversation_analysis_status_check: ANALYSIS_STATUSES,
  conversation_analysis_sentiment_check: SENTIMENTS,
  jobs_type_check: JOB_TYPES,
  jobs_state_check: JOB_STATES,
  budget_reservations_state_check: BUDGET_RESERVATION_STATES,
  usage_events_operation_check: USAGE_OPERATIONS,
  moderation_cache_verdict_check: MODERATION_VERDICTS,
};

function loadAppliedChecks(): Map<string, EnumCheck> {
  const dir = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  expect(files[0]).toBe('001_core.sql');
  const latest = new Map<string, EnumCheck>();
  // Later migrations override earlier definitions of the same constraint name.
  for (const file of files) {
    for (const check of parseEnumChecks(readFileSync(dir + file, 'utf8'))) {
      latest.set(check.constraint, check);
    }
  }
  return latest;
}

describe('TypeScript value lists match the migrations on disk (G-12)', () => {
  const checks = loadAppliedChecks();

  it('finds every expected constraint', () => {
    const missing = Object.keys(EXPECTED).filter((name) => !checks.has(name));
    expect(missing).toEqual([]);
  });

  it.each(Object.entries(EXPECTED))('%s equals its TypeScript list', (name, ts) => {
    const check = checks.get(name);
    expect(check, `${name} not found in migrations`).toBeDefined();
    const d = diffLists(check?.values ?? [], ts);
    expect(d).toEqual({ onlyInSql: [], onlyInTs: [], duplicates: [] });
  });

  it('reports no enum-like CHECK that has no TypeScript counterpart', () => {
    const unknown = [...checks.values()]
      .filter((c) => !(c.constraint in EXPECTED))
      .map((c) => c.constraint);
    expect(unknown).toEqual([]);
  });
});
