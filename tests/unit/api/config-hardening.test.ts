import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../api/src/lib/config.ts';
import { buildLoggerOptions } from '../../../api/src/lib/logger.ts';
import Fastify from 'fastify';
import {
  FAKE_AI_KEY,
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
  PREVIOUS,
];

describe('secrets are non-enumerable on the config (A-1)', () => {
  const config = loadConfig(validEnv({ VISITOR_TOKEN_SECRET_PREVIOUS: PREVIOUS }));

  it('JSON.stringify shows none of them', () => {
    const text = JSON.stringify(config);
    for (const s of SECRET_VALUES) expect(text).not.toContain(s);
    expect(text).not.toMatch(/supabaseSecretKey|visitorTokenSecret|turnstileSecretKey|"ai"/);
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

describe('timeouts must fit inside REQUEST_TIMEOUT_MS (B-10)', () => {
  it.each([
    ['READY_TIMEOUT_MS', '5000'],
    ['READY_TIMEOUT_MS', '6000'],
    ['DB_TIMEOUT_MS', '5000'],
    ['DB_TIMEOUT_MS', '9999'],
  ])('rejects %s = %s against REQUEST_TIMEOUT_MS = 5000', (name, value) => {
    const err = failure({ [name]: value });
    expect(err.variables).toContain(name);
    expect(err.variables).toContain('REQUEST_TIMEOUT_MS');
  });

  it('accepts a value one below', () => {
    expect(() =>
      loadConfig(validEnv({ READY_TIMEOUT_MS: '4999', DB_TIMEOUT_MS: '4999' })),
    ).not.toThrow();
  });
});
