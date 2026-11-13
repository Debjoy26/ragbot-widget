// P8 safe rendering: plain text via `textContent` unless sanitised Markdown is
// explicitly enabled (ADR 0008: off for v1). Model text, config text and
// source text are never inserted as HTML. Remote images, iframes and
// `javascript:` URLs are always rejected (UI_SCHEMA §6).

import type { WidgetSourceRef } from './types.js';

const UNSAFE_PROTOCOL = /^(javascript|data|vbscript|file):/i;
const HTTP_PROTOCOL = /^https?:$/i;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for an `https:` URL (and `http:` where explicitly allowed). */
export function isSafeWebUrl(value: string, allowHttp = false): boolean {
  try {
    const url = new URL(value);
    if (allowHttp && HTTP_PROTOCOL.test(url.protocol)) return true;
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Reject `javascript:`/`data:` links, raw HTML and non-http(s) schemes. */
export function assertSafeHref(value: string): void {
  if (UNSAFE_PROTOCOL.test(value.trim())) throw new Error('unsafe href protocol');
  if (!isSafeWebUrl(value)) throw new Error('href must be https:');
}

/**
 * Validate server `sources` for display. Only validated chunk IDs survive;
 * invented IDs/URLs are dropped (TECH_SPECS §6). Private-document sources
 * carry title/section/excerpt and never a public download URL: only an
 * `https:` URL is kept, anything else is stripped (not rejected).
 */
export function sanitizeSources(sources: readonly unknown[]): WidgetSourceRef[] {
  const out: WidgetSourceRef[] = [];
  for (const entry of sources) {
    if (!isRecord(entry)) continue;
    const {
      chunk_id: chunkId,
      title,
      section,
      excerpt,
      url,
    } = entry as Readonly<Record<string, unknown>>;
    if (typeof chunkId !== 'string' || chunkId.length === 0) continue;
    if (typeof title !== 'string' || title.length === 0 || title.length > 200) continue;
    if (/[<>]/.test(title)) continue;
    const clean: WidgetSourceRef = { chunkId, title };
    const withOptional = clean as { -readonly [K in keyof WidgetSourceRef]?: WidgetSourceRef[K] };
    if (
      typeof section === 'string' &&
      section.length > 0 &&
      section.length <= 200 &&
      !/[<>]/.test(section)
    ) {
      withOptional.section = section;
    }
    if (typeof excerpt === 'string' && excerpt.length > 0 && excerpt.length <= 1000) {
      withOptional.excerpt = excerpt;
    }
    if (typeof url === 'string' && isSafeWebUrl(url)) withOptional.url = url;
    out.push(clean);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * De-link model text: phone numbers, emails and URLs that do not match the
 * configured contact details or validated sources stay plain text (W-16).
 * This helper reports whether the model text contains a link-like token, so
 * the UI can refuse to turn it into an anchor. It never creates links.
 */
export function containsLinkLikeToken(text: string): boolean {
  return /(https?:\/\/|www\.|mailto:|tel:|[^\s@]+@[^\s@]+\.[^\s@]+|\+?\d[\d\s\-()]{7,}\d)/i.test(
    text,
  );
}
