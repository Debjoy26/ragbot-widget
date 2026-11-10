// Server-sent events writer for POST /v1/chat (TECH_SPECS section 4, P7).
//
// Rules this module enforces, so a route bug cannot break the wire contract:
//  * Every event is validated against the shared schema (`sseEventSchema`) before a byte is written.
//    A bad event is a programming error: it throws SseProtocolError and nothing is written.
//  * Order is checked: meta, delta*, sources, (handoff), done; or an error at any point after meta,
//    optionally followed by exactly one handoff. Nothing is accepted after `done`, and nothing but
//    that one handoff after `error`.
//  * Headers are flushed at once, so the widget sees the stream open before the first provider call.
//  * A client that went away makes `send` return false; it never throws and never writes.
//  * Frames carry the validated payload only: no free text from this module.

import type { ServerResponse } from 'node:http';
import { sseEventSchema, type SseEvent, type SseEventName } from '@ragbot/shared';

/** Thrown for an invalid event or an event out of order. The message is fixed text: no payload. */
export class SseProtocolError extends Error {
  override readonly name = 'SseProtocolError';
}

export interface SseWriter {
  /** Writes the status line and headers and flushes them. Call once, before any event. */
  start(headers: Readonly<Record<string, string | number | readonly string[] | undefined>>): void;
  /**
   * Validates and writes one event. Returns false when the client is gone (nothing written).
   * Throws SseProtocolError for an invalid or out-of-order event.
   */
  send(event: SseEvent): Promise<boolean>;
  /** Writes an SSE comment (keep-alive). Never an event. */
  keepAlive(): void;
  /** Ends the response (idempotent). */
  end(): void;
  /** True once the client closed the connection before the response ended. */
  readonly clientGone: boolean;
  /** True after `done`, or after `error` (and its optional handoff). */
  readonly finished: boolean;
  /** Registers a callback for a client disconnect. Called at most once. */
  onClientGone(callback: () => void): void;
}

type Phase = 'new' | 'meta' | 'delta' | 'sources' | 'handoff' | 'errored' | 'closed';

function allowed(phase: Phase, name: SseEventName): boolean {
  switch (name) {
    case 'meta':
      return phase === 'new';
    case 'delta':
      return phase === 'meta' || phase === 'delta';
    case 'sources':
      return phase === 'meta' || phase === 'delta';
    case 'handoff':
      return phase === 'sources' || phase === 'errored';
    case 'done':
      return phase === 'sources' || phase === 'handoff';
    case 'error':
      return phase !== 'new' && phase !== 'errored' && phase !== 'closed';
  }
}

function nextPhase(phase: Phase, name: SseEventName): Phase {
  switch (name) {
    case 'meta':
      return 'meta';
    case 'delta':
      return 'delta';
    case 'sources':
      return 'sources';
    case 'handoff':
      return phase === 'errored' ? 'closed' : 'handoff';
    case 'done':
      return 'closed';
    case 'error':
      return 'errored';
  }
}

export function createSseWriter(raw: ServerResponse): SseWriter {
  let phase: Phase = 'new';
  // A client that left before the response was taken over has already fired its 'close': read the
  // state of the socket now instead of waiting for an event that will not come.
  let gone = raw.destroyed || raw.socket?.destroyed === true;
  let started = false;
  const callbacks: (() => void)[] = [];

  raw.once('close', () => {
    // 'close' also fires after a normal end(): only an unfinished response means the client left.
    if (raw.writableFinished) return;
    gone = true;
    for (const cb of callbacks.splice(0)) {
      try {
        cb();
      } catch {
        // a callback must never break the close handler
      }
    }
  });

  const unusable = (): boolean => gone || raw.destroyed || raw.writableEnded;

  function waitForDrain(): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        raw.off('drain', done);
        raw.off('close', done);
        resolve();
      };
      raw.once('drain', done);
      raw.once('close', done);
    });
  }

  return {
    start(headers) {
      if (started) throw new SseProtocolError('sse already started');
      started = true;
      if (unusable()) return; // nobody is listening: write nothing
      const out: Record<string, string | number | readonly string[]> = {};
      for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined) out[name] = value;
      }
      // Fixed by this module: an event stream that no cache or proxy may keep or buffer.
      out['content-type'] = 'text/event-stream; charset=utf-8';
      out['cache-control'] = 'no-store';
      out['x-accel-buffering'] = 'no';
      delete out['content-length'];
      raw.writeHead(200, out as unknown as Record<string, string | number | string[]>);
      raw.flushHeaders();
    },

    async send(event) {
      const parsed = sseEventSchema.safeParse(event);
      if (!parsed.success) throw new SseProtocolError('invalid sse event');
      if (!started) throw new SseProtocolError('sse not started');
      if (!allowed(phase, parsed.data.event)) throw new SseProtocolError('sse event out of order');
      phase = nextPhase(phase, parsed.data.event);
      if (unusable()) return false;
      const frame = `event: ${parsed.data.event}\ndata: ${JSON.stringify(parsed.data.data)}\n\n`;
      if (!raw.write(frame)) await waitForDrain();
      return !unusable();
    },

    keepAlive() {
      // Nothing at all follows `error` or `done` (a handoff after an error is an event, not this).
      if (started && !unusable() && phase !== 'closed' && phase !== 'errored') {
        raw.write(': keep-alive\n\n');
      }
    },

    end() {
      if (!raw.writableEnded && !raw.destroyed) raw.end();
    },

    get clientGone() {
      return gone;
    },

    get finished() {
      return phase === 'closed' || phase === 'errored';
    },

    onClientGone(callback) {
      if (gone) callback();
      else callbacks.push(callback);
    },
  };
}
