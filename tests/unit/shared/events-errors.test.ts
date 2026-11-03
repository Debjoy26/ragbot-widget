import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROUTES,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  HANDOFF_REASONS,
  PUBLIC_ROUTES,
  SSE_EVENT_NAMES,
  errorEnvelopeSchema,
  httpStatusFor,
  isErrorCode,
  sseEventSchema,
  toErrorEnvelope,
} from '@ragbot/shared';
import { CONVERSATION_ID, MESSAGE_ID } from './fixtures';

const handoff = {
  event: 'handoff',
  data: {
    reason: 'no_knowledge',
    message: "I don't have that information. Our team can help:",
    prominent: false,
    contact: {
      email: 'support@client.example.com',
      phone: '+911234567890',
      whatsapp_url: 'https://wa.me/911234567890',
      page_url: 'https://client.example.com/contact',
      business_hours: { 'mon-fri': '09:00-18:00' },
      timezone: 'Asia/Kolkata',
    },
  },
};

const events: Record<string, unknown> = {
  meta: {
    event: 'meta',
    data: { request_id: 'req_123', conversation_id: CONVERSATION_ID, message_id: MESSAGE_ID },
  },
  delta: { event: 'delta', data: { text: 'Hello' } },
  sources: {
    event: 'sources',
    data: {
      sources: [
        {
          chunk_id: 'chunk-1',
          title: 'Pricing guide',
          section: 'Plans',
          excerpt: 'Plans start at a low monthly price.',
        },
      ],
    },
  },
  handoff,
  done: { event: 'done', data: { status: 'complete' } },
  error: {
    event: 'error',
    data: { code: 'PROVIDER_UNAVAILABLE', request_id: 'req_123', retry_after_seconds: 30 },
  },
};

describe('SSE event schemas', () => {
  it('covers exactly the six documented events', () => {
    expect([...SSE_EVENT_NAMES]).toEqual(['meta', 'delta', 'sources', 'handoff', 'done', 'error']);
    expect(Object.keys(events)).toEqual([...SSE_EVENT_NAMES]);
  });

  it.each(Object.entries(events))('accepts a valid %s event', (_name, event) => {
    expect(sseEventSchema.safeParse(event).success).toBe(true);
  });

  it.each([...HANDOFF_REASONS])('accepts handoff reason %s', (reason) => {
    expect(
      sseEventSchema.safeParse({ ...handoff, data: { ...handoff.data, reason } }).success,
    ).toBe(true);
  });

  it('rejects a handoff reason outside the enum', () => {
    const r = sseEventSchema.safeParse({
      ...handoff,
      data: { ...handoff.data, reason: 'because' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects unsafe or empty handoff contact, html messages and unknown events/fields', () => {
    const withContact = (contact: unknown) =>
      sseEventSchema.safeParse({ ...handoff, data: { ...handoff.data, contact } }).success;
    expect(withContact({})).toBe(false);
    expect(withContact({ page_url: 'javascript:alert(1)' })).toBe(false);
    expect(
      sseEventSchema.safeParse({ ...handoff, data: { ...handoff.data, message: '<b>hi</b>' } })
        .success,
    ).toBe(false);
    expect(sseEventSchema.safeParse({ event: 'usage', data: {} }).success).toBe(false);
    expect(
      sseEventSchema.safeParse({ event: 'done', data: { status: 'complete', provider: 'x' } })
        .success,
    ).toBe(false);
    expect(sseEventSchema.safeParse({ event: 'done', data: { status: 'weird' } }).success).toBe(
      false,
    );
  });

  it('rejects an error event carrying a message or stack', () => {
    const base = events.error as { event: string; data: Record<string, unknown> };
    expect(
      sseEventSchema.safeParse({ ...base, data: { ...base.data, message: 'upstream said...' } })
        .success,
    ).toBe(false);
    expect(
      sseEventSchema.safeParse({ ...base, data: { ...base.data, stack: 'at foo (bar.js)' } })
        .success,
    ).toBe(false);
  });
});

describe('route table', () => {
  it('lists every TECH_SPECS route and no feedback route (ADR 0011)', () => {
    const all = [...PUBLIC_ROUTES, ...ADMIN_ROUTES].map((r) => `${r.method} ${r.path}`);
    expect(all).toHaveLength(13);
    expect(all.some((r) => /feedback/i.test(r))).toBe(false);
    expect(all).toContain('GET /v1/conversations/:id');
    expect(all).toContain('PATCH /v1/admin/bot-settings');
  });
});

describe('error codes', () => {
  const expected = [
    'INVALID_REQUEST',
    'SESSION_EXPIRED',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'RATE_LIMITED',
    'BUDGET_EXCEEDED',
    'FILE_UNSUPPORTED',
    'OCR_REQUIRED',
    'INDEXING_FAILED',
    'PROVIDER_UNAVAILABLE',
    'STREAM_INTERRUPTED',
  ];

  it('contains exactly the 11 stable codes', () => {
    expect([...ERROR_CODES]).toEqual(expected);
  });

  it('maps every code to a 4xx/5xx HTTP status', () => {
    expect(Object.keys(ERROR_HTTP_STATUS).sort()).toEqual([...expected].sort());
    for (const code of ERROR_CODES) {
      const status = httpStatusFor(code);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
    expect(httpStatusFor('RATE_LIMITED')).toBe(429);
    expect(httpStatusFor('UNAUTHORIZED')).toBe(401);
    expect(httpStatusFor('FORBIDDEN')).toBe(403);
  });

  it('recognises only known codes', () => {
    expect(isErrorCode('OCR_REQUIRED')).toBe(true);
    expect(isErrorCode('INTERNAL_ERROR')).toBe(false);
    expect(isErrorCode(500)).toBe(false);
  });

  it('builds an envelope with only code, request_id and optional retry hint', () => {
    const polluted = {
      code: 'PROVIDER_UNAVAILABLE' as const,
      request_id: 'req_1',
      retry_after_seconds: 5,
      message: 'raw upstream body',
      stack: 'Error: boom\n at x',
    };
    const env = toErrorEnvelope(polluted);
    expect(env).toEqual({
      code: 'PROVIDER_UNAVAILABLE',
      request_id: 'req_1',
      retry_after_seconds: 5,
    });
    expect(Object.keys(env)).not.toContain('message');
    expect(Object.keys(env)).not.toContain('stack');
    expect(toErrorEnvelope({ code: 'FORBIDDEN', request_id: 'r' })).toEqual({
      code: 'FORBIDDEN',
      request_id: 'r',
    });
    expect(errorEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it('rejects envelopes with extra fields, unknown codes or a bad retry hint', () => {
    const ok = { code: 'FORBIDDEN', request_id: 'r' };
    expect(errorEnvelopeSchema.safeParse({ ...ok, message: 'x' }).success).toBe(false);
    expect(errorEnvelopeSchema.safeParse({ ...ok, code: 'NOPE' }).success).toBe(false);
    expect(errorEnvelopeSchema.safeParse({ ...ok, retry_after_seconds: -1 }).success).toBe(false);
    expect(() =>
      toErrorEnvelope({ code: 'RATE_LIMITED', request_id: 'r', retry_after_seconds: -1 }),
    ).toThrow(RangeError);
  });
});
