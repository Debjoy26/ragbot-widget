import { WIDGET_KEY_RE } from './provision.mjs';
export const CLIENT_STATES = ['pending', 'approved', 'rejected', 'suspended'];
export const DEPLOY_STATES = ['pending', 'provisioning', 'live', 'failed', 'suspended'];
export function createClient({ name, email }) {
  if (!name || name.length < 1 || name.length > 128) throw new Error('invalid name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('invalid email');
  return { name, contact_email: email, status: 'pending' };
}
export function requestService({ client, botSlug, botName, origin, plan }) {
  if (!client || client.status !== 'approved') throw new Error('client not approved');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(botSlug)) throw new Error('invalid bot_slug');
  if (!botName || botName.length > 128) throw new Error('invalid bot_name');
  let host = null;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:') throw new Error('origin must be https');
    host = u.host;
  } catch {
    throw new Error('invalid origin');
  }
  if (!plan || plan.length > 64) throw new Error('invalid plan');
  return {
    bot_slug: botSlug,
    bot_name: botName,
    website_origin: origin,
    allowed_host: host,
    plan,
    state: 'pending',
  };
}
export function approveDeployment(dep) {
  if (!dep || dep.state !== 'pending') throw new Error('only pending can be approved');
  return { ...dep, state: 'provisioning' };
}
export function markLive(dep, { supabaseRef, apiUrl, widgetUrl, widgetKey }) {
  if (!dep || dep.state !== 'provisioning') throw new Error('only provisioning can go live');
  if (!WIDGET_KEY_RE.test(widgetKey)) throw new Error('invalid widget key');
  for (const u of [apiUrl, widgetUrl]) {
    const x = new URL(u);
    if (x.protocol !== 'https:') throw new Error('urls must be https');
  }
  if (!/^[a-z]{20}$/.test(supabaseRef)) throw new Error('invalid supabase ref');
  return {
    ...dep,
    supabase_ref: supabaseRef,
    api_url: apiUrl,
    widget_url: widgetUrl,
    state: 'live',
  };
}
export function scriptVisible(dep) {
  return !!dep && dep.state === 'live';
}
