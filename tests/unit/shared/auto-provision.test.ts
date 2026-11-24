import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SUBSCRIPTION_STATUSES,
  WIDGET_KEY_PATTERN,
  subscriptionStatusSchema,
  widgetKeySchema,
  DB_ERROR_API_CODE,
  type SubscriptionStatus,
} from '@ragbot/shared';

export function makeWidgetKey(): string {
  return `wgk_${randomBytes(16).toString('hex')}`;
}

export function fingerprintWidgetKey(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function buildEmbedSnippet(args: {
  apiUrl: string;
  supabaseUrl: string;
  publishableKey: string;
  botSlug: string;
  widgetKey: string;
  widgetJsUrl: string;
}): string {
  const { apiUrl, supabaseUrl, publishableKey, botSlug, widgetKey, widgetJsUrl } = args;
  widgetKeySchema.parse(widgetKey);
  return `<script src="${widgetJsUrl}" defer data-bot-slug="${botSlug}" data-api-url="${apiUrl}" data-supabase-url="${supabaseUrl}" data-supabase-publishable-key="${publishableKey}" data-widget-key="${widgetKey}"></script>`;
}

describe('ADR-0022 auto-provision contracts', () => {
  it('generates wgk_ keys and fingerprints, never stores raw', () => {
    const raw = makeWidgetKey();
    expect(WIDGET_KEY_PATTERN.test(raw)).toBe(true);
    expect(widgetKeySchema.safeParse(raw).success).toBe(true);
    const fp = fingerprintWidgetKey(raw);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).not.toContain(raw.slice(4));
  });
  it('rejects malformed keys fail-closed', () => {
    for (const bad of ['wgk_short', 'wgk_' + 'ZZ'.repeat(16), 'bot-slug', '']) {
      expect(widgetKeySchema.safeParse(bad).success).toBe(false);
    }
  });
  it('subscription statuses are closed set with fail-closed mapping', () => {
    expect([...SUBSCRIPTION_STATUSES]).toEqual(['active', 'past_due', 'suspended', 'cancelled']);
    const s: SubscriptionStatus = subscriptionStatusSchema.parse('suspended');
    expect(s).toBe('suspended');
    expect(DB_ERROR_API_CODE.subscription_suspended).toBe('SUBSCRIPTION_SUSPENDED');
    expect(DB_ERROR_API_CODE.widget_key_revoked).toBe('WIDGET_KEY_REVOKED');
    expect(DB_ERROR_API_CODE.widget_key_host_mismatch).toBe('WIDGET_KEY_HOST_MISMATCH');
  });
  it('builds embed snippet with widget key, no secrets', () => {
    const key = makeWidgetKey();
    const html = buildEmbedSnippet({
      apiUrl: 'https://api.example.com',
      supabaseUrl: 'https://abc.supabase.co',
      publishableKey: 'sb_publishable_test',
      botSlug: 'client-a',
      widgetKey: key,
      widgetJsUrl: 'https://widget.example.com/v1.0.0/widget.js',
    });
    expect(html).toContain(`data-widget-key="${key}"`);
    expect(html).not.toContain('SECRET');
  });
});
