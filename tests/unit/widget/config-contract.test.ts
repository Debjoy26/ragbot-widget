// Synthetic public rows, shared runtime schema is the frozen boundary contract.
import { describe, expect, it } from 'vitest';
import { publicBotConfigSchema } from '../../../shared/src/schemas.ts';
import { validatePublicConfig, loadPublicConfig } from '../../../widget/src/public-config.ts';
import { buildContactLinks } from '../../../widget/src/contact-card.ts';

const row = {
  bot_id: '123e4567-e89b-12d3-a456-426614174000',
  bot_slug: 'contract-test',
  display_name: 'FAKE configured assistant',
  greeting: 'FAKE greeting',
  suggested_questions: [],
  primary_color: '#3155D9',
  position: 'bottom-right',
  supported_languages: ['en'],
  escalation_label: 'Contact support',
  escalation_messages: { en: 'FAKE help' },
  contact_email: 'help@example.com',
};
const nullable = {
  privacy_url: null,
  contact_phone: null,
  contact_whatsapp_url: null,
  contact_page_url: null,
  business_hours: null,
  timezone: null,
};

describe('public config contract at the widget boundary', () => {
  it('accepts real PostgREST-shaped nullable fields and omits absent channels', () => {
    const wire = { ...row, ...nullable };
    expect(publicBotConfigSchema.safeParse(wire).success).toBe(true);
    const result = validatePublicConfig(wire);
    expect(result.displayName).toBe(row.display_name);
    for (const key of [
      'privacyUrl',
      'contactPhone',
      'contactWhatsappUrl',
      'contactPageUrl',
      'businessHours',
      'timezone',
    ]) {
      expect(result).not.toHaveProperty(key);
    }
    expect(result.contactEmail).toBe(row.contact_email);
  });
  it('loads a nullable fetched row with configured branding', async () => {
    const result = await loadPublicConfig({
      supabaseUrl: 'https://config.invalid',
      publishableKey: `fake_${crypto.randomUUID()}`,
      botSlug: row.bot_slug,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [{ ...row, ...nullable }],
      }),
    });
    expect(result.config.displayName).toBe(row.display_name);
    expect(result.config.contactEmail).toBe(row.contact_email);
  });
  it.each(['fil', 'zh-Hant', 'es-419'])('accepts shared language tag %s', (lang) => {
    const wire = {
      ...row,
      supported_languages: [lang],
      escalation_messages: { [lang]: 'FAKE help' },
    };
    expect(publicBotConfigSchema.safeParse(wire).success).toBe(true);
    expect(validatePublicConfig(wire).supportedLanguages).toEqual([lang]);
  });
  it('accepts the shared seven-digit phone at config and contact rendering boundaries', () => {
    const wire = { ...row, contact_email: undefined, contact_phone: '+1234567' };
    expect(publicBotConfigSchema.safeParse(wire).success).toBe(true);
    expect(validatePublicConfig(wire).contactPhone).toBe(wire.contact_phone);
    expect(
      buildContactLinks(
        { phone: wire.contact_phone },
        { email: 'E', phone: 'P', whatsapp: 'W', page: 'C' },
      )[0]?.href,
    ).toBe('tel:+1234567');
  });
  it.each([
    { greeting: null },
    { contact_email: null },
    { contact_phone: '+123456' },
    { supported_languages: ['en', 'en'] },
    { escalation_messages: { en: 'FAKE help', fr: 'FAKE help' } },
    { business_hours: { bogus: '09:00-17:00' }, timezone: 'UTC' },
    { business_hours: { mon: '25:00-26:00' }, timezone: 'UTC' },
    { timezone: 'not/a-zone' },
    { escalation_label: 'x'.repeat(61) },
    { display_name: 'bad\u0001text' },
  ])('rejects invalid shared contract patch %j', (patch) => {
    const wire = { ...row, ...patch };
    expect(publicBotConfigSchema.safeParse(wire).success).toBe(false);
    expect(() => validatePublicConfig(wire)).toThrow();
  });
});
