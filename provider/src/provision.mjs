import { createHash, randomBytes } from 'node:crypto';
export const WIDGET_KEY_RE = /^wgk_[0-9a-f]{32}$/;
export function makeWidgetKey() {
  return `wgk_${randomBytes(16).toString('hex')}`;
}
export function fingerprintWidgetKey(raw) {
  if (!WIDGET_KEY_RE.test(raw)) throw new Error('invalid widget key');
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}
export function buildEmbedSnippet({
  apiUrl,
  supabaseUrl,
  publishableKey,
  botSlug,
  widgetKey,
  widgetJsUrl,
}) {
  if (!WIDGET_KEY_RE.test(widgetKey)) throw new Error('invalid widget key');
  return `<script src="${widgetJsUrl}" defer data-bot-slug="${botSlug}" data-api-url="${apiUrl}" data-supabase-url="${supabaseUrl}" data-supabase-publishable-key="${publishableKey}" data-widget-key="${widgetKey}"></script>`;
}
export const PROVISION_STEPS = [
  'create-supabase-project',
  'db-create-001-029',
  'auth-hardening',
  'first-admin-bot-settings',
  'render-api-worker',
  'vercel-widget-admin',
  'turnstile-dns',
  'sync-subscription-key',
  'emit-script',
];
