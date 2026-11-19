// Production chat-service wiring with real cache implementations. Database and
// providers are labelled fakes from chat-harness; no network or provider calls.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEmbeddingCache,
  isEmbeddingCacheEnabled,
  type EmbeddingCacheRecord,
} from '../../../api/src/services/embedding-cache.ts';
import {
  createModerationCache,
  isModerationCacheEnabled,
  type ModerationCacheRecord,
} from '../../../api/src/services/moderation-cache.ts';
import { createConfigCache, isC2Enabled } from '../../../api/src/services/config-cache.ts';
import { createConversations, type ChatContext } from '../../../api/src/services/conversations.ts';
import type { Db } from '../../../api/src/lib/supabase.ts';
import { isRetrievalCacheEnabled } from '../../../api/src/services/retrieval-cache.ts';
import { isAnswerCacheEnabled } from '../../../api/src/services/answer-cache.ts';
import {
  chatBody,
  closeApps,
  defaultContext,
  names,
  parseSse,
  postChat,
  setup,
} from './chat-harness.ts';

afterEach(closeApps);
const model = 'fake-embedding-model';
const moderationModel = 'test/moderation-model';
const question = String(chatBody().message);
function caches() {
  const embeddingL2 = {
    get: vi.fn(async () => null),
    set: vi.fn(async (_r: EmbeddingCacheRecord) => {}),
  };
  const moderationL2 = {
    get: vi.fn(async () => null),
    set: vi.fn(async (_r: ModerationCacheRecord) => {}),
  };
  return {
    embeddingL2,
    moderationL2,
    embeddingCache: createEmbeddingCache({ l2: embeddingL2 }),
    moderationCache: createModerationCache({ l2: moderationL2 }),
  };
}
async function populate(c: ReturnType<typeof caches>) {
  await c.embeddingCache.set(model, 1536, question, new Array<number>(1536).fill(0.01));
  await c.moderationCache.set(moderationModel, 'v1', question, 'allow');
  vi.clearAllMocks();
}
async function turn(c: ReturnType<typeof caches>, policy: Record<string, unknown>) {
  const h = setup({
    embeddingCache: c.embeddingCache,
    moderationCache: c.moderationCache,
    context: defaultContext({ settings: { cache_policy: policy } }),
  });
  const response = await postChat(h, chatBody());
  expect(response.statusCode).toBe(200);
  expect(names(parseSse(response.body))).toContain('done');
  return h;
}

describe('documented global kill_switch', () => {
  it.each([
    ['C2', isC2Enabled],
    ['C4', isEmbeddingCacheEnabled],
    ['C5', isRetrievalCacheEnabled],
    ['C6', isModerationCacheEnabled],
    ['C7', isAnswerCacheEnabled],
  ] as const)('%s disables even when enable flags are present', (_layer, enabled) => {
    expect(enabled({ kill_switch: true, enabled: true, c7: true })).toBe(false);
  });
});

describe('C2 reads policy from the production context shape', () => {
  it.each([{ kill_switch: true }, { enabled: false }, { c2: false }])(
    'refetches disabled context %j',
    async (policy) => {
      const raw = defaultContext({ settings: { cache_policy: policy } });
      const botId = (raw['bot'] as { id: string }).id;
      const cache = createConfigCache<ChatContext>();
      const rpc = vi.fn(async () => raw);
      const selectOne = vi.fn(async () => ({ settings_version: 1 }));
      const service = createConversations({
        db: { rpc, selectOne } as unknown as Db,
        configCache: cache,
      });
      await service.loadContext(botId);
      expect(cache.get(botId, 1)).toBeUndefined();
      await service.loadContext(botId);
      expect(rpc).toHaveBeenCalledTimes(2);
    },
  );
});

describe('chat passes the current policy to C4 and C6 reads and writes', () => {
  for (const [label, policy] of [
    ['global enabled:false', { enabled: false }],
    ['individual flags', { c4: false, c6: false }],
    ['documented kill_switch', { kill_switch: true }],
  ] as const) {
    it.each([false, true])(`${label} bypasses both caches (prepopulated=%s)`, async (warmed) => {
      const c = caches();
      if (warmed) await populate(c);
      const h = await turn(c, policy);
      expect(h.embedding.calls).toBe(1);
      expect(h.moderationProvider.texts).toContain(question);
      expect(c.embeddingL2.get).not.toHaveBeenCalled();
      expect(c.embeddingL2.set).not.toHaveBeenCalled();
      expect(c.moderationL2.get).not.toHaveBeenCalled();
      expect(c.moderationL2.set).not.toHaveBeenCalled();
      if (!warmed) {
        expect(c.embeddingCache.getL1(model, 1536, question)).toBeUndefined();
        expect(c.moderationCache.getL1(moderationModel, 'v1', question)).toBeUndefined();
      }
    });
  }

  it('C4 can be disabled while C6 remains enabled', async () => {
    const c = caches();
    await populate(c);
    const h = await turn(c, { c4: false });
    expect(h.embedding.calls).toBe(1);
    expect(h.moderationProvider.texts).not.toContain(question);
  });

  it('C6 can be disabled while C4 remains enabled', async () => {
    const c = caches();
    await populate(c);
    const h = await turn(c, { c6: false });
    expect(h.embedding.calls).toBe(0);
    expect(h.moderationProvider.texts).toContain(question);
  });

  it('re-enabling uses valid entries while the disabled request populated nothing', async () => {
    const c = caches();
    await populate(c);
    await turn(c, { kill_switch: true });
    vi.clearAllMocks();
    const h = await turn(c, { kill_switch: false });
    expect(h.embedding.calls).toBe(0);
    expect(h.moderationProvider.texts).not.toContain(question);
  });
});
