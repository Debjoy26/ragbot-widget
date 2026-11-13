// P8 widget unit tests: public-config validation + SWR cache (UI_SCHEMA §5).
import { describe, expect, it, vi } from 'vitest';
import {
  configCacheKey,
  loadPublicConfig,
  parseEmbedOptions,
  validatePublicConfig,
} from '../../../widget/src/public-config.ts';

const VALID_ROW = {
  bot_id: '123e4567-e89b-12d3-a456-426614174000',
  bot_slug: 'website-support',
  display_name: 'Acme Assistant',
  greeting: 'Ask about our products.',
  suggested_questions: ['What services do you offer?'],
  primary_color: '#3155D9',
  position: 'bottom-right',
  privacy_url: 'https://client.example.com/privacy',
  supported_languages: ['en', 'hi'],
  escalation_label: 'Contact support',
  escalation_messages: { en: 'Our team can help:', hi: 'हमारी टीम मदद कर सकती है:' },
  contact_email: 'support@client.example.com',
  contact_phone: '+911234567890',
  contact_whatsapp_url: 'https://wa.me/911234567890',
  contact_page_url: 'https://client.example.com/contact',
  business_hours: { 'mon-fri': '09:00-18:00' },
  timezone: 'Asia/Kolkata',
};

function headersOf(headers: Record<string, string | null>): {
  get: (name: string) => string | null;
} {
  return { get: (name: string) => headers[name.toLowerCase()] ?? null };
}

describe('parseEmbedOptions', () => {
  it('accepts a complete valid snippet', () => {
    const options = parseEmbedOptions({
      'data-bot-slug': 'website-support',
      'data-api-url': 'https://client-a-api.example.com',
      'data-supabase-url': 'https://xyz.supabase.co',
      'data-supabase-publishable-key': 'sb_publishable_TEST_KEY_FOR_TESTS',
    });
    expect(options.botSlug).toBe('website-support');
  });

  it('rejects a non-slug bot id, http api url and short key', () => {
    expect(() =>
      parseEmbedOptions({
        'data-bot-slug': 'Website Support!',
        'data-api-url': 'https://x.example.com',
        'data-supabase-url': 'https://x.supabase.co',
        'data-supabase-publishable-key': 'sb_publishable_TEST_KEY_FOR_TESTS',
      }),
    ).toThrow();
    expect(() =>
      parseEmbedOptions({
        'data-bot-slug': 'website-support',
        'data-api-url': 'http://insecure.example.com',
        'data-supabase-url': 'https://x.supabase.co',
        'data-supabase-publishable-key': 'sb_publishable_TEST_KEY_FOR_TESTS',
      }),
    ).toThrow();
  });
});

describe('validatePublicConfig', () => {
  it('accepts the documented public config shape', () => {
    const config = validatePublicConfig(VALID_ROW);
    expect(config.displayName).toBe('Acme Assistant');
    expect(config.supportedLanguages).toEqual(['en', 'hi']);
  });

  it('rejects javascript: URLs, HTML in messages and missing channels', () => {
    expect(() =>
      validatePublicConfig({ ...VALID_ROW, contact_page_url: 'javascript:alert(1)' }),
    ).toThrow();
    expect(() =>
      validatePublicConfig({
        ...VALID_ROW,
        escalation_messages: { en: '<img src=x onerror=alert(1)>', hi: 'x' },
      }),
    ).toThrow();
    const {
      contact_email: _e,
      contact_phone: _p,
      contact_whatsapp_url: _w,
      contact_page_url: _u,
      ...noChannels
    } = VALID_ROW;
    expect(() => validatePublicConfig(noChannels)).toThrow();
  });

  it('rejects a supported language without an escalation message', () => {
    expect(() =>
      validatePublicConfig({
        ...VALID_ROW,
        escalation_messages: { en: 'Our team can help:' },
      }),
    ).toThrow();
  });

  it('rejects a bad primary colour and bad phone', () => {
    expect(() => validatePublicConfig({ ...VALID_ROW, primary_color: 'red' })).toThrow();
    expect(() => validatePublicConfig({ ...VALID_ROW, contact_phone: '12345' })).toThrow();
  });
});

describe('loadPublicConfig', () => {
  it('caches with ETag and serves stale on 304', async () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    const first = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: headersOf({ etag: '"v1"' }),
      json: async () => [VALID_ROW],
    }));
    const loaded = await loadPublicConfig({
      supabaseUrl: 'https://xyz.supabase.co',
      publishableKey: 'sb_publishable_TEST_KEY_FOR_TESTS',
      botSlug: 'website-support',
      fetchFn: first,
      storage,
    });
    expect(loaded.fromCache).toBe(false);
    expect(store.has(configCacheKey('website-support'))).toBe(true);

    const second = vi.fn(async () => ({
      ok: true,
      status: 304,
      headers: headersOf({}),
      json: async () => [],
    }));
    const again = await loadPublicConfig({
      supabaseUrl: 'https://xyz.supabase.co',
      publishableKey: 'sb_publishable_TEST_KEY_FOR_TESTS',
      botSlug: 'website-support',
      fetchFn: second,
      storage,
    });
    expect(again.fromCache).toBe(true);
    expect(second).toHaveBeenCalledOnce();
  });

  it('serves stale cache when the network fails, else throws', async () => {
    const store = new Map<string, string>([
      // The cache stores the RAW server row; reads revalidate it.
      [configCacheKey('website-support'), JSON.stringify({ etag: '"v1"', raw: VALID_ROW })],
    ]);
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    const failing = vi.fn(async () => {
      throw new Error('network down');
    });
    const stale = await loadPublicConfig({
      supabaseUrl: 'https://xyz.supabase.co',
      publishableKey: 'sb_publishable_TEST_KEY_FOR_TESTS',
      botSlug: 'website-support',
      fetchFn: failing,
      storage,
    });
    expect(stale.fromCache).toBe(true);

    await expect(
      loadPublicConfig({
        supabaseUrl: 'https://xyz.supabase.co',
        publishableKey: 'sb_publishable_TEST_KEY_FOR_TESTS',
        botSlug: 'other-bot',
        fetchFn: failing,
        storage: undefined,
      }),
    ).rejects.toThrow();
  });

  it('rejects a malicious row even when the request succeeds', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: headersOf({}),
      json: async () => [{ ...VALID_ROW, contact_page_url: 'javascript:alert(1)' }],
    }));
    await expect(
      loadPublicConfig({
        supabaseUrl: 'https://xyz.supabase.co',
        publishableKey: 'sb_publishable_TEST_KEY_FOR_TESTS',
        botSlug: 'website-support',
        fetchFn,
        storage: undefined,
      }),
    ).rejects.toThrow();
  });

  it('treats throwing storage as a cold cache (P8-D3)', async () => {
    const throwing = {
      getItem: (_key: string): string | null => {
        throw new Error('denied');
      },
      setItem: (_key: string, _value: string): void => undefined,
    };
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: headersOf({}),
      json: async () => [VALID_ROW],
    }));
    const loaded = await loadPublicConfig({
      supabaseUrl: 'https://xyz.supabase.co',
      publishableKey: 'sb_publishable_TEST_KEY_FOR_TESTS',
      botSlug: 'website-support',
      fetchFn,
      storage: throwing,
    });
    expect(loaded.fromCache).toBe(false);
    expect(loaded.config.botSlug).toBe('website-support');
  });
});
