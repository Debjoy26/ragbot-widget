// P8 widget unit tests: SSE frame parser + idempotency keys (TECH_SPECS §4).
import { describe, expect, it, vi } from 'vitest';
import {
  createSseParser,
  fetchHistory,
  newIdempotencyKey,
  streamChat,
} from '../../../widget/src/api.ts';
import type { SseParsedEvent } from '../../../widget/src/types.ts';

function collect(): {
  readonly events: SseParsedEvent[];
  readonly push: (chunk: string) => SseParsedEvent[];
} {
  const events: SseParsedEvent[] = [];
  const parser = createSseParser((event) => void events.push(event));
  return {
    events,
    push: (chunk: string) => {
      parser.push(chunk);
      return events;
    },
  };
}

describe('createSseParser', () => {
  it('parses a full meta → delta → sources → done sequence', () => {
    const { events, push } = collect();
    push('event: meta\ndata: {"request_id":"r","conversation_id":"c","message_id":"m"}\n\n');
    push('event: delta\ndata: {"text":"Hello"}\n\n');
    push('event: sources\ndata: {"sources":[{"chunk_id":"1","title":"Guide"}]}\n\n');
    push('event: done\ndata: {"status":"complete"}\n\n');
    expect(events.map((e) => e.event)).toEqual(['meta', 'delta', 'sources', 'done']);
  });

  it('buffers split frames and skips keep-alive comments', () => {
    const { events, push } = collect();
    push('event: del');
    push('ta\ndata: {"text":"Hel');
    push('lo"}\n\n: keep-alive\n\nevent: done\ndata: {"status":"complete"}\n\n');
    expect(events.map((e) => e.event)).toEqual(['delta', 'done']);
    if (events[0]?.event === 'delta') expect(events[0].data.text).toBe('Hello');
  });

  it('drops unknown events and malformed JSON without rendering', () => {
    const { events, push } = collect();
    push('event: bogus\ndata: {"x":1}\n\n');
    push('event: delta\ndata: not-json\n\n');
    push('event: delta\ndata: {"text":"ok"}\n\n');
    expect(events.map((e) => e.event)).toEqual(['delta']);
  });

  it('parses handoff and error events', () => {
    const { events, push } = collect();
    push(
      'event: handoff\ndata: {"reason":"no_knowledge","message":"Try support","prominent":true,"contact":{}}\n\n',
    );
    push('event: error\ndata: {"code":"PROVIDER_UNAVAILABLE"}\n\n');
    expect(events[0]?.event).toBe('handoff');
    expect(events[1]?.event).toBe('error');
  });

  it('drops handoff frames with unknown reasons (P8-D2 R1)', () => {
    const { events, push } = collect();
    push(
      'event: handoff\ndata: {"reason":"escalate_now","message":"x","prominent":false,"contact":{}}\n\n',
    );
    expect(events).toHaveLength(0);
  });
});

describe('newIdempotencyKey', () => {
  it('produces canonical v4 UUIDs and differs per call', () => {
    const seen = new Set([newIdempotencyKey(), newIdempotencyKey(), newIdempotencyKey()]);
    expect(seen.size).toBe(3);
    for (const key of seen) {
      expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

describe('streamChat', () => {
  function chunkReader(chunks: string[]): {
    readonly getReader: () => {
      readonly read: () => Promise<{
        readonly done: boolean;
        readonly value?: Uint8Array | undefined;
      }>;
      readonly releaseLock: () => void;
    };
  } {
    let index = 0;
    return {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) return { done: true };
          const value = new TextEncoder().encode(chunks[index] as string);
          index += 1;
          return { done: false, value };
        },
        releaseLock: () => undefined,
      }),
    };
  }

  it('streams events and sends the idempotency key header', async () => {
    const seen: SseParsedEvent[] = [];
    let capturedHeaders: Record<string, string> = {};
    const fetchFn = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      capturedHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        body: chunkReader([
          'event: meta\ndata: {"request_id":"r","conversation_id":"c","message_id":"m"}\n\n',
          'event: done\ndata: {"status":"complete"}\n\n',
        ]),
      };
    });
    await streamChat({
      apiUrl: 'https://api.example.com',
      token: 'tok',
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
      botSlug: 'website-support',
      conversationId: null,
      message: 'Hi',
      fetchFn,
      onEvent: (event) => void seen.push(event),
    });
    expect(capturedHeaders['idempotency-key']).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(capturedHeaders['authorization']).toBe('Bearer tok');
    expect(seen.map((e) => e.event)).toEqual(['meta', 'done']);
  });

  it('rejects 409/400 without opening a stream', async () => {
    const conflict = vi.fn(async () => ({ ok: false, status: 409, body: null }));
    await expect(
      streamChat({
        apiUrl: 'https://api.example.com',
        token: 't',
        idempotencyKey: 'k',
        botSlug: 'b',
        conversationId: null,
        message: 'm',
        fetchFn: conflict,
        onEvent: () => undefined,
      }),
    ).rejects.toThrow('IDEMPOTENT_IN_PROGRESS');
    const mismatch = vi.fn(async () => ({ ok: false, status: 400, body: null }));
    await expect(
      streamChat({
        apiUrl: 'https://api.example.com',
        token: 't',
        idempotencyKey: 'k',
        botSlug: 'b',
        conversationId: null,
        message: 'm',
        fetchFn: mismatch,
        onEvent: () => undefined,
      }),
    ).rejects.toThrow('IDEMPOTENT_MISMATCH');
  });
});

describe('fetchHistory', () => {
  it('returns the bounded page and drops system rows even if sent', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        conversation_id: 'c',
        messages: [
          { id: '1', role: 'user', content: 'Hi' },
          { id: '2', role: 'assistant', content: 'Hello' },
          { id: '3', role: 'system', content: 'secret' },
          'garbage',
        ],
        has_more: true,
      }),
    }));
    const page = await fetchHistory({
      apiUrl: 'https://api.example.com',
      token: 't',
      conversationId: 'c',
      fetchFn,
    });
    expect(page.hasMore).toBe(true);
    expect(page.messages.map((m) => m.id)).toEqual(['1', '2']);
  });
});
