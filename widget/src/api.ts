// P8 API client: chat SSE stream, conversation history and idempotent send
// (TECH_SPECS §4, UI_SCHEMA §4).
//
// Wire format (api/src/lib/sse.ts): frames are
// `event: <name>\ndata: <json>\n\n`, comments start with `:`. Order is
// meta, delta*, sources, (handoff), done — or error (+ optional handoff).
// The client never auto-resends after partial output: a retry reconciles the
// idempotency key with server state first (UI_SCHEMA §8).

import type { SseParsedEvent, WidgetHandoff, WidgetSourceRef } from './types.js';
import { SSE_EVENT_NAMES } from './types.js';
import { MESSAGE_STATUSES } from '../../shared/src/contracts.js';

export interface ChatEvents {
  readonly onEvent: (event: SseParsedEvent) => void;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const HANDOFF_REASONS: readonly string[] = [
  'no_knowledge',
  'out_of_scope',
  'human_requested',
  'blocked',
  'unavailable',
  'repeated_no_knowledge',
];

function isSourceRef(value: unknown): value is WidgetSourceRef {
  if (!isRecord(value)) return false;
  const v = value as Readonly<Record<string, unknown>>;
  return typeof v['chunk_id'] === 'string' && typeof v['title'] === 'string';
}

function coerceEvent(name: string, data: unknown): SseParsedEvent | null {
  if (!SSE_EVENT_NAMES.includes(name)) return null;
  if (!isRecord(data)) return null;
  switch (name) {
    case 'meta': {
      const d = data as Readonly<Record<string, unknown>>;
      if (
        typeof d['request_id'] !== 'string' ||
        typeof d['conversation_id'] !== 'string' ||
        typeof d['message_id'] !== 'string'
      ) {
        return null;
      }
      return {
        event: 'meta',
        data: {
          requestId: d['request_id'],
          conversationId: d['conversation_id'],
          messageId: d['message_id'],
        },
      };
    }
    case 'delta': {
      const d = data as Readonly<Record<string, unknown>>;
      if (typeof d['text'] !== 'string') return null;
      return { event: 'delta', data: { text: d['text'] } };
    }
    case 'sources': {
      const d = data as Readonly<Record<string, unknown>>;
      const sources = d['sources'];
      if (!Array.isArray(sources) || !sources.every(isSourceRef)) return null;
      return {
        event: 'sources',
        data: { sources: (sources as readonly WidgetSourceRef[]).map((s) => ({ ...s })) },
      };
    }
    case 'handoff': {
      const d = data as Readonly<Record<string, unknown>>;
      if (typeof d['reason'] !== 'string' || typeof d['message'] !== 'string') return null;
      if (!HANDOFF_REASONS.includes(d['reason'])) return null;
      if (!isRecord(d['contact'])) return null;
      const handoff: WidgetHandoff = {
        reason: d['reason'] as WidgetHandoff['reason'],
        message: d['message'],
        prominent: d['prominent'] === true,
        contact: d['contact'] as unknown as WidgetHandoff['contact'],
      };
      return { event: 'handoff', data: handoff };
    }
    case 'done': {
      const d = data as Readonly<Record<string, unknown>>;
      if (
        typeof d['status'] !== 'string' ||
        !MESSAGE_STATUSES.some((status) => status === d['status'])
      )
        return null;
      return { event: 'done', data: { status: d['status'] } };
    }
    case 'error': {
      const d = data as Readonly<Record<string, unknown>>;
      if (typeof d['code'] !== 'string') return null;
      return {
        event: 'error',
        data: {
          code: d['code'],
          ...(typeof d['request_id'] === 'string' ? { requestId: d['request_id'] } : {}),
          ...(typeof d['retryable'] === 'boolean' ? { retryable: d['retryable'] } : {}),
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Incremental SSE frame parser. Feed decoded text chunks; complete frames are
 * emitted via `onEvent`. Unknown events and malformed frames are dropped (never
 * rendered). Returns any trailing incomplete buffer via `flush()`.
 */
export function createSseParser(onEvent: (event: SseParsedEvent) => void): {
  readonly push: (chunk: string) => void;
  readonly flush: () => void;
} {
  let buffer = '';
  const emitFrame = (frame: string): void => {
    const lines = frame.split('\n');
    let name: string | null = null;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) name = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
    }
    if (name === null || dataLines.length === 0) return;
    try {
      const event = coerceEvent(name, JSON.parse(dataLines.join('\n')) as unknown);
      if (event !== null) onEvent(event);
    } catch {
      // Malformed JSON frames are dropped, never rendered.
    }
  };
  return {
    push(chunk: string): void {
      buffer += chunk;
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (frame.trim().length > 0) emitFrame(frame);
        index = buffer.indexOf('\n\n');
      }
    },
    flush(): void {
      if (buffer.trim().length > 0) emitFrame(buffer);
      buffer = '';
    },
  };
}

export interface StreamFetch {
  (
    url: string,
    init: {
      readonly method: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<{
    readonly ok: boolean;
    readonly status: number;
    readonly body: {
      readonly getReader: () => {
        readonly read: () => Promise<{
          readonly done: boolean;
          readonly value?: Uint8Array | undefined;
        }>;
        readonly releaseLock: () => void;
      };
    } | null;
  }>;
}

/** Build a canonical v4 UUID idempotency key with the available entropy. */
export function newIdempotencyKey(randomValues?: (array: Uint8Array) => Uint8Array): string {
  const bytes = new Uint8Array(16);
  if (randomValues !== undefined) {
    randomValues(bytes);
  } else {
    const cryptoRef = (
      globalThis as {
        readonly crypto?: { readonly getRandomValues?: (a: Uint8Array) => Uint8Array };
      }
    ).crypto;
    if (cryptoRef?.getRandomValues !== undefined) cryptoRef.getRandomValues(bytes);
    else throw new Error('no secure randomness for idempotency key');
  }
  // NOTE: keep the casts inside their own parens. `x as number & 0x0f` parses
  // the `number & 0x0f` as an intersection *type* (a no-op cast), which drops
  // the mask and can emit a non-4 version nibble.
  const b6 = bytes[6] as number;
  const b8 = bytes[8] as number;
  bytes[6] = (b6 & 0x0f) | 0x40;
  bytes[8] = (b8 & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => (b as number).toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Stream one chat turn. Rejects before opening the stream on 409 (duplicate in
 * progress — reconcile first) and 400 (same key, different body — new key
 * required). Partial output is never auto-resent by this function.
 */
export async function streamChat(args: {
  readonly apiUrl: string;
  readonly token: string;
  readonly idempotencyKey: string;
  readonly botSlug: string;
  readonly conversationId: string | null;
  readonly message: string;
  readonly preferredLanguage?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly fetchFn: StreamFetch;
  readonly onEvent: (event: SseParsedEvent) => void;
}): Promise<void> {
  const {
    apiUrl,
    token,
    idempotencyKey,
    botSlug,
    conversationId,
    message,
    preferredLanguage,
    signal,
    fetchFn,
    onEvent,
  } = args;
  const body: Record<string, string | null> = {
    bot_slug: botSlug,
    conversation_id: conversationId,
    message,
  };
  if (preferredLanguage !== undefined) body['preferred_language'] = preferredLanguage;
  const response = await fetchFn(`${apiUrl.replace(/\/$/, '')}/v1/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'idempotency-key': idempotencyKey,
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    if (response.status === 409) throw new Error('IDEMPOTENT_IN_PROGRESS');
    if (response.status === 400) throw new Error('IDEMPOTENT_MISMATCH');
    if (response.status === 401 || response.status === 403) throw new Error('SESSION_EXPIRED');
    if (response.status === 429) throw new Error('RATE_LIMITED');
    throw new Error('CHAT_FAILED');
  }
  if (response.body === null) throw new Error('CHAT_FAILED');
  const reader = response.body.getReader();
  let terminal = false;
  const parser = createSseParser((event) => {
    if (event.event === 'done' || event.event === 'error') terminal = true;
    onEvent(event);
  });
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) parser.push(decoder.decode(value, { stream: true }));
      if (signal?.aborted === true) break;
    }
    parser.push(decoder.decode());
    parser.flush();
    if (!terminal && signal?.aborted !== true) throw new Error('STREAM_INTERRUPTED');
  } finally {
    reader.releaseLock();
  }
}

export interface HistoryFetch {
  (
    url: string,
    init: { readonly headers: Readonly<Record<string, string>> },
  ): Promise<{
    readonly ok: boolean;
    readonly status: number;
    readonly json: () => Promise<unknown>;
  }>;
}

export interface HistoryPage {
  readonly conversationId: string;
  readonly messages: readonly {
    readonly id: string;
    readonly role: string;
    readonly content: string;
  }[];
  readonly hasMore: boolean;
}

/** Same-session bounded history. System rows are excluded server-side. */
export async function fetchHistory(args: {
  readonly apiUrl: string;
  readonly token: string;
  readonly conversationId: string;
  readonly before?: string | undefined;
  readonly fetchFn: HistoryFetch;
}): Promise<HistoryPage> {
  const params = args.before === undefined ? '' : `?before=${encodeURIComponent(args.before)}`;
  const response = await args.fetchFn(
    `${args.apiUrl.replace(/\/$/, '')}/v1/conversations/${encodeURIComponent(args.conversationId)}${params}`,
    { headers: { authorization: `Bearer ${args.token}`, accept: 'application/json' } },
  );
  if (!response.ok) throw new Error('HISTORY_FAILED');
  const parsed = (await response.json()) as unknown;
  if (!isRecord(parsed)) throw new Error('HISTORY_FAILED');
  const p = parsed as Readonly<Record<string, unknown>>;
  if (
    typeof p['conversation_id'] !== 'string' ||
    !Array.isArray(p['messages']) ||
    typeof p['has_more'] !== 'boolean'
  ) {
    throw new Error('HISTORY_FAILED');
  }
  return {
    conversationId: p['conversation_id'],
    messages: (p['messages'] as readonly unknown[]).filter(isRecord).flatMap((m) => {
      const r = m as Readonly<Record<string, unknown>>;
      // Defense in depth: the server excludes `system` rows, and the widget
      // refuses to render them even if one ever arrives.
      if (typeof r['id'] !== 'string' || typeof r['content'] !== 'string') return [];
      if (r['role'] !== 'user' && r['role'] !== 'assistant') return [];
      return [{ id: r['id'], role: r['role'], content: r['content'] }];
    }),
    hasMore: p['has_more'],
  };
}
