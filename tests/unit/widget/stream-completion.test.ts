// Offline stream lifecycle regression; all bytes and credentials are synthetic.
import { describe, expect, it, vi } from 'vitest';
import { streamChat } from '../../../widget/src/api.ts';

const meta = 'event: meta\ndata: {"request_id":"r","conversation_id":"c","message_id":"m"}\n\n';
const delta = 'event: delta\ndata: {"text":"FAKE partial"}\n\n';

async function run(chunks: readonly string[], signal?: AbortSignal) {
  const events: string[] = [];
  const releaseLock = vi.fn();
  let index = 0;
  const fetchFn = vi.fn(async () => ({
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length
            ? { done: false, value: new TextEncoder().encode(chunks[index++]) }
            : { done: true },
        releaseLock,
      }),
    },
  }));
  let failure: string | undefined;
  try {
    await streamChat({
      apiUrl: 'https://api.invalid',
      botSlug: 'fake',
      token: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      conversationId: null,
      message: 'FAKE question',
      fetchFn,
      signal,
      onEvent: (event) => events.push(event.event),
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : 'unknown';
  }
  expect(releaseLock).toHaveBeenCalledOnce();
  expect(fetchFn).toHaveBeenCalledOnce();
  return { failure, events };
}

describe('stream completion', () => {
  for (const [name, chunks] of [
    ['empty', []],
    ['meta only', [meta]],
    ['partial text', [meta, delta, delta]],
    ['malformed done', [meta, delta, 'event: done\ndata: {"status":null}\n\n']],
    ['unknown done status', [meta, delta, 'event: done\ndata: {"status":"invented"}\n\n']],
  ] as const) {
    it(`rejects ${name} EOF as interrupted without resending`, async () => {
      expect((await run(chunks)).failure).toBe('STREAM_INTERRUPTED');
    });
  }
  it('accepts a valid done or error terminal outcome', async () => {
    expect(
      (await run([meta, delta, 'event: done\ndata: {"status":"complete"}\n\n'])).failure,
    ).toBeUndefined();
    expect(
      (await run([meta, 'event: error\ndata: {"code":"PROVIDER_UNAVAILABLE"}\n\n'])).failure,
    ).toBeUndefined();
  });
  it('does not convert a user abort into an unexpected EOF', async () => {
    const stop = new AbortController();
    stop.abort();
    expect((await run([], stop.signal)).failure).toBeUndefined();
  });
});
