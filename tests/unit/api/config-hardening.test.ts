import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../api/src/lib/config.ts';
import { buildLoggerOptions } from '../../../api/src/lib/logger.ts';
import Fastify from 'fastify';
import {
  FAKE_AI_KEY,
  FAKE_RATE_KEY,
  FAKE_SUPABASE_KEY,
  FAKE_TURNSTILE_KEY,
  FAKE_VISITOR_SECRET,
  LogCapture,
  validEnv,
} from './helpers.ts';

// P4-D1 (A-1, A-6, B-10): secrets stay out of every serialisation of the config, and unsafe
// combinations are refused at startup. All values are labelled fakes.

const PREVIOUS = 'fake-previous-visitor-secret-0123456789-abcdef';

function failure(overrides: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(validEnv(overrides));
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error('expected loadConfig to throw');
}

const SECRET_VALUES = [
  FAKE_SUPABASE_KEY,
  FAKE_VISITOR_SECRET,
  FAKE_TURNSTILE_KEY,
  FAKE_AI_KEY,
  FAKE_RATE_KEY,
  PREVIOUS,
];

describe('secrets are non-enumerable on the config (A-1)', () => {
  const config = loadConfig(validEnv({ VISITOR_TOKEN_SECRET_PREVIOUS: PREVIOUS }));

  it('JSON.stringify shows none of them', () => {
    const text = JSON.stringify(config);
    for (const s of SECRET_VALUES) expect(text).not.toContain(s);
    expect(text).not.toMatch(
      /supabaseSecretKey|visitorTokenSecret|turnstileSecretKey|rateLimitKeySecret|"ai"/,
    );
    expect(JSON.parse(text)).toMatchObject({ port: 8080 });
  });

  it('util.inspect (and console.log) shows none of them', () => {
    for (const text of [
      inspect(config),
      inspect(config, { depth: 10 }),
      String(inspect(config, { colors: true })),
    ]) {
      for (const s of SECRET_VALUES) expect(text).not.toContain(s);
    }
  });

  it('spreading, Object.keys and Object.entries omit them', () => {
    const keys = Object.keys(config);
    for (const hidden of [
      'supabaseSecretKey',
      'visitorTokenSecret',
      'visitorTokenSecretPrevious',
      'turnstileSecretKey',
      'rateLimitKeySecret',
      'ai',
    ]) {
      expect(keys).not.toContain(hidden);
      expect(Object.keys({ ...config })).not.toContain(hidden);
    }
    for (const s of SECRET_VALUES) expect(JSON.stringify(Object.entries(config))).not.toContain(s);
  });

  it('logging the config object logs none of them', () => {
    const capture = new LogCapture();
    const log = Fastify({ logger: { ...buildLoggerOptions('info'), stream: capture.stream } }).log;
    log.info({ config }, 'config');
    log.info(config, 'config at top level');
    for (const s of SECRET_VALUES) expect(capture.text).not.toContain(s);
  });

  it('direct property access still works, and the config stays frozen', () => {
    expect(config.supabaseSecretKey).toBe(FAKE_SUPABASE_KEY);
    expect(config.visitorTokenSecret).toBe(FAKE_VISITOR_SECRET);
    expect(config.visitorTokenSecretPrevious).toBe(PREVIOUS);
    expect(config.turnstileSecretKey).toBe(FAKE_TURNSTILE_KEY);
    expect(config.rateLimitKeySecret).toBe(FAKE_RATE_KEY);
    expect(config.ai.chatPrimary.apiKey).toBe(FAKE_AI_KEY);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.ai)).toBe(true);
    expect(() => {
      (config as { supabaseSecretKey: string }).supabaseSecretKey = 'x';
    }).toThrow();
    expect(() => {
      delete (config as { ai?: unknown }).ai;
    }).toThrow();
  });
});

describe('VISITOR_TOKEN_SECRET_PREVIOUS (A-6)', () => {
  it('is optional: unset or empty means no previous secret', () => {
    expect(loadConfig(validEnv()).visitorTokenSecretPrevious).toBeUndefined();
    expect(
      loadConfig(validEnv({ VISITOR_TOKEN_SECRET_PREVIOUS: '' })).visitorTokenSecretPrevious,
    ).toBeUndefined();
  });

  it.each(['short-previous', '<previous-secret-placeholder-0123456789-abcdef>', '   '])(
    'rejects an invalid value (%j) naming the variable',
    (value) => {
      expect(failure({ VISITOR_TOKEN_SECRET_PREVIOUS: value }).variables).toEqual([
        'VISITOR_TOKEN_SECRET_PREVIOUS',
      ]);
    },
  );
});

