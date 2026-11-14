// Debounced analysis enqueue (P9-T2, W-10). After a chat turn is persisted, the API asks
// the database to queue one `analyze_conversation` job for the conversation. The RPC
// debounces by dedupe key (a new message pushes the window back) and returns the job id
// of the in-flight run when one already covers recent messages.
//
// The chat service calls this in a try/catch that only warns: analysis must never fail
// or delay a visitor turn. An RB037 (the conversation vanished in a race) resolves
// quietly; any other database failure rejects so the caller can log it.
import { DbError, type Db } from '../lib/supabase.js';

/** Debounce window pushed back by every new message (seconds). */
export const ANALYSIS_DEBOUNCE_SECONDS = 300;

export interface AnalysisQueue {
  enqueue(botId: string, conversationId: string): Promise<void>;
}

export function createAnalysisQueue(deps: { db: Pick<Db, 'rpc'> }): AnalysisQueue {
  const { db } = deps;
  return {
    async enqueue(botId: string, conversationId: string): Promise<void> {
      try {
        await db.rpc<unknown>('queue_analysis_job', {
          p_bot_id: botId,
          p_conversation_id: conversationId,
          p_debounce_seconds: ANALYSIS_DEBOUNCE_SECONDS,
        });
      } catch (err) {
        if (err instanceof DbError && err.sqlstate === 'RB037') return;
        throw err;
      }
    },
  };
}
