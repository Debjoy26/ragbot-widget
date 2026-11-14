// POST /v1/entries (TECH_SPECS §2, PRD W-13). P9-T1.
//
// Order is part of the contract:
//   1. strict body validation (`createEntryRequestSchema`: unknown fields rejected,
//      `consent` must be literally true)
//   2. form validation against the injected registry: unknown `schema_key` and payload
//      violations are both INVALID_REQUEST (fail closed; an empty registry rejects all)
//   3. when `conversation_id` is given, it must be the visitor's own conversation
//      (same bot + session); a missing or foreign conversation answers 404
//      INVALID_REQUEST, so nothing tells them apart (same rule as the history route)
//   4. insert through the service-role `create_data_entry` RPC (migration 016);
//      a lost race on the conversation (RB037) answers the same 404
//
// Logs carry ids and the schema key only: never the payload, consent values,
// or message content.

import type { FastifyInstance } from 'fastify';
import {
  createEntryRequestSchema,
  createEntryResponseSchema,
  type EntrySchemaRegistry,
} from '@ragbot/shared';
import { AppError } from '../lib/errors.js';
import { DbError, type Db } from '../lib/supabase.js';
import { requireVisitor, type VisitorAuth } from '../services/auth.js';

export interface EntriesDeps {
  readonly auth: Pick<VisitorAuth, 'authenticate'>;
  readonly db: Pick<Db, 'selectOne' | 'rpc'>;
  /** Approved form schemas. Empty by default: nothing is accepted until registered. */
  readonly registry: Pick<EntrySchemaRegistry, 'validate'>;
}

/** One row from a set-returning RPC; PostgREST answers an array. */
function singleRow(raw: unknown): unknown {
  return Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
}

const entryRowSchema = createEntryResponseSchema;

/** `create_data_entry` raises this when the conversation is missing or foreign. */
const CONVERSATION_NOT_FOUND_SQLSTATE = 'RB037';

const internal = (internalName: string): AppError =>
  new AppError('INTERNAL_ERROR', { internalName });

export function registerEntriesRoutes(app: FastifyInstance, deps: EntriesDeps): void {
  const { auth, db, registry } = deps;

  app.post('/v1/entries', { preHandler: requireVisitor(auth) }, async (request, reply) => {
    // 1. Strict body. Consent must be literally true; anything else is a client bug.
    const body = createEntryRequestSchema.safeParse(request.body);
    if (!body.success) {
      throw new AppError('INVALID_REQUEST', { internalName: 'entries_body_invalid' });
    }
    const visitor = request.visitor;
    if (visitor === undefined) throw new AppError('UNAUTHORIZED', { internalName: 'no_visitor' });

    // 2. Approved form only. Unknown keys and bad payloads share one answer.
    const checked = registry.validate(body.data.schema_key, body.data.payload);
    if (!checked.success) {
      throw new AppError('INVALID_REQUEST', {
        internalName:
          checked.reason === 'unknown_schema_key'
            ? 'entries_unknown_schema'
            : 'entries_invalid_payload',
      });
    }

    // 3. Conversation ownership, when the entry is attached to one.
    if (body.data.conversation_id !== null) {
      let conversation: unknown;
      try {
        conversation = await db.selectOne(
          'conversations',
          {
            id: body.data.conversation_id,
            bot_id: visitor.bot_id,
            visitor_session_id: visitor.session_id,
          },
          ['id'],
        );
      } catch (err) {
        if (err instanceof DbError) throw internal('entries_conversation_lookup_failed');
        throw err;
      }
      if (conversation === null) {
        throw new AppError('INVALID_REQUEST', {
          httpStatus: 404,
          internalName: 'entries_conversation_not_found',
        });
      }
    }

    // 4. Store. Consent is recorded as a timestamp, never as an echoed boolean.
    let raw: unknown;
    try {
      raw = await db.rpc<unknown>('create_data_entry', {
        p_bot_id: visitor.bot_id,
        p_conversation_id: body.data.conversation_id,
        p_schema_key: body.data.schema_key,
        p_payload: checked.data,
        p_consent_at: new Date().toISOString(),
      });
    } catch (err) {
      if (err instanceof DbError && err.sqlstate === CONVERSATION_NOT_FOUND_SQLSTATE) {
        throw new AppError('INVALID_REQUEST', {
          httpStatus: 404,
          internalName: 'entries_conversation_not_found',
        });
      }
      throw err;
    }
    const row = entryRowSchema.safeParse(singleRow(raw));
    if (!row.success) throw internal('entries_row_bad');

    request.log.info(
      {
        bot_id: visitor.bot_id,
        session_id: visitor.session_id,
        schema_key: body.data.schema_key,
        entry_id: row.data.entry_id,
      },
      'data entry recorded',
    );
    return reply.status(200).send(row.data);
  });
}
