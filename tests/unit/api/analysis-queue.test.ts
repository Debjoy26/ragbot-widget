import { describe, expect, it, vi } from 'vitest';
import { createAnalysisQueue } from '../../../api/src/services/analysis-queue.ts';
import type { Db } from '../../../api/src/lib/supabase.ts';

// P9-T2: the analysis enqueue service against a labelled FAKE database.

const BOT = 'b0000000-0000-4000-8000-000000000001';
const CONVERSATION = 'c0000000-0000-4000-8000-000000000001';

function setup(rpc: (name: string, args: Record<string, unknown>) => unknown = () => 'job-1') {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const db: Pick<Db, 'rpc'> = {
    rpc: (async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return rpc(name, args) as never;
    }) as Db['rpc'],
  };
  return { queue: createAnalysisQueue({ db }), calls };
}

describe('analysis queue', () => {
  it('enqueues with bot, conversation and the debounce delay', async () => {
    const { queue, calls } = setup();
    await queue.enqueue(BOT, CONVERSATION);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'queue_analysis_job',
      args: {
        p_bot_id: BOT,
        p_conversation_id: CONVERSATION,
        p_debounce_seconds: 300,
      },
    });
  });

  it('resolves quietly when the conversation is gone (RB037 race)', async () => {
    const fail = vi.fn(async () => {
      const { DbError } = await import('../../../api/src/lib/supabase.ts');
      throw new DbError('http', 404, 'RB037');
    });
    const { queue, calls } = setup(fail as never);
    await expect(queue.enqueue(BOT, CONVERSATION)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('rejects when the database is otherwise unavailable', async () => {
    const fail = vi.fn(async () => {
      throw new Error('connection reset');
    });
    const { queue } = setup(fail as never);
    await expect(queue.enqueue(BOT, CONVERSATION)).rejects.toThrow('connection reset');
    expect(fail).toHaveBeenCalledTimes(1);
  });
});
