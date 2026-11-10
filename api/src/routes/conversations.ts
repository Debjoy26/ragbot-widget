// GET /v1/conversations/:id?before=<uuid> (TECH_SPECS section 2, ADR 0009). P7.
//
// The visitor's own conversation only, one bounded page (HISTORY_PAGE_SIZE), oldest first, with no
// `system` rows (the database function never returns them and the schema forbids the role). The
// route exists only while `feature_flags.history_enabled` is not switched off for the bot: off is
// 403 FORBIDDEN. A conversation that does not exist, belongs to another session or bot, or a
// `before` message that is not in it, all answer 404 INVALID_REQUEST: nothing tells them apart.

import type { FastifyInstance } from 'fastify';
import {
  conversationHistoryRequestSchema,
  conversationHistoryResponseSchema,
  idParamSchema,
} from '@ragbot/shared';
import { AppError } from '../lib/errors.js';
import { requireVisitor, type VisitorAuth } from '../services/auth.js';
import { historyEnabled, type Conversations } from '../services/conversations.js';

export interface ConversationRouteDeps {
  readonly auth: Pick<VisitorAuth, 'authenticate'>;
  readonly conversations: Pick<Conversations, 'loadContext' | 'history'>;
  /** HISTORY_PAGE_SIZE. */
  readonly pageSize: number;
}

export function registerConversationRoutes(
  app: FastifyInstance,
  deps: ConversationRouteDeps,
): void {
  const { auth, conversations, pageSize } = deps;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new TypeError('history page size must be 1..100');
  }

  app.get('/v1/conversations/:id', { preHandler: requireVisitor(auth) }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    const query = conversationHistoryRequestSchema.safeParse(request.query);
    if (!params.success || !query.success) {
      throw new AppError('INVALID_REQUEST', { internalName: 'history_request_invalid' });
    }
    const visitor = request.visitor;
    if (visitor === undefined) throw new AppError('UNAUTHORIZED', { internalName: 'no_visitor' });

    const ctx = await conversations.loadContext(visitor.bot_id);
    if (!ctx.bot.enabled || !historyEnabled(ctx.settings.feature_flags)) {
      throw new AppError('FORBIDDEN', { internalName: 'history_disabled' });
    }

    let page;
    try {
      page = await conversations.history({
        botId: visitor.bot_id,
        sessionId: visitor.session_id,
        conversationId: params.data.id,
        before: query.data.before ?? null,
        limit: pageSize,
      });
    } catch (err) {
      if (err instanceof AppError && err.internalName === 'conversation_not_found') {
        throw new AppError('INVALID_REQUEST', {
          httpStatus: 404,
          internalName: 'conversation_not_found',
        });
      }
      throw err;
    }
    const response = conversationHistoryResponseSchema.safeParse({
      conversation_id: params.data.id,
      messages: page.messages,
      has_more: page.hasMore,
    });
    if (!response.success) {
      throw new AppError('INTERNAL_ERROR', { internalName: 'history_response_invalid' });
    }
    request.log.info(
      { bot_id: visitor.bot_id, session_id: visitor.session_id, count: page.messages.length },
      'conversation history served',
    );
    return reply.status(200).send(response.data);
  });
}
