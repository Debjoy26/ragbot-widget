// P8 public config: embed-option parsing, server-config validation and a
// stale-while-revalidate edge cache (TECH_SPECS §6.2, UI_SCHEMA §2/§5).
//
// Validation mirrors `publicBotConfigSchema` in `shared/src/schemas.ts`:
// hex colour, https URLs only, E.164 phone, email format, plain-text fields
// (no HTML), at least one contact channel, one escalation message per
// supported language. Anything else fails closed to bundled fallback branding.

import type { EmbedOptions, WidgetPublicConfig } from './types.js';

export interface AttrMap {
  readonly [name: string]: string | undefined;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const BOT_SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164 = /^\+[1-9]\d{7,14}$/;
const NO_HTML = /[<>]/;
const BUSINESS_HOURS_VALUE = /^\d{2}:\d{2}-\d{2}:\d{2}$/;

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function plainText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= max && !NO_HTML.test(value)
  );
}

/** Parse `data-*` attributes from `document.currentScript`. Fails closed. */
export function parseEmbedOptions(attrs: AttrMap): EmbedOptions {
  const botSlug = attrs['data-bot-slug'] ?? '';
  const apiUrl = attrs['data-api-url'] ?? '';
  const supabaseUrl = attrs['data-supabase-url'] ?? '';
  const supabasePublishableKey = attrs['data-supabase-publishable-key'] ?? '';
  if (!BOT_SLUG.test(botSlug)) throw new Error('invalid data-bot-slug');
  if (!isHttpsUrl(apiUrl)) throw new Error('invalid data-api-url');
  if (!isHttpsUrl(supabaseUrl)) throw new Error('invalid data-supabase-url');
  if (supabasePublishableKey.length < 16 || NO_HTML.test(supabasePublishableKey)) {
    throw new Error('invalid data-supabase-publishable-key');
  }
  return { botSlug, apiUrl, supabaseUrl, supabasePublishableKey };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate one raw row from `public_bot_config`. Returns a typed config or throws. */
export function validatePublicConfig(raw: unknown): WidgetPublicConfig {
  if (!isRecord(raw)) throw new Error('public config is not an object');
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
  } = raw as Readonly<Record<string, unknown>>;

  if (typeof botId !== 'string' || botId.length === 0) throw new Error('bad bot_id');
  if (typeof botSlug !== 'string' || !BOT_SLUG.test(botSlug)) throw new Error('bad bot_slug');
  if (!plainText(displayName, 80)) throw new Error('bad display_name');
  if (!plainText(greeting, 500)) throw new Error('bad greeting');
  if (
    !Array.isArray(suggestedQuestions) ||
    suggestedQuestions.length > 6 ||
    !suggestedQuestions.every((q) => plainText(q, 200))
  ) {
    throw new Error('bad suggested_questions');
  }
  if (typeof primaryColor !== 'string' || !HEX_COLOR.test(primaryColor)) {
    throw new Error('bad primary_color');
  }
  if (position !== 'bottom-right' && position !== 'bottom-left') throw new Error('bad position');
  if (privacyUrl !== undefined && (typeof privacyUrl !== 'string' || !isHttpsUrl(privacyUrl))) {
    throw new Error('bad privacy_url');
  }
  if (
    !Array.isArray(supportedLanguages) ||
    supportedLanguages.length === 0 ||
    !supportedLanguages.every((l) => typeof l === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(l))
  ) {
    throw new Error('bad supported_languages');
  }
  if (!plainText(escalationLabel, 80)) throw new Error('bad escalation_label');
  if (!isRecord(escalationMessages)) throw new Error('bad escalation_messages');
  const langs = supportedLanguages as readonly string[];
  for (const lang of langs) {
    if (!plainText((escalationMessages as Readonly<Record<string, unknown>>)[lang], 500)) {
      throw new Error(`missing escalation message for ${lang}`);
    }
  }

  if (
    contactEmail !== undefined &&
    (typeof contactEmail !== 'string' || !EMAIL.test(contactEmail))
  ) {
    throw new Error('bad contact_email');
  }
  if (
    contactPhone !== undefined &&
    (typeof contactPhone !== 'string' || !E164.test(contactPhone))
  ) {
    throw new Error('bad contact_phone');
  }
  if (
    contactWhatsappUrl !== undefined &&
    (typeof contactWhatsappUrl !== 'string' || !isHttpsUrl(contactWhatsappUrl))
  ) {
    throw new Error('bad contact_whatsapp_url');
  }
  if (
    contactPageUrl !== undefined &&
    (typeof contactPageUrl !== 'string' || !isHttpsUrl(contactPageUrl))
  ) {
    throw new Error('bad contact_page_url');
  }
  if (
    contactEmail === undefined &&
    contactPhone === undefined &&
    contactWhatsappUrl === undefined &&
    contactPageUrl === undefined
  ) {
    throw new Error('at least one contact channel is required');
  }
  if (businessHours !== undefined) {
    if (!isRecord(businessHours)) throw new Error('bad business_hours');
    for (const [day, hours] of Object.entries(businessHours)) {
      if (typeof hours !== 'string' || !BUSINESS_HOURS_VALUE.test(hours)) {
        throw new Error(`bad business_hours for ${day}`);
      }
    }
    if (typeof timezone !== 'string' || timezone.length === 0) {
      throw new Error('timezone is required with business_hours');
    }
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
      throw new Error('bad timezone');
    }
  }

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
