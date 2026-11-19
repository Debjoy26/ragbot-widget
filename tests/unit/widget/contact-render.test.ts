// P8 widget unit tests: contact card + safe rendering (UI_SCHEMA §6/§6.1).
import { describe, expect, it } from 'vitest';
import {
  buildContactCard,
  buildContactLinks,
  computeOpenNow,
  mergeContact,
} from '../../../widget/src/contact-card.ts';
import {
  assertSafeHref,
  containsLinkLikeToken,
  isSafeWebUrl,
  sanitizeSources,
} from '../../../widget/src/render.ts';
import type { WidgetPublicConfig } from '../../../widget/src/types.ts';

const CONFIG: WidgetPublicConfig = {
  botId: '123e4567-e89b-12d3-a456-426614174000',
  botSlug: 'website-support',
  displayName: 'Acme Assistant',
  greeting: 'Ask about our products.',
  suggestedQuestions: [],
  primaryColor: '#3155D9',
  position: 'bottom-right',
  supportedLanguages: ['en'],
  escalationLabel: 'Contact support',
  escalationMessages: { en: 'Our team can help:' },
  contactEmail: 'support@client.example.com',
  contactPhone: '+911234567890',
  contactWhatsappUrl: 'https://wa.me/911234567890',
  contactPageUrl: 'https://client.example.com/contact',
  businessHours: { 'mon-fri': '09:00-18:00' },
  timezone: 'Asia/Kolkata',
};

describe('buildContactLinks', () => {
  it('preserves SQL URL forms for configured contact links', () => {
    const value = 'https://xn--a';
    const links = buildContactLinks(
      { pageUrl: value },
      { email: 'E', phone: 'P', whatsapp: 'W', page: 'C' },
    );
    expect(links.map((link) => link.href)).toEqual([value]);
  });
  it('rejects forms the SQL URL policy refuses', () => {
    expect(() =>
      buildContactLinks(
        { pageUrl: 'https://127.0.0.1' },
        { email: 'E', phone: 'P', whatsapp: 'W', page: 'C' },
      ),
    ).toThrow();
  });
  it('builds mailto/tel/https links from validated contact', () => {
    const links = buildContactLinks(
      {
        email: 'a@b.com',
        phone: '+911234567890',
        whatsappUrl: 'https://wa.me/1',
        pageUrl: 'https://x.example.com/c',
      },
      { email: 'Email', phone: 'Call', whatsapp: 'WhatsApp', page: 'Contact' },
    );
    expect(links.map((l) => l.href)).toEqual([
      'mailto:a@b.com',
      'tel:+911234567890',
      'https://wa.me/1',
      'https://x.example.com/c',
    ]);
  });

  it('rejects javascript: URLs and malformed email/phone', () => {
    expect(() =>
      buildContactLinks(
        { pageUrl: 'javascript:alert(1)' },
        { email: 'E', phone: 'P', whatsapp: 'W', page: 'C' },
      ),
    ).toThrow();
    expect(() =>
      buildContactLinks(
        { email: 'not-an-email' },
        { email: 'E', phone: 'P', whatsapp: 'W', page: 'C' },
      ),
    ).toThrow();
    expect(() =>
      buildContactLinks({ phone: '123' }, { email: 'E', phone: 'P', whatsapp: 'W', page: 'C' }),
    ).toThrow();
  });
});

describe('mergeContact', () => {
  it('lets the handoff override config per field', () => {
    const merged = mergeContact(CONFIG, {
      reason: 'human_requested',
      message: 'm',
      prominent: false,
      contact: { phone: '+19999999999' },
    });
    expect(merged.phone).toBe('+19999999999');
    expect(merged.email).toBe('support@client.example.com');
  });
});

