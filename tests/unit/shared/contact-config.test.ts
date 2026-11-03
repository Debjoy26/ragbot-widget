import { describe, expect, it } from 'vitest';
import {
  contactBlockSchema,
  handoffContactSchema,
  publicBotConfigSchema,
  WIDGET_POSITIONS,
} from '@ragbot/shared';
import { validContactFields, validPublicConfig } from './fixtures';

const accepts = (patch: Record<string, unknown>) =>
  contactBlockSchema.safeParse({ ...validContactFields, ...patch }).success;

describe('contact block', () => {
  it('accepts a full valid block', () => {
    expect(contactBlockSchema.safeParse(validContactFields).success).toBe(true);
  });

  it('accepts a single channel (email only)', () => {
    expect(
      contactBlockSchema.safeParse({
        escalation_label: 'Help',
        escalation_messages: { en: 'Please contact us:' },
        contact_email: 'a@client.example.com',
      }).success,
    ).toBe(true);
  });

  it.each([
    ['javascript: page url', { contact_page_url: 'javascript:alert(1)' }],
    ['http: page url', { contact_page_url: 'http://client.example.com/contact' }],
    ['http: whatsapp url', { contact_whatsapp_url: 'http://wa.me/911234567890' }],
    ['data: url', { contact_page_url: 'data:text/html,<script>1</script>' }],
    ['url with credentials', { contact_page_url: 'https://u:p@client.example.com/' }],
    ['phone without plus', { contact_phone: '911234567890' }],
    ['phone with spaces', { contact_phone: '+91 12345 67890' }],
    ['phone too short', { contact_phone: '+1234' }],
    ['bad email', { contact_email: 'not-an-email' }],
    ['html in label', { escalation_label: '<b>Contact</b>' }],
    ['html in message', { escalation_messages: { en: 'Hi <script>alert(1)</script>' } }],
    ['invalid timezone', { timezone: 'Mars/Olympus' }],
    ['offset timezone', { timezone: '+05:30' }],
    ['bad hours format', { business_hours: { 'mon-fri': '9am-6pm' } }],
    ['hours end before start', { business_hours: { sat: '14:00-10:00' } }],
    ['bad weekday key', { business_hours: { monday: '09:00-18:00' } }],
    ['reversed day range', { business_hours: { 'fri-mon': '09:00-18:00' } }],
    ['bad language key', { escalation_messages: { 'not a lang': 'x' } }],
  ])('rejects %s', (_name, patch) => {
    expect(accepts(patch)).toBe(false);
  });

  it('rejects zero contact channels', () => {
    const r = contactBlockSchema.safeParse({
      escalation_label: 'Help',
      escalation_messages: { en: 'Please contact us' },
      business_hours: { sat: '10:00-14:00' },
      timezone: 'Asia/Kolkata',
    });
    expect(r.success).toBe(false);
  });

  it('rejects business_hours without a timezone', () => {
    const { timezone: _tz, ...rest } = validContactFields;
    expect(contactBlockSchema.safeParse(rest).success).toBe(false);
  });
});

describe('handoff contact', () => {
  it('accepts valid server-config contact details', () => {
    expect(
      handoffContactSchema.safeParse({ email: 'a@client.example.com', phone: '+911234567890' })
        .success,
    ).toBe(true);
  });

  it('rejects unknown keys, empty contact and unsafe urls', () => {
    expect(handoffContactSchema.safeParse({}).success).toBe(false);
    expect(handoffContactSchema.safeParse({ email: 'a@b.example.com', extra: 1 }).success).toBe(
      false,
    );
    expect(handoffContactSchema.safeParse({ page_url: 'javascript:alert(1)' }).success).toBe(false);
  });
});

describe('public bot config', () => {
  const parse = (patch: Record<string, unknown>) =>
    publicBotConfigSchema.safeParse({ ...validPublicConfig, ...patch });

  it('accepts a valid config and converts database nulls to absent values', () => {
    const r = parse({ privacy_url: null, contact_page_url: null, updated_at: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.privacy_url).toBeUndefined();
  });

  it('strips unknown keys rather than passing them to the widget', () => {
    const r = parse({ identity_prompt: 'secret', allowed_origins: ['x'] });
    expect(r.success).toBe(true);
    if (r.success) expect(Object.keys(r.data)).not.toContain('identity_prompt');
  });

  it.each(['red', '#fff', '#GGGGGG', '#3155D9; background:url(x)', 'rgb(0,0,0)', ''])(
    'rejects colour %j',
    (primary_color) => {
      expect(parse({ primary_color }).success).toBe(false);
    },
  );

  it('accepts both positions and rejects others', () => {
    for (const position of WIDGET_POSITIONS) expect(parse({ position }).success).toBe(true);
    expect(parse({ position: 'top-left' }).success).toBe(false);
  });

  it('rejects html in greeting/display name and non-https privacy url', () => {
    expect(parse({ greeting: '<img src=x onerror=alert(1)>' }).success).toBe(false);
    expect(parse({ display_name: 'A<b>' }).success).toBe(false);
    expect(parse({ privacy_url: 'http://client.example.com/privacy' }).success).toBe(false);
  });

  it('requires an escalation message for every supported language and none extra (ADR 0013)', () => {
    expect(parse({ supported_languages: ['en', 'hi'] }).success).toBe(false);
    expect(
      parse({ supported_languages: ['en'], escalation_messages: { en: 'x', hi: 'y' } }).success,
    ).toBe(false);
    expect(
      parse({
        supported_languages: ['en', 'hi'],
        escalation_messages: { en: 'Contact us:', hi: 'हमसे संपर्क करें:' },
      }).success,
    ).toBe(true);
  });

  it('requires at least one contact channel', () => {
    expect(
      parse({
        contact_email: null,
        contact_phone: null,
        contact_whatsapp_url: null,
        contact_page_url: null,
      }).success,
    ).toBe(false);
  });
});
