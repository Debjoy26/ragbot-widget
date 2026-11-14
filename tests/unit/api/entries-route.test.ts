import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createEntrySchemaRegistry, type EntrySchemaRegistry } from '@ragbot/shared';
import { buildTestServer } from './helpers.ts';
import { createVisitorAuth } from '../../../api/src/services/auth.ts';
import { registerEntriesRoutes } from '../../../api/src/routes/entries.ts';
import { FAKE_VISITOR_SECRET, testConfig } from './helpers.ts';
import type { Db } from '../../../api/src/lib/supabase.ts';

const BOT = randomUUID();
const SESSION = randomUUID();
const CONVERSATION = randomUUID();
const ENTRY = randomUUID();

const callbackSchema = z.strictObject({
  name: z.string().min(1).max(200),
  phone: z.string().min(1).max(30),
});

function registryWithCallback(): EntrySchemaRegistry {
  const registry = createEntrySchemaRegistry();
  registry.register('callback_request', callbackSchema);
  return registry;
}

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

function setup(
  registry: EntrySchemaRegistry = registryWithCallback(),
  dbOver: {
    conversationRow?: Record<string, unknown> | null;
    entryId?: string;
    rpcName?: string;
  } = {},
) {
  const config = testConfig();
  const rpcs: RpcCall[] = [];
  const db: Db = {
    ping: async () => true,
    selectOne: (async () => {
      if (dbOver.conversationRow !== undefined) return dbOver.conversationRow;
      return { id: CONVERSATION };
    }) as Db['selectOne'],
    rpc: (async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return [{ entry_id: dbOver.entryId ?? ENTRY }];
    }) as Db['rpc'],
  };
  const auth = createVisitorAuth({
    secret: FAKE_VISITOR_SECRET,
    ttlSeconds: 900,
    db: {
      selectOne: (async () => ({
        token_version: 1,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        revoked_at: null,
      })) as Db['selectOne'],
    },
  });
  const token = auth.issueToken({ bot_id: BOT, session_id: SESSION, token_version: 1 }).token;
  const app = buildTestServer({ config, db, auth });
  registerEntriesRoutes(app, { auth, db, registry });
  return { app, token, rpcs };
}

afterEach(async () => {
  vi.restoreAllMocks();
});

const post = (
  app: { inject: (o: unknown) => Promise<{ statusCode: number; body: string }> },
  token: string,
  body: unknown,
) =>
  app.inject({
    method: 'POST',
    url: '/v1/entries',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  }) as Promise<{ statusCode: number; body: string }>;

const json = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

describe('POST /v1/entries (P9-T1, W-13)', () => {
  it('records a valid entry and returns its id', async () => {
    const { app, token, rpcs } = setup();
    const res = await post(app, token, {
      conversation_id: CONVERSATION,
      schema_key: 'callback_request',
      payload: { name: 'Asha', phone: '+911234567890' },
      consent: true,
    });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ entry_id: expect.any(String) });
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]?.name).toBe('create_data_entry');
    expect(rpcs[0]?.args).toMatchObject({
      p_bot_id: BOT,
      p_conversation_id: CONVERSATION,
      p_schema_key: 'callback_request',
    });
    // Consent is stored as a timestamp, never as a boolean echo.
    expect(typeof rpcs[0]?.args['p_consent_at']).toBe('string');
    // The raw payload is passed through for storage; nothing extra is added.
    expect(rpcs[0]?.args['p_payload']).toEqual({ name: 'Asha', phone: '+911234567890' });
  });

  it('accepts a null conversation_id (standalone entry)', async () => {
    const { app, token, rpcs } = setup();
    const res = await post(app, token, {
      conversation_id: null,
      schema_key: 'callback_request',
      payload: { name: 'Asha', phone: '+911234567890' },
      consent: true,
    });
    expect(res.statusCode).toBe(200);
    expect(rpcs[0]?.args).toMatchObject({ p_conversation_id: null });
  });

  it('400 INVALID_REQUEST for an unknown schema_key (fail closed)', async () => {
    const { app, token, rpcs } = setup(createEntrySchemaRegistry());
    const res = await post(app, token, {
      conversation_id: null,
      schema_key: 'callback_request',
      payload: { name: 'Asha' },
      consent: true,
    });
    expect(res.statusCode).toBe(400);
    expect(json(res)).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(rpcs).toHaveLength(0);
  });

  it('400 INVALID_REQUEST when the payload violates the form schema', async () => {
    const { app, token, rpcs } = setup();
    const res = await post(app, token, {
      conversation_id: null,
      schema_key: 'callback_request',
      payload: { name: 'Asha' },
      consent: true,
    });
    expect(res.statusCode).toBe(400);
    expect(json(res)).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(rpcs).toHaveLength(0);
  });

  it('400 INVALID_REQUEST when an unknown field is added (strict forms)', async () => {
    const { app, token, rpcs } = setup();
    const res = await post(app, token, {
      conversation_id: null,
      schema_key: 'callback_request',
      payload: { name: 'Asha', phone: '+911234567890', admin: true },
      consent: true,
    });
    expect(res.statusCode).toBe(400);
    expect(rpcs).toHaveLength(0);
  });

  it('400 INVALID_REQUEST when consent is missing', async () => {
    const { app, token, rpcs } = setup();
    const res = await post(app, token, {
      conversation_id: null,
      schema_key: 'callback_request',
      payload: { name: 'Asha', phone: '+911234567890' },
    });
    expect(res.statusCode).toBe(400);
    expect(rpcs).toHaveLength(0);
  });

  it('404 INVALID_REQUEST when the conversation belongs to another session (no oracle)', async () => {
    const { app, token, rpcs } = setup(registryWithCallback(), { conversationRow: null });
    const res = await post(app, token, {
      conversation_id: randomUUID(),
      schema_key: 'callback_request',
      payload: { name: 'Asha', phone: '+911234567890' },
      consent: true,
    });
    expect(res.statusCode).toBe(404);
    expect(json(res)).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(rpcs).toHaveLength(0);
  });

  it('401 without a visitor token and never reaches the database', async () => {
    const { app, rpcs } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/entries',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        conversation_id: null,
        schema_key: 'callback_request',
        payload: { name: 'Asha', phone: '+911234567890' },
        consent: true,
      }),
    });
    expect(res.statusCode).toBe(401);
    expect(rpcs).toHaveLength(0);
  });
});
