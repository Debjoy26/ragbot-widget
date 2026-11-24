// P8 public config: embed-option parsing, server-config validation and a
// stale-while-revalidate edge cache (TECH_SPECS §6.2, UI_SCHEMA §2/§5).
//
// Validation mirrors `publicBotConfigSchema` in `shared/src/schemas.ts`:
// hex colour, https URLs only, E.164 phone, email format, plain-text fields
// (no HTML), at least one contact channel, one escalation message per
// supported language. Anything else fails closed to bundled fallback branding.

import type { EmbedOptions, WidgetPublicConfig } from './types.js';
import { publicBotConfigSchema, botSlugSchema } from '../../shared/src/schemas.js';

export interface AttrMap {
  readonly [name: string]: string | undefined;
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Parse `data-*` attributes from `document.currentScript`. Fails closed. */
export function parseEmbedOptions(attrs: AttrMap): EmbedOptions {
  const botSlug = attrs['data-bot-slug'] ?? '';
  const apiUrl = attrs['data-api-url'] ?? '';
  const supabaseUrl = attrs['data-supabase-url'] ?? '';
  const supabasePublishableKey = attrs['data-supabase-publishable-key'] ?? '';
  const turnstileSiteKey = attrs['data-turnstile-site-key'];
  const widgetKey = attrs['data-widget-key'];
  if (!botSlugSchema.safeParse(botSlug).success) throw new Error('invalid data-bot-slug');
  if (!isHttpsUrl(apiUrl)) throw new Error('invalid data-api-url');
  if (!isHttpsUrl(supabaseUrl)) throw new Error('invalid data-supabase-url');
  if (supabasePublishableKey.length < 16 || /[<>]/.test(supabasePublishableKey)) {
    throw new Error('invalid data-supabase-publishable-key');
  }
  if (turnstileSiteKey !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(turnstileSiteKey)) {
    throw new Error('invalid data-turnstile-site-key');
  }
  if (widgetKey !== undefined && !/^wgk_[0-9a-f]{32}$/.test(widgetKey)) {
    throw new Error('invalid data-widget-key');
  }
  return {
    botSlug,
    apiUrl,
    supabaseUrl,
    supabasePublishableKey,
    turnstileSiteKey,
    ...(widgetKey === undefined ? {} : { widgetKey }),
  };
}

/** Validate one raw row from `public_bot_config`. Returns a typed config or throws. */
export function validatePublicConfig(raw: unknown): WidgetPublicConfig {
  const {
    bot_id: botId,
    bot_slug: botSlug,
    display_name: displayName,
    greeting,
    suggested_questions: suggestedQuestions,
    primary_color: primaryColor,
    position,
    privacy_url: privacyUrl,
    supported_languages: supportedLanguages,
    escalation_label: escalationLabel,
    escalation_messages: escalationMessages,
    contact_email: contactEmail,
    contact_phone: contactPhone,
    contact_whatsapp_url: contactWhatsappUrl,
    contact_page_url: contactPageUrl,
    business_hours: businessHours,
    timezone,
  } = publicBotConfigSchema.parse(raw);
  const langs = supportedLanguages;

  return {
    botId,
    botSlug,
    displayName,
    greeting,
    suggestedQuestions: [...(suggestedQuestions as readonly string[])],
    primaryColor,
    position,
    ...(privacyUrl === undefined ? {} : { privacyUrl: privacyUrl as string }),
    supportedLanguages: [...langs],
    escalationLabel: escalationLabel as string,
    escalationMessages: { ...(escalationMessages as Readonly<Record<string, string>>) },
    ...(contactEmail === undefined ? {} : { contactEmail: contactEmail as string }),
    ...(contactPhone === undefined ? {} : { contactPhone: contactPhone as string }),
    ...(contactWhatsappUrl === undefined
      ? {}
      : { contactWhatsappUrl: contactWhatsappUrl as string }),
    ...(contactPageUrl === undefined ? {} : { contactPageUrl: contactPageUrl as string }),
    ...(businessHours === undefined
      ? {}
      : { businessHours: { ...(businessHours as Readonly<Record<string, string>>) } }),
    ...(timezone === undefined ? {} : { timezone: timezone as string }),
  };
}

export interface ConfigFetcher {
  (
    url: string,
    init: { readonly headers: Readonly<Record<string, string>> },
  ): Promise<{
    readonly ok: boolean;
    readonly status: number;
    readonly headers: { readonly get: (name: string) => string | null };
    readonly json: () => Promise<unknown>;
  }>;
}

export interface ConfigStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export function configCacheKey(botSlug: string): string {
  return `ragbot.public-config.${botSlug}`;
}

/**
 * Load `public_bot_config` via the Supabase REST endpoint with the publishable
 * key (anon may read only this relation). Stale-while-revalidate: a cached copy
 * (with ETag) renders instantly and revalidates in the background; a 304 keeps
 * the cache. Any validation failure throws and the caller falls back to
 * bundled branding.
 */
export async function loadPublicConfig(args: {
  readonly supabaseUrl: string;
  readonly publishableKey: string;
  readonly botSlug: string;
  readonly fetchFn: ConfigFetcher;
  readonly storage?: ConfigStorage | undefined;
}): Promise<{ readonly config: WidgetPublicConfig; readonly fromCache: boolean }> {
  const { supabaseUrl, publishableKey, botSlug, fetchFn, storage } = args;
  const key = configCacheKey(botSlug);
  // Private-mode and blocked-cookie browsers can throw on storage access;
  // treat that as a cold cache, never as a boot failure.
  let cachedRaw: string | null;
  try {
    cachedRaw = storage?.getItem(key) ?? null;
  } catch {
    cachedRaw = null;
  }
  let cached: { readonly etag: string; readonly config: WidgetPublicConfig } | null = null;
  if (cachedRaw !== null) {
    try {
      // The cache stores the RAW server row (see write path below) and every
      // read revalidates it: tampered or stale entries fail closed to a miss.
      const parsed = JSON.parse(cachedRaw) as { readonly etag?: unknown; readonly raw?: unknown };
      if (typeof parsed.etag === 'string') {
        cached = { etag: parsed.etag, config: validatePublicConfig(parsed.raw) };
      }
    } catch {
      cached = null;
    }
  }

  const base = supabaseUrl.replace(/\/$/, '');
  const url =
    `${base}/rest/v1/public_bot_config` +
    `?bot_slug=eq.${encodeURIComponent(botSlug)}&select=*&limit=1`;
  const headers: Record<string, string> = {
    apikey: publishableKey,
    Authorization: `Bearer ${publishableKey}`,
    Accept: 'application/json',
  };
  if (cached !== null) headers['If-None-Match'] = cached.etag;

  let response;
  try {
    response = await fetchFn(url, { headers });
  } catch {
    if (cached !== null) return { config: cached.config, fromCache: true };
    throw new Error('public config unreachable');
  }
  if (response.status === 304 && cached !== null) {
    return { config: cached.config, fromCache: true };
  }
  if (!response.ok) {
    if (cached !== null) return { config: cached.config, fromCache: true };
    throw new Error(`public config request failed: ${response.status}`);
  }
  const body = (await response.json()) as readonly unknown[];
  const row = Array.isArray(body) ? body[0] : undefined;
  // Fail closed: a row that does not validate is never rendered and never cached.
  const config = validatePublicConfig(row);
  const etag = response.headers.get('etag');
  if (storage !== undefined && etag !== null) {
    try {
      // Store the RAW row: the read path revalidates it, so a tampered or
      // stale cache entry can never bypass validation.
      storage.setItem(key, JSON.stringify({ etag, raw: row }));
    } catch {
      // Cache write failures never break the widget.
    }
  }
  return { config, fromCache: false };
}