describe('one value per secret (A-6)', () => {
  const reuse: [string, Record<string, string>, string[]][] = [
    [
      'previous equals current',
      { VISITOR_TOKEN_SECRET_PREVIOUS: FAKE_VISITOR_SECRET },
      ['VISITOR_TOKEN_SECRET', 'VISITOR_TOKEN_SECRET_PREVIOUS'],
    ],
    [
      'turnstile equals the token secret',
      { TURNSTILE_SECRET_KEY: FAKE_VISITOR_SECRET },
      ['VISITOR_TOKEN_SECRET', 'TURNSTILE_SECRET_KEY'],
    ],
    [
      'supabase key equals the token secret',
      { SUPABASE_SECRET_KEY: FAKE_VISITOR_SECRET },
      ['VISITOR_TOKEN_SECRET', 'SUPABASE_SECRET_KEY'],
    ],
    [
      'supabase key equals turnstile',
      { SUPABASE_SECRET_KEY: FAKE_TURNSTILE_KEY },
      ['TURNSTILE_SECRET_KEY', 'SUPABASE_SECRET_KEY'],
    ],
    [
      'the rate-limit key equals the token secret',
      { RATE_LIMIT_KEY_SECRET: FAKE_VISITOR_SECRET },
      ['VISITOR_TOKEN_SECRET', 'RATE_LIMIT_KEY_SECRET'],
    ],
    [
      'the rate-limit key equals turnstile',
      { RATE_LIMIT_KEY_SECRET: FAKE_TURNSTILE_KEY },
      ['TURNSTILE_SECRET_KEY', 'RATE_LIMIT_KEY_SECRET'],
    ],
    [
      'the rate-limit key equals the supabase key',
      { RATE_LIMIT_KEY_SECRET: FAKE_SUPABASE_KEY },
      ['SUPABASE_SECRET_KEY', 'RATE_LIMIT_KEY_SECRET'],
    ],
    [
      'the rate-limit key equals the previous token secret',
      { RATE_LIMIT_KEY_SECRET: PREVIOUS, VISITOR_TOKEN_SECRET_PREVIOUS: PREVIOUS },
      ['VISITOR_TOKEN_SECRET_PREVIOUS', 'RATE_LIMIT_KEY_SECRET'],
    ],
    [
      'previous equals the supabase key',
      {
        VISITOR_TOKEN_SECRET_PREVIOUS: FAKE_SUPABASE_KEY.padEnd(40, 'x'),
        SUPABASE_SECRET_KEY: FAKE_SUPABASE_KEY.padEnd(40, 'x'),
      },
      ['VISITOR_TOKEN_SECRET_PREVIOUS', 'SUPABASE_SECRET_KEY'],
    ],
  ];

  it.each(reuse)(
    'refuses when %s, naming the variables but never the value',
    (_label, env, names) => {
      const err = failure(env);
      expect([...err.variables].sort()).toEqual([...names].sort());
      const text = `${err.message} ${String(err.stack)}`;
      for (const s of SECRET_VALUES) expect(text).not.toContain(s);
    },
  );

  it('accepts four distinct values', () => {
    expect(() => loadConfig(validEnv({ VISITOR_TOKEN_SECRET_PREVIOUS: PREVIOUS }))).not.toThrow();
  });
});

describe('SUPABASE_URL shape (B-10)', () => {
  it.each([
    'https://project.supabase.co?apikey=abc',
    'https://project.supabase.co/?x=1',
    'https://project.supabase.co#frag',
    'https://project.supabase.co?',
    'https://user:pw@project.supabase.co',
    'http://user@127.0.0.1:54321',
  ])('rejects %s naming SUPABASE_URL only', (value) => {
    const err = failure({ SUPABASE_URL: value });
    expect(err.variables).toEqual(['SUPABASE_URL']);
    expect(`${err.message}`).not.toContain('apikey=abc');
    expect(`${err.message}`).not.toContain('pw');
  });
});

describe('AI key placeholders (B-10)', () => {
  it('rejects a placeholder GEMINI_API_KEY, naming it without its value', () => {
    const err = failure({ GEMINI_API_KEY: '<gemini-key>' });
    expect(err.variables).toEqual(['GEMINI_API_KEY']);
    expect(err.message).not.toContain('<gemini-key>');
  });

  it('rejects a placeholder per-role key', () => {
    const err = failure({ CHAT_PRIMARY_API_KEY: '<chat-key>' });
    expect(err.variables).toEqual(['CHAT_PRIMARY_API_KEY']);
  });

  it('rejects a placeholder embedded in a longer value', () => {
    expect(failure({ GEMINI_API_KEY: 'prefix-<replace-me>-suffix' }).variables).toEqual([
      'GEMINI_API_KEY',
    ]);
  });

  it('ignores a placeholder in a provider key that nothing uses', () => {
    expect(() => loadConfig(validEnv({ OPENAI_API_KEY: '<openai-key-if-used>' }))).not.toThrow();
  });
});

