// P8 ContactCard: built only from public config plus the `handoff` event,
// never from model text (UI_SCHEMA §6.1). Links are `mailto:` from
// `contact_email`, `tel:` from `contact_phone`, `https:` for WhatsApp and the
// contact page. Business hours render with an open-now/closed hint; the card
// never claims a human has been notified.

import type { WidgetContact, WidgetHandoff, WidgetPublicConfig } from './types.js';
import { isAdminHttpsUrl, phoneE164Schema, emailSchema } from '../../shared/src/schemas.js';

export interface ContactLink {
  readonly kind: 'email' | 'phone' | 'whatsapp' | 'page';
  readonly label: string;
  readonly href: string;
}

export interface ContactCardData {
  readonly heading: string;
  readonly message: string;
  readonly links: readonly ContactLink[];
  readonly businessHoursText?: string | undefined;
  readonly openNow: boolean | null;
  readonly prominent: boolean;
}

function contactFromConfig(config: WidgetPublicConfig): WidgetContact {
  return {
    ...(config.contactEmail === undefined ? {} : { email: config.contactEmail }),
    ...(config.contactPhone === undefined ? {} : { phone: config.contactPhone }),
    ...(config.contactWhatsappUrl === undefined ? {} : { whatsappUrl: config.contactWhatsappUrl }),
    ...(config.contactPageUrl === undefined ? {} : { pageUrl: config.contactPageUrl }),
    ...(config.businessHours === undefined ? {} : { businessHours: config.businessHours }),
    ...(config.timezone === undefined ? {} : { timezone: config.timezone }),
  };
}

/** Merge server `handoff.contact` (wire shape) over config contact; handoff wins per field. */
export function mergeContact(config: WidgetPublicConfig, handoff: WidgetHandoff): WidgetContact {
  const base = contactFromConfig(config);
  const override = handoff.contact;
  return {
    email: override.email ?? base.email,
    phone: override.phone ?? base.phone,
    whatsappUrl: override.whatsapp_url ?? base.whatsappUrl,
    pageUrl: override.page_url ?? base.pageUrl,
    businessHours: override.business_hours ?? base.businessHours,
    timezone: override.timezone ?? base.timezone,
  };
}

/** Build safe, labelled links. Malicious values throw and hide the card row. */
export function buildContactLinks(
  contact: WidgetContact,
  labels: {
    readonly email: string;
    readonly phone: string;
    readonly whatsapp: string;
    readonly page: string;
  },
): ContactLink[] {
  const links: ContactLink[] = [];
  if (contact.email !== undefined) {
    if (!emailSchema.safeParse(contact.email).success) throw new Error('bad handoff email');
    links.push({ kind: 'email', label: labels.email, href: `mailto:${contact.email}` });
  }
  if (contact.phone !== undefined) {
    if (!phoneE164Schema.safeParse(contact.phone).success) throw new Error('bad handoff phone');
    links.push({ kind: 'phone', label: labels.phone, href: `tel:${contact.phone}` });
  }
  if (contact.whatsappUrl !== undefined) {
    if (!isAdminHttpsUrl(contact.whatsappUrl)) throw new Error('bad handoff whatsapp_url');
    links.push({ kind: 'whatsapp', label: labels.whatsapp, href: contact.whatsappUrl });
  }
  if (contact.pageUrl !== undefined) {
    if (!isAdminHttpsUrl(contact.pageUrl)) throw new Error('bad handoff page_url');
    links.push({ kind: 'page', label: labels.page, href: contact.pageUrl });
  }
  return links;
}

const DAY_INDEX: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function dayMatches(key: string, dayIndex: number): boolean {
  const lower = key.toLowerCase();
  if (DAY_INDEX[lower] !== undefined) return DAY_INDEX[lower] === dayIndex;
  const range = lower.split('-');
  if (range.length === 2) {
    const [start, end] = [DAY_INDEX[range[0] as string], DAY_INDEX[range[1] as string]];
    if (start === undefined || end === undefined) return false;
    if (start <= end) return dayIndex >= start && dayIndex <= end;
    return dayIndex >= start || dayIndex <= end;
  }
  return false;
}

function minutesOf(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59)
    return null;
  return hours * 60 + minutes;
}

/**
 * Open-now hint in the configured time zone. Returns null when the hours or
 * time zone are missing/invalid — the card then shows hours without a claim.
 */
export function computeOpenNow(
  businessHours: Readonly<Record<string, string>> | undefined,
  timezone: string | undefined,
  now: Date = new Date(),
): boolean | null {
  if (businessHours === undefined || timezone === undefined) return null;
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const weekday = (parts.find((p) => p.type === 'weekday')?.value ?? '')
      .slice(0, 3)
      .toLowerCase();
    const dayIndex = DAY_INDEX[weekday];
    if (dayIndex === undefined) return null;
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? Number.NaN);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? Number.NaN);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    const current = hour * 60 + minute;
    for (const [key, window] of Object.entries(businessHours)) {
      if (!dayMatches(key, dayIndex)) continue;
      const [open, close] = window.split('-');
      const openMin = open === undefined ? null : minutesOf(open);
      const closeMin = close === undefined ? null : minutesOf(close);
      if (openMin === null || closeMin === null) return null;
      if (current >= openMin && current <= closeMin) return true;
    }
    return false;
  } catch {
    return null;
  }
}

/** Assemble card data from config + handoff. Throws on malicious contact values. */
export function buildContactCard(args: {
  readonly config: WidgetPublicConfig;
  readonly handoff: WidgetHandoff;
  readonly preferredLanguage: string;
  readonly now?: Date | undefined;
}): ContactCardData {
  const { config, handoff, preferredLanguage } = args;
  // P8-D2 (review R5): a whitespace-only server message would render a blank
  // card line — fall back to the configured escalation message instead.
  const clean = handoff.message.trim();
  const message =
    clean.length > 0 && !/[<>]/.test(clean)
      ? clean
      : (config.escalationMessages[preferredLanguage] ??
        config.escalationMessages['en'] ??
        Object.values(config.escalationMessages)[0] ??
        '');
  const contact = mergeContact(config, handoff);
  const links = buildContactLinks(contact, {
    email: 'Email',
    phone: 'Call',
    whatsapp: 'WhatsApp',
    page: config.escalationLabel,
  });
  if (links.length === 0) throw new Error('contact card has no channel');
  const entries = contact.businessHours === undefined ? [] : Object.entries(contact.businessHours);
  const businessHoursText =
    entries.length === 0 ? undefined : entries.map(([day, hours]) => `${day} ${hours}`).join(' · ');
  return {
    heading: config.escalationLabel,
    message,
    links,
    ...(businessHoursText === undefined ? {} : { businessHoursText }),
    openNow: computeOpenNow(contact.businessHours, contact.timezone, args.now),
    prominent: handoff.prominent,
  };
}
