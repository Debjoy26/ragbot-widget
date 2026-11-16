#!/usr/bin/env node
// Per-client deployment descriptor check (P10-T1).
//
//   node scripts/deploy-client.mjs --file clients/<client>/deployment.json
//
// Reads the descriptor (PUBLIC IDS ONLY: slug, URLs, origins, widget version),
// validates it, and prints the README "Deployment order" checklist with the
// values filled in. Exits non-zero when the file is missing, unparsable, or
// invalid. Refuses any value that looks like a secret: secrets live in Render
// env, never in this file. Prints values only, never keys (there are none here).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const KNOWN_KEYS = new Set([
  'botSlug',
  'apiUrl',
  'supabaseUrl',
  'adminUrl',
  'widgetVersion',
  'allowedOrigins',
]);

const BOT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WIDGET_VERSION = /^v\d+\.\d+\.\d+$/;
/** Anything that smells like a credential: secrets must never be deployed via this file. */
const SECRET_LIKE =
  /(^|[^a-z])(sk-|secret|passwd|private[_-]?key|sb_secret|service[_-]?role|api[_-]?key\s*[:=]\s*\S{8,})/i;

function fail(message) {
  console.error(`deploy-client: ${message}`);
  process.exitCode = 1;
}

function httpsUrl(value, { allowLoopback = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:' && !url.username && !url.password) return true;
  if (!allowLoopback) return false;
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
  return url.protocol === 'http:' && loopback.has(url.hostname);
}

function main() {
  const flag = process.argv.indexOf('--file');
  const path = flag === -1 ? undefined : process.argv[flag + 1];
  if (path === undefined || path.startsWith('--')) {
    fail('usage: node scripts/deploy-client.mjs --file <deployment.json>');
    return;
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    fail(`cannot read file: ${path}`);
    return;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    fail(`not valid JSON: ${path}`);
    return;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    fail('top level must be a JSON object');
    return;
  }
  const problems = [];
  if (typeof doc.botSlug !== 'string' || !BOT_SLUG.test(doc.botSlug)) {
    problems.push('botSlug must be lowercase letters/digits/hyphens, e.g. website-support');
  }
  if (typeof doc.apiUrl !== 'string' || !httpsUrl(doc.apiUrl, { allowLoopback: true })) {
    problems.push('apiUrl must be an https URL (http only for localhost)');
  }
  if (typeof doc.supabaseUrl !== 'string' || !httpsUrl(doc.supabaseUrl, { allowLoopback: true })) {
    problems.push('supabaseUrl must be an https URL (http only for localhost)');
  }
  if (typeof doc.adminUrl !== 'string' || !httpsUrl(doc.adminUrl)) {
    problems.push('adminUrl must be an https URL');
  }
  if (typeof doc.widgetVersion !== 'string' || !WIDGET_VERSION.test(doc.widgetVersion)) {
    problems.push('widgetVersion must look like v1.0.0');
  }
  if (
    !Array.isArray(doc.allowedOrigins) ||
    doc.allowedOrigins.length === 0 ||
    !doc.allowedOrigins.every((o) => typeof o === 'string' && httpsUrl(o))
  ) {
    problems.push('allowedOrigins must be a non-empty array of https origins');
  }
  // Secrets trip the whole file: public IDs only.
  const haystack = JSON.stringify(doc);
  if (SECRET_LIKE.test(haystack)) {
    problems.push('a value looks like a secret; this file carries public IDs only');
  }
  for (const key of Object.keys(doc)) {
    if (!KNOWN_KEYS.has(key) && !key.startsWith('$')) {
      console.warn(`deploy-client: warning: unknown key '${key}' (ignored)`);
    }
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`deploy-client: ${p}`);
    process.exitCode = 1;
    return;
  }
  const api = doc.apiUrl.replace(/\/$/, '');
  console.log(`ok   descriptor valid for bot '${doc.botSlug}'`);
  console.log('checklist (README "Deployment order per client"):');
  console.log(
    `  1. Supabase at ${doc.supabaseUrl}: apply migrations, private bucket, first admin (aal2).`,
  );
  console.log('  2. Grants/RLS matrix green as anon, nonmember, analyst, admin, service role.');
  console.log(`  3. Render API ${api} + worker from render.yaml; secrets in Render env only.`);
  console.log(`  4. Health ${api}/health/ready; CORS for ${doc.allowedOrigins.join(', ')}.`);
  console.log(`  5. Widget ${doc.widgetVersion}/widget.js immutable; admin at ${doc.adminUrl}.`);
  console.log('  6. Knowledge uploaded, eval + E2E green on both providers.');
  console.log('  7. Handover: embed snippet, dashboard login, versions, alerts on.');
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(new URL(`file://${process.argv[1]}`, 'file:///'));
if (invokedAsScript) main();
