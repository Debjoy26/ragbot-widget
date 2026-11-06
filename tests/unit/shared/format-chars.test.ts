import { describe, expect, it } from 'vitest';
import {
  botSettingsPatchSchema,
  hasFormatChars,
  isHttpsUrl,
  publicBotConfigSchema,
} from '@ragbot/shared';
import { validPublicConfig } from './fixtures';

// P35-D1 Addendum: one format-character class, shared with SQL. Applies to display_name,
// greeting, suggested_questions, escalation_label, escalation_messages values, tone, scope.
const BAD: ReadonlyArray<readonly [string, string]> = [
  ['soft hyphen', '\u00AD'],
  ['zero width space', '\u200B'],
  ['right-to-left mark', '\u200F'],
  ['left-to-right embedding', '\u202A'],
  ['right-to-left override', '\u202E'],
  ['word joiner', '\u2060'],
  ['invisible operators end', '\u206F'],
  ['BOM / zero width no-break space', '\uFEFF'],
  ['tag character start', '\u{E0000}'],
  ['tag character end', '\u{E007F}'],
  ['tag latin a', '\u{E0061}'],
];

// Characters just outside the class, plus ordinary non-ASCII text, stay allowed.
const GOOD: ReadonlyArray<readonly [string, string]> = [
  ['U+00AC just below soft hyphen', '\u00AC'],
  ['U+00AE just above soft hyphen', '\u00AE'],
  ['U+200A hair space below range', '\u200A'],
  ['U+2010 hyphen above range', '\u2010'],
  ['U+2029 below embedding range', '\u2029'],
  ['U+202F above embedding range', '\u202F'],
  ['U+205F below word joiner range', '\u205F'],
  ['U+2070 above range', '\u2070'],
  ['U+FEFE below BOM', '\uFEFE'],
  ['U+E0080 above tag block', '\u{E0080}'],
  ['accented and CJK text', 'Caf\u00E9 \u4F60\u597D'],
];

describe('hasFormatChars', () => {
  it.each(BAD)('detects %s', (_n, ch) => {
    expect(hasFormatChars(`a${ch}b`)).toBe(true);
    expect(hasFormatChars(ch)).toBe(true);
  });
  it.each(GOOD)('allows %s', (_n, ch) => {
    expect(hasFormatChars(`a${ch}b`)).toBe(false);
  });
});

const fields = {
  display_name: (v: string) => ({ display_name: v }),
  greeting: (v: string) => ({ greeting: v }),
  suggested_questions: (v: string) => ({ suggested_questions: [v] }),
  escalation_label: (v: string) => ({ escalation_label: v }),
  escalation_messages: (v: string) => ({ escalation_messages: { en: v } }),
  tone: (v: string) => ({ tone: v }),
  scope: (v: string) => ({ scope: v }),
};

describe('settings patch rejects format characters in every listed field', () => {
  for (const [field, make] of Object.entries(fields)) {
    it.each(BAD)(`${field} rejects %s`, (_n, ch) => {
      expect(botSettingsPatchSchema.safeParse(make(`ab${ch}cd`)).success).toBe(false);
    });
    it(`${field} accepts ordinary text and near-miss characters`, () => {
      expect(botSettingsPatchSchema.safeParse(make('Hello there')).success).toBe(true);
      for (const [, ch] of GOOD) {
        expect(botSettingsPatchSchema.safeParse(make(`ab${ch}cd`)).success).toBe(true);
      }
    });
  }
});

describe('public bot config rejects format characters', () => {
  it('accepts the fixture', () => {
    expect(publicBotConfigSchema.safeParse(validPublicConfig).success).toBe(true);
  });
  it.each([
    ['display_name', { display_name: 'Acme\u200BBot' }],
    ['greeting', { greeting: 'Hi\u202Ethere' }],
    ['suggested_questions', { suggested_questions: ['What\u00ADs up?'] }],
    ['escalation_label', { escalation_label: 'Con\uFEFFtact' }],
    ['escalation_messages', { escalation_messages: { en: 'Help\u{E0041}' } }],
  ])('%s', (_n, patch) => {
    expect(publicBotConfigSchema.safeParse({ ...validPublicConfig, ...patch }).success).toBe(false);
  });
});

describe('tone is single-line, scope may span lines', () => {
  it('rejects newline and carriage return in tone, and other control characters', () => {
    for (const v of ['a\nb', 'a\r\nb', 'a\rb', 'a\u0007b', 'a\u0000b', 'a\u007fb']) {
      expect(botSettingsPatchSchema.safeParse({ tone: v }).success).toBe(false);
    }
  });
  it('accepts a single-line tone, a tab included (contract: only newline and CR are rejected)', () => {
    expect(botSettingsPatchSchema.safeParse({ tone: 'Friendly\tand concise' }).success).toBe(true);
    expect(botSettingsPatchSchema.safeParse({ tone: 'Friendly and concise' }).success).toBe(true);
  });
  it('still accepts newlines in scope but not other control characters', () => {
    expect(botSettingsPatchSchema.safeParse({ scope: 'Line one\nLine two' }).success).toBe(true);
    expect(botSettingsPatchSchema.safeParse({ scope: 'a\u0000b' }).success).toBe(false);
    expect(botSettingsPatchSchema.safeParse({ scope: 'a\u0007b' }).success).toBe(false);
  });
  it('rejects tone and scope longer than their limits', () => {
    expect(botSettingsPatchSchema.safeParse({ tone: 'x'.repeat(501) }).success).toBe(false);
    expect(botSettingsPatchSchema.safeParse({ scope: 'x'.repeat(2001) }).success).toBe(false);
  });
});

describe('isHttpsUrl rejects C0 and C1 controls (S-9)', () => {
  it('accepts a plain https URL', () => {
    expect(isHttpsUrl('https://client.example.com/contact?a=1#top')).toBe(true);
  });
  it('rejects every C0 control, DEL and every C1 control anywhere in the URL', () => {
    const codes = [
      ...Array.from({ length: 0x20 }, (_, i) => i),
      ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i),
    ];
    for (const c of codes) {
      const ch = String.fromCharCode(c);
      expect(isHttpsUrl(`https://client.example.com/a${ch}b`), `U+${c.toString(16)} in path`).toBe(
        false,
      );
      expect(isHttpsUrl(`https://client.example.com${ch}`), `U+${c.toString(16)} at end`).toBe(
        false,
      );
      expect(isHttpsUrl(`${ch}https://client.example.com/`), `U+${c.toString(16)} at start`).toBe(
        false,
      );
    }
  });
  it('rejects a tab or newline that URL parsing would silently strip', () => {
    expect(isHttpsUrl('https://client.exa\tmple.com/')).toBe(false);
    expect(isHttpsUrl('https://client.example.com/pa\nth')).toBe(false);
  });
  it('is reflected in the settings patch', () => {
    expect(
      botSettingsPatchSchema.safeParse({ contact_page_url: 'https://client.example.com/a\u0085b' })
        .success,
    ).toBe(false);
  });
});