describe('computeOpenNow', () => {
  // 2026-11-11 is a Wednesday.
  const wednesdayNoonUtc = new Date('2026-11-11T06:30:00.000Z'); // 12:00 in Kolkata
  const wednesdayNightUtc = new Date('2026-11-11T15:30:00.000Z'); // 21:00 in Kolkata

  it('reports open inside hours and closed outside', () => {
    expect(computeOpenNow({ 'mon-fri': '09:00-18:00' }, 'Asia/Kolkata', wednesdayNoonUtc)).toBe(
      true,
    );
    expect(computeOpenNow({ 'mon-fri': '09:00-18:00' }, 'Asia/Kolkata', wednesdayNightUtc)).toBe(
      false,
    );
  });

  it('returns null for missing or invalid timezone', () => {
    expect(computeOpenNow(undefined, undefined, wednesdayNoonUtc)).toBe(null);
    expect(computeOpenNow({ 'mon-fri': '09:00-18:00' }, 'Not/AZone', wednesdayNoonUtc)).toBe(null);
  });
});

describe('buildContactCard', () => {
  it('builds a card with links and hours hint', () => {
    const card = buildContactCard({
      config: CONFIG,
      handoff: { reason: 'no_knowledge', message: 'Try the team:', prominent: true, contact: {} },
      preferredLanguage: 'en',
      now: new Date('2026-11-11T06:30:00.000Z'),
    });
    expect(card.heading).toBe('Contact support');
    expect(card.message).toBe('Try the team:');
    expect(card.links.length).toBe(4);
    expect(card.prominent).toBe(true);
    expect(card.openNow).toBe(true);
  });

  it('falls back to the configured escalation message and throws with no channel', () => {
    const card = buildContactCard({
      config: CONFIG,
      handoff: { reason: 'blocked', message: '', prominent: false, contact: {} },
      preferredLanguage: 'en',
    });
    expect(card.message).toBe('Our team can help:');
    // P8-D2 (review R5): whitespace-only server messages fall back too.
    const blank = buildContactCard({
      config: CONFIG,
      handoff: { reason: 'blocked', message: '   ', prominent: false, contact: {} },
      preferredLanguage: 'en',
    });
    expect(blank.message).toBe('Our team can help:');
    expect(() =>
      buildContactCard({
        config: {
          ...CONFIG,
          contactEmail: undefined,
          contactPhone: undefined,
          contactWhatsappUrl: undefined,
          contactPageUrl: undefined,
        },
        handoff: { reason: 'blocked', message: 'm', prominent: false, contact: {} },
        preferredLanguage: 'en',
      }),
    ).toThrow();
  });
});

describe('safe rendering', () => {
  it('accepts https: links and rejects javascript:/data: URLs', () => {
    expect(isSafeWebUrl('https://client.example.com/contact')).toBe(true);
    expect(isSafeWebUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeWebUrl('data:text/html,<h1>x</h1>')).toBe(false);
    expect(() => assertSafeHref('javascript:alert(1)')).toThrow();
  });

  it('keeps validated sources, strips non-https URLs, drops invented rows', () => {
    const clean = sanitizeSources([
      { chunk_id: 'c1', title: 'Guide', section: 'Install', url: 'https://docs.example.com/g' },
      { chunk_id: 'c2', title: 'Private doc', excerpt: 'internal' },
      { chunk_id: 'c3', title: 'Evil', url: 'javascript:alert(1)' },
      { chunk_id: '', title: 'No id' },
      { title: 'No chunk' },
      'garbage',
    ]);
    expect(clean.map((s) => s.chunkId)).toEqual(['c1', 'c2', 'c3']);
    expect(clean[0]?.url).toBe('https://docs.example.com/g');
    expect(clean[1]?.url).toBe(undefined);
    expect(clean[2]?.url).toBe(undefined);
  });

  it('detects link-like tokens in model text so the UI keeps them plain', () => {
    expect(containsLinkLikeToken('Call +911234567890 now')).toBe(true);
    expect(containsLinkLikeToken('mail me at a@b.com')).toBe(true);
    expect(containsLinkLikeToken('see https://evil.example.com')).toBe(true);
    expect(containsLinkLikeToken('Just a plain answer.')).toBe(false);
  });
});
