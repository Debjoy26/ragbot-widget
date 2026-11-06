import { describe, expect, it } from 'vitest';
import {
  budgetPolicySchema,
  chatRequestSchema,
  conversationHistoryRequestSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  excerptText,
  freeText,
  historyMessageSchema,
  idParamSchema,
  idempotentReplayResponseSchema,
  jobSchema,
  normaliseExcerpt,
  plainText,
  QUOTA_KINDS,
  ratePolicyRequiredSchema,
  retentionPolicySchema,
  sourceRefSchema,
  uploadPolicySchema,
} from '@ragbot/shared';
import { BOT_ID, CONVERSATION_ID, DOC_ID, MESSAGE_ID, SESSION_ID } from './fixtures';

const ok = (r: { success: boolean }) => r.success;

// ---------------------------------------------------------------------------
// G-11: session schemas
// ---------------------------------------------------------------------------

describe('createSessionRequestSchema', () => {
  const valid = { bot_slug: 'website-support' };

  it('accepts a slug alone and with a challenge token', () => {
    expect(ok(createSessionRequestSchema.safeParse(valid))).toBe(true);
    expect(
      ok(createSessionRequestSchema.safeParse({ ...valid, challenge_token: 'placeholder-token' })),
    ).toBe(true);
  });

  it.each([
    ['missing slug', {}],
    ['uppercase slug', { bot_slug: 'Bad Slug' }],
    ['path-like slug', { bot_slug: '../x' }],
    ['empty challenge token', { ...valid, challenge_token: '' }],
    ['oversized challenge token', { ...valid, challenge_token: 'a'.repeat(4097) }],
    ['extra key: role', { ...valid, role: 'admin' }],
    ['extra key: token_version', { ...valid, token_version: 99 }],
  ])('rejects %s', (_name, body) => {
    expect(ok(createSessionRequestSchema.safeParse(body))).toBe(false);
  });
});

describe('createSessionResponseSchema', () => {
  const valid = { token: 'placeholder-token', expires_at: '2026-11-05T10:00:00Z' };

  it('accepts a token and an ISO expiry', () => {
    expect(ok(createSessionResponseSchema.safeParse(valid))).toBe(true);
  });

  it.each([
    ['empty token', { ...valid, token: '' }],
    ['missing expires_at', { token: 'placeholder-token' }],
    ['non-ISO expires_at', { ...valid, expires_at: 'tomorrow' }],
    ['extra key: session_id', { ...valid, session_id: SESSION_ID }],
  ])('rejects %s', (_name, body) => {
    expect(ok(createSessionResponseSchema.safeParse(body))).toBe(false);
  });
});

describe('idParamSchema', () => {
  it('accepts a uuid and rejects anything else', () => {
    expect(ok(idParamSchema.safeParse({ id: DOC_ID }))).toBe(true);
    expect(ok(idParamSchema.safeParse({ id: 'not-a-uuid' }))).toBe(false);
    expect(ok(idParamSchema.safeParse({ id: "1' or '1'='1" }))).toBe(false);
    expect(ok(idParamSchema.safeParse({}))).toBe(false);
    expect(ok(idParamSchema.safeParse({ id: DOC_ID, bot_id: BOT_ID }))).toBe(false);
  });
});

