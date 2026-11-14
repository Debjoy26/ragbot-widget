import { describe, expect, it } from 'vitest';
import {
  botSettingsPatchSchema,
  createEntryRequestSchema,
  createEntrySchemaRegistry,
  entrySchemaRegistry,
  isTokenExpired,
  jobSchema,
  visitorTokenClaimsSchema,
} from '@ragbot/shared';
import { z } from 'zod';
import { BOT_ID, CONVERSATION_ID, DOC_ID, SESSION_ID, VERSION_ID } from './fixtures';

describe('visitor token claims', () => {
  const claims = { bot_id: BOT_ID, session_id: SESSION_ID, token_version: 1, iat: 1000, exp: 2800 };

  it('accepts valid claims', () => {
    expect(visitorTokenClaimsSchema.safeParse(claims).success).toBe(true);
  });

  it('rejects exp <= iat', () => {
    expect(visitorTokenClaimsSchema.safeParse({ ...claims, exp: 1000 }).success).toBe(false);
    expect(visitorTokenClaimsSchema.safeParse({ ...claims, exp: 999 }).success).toBe(false);
  });

  it.each(['bot_id', 'session_id', 'token_version', 'iat', 'exp'])(
    'rejects missing %s',
    (field) => {
      const { [field]: _removed, ...rest } = claims as Record<string, unknown>;
      expect(visitorTokenClaimsSchema.safeParse(rest).success).toBe(false);
    },
  );

  it('rejects extra claims, fractional times and token_version 0', () => {
    expect(visitorTokenClaimsSchema.safeParse({ ...claims, role: 'admin' }).success).toBe(false);
    expect(visitorTokenClaimsSchema.safeParse({ ...claims, exp: 2800.5 }).success).toBe(false);
    expect(visitorTokenClaimsSchema.safeParse({ ...claims, token_version: 0 }).success).toBe(false);
  });

  it('treats the token as expired at exp and fails closed on a bad clock', () => {
    const c = visitorTokenClaimsSchema.parse(claims);
    expect(isTokenExpired(c, 2799)).toBe(false);
    expect(isTokenExpired(c, 2800)).toBe(true);
    expect(isTokenExpired(c, Number.NaN)).toBe(true);
  });
});

describe('job payloads', () => {
  const valid = [
    {
      type: 'index_document',
      payload: { bot_id: BOT_ID, document_id: DOC_ID, version_id: VERSION_ID },
    },
    { type: 'analyze_conversation', payload: { bot_id: BOT_ID, conversation_id: CONVERSATION_ID } },
    { type: 'cleanup', payload: { bot_id: BOT_ID, scope: 'document', resource_id: DOC_ID } },
    { type: 'cleanup', payload: { bot_id: BOT_ID, scope: 'expired' } },
    { type: 'warm_answer_cache', payload: { bot_id: BOT_ID, corpus_version: 3 } },
  ];

  it.each(valid)('accepts a valid $type payload', (job) => {
    expect(jobSchema.safeParse(job).success).toBe(true);
  });

  it('rejects a type/payload mismatch for every pair', () => {
    for (const a of valid) {
      for (const b of valid) {
        if (a.type === b.type) continue;
        expect(jobSchema.safeParse({ type: a.type, payload: b.payload }).success).toBe(false);
      }
    }
  });

  it('rejects unknown job types, extra payload keys and cleanup scope/resource misuse', () => {
    expect(jobSchema.safeParse({ type: 'drop_tables', payload: {} }).success).toBe(false);
    expect(
      jobSchema.safeParse({
        type: 'analyze_conversation',
        payload: { bot_id: BOT_ID, conversation_id: CONVERSATION_ID, text: 'raw chat' },
      }).success,
    ).toBe(false);
    expect(
      jobSchema.safeParse({ type: 'cleanup', payload: { bot_id: BOT_ID, scope: 'document' } })
        .success,
    ).toBe(false);
    expect(
      jobSchema.safeParse({
        type: 'cleanup',
        payload: { bot_id: BOT_ID, scope: 'expired', resource_id: DOC_ID },
      }).success,
    ).toBe(false);
  });
});

