// POST /v1/chat (TECH_SPECS section 4, ARCHITECTURE section 3). P7.
//
// This route owns steps 1-2 of the per-request order and the hand-over to SSE; the chat service
// owns the rest. Everything up to `reply.hijack()` answers with the JSON error envelope and
// nothing has been spent:
//   1. strict body (no history, system prompt, context or key is accepted), a canonical
//      Idempotency-Key, a bearer token that authenticates, and (in the service) a `bot_slug` that
//      is the token's bot
//   2. message rate limit (per session, then per IP bucket), then beginRun: a repeat of a finished
//      request is answered with JSON (the stored status, no SSE, no spend); one still running gets
//      409 with a retry hint; the same key with another body is 400
// The headers and `meta` event are written the moment the service has reserved the budget and
// stored the visitor message.

import type { FastifyInstance } from 'fastify';
import { chatRequestSchema } from '@ragbot/shared';
import { AppError } from '../lib/errors.js';
import { createSseWriter } from '../lib/sse.js';
import { bearerToken, type VisitorAuth } from '../services/auth.js';
import type { ChatService } from '../services/chat.js';
import type { Limits } from '../services/limits.js';
import { isCanonicalIdempotencyKey, requestHash, type Runs } from '../services/runs.js';

export interface ChatRouteDeps {
  readonly auth: Pick<VisitorAuth, 'authenticate'>;
  readonly limits: Pick<Limits, 'loadMessagePolicy' | 'consumeMessage'>;
  readonly runs: Pick<Runs, 'beginRun'>;
  readonly chat: ChatService;
  readonly now?: () => number;
}

export function registerChatRoutes(app: FastifyInstance, deps: ChatRouteDeps): void {
  const { auth, limits, runs, chat } = deps;
  const now = deps.now ?? Date.now;

  app.post('/v1/chat', async (request, reply) => {
    const startedAt = now();

    // 1. Body, key and token.
    const body = chatRequestSchema.safeParse(request.body);
    if (!body.success) throw new AppError('INVALID_REQUEST', { internalName: 'chat_body_invalid' });
    const key = request.headers['idempotency-key'];
    if (!isCanonicalIdempotencyKey(key)) {
      throw new AppError('INVALID_REQUEST', { internalName: 'idempotency_key_invalid' });
    }
    const visitor = await auth.authenticate(bearerToken(request.headers.authorization));

    // 2. Rate limit, then the run. A replay or a conflict ends here.
    const policy = await limits.loadMessagePolicy(visitor.bot_id);
    await limits.consumeMessage(visitor, request.clientIp, policy);
    const begun = await runs.beginRun(visitor, key, requestHash(body.data));
    if (begun.kind === 'replay') return reply.status(200).send(begun.response);

    // 3-6. Context, guards, budget reservation, stored question, run marked running.
    const turn = await chat.prepare({
      visitor,
      runId: begun.runId,
      body: body.data,
      startedAt,
    });

    // 7-20. From here on the response is a stream and errors are events.
    reply.hijack();
    const sse = createSseWriter(reply.raw);
    const clientGone = new AbortController();
    sse.onClientGone(() => clientGone.abort());
    try {
      await chat.run(turn, {
        sse,
        log: request.log,
        clientSignal: clientGone.signal,
        headers: reply.getHeaders(),
      });
    } catch {
      // run() does not throw; this is the last resort so a socket is never left open.
      request.log.error({ run_id: turn.runId, code: 'chat_run_threw' }, 'chat run failed');
      sse.end();
    }
    return undefined;
  });
}