describe('historyMessageSchema', () => {
  const valid = {
    id: MESSAGE_ID,
    role: 'assistant',
    content: 'hi',
    status: 'complete',
    created_at: '2026-11-04T10:00:00Z',
  };

  it('accepts user and assistant messages, with and without a handoff reason', () => {
    expect(ok(historyMessageSchema.safeParse(valid))).toBe(true);
    expect(ok(historyMessageSchema.safeParse({ ...valid, role: 'user' }))).toBe(true);
    expect(ok(historyMessageSchema.safeParse({ ...valid, handoff_reason: 'no_knowledge' }))).toBe(
      true,
    );
  });

  it.each([
    ['system role', { ...valid, role: 'system' }],
    ['unknown status', { ...valid, status: 'deleted' }],
    ['unknown handoff reason', { ...valid, handoff_reason: 'because' }],
    ['non-uuid id', { ...valid, id: '123' }],
    ['non-ISO created_at', { ...valid, created_at: 'yesterday' }],
    [
      'missing content',
      { id: valid.id, role: 'user', status: 'complete', created_at: valid.created_at },
    ],
    ['extra key: usage', { ...valid, usage: { input_tokens: 1 } }],
    ['extra key: provider', { ...valid, provider: 'x' }],
  ])('rejects %s', (_name, body) => {
    expect(ok(historyMessageSchema.safeParse(body))).toBe(false);
  });
});

