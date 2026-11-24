import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DB_ERROR_API_CODE, DB_ERROR_STATES, ERROR_CODES, dbErrorFor } from '@ragbot/shared';

/** SQLSTATEs from the frozen P3-D5 contract: existing and new (B-11). */
const CONTRACT: ReadonlyArray<readonly [string, string]> = [
  ['RB001', 'budget_exceeded'],
  ['RB002', 'budget_policy_missing'],
  ['RB003', 'reservation_not_active'],
  ['RB004', 'request_conflict'],
  ['RB010', 'document_not_found'],
  ['RB011', 'activation_failed'],
  ['RB012', 'embedding_change_requires_reindex'],
  ['RB013', 'lease_not_held'],
  ['RB020', 'retention_policy_missing'],
  ['22023', 'invalid_argument'],
  ['23514', 'check_violation'],
  ['42501', 'permission_denied'],
  ['RB030', 'conflict'],
  ['RB031', 'file_too_large'],
  ['RB032', 'mfa_required'],
  ['RB033', 'forbidden'],
  ['RB034', 'quota_exceeded'],
  ['RB035', 'settings_invalid'],
  ['RB036', 'policy_missing'],
  ['RB037', 'not_found'],
  ['RB038', 'upload_missing'],
  ['RB039', 'bot_disabled'],
  ['RB040', 'widget_key_invalid'],
  ['RB041', 'widget_key_revoked'],
  ['RB042', 'subscription_suspended'],
  ['RB043', 'widget_key_host_mismatch'],
];

describe('dbErrorFor (G-14)', () => {
  it.each(CONTRACT)('maps %s to %s', (sqlstate, name) => {
    expect(dbErrorFor(sqlstate)).toBe(name);
  });

  it('covers exactly the contract states, no more', () => {
    expect(Object.keys(DB_ERROR_STATES).sort()).toEqual(CONTRACT.map(([s]) => s).sort());
  });

  it('uses unique, stable lowercase names', () => {
    const names = Object.values(DB_ERROR_STATES);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('returns undefined for unknown states', () => {
    for (const s of ['XX000', '23505', 'RB000', 'RB999', 'rb001', '', ' RB001', 'RB001 ']) {
      expect(dbErrorFor(s)).toBeUndefined();
    }
  });

  it('does not resolve inherited object keys', () => {
    for (const s of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(dbErrorFor(s)).toBeUndefined();
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DB_ERROR_STATES)).toBe(true);
  });

  it('keeps the API envelope codes separate from database states', () => {
    for (const code of ERROR_CODES) expect(Object.keys(DB_ERROR_STATES)).not.toContain(code);
    expect(ERROR_CODES).toHaveLength(15);
  });

  it('knows every errcode raised in the migrations on disk, not only RBxxx', () => {
    const dir = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));
    const raised = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
      const sql = readFileSync(dir + file, 'utf8').replace(/--[^\n]*/g, '');
      for (const m of sql.matchAll(/errcode\s*=\s*'([^']+)'/gi)) raised.add(m[1] as string);
    }
    expect(raised.size).toBeGreaterThan(0);
    // Standard states used by the migrations must be present, not just the RB ones.
    for (const std of ['22023', '23514', '42501'])
      expect(raised.has(std), `${std} not raised`).toBe(true);
    for (const state of raised) {
      expect(dbErrorFor(state), `${state} unmapped`).toBeDefined();
      const name = dbErrorFor(state);
      expect(
        name !== undefined && DB_ERROR_API_CODE[name],
        `${state} has no API code`,
      ).toBeTruthy();
    }
  });
});

describe('DB_ERROR_API_CODE', () => {
  it('is total over the database error names and maps only to known public codes', () => {
    expect(Object.keys(DB_ERROR_API_CODE).sort()).toEqual(
      [...Object.values(DB_ERROR_STATES)].sort(),
    );
    for (const code of Object.values(DB_ERROR_API_CODE)) {
      expect((ERROR_CODES as readonly string[]).includes(code)).toBe(true);
    }
  });

  it('maps the authorisation and limit states as documented', () => {
    expect(DB_ERROR_API_CODE.budget_exceeded).toBe('BUDGET_EXCEEDED');
    expect(DB_ERROR_API_CODE.quota_exceeded).toBe('RATE_LIMITED');
    for (const n of ['forbidden', 'mfa_required', 'permission_denied'] as const) {
      expect(DB_ERROR_API_CODE[n]).toBe('FORBIDDEN');
    }
    expect(DB_ERROR_API_CODE.not_found).toBe('INVALID_REQUEST');
    expect(DB_ERROR_API_CODE.conflict).toBe('INVALID_REQUEST');
  });

  it('does not map unknown names and is frozen', () => {
    expect(Object.isFrozen(DB_ERROR_API_CODE)).toBe(true);
    expect(Object.hasOwn(DB_ERROR_API_CODE, 'unknown_error')).toBe(false);
  });
});
