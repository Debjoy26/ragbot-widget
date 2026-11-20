// Append explicit SQL-policy fixtures once; no network or secrets.
import { readFileSync, writeFileSync } from 'node:fs';
const path = new URL('../../../tests/fixtures/settings-parity.json', import.meta.url);
const cases = JSON.parse(readFileSync(path, 'utf8'));
if (cases.some((c) => c.name.startsWith('URL policy:')))
  throw new Error('URL fixtures already added');
const inputs = [
  ['ordinary', true, 'https://example.com/path'],
  ['mixed case', true, 'HTTPS://Example.COM/path'],
  ['single label', true, 'https://intranet'],
  ['underscore', true, 'https://under_score.example/path'],
  ['punycode', true, 'https://xn--bcher-kva.example'],
  ['opaque ASCII label', true, 'https://xn--a'],
  ['raw Unicode host', false, 'https://bücher.example'],
  ['IPv4', false, 'https://127.0.0.1'],
  ['IPv6', false, 'https://[::1]'],
  ['trailing dot', false, 'https://example.com.'],
  ['empty port', false, 'https://example.com:'],
  ['zero port', true, 'https://example.com:0'],
  ['maximum port', true, 'https://example.com:65535'],
  ['overflow port', false, 'https://example.com:65536'],
  ['six digit port', false, 'https://example.com:000001'],
  ['credentials', false, 'https://user:password@example.com'],
  ['missing slashes', false, 'https:example.com'],
  ['HTTP', false, 'http://example.com'],
  ['control', false, 'https://example.com/a\tb'],
  ['space', false, 'https://example.com/a b'],
  ['UTF16 limit', true, 'https://example.com/' + '😀'.repeat(1014)],
  ['UTF16 overflow', false, 'https://example.com/' + '😀'.repeat(1015)],
  ['null clearing', true, null],
];
const added = inputs.map(([name, valid, value]) => ({
  name: `URL policy: ${name}`,
  valid,
  patch: { privacy_url: value },
}));
writeFileSync(path, JSON.stringify([...cases, ...added], null, 2) + '\n');
console.log(`Added ${added.length} URL policy fixtures.`);