describe('chat request strictness (named extras)', () => {
  const valid = { bot_slug: 'website-support', conversation_id: null, message: 'Hello' };

  it.each([
    ['role', 'system'],
    ['usage', { input_tokens: 1 }],
    ['sources', []],
    ['citations', []],
    ['provider', 'openai'],
    ['temperature', 2],
  ])('rejects extra key %s', (field, value) => {
    expect(ok(chatRequestSchema.safeParse({ ...valid, [field]: value }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G-11 / G-15: sourceRefSchema, excerpt normaliser, NUL in every text helper
// ---------------------------------------------------------------------------

describe('sourceRefSchema', () => {
  const valid = { chunk_id: 'chunk-1', title: 'Pricing guide' };

  it('accepts a minimal and a full source', () => {
    expect(ok(sourceRefSchema.safeParse(valid))).toBe(true);
    expect(
      ok(
        sourceRefSchema.safeParse({
          ...valid,
          section: 'Plans',
          excerpt: 'Plans start low.',
          url: 'https://client.example.com/pricing',
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ['bad chunk_id', { ...valid, chunk_id: 'a b' }],
    ['missing title', { chunk_id: 'chunk-1' }],
    ['html in title', { ...valid, title: '<b>Pricing</b>' }],
    ['html in section', { ...valid, section: 'a > b' }],
    ['http url', { ...valid, url: 'http://client.example.com/x' }],
    ['javascript url', { ...valid, url: 'javascript:alert(1)' }],
    ['newline in excerpt', { ...valid, excerpt: 'line one\nline two' }],
    ['tab in excerpt', { ...valid, excerpt: 'a\tb' }],
    ['NUL in excerpt', { ...valid, excerpt: 'abc\u0000def' }],
    ['NUL in title', { ...valid, title: 'abc\u0000def' }],
    ['excerpt over 1000', { ...valid, excerpt: 'a'.repeat(1001) }],
    ['empty excerpt', { ...valid, excerpt: '   ' }],
    ['extra key: document_id', { ...valid, document_id: DOC_ID }],
  ])('rejects %s', (_name, body) => {
    expect(ok(sourceRefSchema.safeParse(body))).toBe(false);
  });

  it('accepts angle brackets in an excerpt as literal text (widget uses textContent)', () => {
    expect(ok(sourceRefSchema.safeParse({ ...valid, excerpt: 'if a > b then <b>x</b>' }))).toBe(
      true,
    );
  });

  it('accepts a normalised multi-line excerpt but not the raw one', () => {
    const raw = 'first line\n\n  second\tline\r\nthird';
    expect(ok(sourceRefSchema.safeParse({ ...valid, excerpt: raw }))).toBe(false);
    const r = sourceRefSchema.safeParse({ ...valid, excerpt: normaliseExcerpt(raw) });
    expect(r.success && r.data.excerpt).toBe('first line second line third');
  });
});

describe('normaliseExcerpt', () => {
  it.each([
    ['newlines', 'a\nb\r\nc', 'a b c'],
    ['tabs', 'a\tb\t\tc', 'a b c'],
    ['mixed whitespace runs', '  a \n\t b  ', 'a b'],
    ['greater-than kept', 'a > b', 'a > b'],
    ['html kept as literal text', '<b>x</b>', '<b>x</b>'],
    ['NUL stripped', 'ab\u0000cd', 'abcd'],
    ['other control characters stripped', 'a\u0001b\u001fc\u007fd', 'abcd'],
    ['NUL between spaces', 'a \u0000 b', 'a b'],
    ['only whitespace and controls', ' \n\u0000\t ', ''],
  ])('%s', (_name, input, expected) => {
    expect(normaliseExcerpt(input)).toBe(expected);
  });

  it('produces output that excerptText accepts (when non-empty)', () => {
    const out = normaliseExcerpt('x\n<y>\t\u0000z');
    expect(ok(excerptText(100).safeParse(out))).toBe(true);
  });
});

describe('NUL is rejected by every text helper', () => {
  const nul = 'abc\u0000def';
  it.each([
    ['plainText', plainText(50)],
    ['freeText', freeText(50)],
    ['excerptText', excerptText(50)],
  ])('%s', (_name, schema) => {
    expect(ok(schema.safeParse(nul))).toBe(false);
    expect(ok(schema.safeParse('\u0000'))).toBe(false);
    expect(ok(schema.safeParse('abcdef'))).toBe(true);
  });

  it('plainText stays strict about angle brackets; freeText and excerptText differ as documented', () => {
    expect(ok(plainText(50).safeParse('a > b'))).toBe(false);
    expect(ok(plainText(50).safeParse('<b>'))).toBe(false);
    expect(ok(excerptText(50).safeParse('a > b'))).toBe(true);
    expect(ok(freeText(50).safeParse('line\nbreak'))).toBe(true);
    expect(ok(excerptText(50).safeParse('line\nbreak'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G-1: cleanup job payload as SQL writes it
// ---------------------------------------------------------------------------

describe('cleanup job payload (G-1)', () => {
  it('accepts {bot_id, scope: document, resource_id}', () => {
    expect(
      ok(
        jobSchema.safeParse({
          type: 'cleanup',
          payload: { bot_id: BOT_ID, scope: 'document', resource_id: DOC_ID },
        }),
      ),
    ).toBe(true);
  });

  it('rejects the legacy {document_id, bot_id} payload', () => {
    expect(
      ok(
        jobSchema.safeParse({ type: 'cleanup', payload: { document_id: DOC_ID, bot_id: BOT_ID } }),
      ),
    ).toBe(false);
  });

  it.each([
    ['document scope without resource_id', { bot_id: BOT_ID, scope: 'document' }],
    ['expired scope with resource_id', { bot_id: BOT_ID, scope: 'expired', resource_id: DOC_ID }],
    ['unknown scope', { bot_id: BOT_ID, scope: 'everything', resource_id: DOC_ID }],
    ['extra key', { bot_id: BOT_ID, scope: 'document', resource_id: DOC_ID, document_id: DOC_ID }],
  ])('rejects %s', (_name, payload) => {
    expect(ok(jobSchema.safeParse({ type: 'cleanup', payload }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G-17: unconfirmed shapes (history cursor, idempotent replay)
// ---------------------------------------------------------------------------

describe('conversationHistoryRequestSchema (UNCONFIRMED shape)', () => {
  it('accepts no cursor and a uuid cursor', () => {
    expect(ok(conversationHistoryRequestSchema.safeParse({}))).toBe(true);
    expect(ok(conversationHistoryRequestSchema.safeParse({ before: MESSAGE_ID }))).toBe(true);
  });

  it.each([
    ['non-uuid cursor', { before: 'yesterday' }],
    ['limit is not client-controlled', { limit: 5000 }],
    ['extra key', { before: MESSAGE_ID, conversation_id: CONVERSATION_ID }],
  ])('rejects %s', (_name, body) => {
    expect(ok(conversationHistoryRequestSchema.safeParse(body))).toBe(false);
  });
});

describe('idempotentReplayResponseSchema (UNCONFIRMED shape)', () => {
  const done = {
    request_id: 'req_123',
    run_state: 'succeeded',
    conversation_id: CONVERSATION_ID,
    message_id: MESSAGE_ID,
    status: 'complete',
  };
  const running = { ...done, run_state: 'running', message_id: null, status: null };

  it('accepts a finished and an in-flight stored status', () => {
    expect(ok(idempotentReplayResponseSchema.safeParse(done))).toBe(true);
    expect(ok(idempotentReplayResponseSchema.safeParse(running))).toBe(true);
  });

  it.each([
    ['content is never replayed', { ...done, content: 'answer text' }],
    ['unknown run_state', { ...done, run_state: 'done' }],
    ['status without message_id', { ...done, message_id: null }],
    ['missing request_id', { ...done, request_id: undefined }],
  ])('rejects %s', (_name, body) => {
    expect(ok(idempotentReplayResponseSchema.safeParse(body))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G-18: policy JSON keys SQL depends on
// ---------------------------------------------------------------------------

describe('budgetPolicySchema', () => {
  it.each([[0], [5], [2.5]])('accepts daily_cap_usd %j', (daily_cap_usd) => {
    expect(ok(budgetPolicySchema.safeParse({ daily_cap_usd }))).toBe(true);
  });

  it.each([
    ['missing', {}],
    ['negative', { daily_cap_usd: -1 }],
    ['string', { daily_cap_usd: '5' }],
    ['NaN', { daily_cap_usd: Number.NaN }],
    ['Infinity', { daily_cap_usd: Number.POSITIVE_INFINITY }],
    ['exponent notation SQL cannot read', { daily_cap_usd: 1e21 }],
    ['null', { daily_cap_usd: null }],
    ['extra key', { daily_cap_usd: 5, soft_cap_usd: 1 }],
  ])('rejects %s', (_name, body) => {
    expect(ok(budgetPolicySchema.safeParse(body))).toBe(false);
  });
});

describe('retentionPolicySchema', () => {
  const valid = { conversation_days: 90, usage_months: 13 };

  it('accepts positive integers within the SQL digit limits', () => {
    expect(ok(retentionPolicySchema.safeParse(valid))).toBe(true);
    expect(
      ok(retentionPolicySchema.safeParse({ conversation_days: 999_999, usage_months: 9_999 })),
    ).toBe(true);
  });

  it.each([
    ['zero days', { ...valid, conversation_days: 0 }],
    ['fractional months', { ...valid, usage_months: 1.5 }],
    ['days beyond SQL digits', { ...valid, conversation_days: 1_000_000 }],
    ['months beyond SQL digits', { ...valid, usage_months: 10_000 }],
    ['string days', { ...valid, conversation_days: '90' }],
    ['missing usage_months', { conversation_days: 90 }],
    ['missing conversation_days', { usage_months: 13 }],
    ['extra key', { ...valid, audit_days: 1 }],
  ])('rejects %s', (_name, body) => {
    expect(ok(retentionPolicySchema.safeParse(body))).toBe(false);
  });
});

describe('ratePolicyRequiredSchema', () => {
  it('accepts the key, tolerating other rate keys', () => {
    expect(ok(ratePolicyRequiredSchema.safeParse({ concurrent_requests_per_session: 1 }))).toBe(
      true,
    );
    expect(
      ok(
        ratePolicyRequiredSchema.safeParse({
          concurrent_requests_per_session: 2,
          message_per_session: { limit: 20, window_seconds: 600 },
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ['missing', {}],
    ['zero', { concurrent_requests_per_session: 0 }],
    ['negative', { concurrent_requests_per_session: -1 }],
    ['string', { concurrent_requests_per_session: '1' }],
    ['beyond SQL digits', { concurrent_requests_per_session: 10_000 }],
    ['fractional', { concurrent_requests_per_session: 1.5 }],
  ])('rejects %s', (_name, body) => {
    expect(ok(ratePolicyRequiredSchema.safeParse(body))).toBe(false);
  });
});

describe('uploadPolicySchema', () => {
  const rule = { limit: 10, window_seconds: 3600 };
  const valid = {
    max_bytes: 20_971_520,
    max_pages: 300,
    index_max_attempts: 3,
    cleanup_max_attempts: 5,
    quotas: { register: rule, upload: rule, reindex: rule, write: rule },
  };

  it('accepts the full contract shape', () => {
    expect(ok(uploadPolicySchema.safeParse(valid))).toBe(true);
    expect(
      ok(
        uploadPolicySchema.safeParse({ ...valid, index_max_attempts: 1, cleanup_max_attempts: 20 }),
      ),
    ).toBe(true);
  });

  const without = (key: string) => {
    const { [key]: _removed, ...rest } = valid as Record<string, unknown>;
    return rest;
  };

  it('accepts the exact SQL upper bounds', () => {
    expect(
      ok(
        uploadPolicySchema.safeParse({
          ...valid,
          max_bytes: 1_099_511_627_776,
          quotas: {
            ...valid.quotas,
            write: { limit: 999_999, window_seconds: 86_400 },
            register: { limit: 1, window_seconds: 1 },
          },
        }),
      ),
    ).toBe(true);
  });

  it('QUOTA_KINDS and the quotas shape agree and include write', () => {
    expect([...QUOTA_KINDS]).toEqual(['register', 'upload', 'reindex', 'write']);
    expect(Object.keys(uploadPolicySchema.shape.quotas.shape).sort()).toEqual(
      [...QUOTA_KINDS].sort(),
    );
  });

  it.each(['max_bytes', 'max_pages', 'index_max_attempts', 'cleanup_max_attempts', 'quotas'])(
    'rejects a missing %s (fails closed, RB036)',
    (key) => {
      expect(ok(uploadPolicySchema.safeParse(without(key)))).toBe(false);
    },
  );

  it.each([
    ['index attempts 0', { ...valid, index_max_attempts: 0 }],
    ['index attempts 21', { ...valid, index_max_attempts: 21 }],
    ['cleanup attempts 0', { ...valid, cleanup_max_attempts: 0 }],
    ['cleanup attempts 21', { ...valid, cleanup_max_attempts: 21 }],
    ['fractional attempts', { ...valid, index_max_attempts: 2.5 }],
    ['zero max_bytes', { ...valid, max_bytes: 0 }],
    ['string max_pages', { ...valid, max_pages: '300' }],
    ['missing upload quota', { ...valid, quotas: { register: rule, reindex: rule, write: rule } }],
    ['missing write quota', { ...valid, quotas: { register: rule, upload: rule, reindex: rule } }],
    ['max_bytes above SQL bound', { ...valid, max_bytes: 1_099_511_627_777 }],
    [
      'quota limit above SQL bound',
      { ...valid, quotas: { ...valid.quotas, write: { ...rule, limit: 1_000_000 } } },
    ],
    [
      'quota window above one day',
      { ...valid, quotas: { ...valid.quotas, upload: { ...rule, window_seconds: 86_401 } } },
    ],
    [
      'negative quota window',
      { ...valid, quotas: { ...valid.quotas, upload: { ...rule, window_seconds: -1 } } },
    ],
    ['unknown quota kind', { ...valid, quotas: { ...valid.quotas, download: rule } }],
    ['zero quota limit', { ...valid, quotas: { ...valid.quotas, upload: { ...rule, limit: 0 } } }],
    [
      'zero quota window',
      { ...valid, quotas: { ...valid.quotas, reindex: { ...rule, window_seconds: 0 } } },
    ],
    [
      'extra key inside a quota',
      { ...valid, quotas: { ...valid.quotas, register: { ...rule, burst: 5 } } },
    ],
    ['extra top-level key', { ...valid, allow_all: true }],
  ])('rejects %s', (_name, body) => {
    expect(ok(uploadPolicySchema.safeParse(body))).toBe(false);
  });
});