describe('timeout relations (B-10, P4-D3 R-6)', () => {
  it.each([
    ['5000', '5000'],
    ['6000', '5000'],
    ['5001', '5000'],
  ])('rejects READY_TIMEOUT_MS = %s against CONNECTION_TIMEOUT_MS = %s', (ready, conn) => {
    const err = failure({ READY_TIMEOUT_MS: ready, CONNECTION_TIMEOUT_MS: conn });
    expect(err.variables).toEqual(['READY_TIMEOUT_MS', 'CONNECTION_TIMEOUT_MS']);
  });

  it('accepts READY_TIMEOUT_MS one below CONNECTION_TIMEOUT_MS', () => {
    expect(() =>
      loadConfig(validEnv({ READY_TIMEOUT_MS: '4999', CONNECTION_TIMEOUT_MS: '5000' })),
    ).not.toThrow();
  });

  it('no longer compares READY_TIMEOUT_MS or DB_TIMEOUT_MS with REQUEST_TIMEOUT_MS', () => {
    // REQUEST_TIMEOUT_MS only bounds receiving a request, so a longer probe or database
    // deadline is not an error on that account.
    expect(() =>
      loadConfig(
        validEnv({
          REQUEST_TIMEOUT_MS: '1000',
          READY_TIMEOUT_MS: '3000',
          DB_TIMEOUT_MS: '9000',
          CONNECTION_TIMEOUT_MS: '60000',
        }),
      ),
    ).not.toThrow();
  });
});

describe('provider keys are non-enumerable inside config.ai (P4-D3 R-9, R-10)', () => {
  const config = loadConfig(validEnv());
  const roles = () => [
    config.ai.chatPrimary,
    config.ai.embedding,
    config.ai.moderation,
    ...(config.ai.chatFallback === null ? [] : [config.ai.chatFallback]),
  ];

  it('JSON.stringify(config.ai) shows no key', () => {
    const text = JSON.stringify(config.ai);
    expect(text).not.toContain(FAKE_AI_KEY);
    expect(text).not.toContain('apiKey');
    expect(JSON.parse(text)).toMatchObject({ chatPrimary: { provider: 'gemini' } });
  });

  it('util.inspect(config.ai) and of each role shows no key', () => {
    for (const value of [config.ai, ...roles()]) {
      for (const text of [inspect(value), inspect(value, { depth: 10, showHidden: false })]) {
        expect(text).not.toContain(FAKE_AI_KEY);
      }
    }
  });

  it('logging config.ai logs no key', () => {
    const capture = new LogCapture();
    const log = Fastify({ logger: { ...buildLoggerOptions('info'), stream: capture.stream } }).log;
    log.info({ ai: config.ai }, 'ai');
    log.info(config.ai, 'ai at top level');
    log.info({ role: config.ai.chatPrimary }, 'role');
    expect(capture.text).not.toContain(FAKE_AI_KEY);
  });

  it('every role still hands its key to a provider by direct access', () => {
    for (const role of roles()) expect(role.apiKey).toBe(FAKE_AI_KEY);
    expect(Object.keys(config.ai.chatPrimary)).not.toContain('apiKey');
    expect(Object.getOwnPropertyDescriptor(config.ai.chatPrimary, 'apiKey')).toMatchObject({
      enumerable: false,
      writable: false,
      configurable: false,
    });
  });

  it('the rest of each role stays visible and frozen', () => {
    expect(config.ai.embedding).toMatchObject({ provider: 'gemini', dimensions: 1536 });
    for (const role of roles()) expect(Object.isFrozen(role)).toBe(true);
    expect(Object.isFrozen(config.ai)).toBe(true);
    expect(() => {
      (config.ai.chatPrimary as { apiKey: string }).apiKey = 'x';
    }).toThrow();
  });

  it('a configured fallback hides its key too', () => {
    const withFallback = loadConfig(
      validEnv({
        CHAT_FALLBACK_PROVIDER: 'gemini',
        CHAT_FALLBACK_MODEL: 'fake-fallback-model',
        // P7: a configured fallback needs its own prices.
        CHAT_FALLBACK_PRICE_INPUT_PER_MILLION: '0.2',
        CHAT_FALLBACK_PRICE_OUTPUT_PER_MILLION: '0.8',
      }),
    );
    const fb = withFallback.ai.chatFallback;
    expect(fb).not.toBeNull();
    expect(JSON.stringify(fb)).not.toContain(FAKE_AI_KEY);
    expect(fb?.apiKey).toBe(FAKE_AI_KEY);
  });

  it('{ ...config } carries no secret and no ai (R-10)', () => {
    const spread = { ...loadConfig(validEnv({ VISITOR_TOKEN_SECRET_PREVIOUS: PREVIOUS })) };
    const text = JSON.stringify(spread) + inspect(spread, { depth: 10 });
    for (const s of SECRET_VALUES) expect(text).not.toContain(s);
    for (const hidden of [
      'supabaseSecretKey',
      'visitorTokenSecret',
      'visitorTokenSecretPrevious',
      'turnstileSecretKey',
      'rateLimitKeySecret',
      'ai',
    ]) {
      expect(Object.keys(spread)).not.toContain(hidden);
      expect(hidden in spread).toBe(false);
    }
    expect(spread).toMatchObject({ port: 8080 });
  });
});