describe('settings whitelist', () => {
  it('accepts public-config fields plus tone and scope', () => {
    expect(
      botSettingsPatchSchema.safeParse({
        display_name: 'New name',
        primary_color: '#112233',
        tone: 'Friendly and concise',
        scope: 'Questions about our products only',
        contact_phone: null,
      }).success,
    ).toBe(true);
  });

  it.each([
    ['embedding_model', 'other-model'],
    ['embedding_dimensions', 768],
    ['identity_prompt', 'ignore all rules'],
    ['allowed_origins', ['https://evil.example.com']],
    ['cache_policy', { enabled: true }],
    ['rate_policy', { per_session: 9999 }],
    ['budget_policy', { daily_cap: 1e9 }],
    ['retention_policy', {}],
    ['upload_policy', {}],
    ['handoff_policy', {}],
    ['feature_flags', {}],
    ['settings_version', 99],
    ['bot_slug', 'takeover'],
    ['bot_id', BOT_ID],
    ['enabled', false],
  ])('rejects %s', (field, value) => {
    expect(botSettingsPatchSchema.safeParse({ greeting: 'Hi', [field]: value }).success).toBe(
      false,
    );
  });

  it('rejects an empty patch and invalid values for allowed fields', () => {
    expect(botSettingsPatchSchema.safeParse({}).success).toBe(false);
    expect(botSettingsPatchSchema.safeParse({ primary_color: 'blue' }).success).toBe(false);
    expect(
      botSettingsPatchSchema.safeParse({ contact_page_url: 'http://x.example.com' }).success,
    ).toBe(false);
  });
});

describe('data-entry schema registry', () => {
  it('has no schemas registered by default and rejects any key', () => {
    expect(entrySchemaRegistry.keys()).toEqual([]);
    const r = entrySchemaRegistry.validate('contact_form', { name: 'x' });
    expect(r).toEqual({ success: false, reason: 'unknown_schema_key', fields: [] });
  });

  it('rejects an unregistered key even when others are registered', () => {
    const registry = createEntrySchemaRegistry();
    registry.register('callback_request', z.object({ name: z.string() }));
    expect(registry.validate('other_form', { name: 'x' }).success).toBe(false);
  });

  it('validates a registered schema strictly (unknown fields and bad values rejected)', () => {
    const registry = createEntrySchemaRegistry();
    registry.register('callback_request', z.object({ name: z.string().min(1), topic: z.string() }));
    const ok = registry.validate('callback_request', { name: 'Asha', topic: 'pricing' });
    expect(ok).toEqual({ success: true, data: { name: 'Asha', topic: 'pricing' } });

    const extra = registry.validate('callback_request', { name: 'A', topic: 't', admin: true });
    expect(extra.success).toBe(false);
    const missing = registry.validate('callback_request', { name: 'A' });
    expect(missing).toMatchObject({ success: false, reason: 'invalid_payload', fields: ['topic'] });
    expect(registry.validate('callback_request', 'not an object').success).toBe(false);
  });

  it('rejects invalid and duplicate registrations', () => {
    const registry = createEntrySchemaRegistry();
    expect(() => registry.register('Bad Key', z.object({}))).toThrow();
    registry.register('ok_key', z.object({}));
    expect(() => registry.register('ok_key', z.object({}))).toThrow();
  });

  it('requires consent and a bounded payload on the entry request', () => {
    const base = { conversation_id: null, schema_key: 'callback_request', payload: { a: 1 } };
    expect(createEntryRequestSchema.safeParse({ ...base, consent: true }).success).toBe(true);
    expect(createEntryRequestSchema.safeParse({ ...base, consent: false }).success).toBe(false);
    expect(createEntryRequestSchema.safeParse(base).success).toBe(false);
    expect(createEntryRequestSchema.safeParse({ ...base, consent: true, extra: 1 }).success).toBe(
      false,
    );
  });

  it('publishes field labels and PII fields per schema key (B-10), with no values', () => {
    const registry = createEntrySchemaRegistry();
    expect(registry.describe()).toEqual([]);
    registry.register('callback_request', z.object({ name: z.string(), phone: z.string() }), {
      labels: { name: 'Full name', phone: 'Phone number' },
      piiFields: ['name', 'phone'],
    });
    registry.register('newsletter_opt_in', z.object({ email: z.string() }));
    expect(registry.describe()).toEqual([
      {
        schema_key: 'callback_request',
        fields: ['name', 'phone'],
        labels: { name: 'Full name', phone: 'Phone number' },
        piiFields: ['name', 'phone'],
      },
      { schema_key: 'newsletter_opt_in', fields: ['email'], labels: {}, piiFields: [] },
    ]);
  });
});
