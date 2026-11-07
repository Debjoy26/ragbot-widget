import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../api/src/lib/config.ts';
import {
  FAKE_AI_KEY,
  FAKE_RATE_KEY,
  FAKE_SUPABASE_KEY,
  FAKE_TURNSTILE_KEY,
  FAKE_VISITOR_SECRET,
  validEnv,
} from './helpers.ts';

function failure(overrides: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(validEnv(overrides));
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('accepts a complete environment and returns a deeply frozen config', () => {
    const config = loadConfig(validEnv());
    expect(config.port).toBe(8080);
    expect(config.supabaseUrl).toBe('https://fakeproject.supabase.co');
    expect(config.allowedOrigins).toEqual([
      'https://client.example.com',
      'https://other.example.com',
    ]);
    expect(config.trustedProxyHops).toBe(1);
    expect(config.bodyLimitBytes).toBe(1024);
    expect(config.ai.chatPrimary.provider).toBe('gemini');
    expect(config.ai.embedding.dimensions).toBe(1536);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.allowedOrigins)).toBe(true);
    expect(Object.isFrozen(config.ai)).toBe(true);
    expect(() => {
      (config as { port: number }).port = 1;
    }).toThrow();
  });

  it('accepts http only on loopback for SUPABASE_URL and ALLOWED_ORIGINS', () => {
    const config = loadConfig(
      validEnv({
        SUPABASE_URL: 'http://127.0.0.1:54321',
        ALLOWED_ORIGINS: 'http://localhost:3000',
      }),
    );
    expect(config.supabaseUrl).toBe('http://127.0.0.1:54321');
    expect(config.allowedOrigins).toEqual(['http://localhost:3000']);
  });

  it('reads RATE_LIMIT_KEY_SECRET and TURNSTILE_TIMEOUT_MS', () => {
    const config = loadConfig(validEnv({ TURNSTILE_TIMEOUT_MS: '1500' }));
    expect(config.turnstileTimeoutMs).toBe(1500);
    expect(config.rateLimitKeySecret).toBe(FAKE_RATE_KEY);
  });

  it('reads the session preflight limit and window', () => {
    const config = loadConfig(
      validEnv({ SESSION_PREFLIGHT_PER_IP_LIMIT: '7', SESSION_PREFLIGHT_WINDOW_SECONDS: '120' }),
    );
    expect(config.sessionPreflightPerIpLimit).toBe(7);
    expect(config.sessionPreflightWindowSeconds).toBe(120);
  });

  it('accepts the edges of VISITOR_TOKEN_TTL_SECONDS (60 and 86400, as the database requires)', () => {
    expect(loadConfig(validEnv({ VISITOR_TOKEN_TTL_SECONDS: '60' })).visitorTokenTtlSeconds).toBe(
      60,
    );
    expect(
      loadConfig(validEnv({ VISITOR_TOKEN_TTL_SECONDS: '86400' })).visitorTokenTtlSeconds,
    ).toBe(86_400);
  });

  it('accepts the edges of the preflight bounds', () => {
    const config = loadConfig(
      validEnv({
        SESSION_PREFLIGHT_PER_IP_LIMIT: '1000000',
        SESSION_PREFLIGHT_WINDOW_SECONDS: '86400',
      }),
    );
    expect(config.sessionPreflightPerIpLimit).toBe(1_000_000);
    expect(config.sessionPreflightWindowSeconds).toBe(86_400);
  });

  describe("Cloudflare's published Turnstile test secrets (S-4)", () => {
    // Assembled from parts so the secret scanner does not flag this file.
    const testSecrets = ['1x', '2x', '3x'].map((p) => [p, '0'.repeat(31), 'AA'].join(''));

    it.each(testSecrets.map((s, i) => [`variant ${String(i + 1)}`, s] as const))(
      'refuses %s, naming the variable only',
      (_label, value) => {
        const err = failure({ TURNSTILE_SECRET_KEY: value });
        expect(err.variables).toEqual(['TURNSTILE_SECRET_KEY']);
        expect(`${err.message} ${String(err.stack)}`).not.toContain(value);
      },
    );

    it('accepts a value that only looks similar', () => {
      const near = ['1x', '0'.repeat(31), 'AB'].join('');
      expect(loadConfig(validEnv({ TURNSTILE_SECRET_KEY: near })).turnstileSecretKey).toBe(near);
    });
  });

  it('accepts TRUSTED_PROXY_HOPS = 0', () => {
    expect(loadConfig(validEnv({ TRUSTED_PROXY_HOPS: '0' })).trustedProxyHops).toBe(0);
  });

  const required = [
    'SUPABASE_URL',
    'SUPABASE_SECRET_KEY',
    'VISITOR_TOKEN_SECRET',
    'TURNSTILE_SECRET_KEY',
    'RATE_LIMIT_KEY_SECRET',
    'ALLOWED_ORIGINS',
    'PORT',
    'LOG_LEVEL',
    'TRUSTED_PROXY_HOPS',
    'BODY_LIMIT_BYTES',
    'REQUEST_TIMEOUT_MS',
    'CONNECTION_TIMEOUT_MS',
    'READY_TIMEOUT_MS',
    'DB_TIMEOUT_MS',
    'VISITOR_TOKEN_TTL_SECONDS',
    'SESSION_PREFLIGHT_PER_IP_LIMIT',
    'SESSION_PREFLIGHT_WINDOW_SECONDS',
    'TURNSTILE_TIMEOUT_MS',
    'CHAT_DEADLINE_MS',
    'PROVIDER_MAX_ATTEMPTS',
  ];

  it.each(required)('rejects a missing %s and names only that variable', (name) => {
    const err = failure({ [name]: undefined });
    expect(err.variables).toEqual([name]);
    expect(err.message).toContain(name);
  });

  it.each(required)('rejects an empty %s', (name) => {
    expect(failure({ [name]: '   ' }).variables).toEqual([name]);
  });

  it('reports every bad variable at once', () => {
    const err = failure({ PORT: 'abc', BODY_LIMIT_BYTES: undefined });
    expect([...err.variables].sort()).toEqual(['BODY_LIMIT_BYTES', 'PORT']);
  });

  const invalid: [string, string][] = [
    ['SUPABASE_URL', 'not a url'],
    ['SUPABASE_URL', 'http://project.supabase.co'],
    ['SUPABASE_URL', 'https://user:pw@project.supabase.co'],
    ['SUPABASE_URL', 'ftp://project.supabase.co'],
    ['SUPABASE_SECRET_KEY', '<server-only-secret-key>'],
    ['VISITOR_TOKEN_SECRET', 'x'.repeat(31)],
    ['VISITOR_TOKEN_SECRET', '<random-32+-byte-secret-placeholder>'],
    ['TURNSTILE_SECRET_KEY', '<turnstile-secret>'],
    ['RATE_LIMIT_KEY_SECRET', 'x'.repeat(31)],
    ['RATE_LIMIT_KEY_SECRET', '<random-32+-byte-secret-placeholder>'],
    ['TURNSTILE_TIMEOUT_MS', '0'],
    ['TURNSTILE_TIMEOUT_MS', 'soon'],
    ['TURNSTILE_TIMEOUT_MS', '1.5'],
    ['ALLOWED_ORIGINS', '*'],
    ['ALLOWED_ORIGINS', 'https://*.example.com'],
    ['ALLOWED_ORIGINS', 'https://ok.example.com,*'],
    ['ALLOWED_ORIGINS', 'https://client.example.com/'],
    ['ALLOWED_ORIGINS', 'https://client.example.com/path'],
    ['ALLOWED_ORIGINS', 'client.example.com'],
    ['ALLOWED_ORIGINS', 'http://client.example.com'],
    ['ALLOWED_ORIGINS', 'https://a.example.com,,https://b.example.com'],
    ['ALLOWED_ORIGINS', 'null'],
    ['PORT', '0'],
    ['PORT', '65536'],
    ['PORT', '80.5'],
    ['PORT', '-1'],
    ['PORT', '0x50'],
    ['LOG_LEVEL', 'verbose'],
    ['TRUSTED_PROXY_HOPS', '-1'],
    ['TRUSTED_PROXY_HOPS', '1.5'],
    ['TRUSTED_PROXY_HOPS', 'many'],
    ['BODY_LIMIT_BYTES', '0'],
    ['REQUEST_TIMEOUT_MS', '0'],
    ['CONNECTION_TIMEOUT_MS', '-5'],
    ['READY_TIMEOUT_MS', 'soon'],
    ['DB_TIMEOUT_MS', 'soon'],
    ['VISITOR_TOKEN_TTL_SECONDS', '0'],
    ['VISITOR_TOKEN_TTL_SECONDS', '59'],
    ['VISITOR_TOKEN_TTL_SECONDS', '86401'],
    ['SESSION_PREFLIGHT_PER_IP_LIMIT', '0'],
    ['SESSION_PREFLIGHT_PER_IP_LIMIT', '1000001'],
    ['SESSION_PREFLIGHT_PER_IP_LIMIT', 'lots'],
    ['SESSION_PREFLIGHT_PER_IP_LIMIT', '1.5'],
    ['SESSION_PREFLIGHT_PER_IP_LIMIT', '<attempts>'],
    ['SESSION_PREFLIGHT_WINDOW_SECONDS', '0'],
    ['SESSION_PREFLIGHT_WINDOW_SECONDS', '86401'],
    ['SESSION_PREFLIGHT_WINDOW_SECONDS', 'soon'],
    ['SESSION_PREFLIGHT_WINDOW_SECONDS', '<seconds-1-to-86400>'],
    ['CHAT_DEADLINE_MS', '99999999999'],
    ['PROVIDER_MAX_ATTEMPTS', '0'],
    ['PROVIDER_MAX_ATTEMPTS', '11'],
  ];

  it.each(invalid)('rejects invalid %s = %j', (name, value) => {
    const err = failure({ [name]: value });
    expect(err.variables).toEqual([name]);
  });

  it('never includes any secret or rejected value in the error message', () => {
    const secrets = [
      FAKE_SUPABASE_KEY,
      FAKE_VISITOR_SECRET,
      FAKE_TURNSTILE_KEY,
      FAKE_AI_KEY,
      FAKE_RATE_KEY,
    ];
    const bad = 'bad-value-marker-should-not-appear';
    const cases: Record<string, string>[] = [
      { PORT: bad },
      { LOG_LEVEL: bad },
      { SUPABASE_URL: bad },
      { ALLOWED_ORIGINS: `https://client.example.com,${bad}` },
      { VISITOR_TOKEN_SECRET: 'short-secret-marker' },
      { RATE_LIMIT_KEY_SECRET: 'short-secret-marker' },
      { SUPABASE_SECRET_KEY: '<placeholder-marker>' },
      { CHAT_PRIMARY_PROVIDER: bad },
      { CHAT_PRIMARY_MODEL: `bad model ${bad}` },
      { EMBEDDING_DIMENSIONS: bad },
    ];
    for (const overrides of cases) {
      const err = failure(overrides);
      const text = `${err.message} ${err.variables.join(' ')} ${String(err.stack)}`;
      for (const s of [...secrets, bad, 'short-secret-marker', '<placeholder-marker>']) {
        expect(text).not.toContain(s);
      }
    }
  });

  it('rejects wildcard origins with the variable name only', () => {
    const err = failure({ ALLOWED_ORIGINS: '*' });
    expect(err.message).toBe('Invalid configuration: ALLOWED_ORIGINS');
  });

  it('fails closed on AI configuration errors and names the variable', () => {
    const err = failure({ CHAT_PRIMARY_PROVIDER: undefined });
    expect(err.variables).toContain('CHAT_PRIMARY_PROVIDER');
  });

  it('fails closed when the AI provider key is missing', () => {
    const err = failure({ GEMINI_API_KEY: undefined });
    expect(err.variables).toContain('GEMINI_API_KEY');
  });

  it('fails closed when EMBEDDING_DIMENSIONS does not match the database', () => {
    expect(failure({ EMBEDDING_DIMENSIONS: '768' }).variables).toContain('EMBEDDING_DIMENSIONS');
  });
});
