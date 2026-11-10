import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { SseEvent } from '@ragbot/shared';
import { SseProtocolError, createSseWriter } from '../../../api/src/lib/sse.ts';

// A labelled FAKE response: records what the writer does, with no socket.
class FakeResponse extends EventEmitter {
  status: number | undefined;
  headers: Record<string, unknown> = {};
  frames: string[] = [];
  flushed = false;
  writableEnded = false;
  writableFinished = false;
  destroyed = false;
  /** When false, write() reports backpressure until 'drain' is emitted. */
  accept = true;

  writeHead(status: number, headers: Record<string, unknown>) {
    this.status = status;
    this.headers = headers;
    return this;
  }
  flushHeaders() {
    this.flushed = true;
  }
  write(frame: string) {
    this.frames.push(frame);
    return this.accept;
  }
  end() {
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit('close');
  }
}

const ID = '11111111-1111-4111-8111-111111111111';
const meta: SseEvent = {
  event: 'meta',
  data: { request_id: ID, conversation_id: ID, message_id: ID },
};
const delta = (text: string): SseEvent => ({ event: 'delta', data: { text } });
const sources: SseEvent = { event: 'sources', data: { sources: [] } };
const done: SseEvent = { event: 'done', data: { status: 'complete' } };
const error: SseEvent = { event: 'error', data: { code: 'STREAM_INTERRUPTED', request_id: ID } };
const handoff: SseEvent = {
  event: 'handoff',
  data: {
    reason: 'unavailable',
    message: 'Contact us',
    prominent: false,
    contact: { email: 'a@b.example' },
  },
};

function make() {
  const res = new FakeResponse();
  const writer = createSseWriter(res as unknown as ServerResponse);
  return { res, writer };
}

describe('SSE writer', () => {
  it('flushes headers at once, with the fixed event-stream headers', () => {
    const { res, writer } = make();
    writer.start({ 'x-request-id': 'r1', 'cache-control': 'max-age=5', 'content-length': 10 });
    expect(res.status).toBe(200);
    expect(res.flushed).toBe(true);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toBe('r1');
    expect(res.headers['content-length']).toBeUndefined();
  });

  it('writes validated frames in the documented order', async () => {
    const { res, writer } = make();
    writer.start({});
    for (const e of [meta, delta('hi'), delta('there'), sources, handoff, done]) {
      // handoff after sources is allowed
      expect(await writer.send(e)).toBe(true);
    }
    expect(res.frames[0]).toBe(`event: meta\ndata: ${JSON.stringify(meta.data)}\n\n`);
    expect(res.frames).toHaveLength(6);
  });

  it('allows error then exactly one handoff, and nothing else', async () => {
    const { writer } = make();
    writer.start({});
    await writer.send(meta);
    await writer.send(delta('a'));
    await writer.send(error);
    await expect(writer.send(delta('b'))).rejects.toBeInstanceOf(SseProtocolError);
    await expect(writer.send(done)).rejects.toBeInstanceOf(SseProtocolError);
    await writer.send(handoff);
    await expect(writer.send(handoff)).rejects.toBeInstanceOf(SseProtocolError);
    await expect(writer.send(error)).rejects.toBeInstanceOf(SseProtocolError);
  });

  it.each([
    ['delta before meta', [delta('x')]],
    ['sources before meta', [sources]],
    ['done before sources', [meta, done]],
    ['a second meta', [meta, meta]],
    ['delta after sources', [meta, sources, delta('x')]],
    ['anything after done', [meta, sources, done, delta('x')]],
    ['handoff without sources', [meta, handoff]],
    ['a second sources', [meta, sources, sources]],
    ['an error before meta', [error]],
  ] as [string, SseEvent[]][])('refuses %s', async (_name, events) => {
    const { res, writer } = make();
    writer.start({});
    const last = events.at(-1) as SseEvent;
    for (const e of events.slice(0, -1)) await writer.send(e);
    const before = res.frames.length;
    await expect(writer.send(last)).rejects.toBeInstanceOf(SseProtocolError);
    expect(res.frames.length).toBe(before); // nothing was written for the refused event
  });

  it('refuses an event that fails its schema, without writing it', async () => {
    const { res, writer } = make();
    writer.start({});
    await writer.send(meta);
    const bad = { event: 'delta', data: { text: 1 } } as unknown as SseEvent;
    await expect(writer.send(bad)).rejects.toBeInstanceOf(SseProtocolError);
    const extra = {
      event: 'done',
      data: { status: 'complete', extra: true },
    } as unknown as SseEvent;
    await expect(writer.send(extra)).rejects.toBeInstanceOf(SseProtocolError);
    const html = {
      event: 'handoff',
      data: { ...handoff.data, message: '<script>' },
    } as unknown as SseEvent;
    await writer.send(sources);
    await expect(writer.send(html)).rejects.toBeInstanceOf(SseProtocolError);
    expect(res.frames).toHaveLength(2);
  });

  it('refuses events before start()', async () => {
    const { writer } = make();
    await expect(writer.send(meta)).rejects.toBeInstanceOf(SseProtocolError);
  });

  it('after a disconnect send() returns false, writes nothing and never throws', async () => {
    const { res, writer } = make();
    writer.start({});
    await writer.send(meta);
    let called = 0;
    writer.onClientGone(() => {
      called += 1;
    });
    res.emit('close'); // the socket closed before the response ended
    expect(writer.clientGone).toBe(true);
    expect(called).toBe(1);
    const frames = res.frames.length;
    expect(await writer.send(delta('x'))).toBe(false);
    expect(res.frames.length).toBe(frames);
    writer.keepAlive();
    expect(res.frames.length).toBe(frames);
    // A late subscriber is told at once.
    writer.onClientGone(() => {
      called += 1;
    });
    expect(called).toBe(2);
  });

  it('a normal end is not a disconnect', async () => {
    const { res, writer } = make();
    writer.start({});
    await writer.send(meta);
    await writer.send(sources);
    await writer.send(done);
    writer.end();
    expect(res.writableEnded).toBe(true);
    expect(writer.clientGone).toBe(false);
  });

  it('waits for drain on backpressure and gives up if the client leaves', async () => {
    const { res, writer } = make();
    writer.start({});
    res.accept = false;
    let resolved = false;
    const pending = writer.send(meta).then((ok) => {
      resolved = ok;
      return ok;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    res.emit('drain');
    expect(await pending).toBe(true);

    res.accept = false;
    const second = writer.send(delta('x'));
    res.emit('close');
    expect(await second).toBe(false);
  });

  it('keep-alive is a comment, never an event', () => {
    const { res, writer } = make();
    writer.start({});
    writer.keepAlive();
    expect(res.frames).toEqual([': keep-alive\n\n']);
  });
});
