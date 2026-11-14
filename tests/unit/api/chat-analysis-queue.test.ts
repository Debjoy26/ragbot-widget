import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOT,
  CONVERSATION,
  closeApps,
  dbError,
  deltaText,
  eventOf,
  names,
  parseSse,
  postChat,
  setup,
} from './chat-harness.ts';

afterEach(closeApps);

describe('POST /v1/chat: background analysis enqueue (P9-T2, W-10)', () => {
  it('enqueues analysis with the turn bot and conversation after a persisted turn', async () => {
    const queueAnalysis = { enqueue: vi.fn(async () => undefined) };
    const h = setup({ queueAnalysis });
    const events = parseSse((await postChat(h)).body);
    expect(eventOf(events, 'done').data.status).toBe('complete');
    expect(queueAnalysis.enqueue).toHaveBeenCalledTimes(1);
    expect(queueAnalysis.enqueue).toHaveBeenCalledWith(BOT, CONVERSATION);
  });

  it('still completes the stream when the enqueue fails', async () => {
    const queueAnalysis = { enqueue: vi.fn(async () => Promise.reject(new Error('db down'))) };
    const h = setup({ queueAnalysis });
    const res = await postChat(h);
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    expect(names(events)).toEqual(['meta', 'delta', 'sources', 'done']);
    expect(deltaText(events)).toBe('Plans start at ten dollars.');
    expect(queueAnalysis.enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not enqueue when the turn is not persisted', async () => {
    const queueAnalysis = { enqueue: vi.fn(async () => undefined) };
    const h = setup({
      queueAnalysis,
      dbFail: { finish_chat_turn: () => dbError('RB030') },
    });
    const res = await postChat(h);
    expect(res.statusCode).toBe(200);
    expect(queueAnalysis.enqueue).not.toHaveBeenCalled();
  });

  it('never enqueues without the hook (no-op default keeps old tests quiet)', async () => {
    const h = setup();
    const events = parseSse((await postChat(h)).body);
    expect(eventOf(events, 'done').data.status).toBe('complete');
  });
});
