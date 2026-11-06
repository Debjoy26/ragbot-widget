import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { botSettingsPatchSchema } from '@ragbot/shared';

// P3.5 settings parity (ADR 0017). The same fixture is run against the SQL validator in
// tests/integration/settings-parity.test.ts. Each case carries the expected outcome, so a disagreement
// between the Zod whitelist and SQL fails one of the two tests. Add a case here when a rule changes.

interface ParityCase {
  name: string;
  valid: boolean;
  patch: unknown;
}

const cases = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../fixtures/settings-parity.json', import.meta.url)),
    'utf8',
  ),
) as ParityCase[];

describe('settings parity fixture (Zod side)', () => {
  it('is large enough, with unique names and both outcomes', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
    expect(cases.some((c) => c.valid)).toBe(true);
    expect(cases.some((c) => !c.valid)).toBe(true);
    for (const c of cases) expect(typeof c.valid).toBe('boolean');
  });

  it('covers every whitelisted field with a valid and an invalid case', () => {
    const fields = Object.keys(botSettingsPatchSchema.shape);
    expect(fields.length).toBe(17);
    for (const f of fields) {
      const touching = cases.filter(
        (c) => typeof c.patch === 'object' && c.patch !== null && Object.keys(c.patch).includes(f),
      );
      expect(
        touching.some((c) => c.valid && Object.keys(c.patch as object).length === 1),
        `valid case for ${f}`,
      ).toBe(true);
      expect(
        touching.some((c) => !c.valid && Object.keys(c.patch as object).length === 1),
        `invalid case for ${f}`,
      ).toBe(true);
    }
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(botSettingsPatchSchema.safeParse(c.patch).success).toBe(c.valid);
  });
});
