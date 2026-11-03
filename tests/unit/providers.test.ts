import { describe, expect, it } from 'vitest';
import {
  describeProvider,
  loadApiAiConfig,
  loadProviderConfig,
  loadWorkerAiConfig,
  ProviderConfigError,
  type Env,
} from '@ragbot/shared';

// Fake placeholder keys — not real credentials.
const FAKE_GEMINI = 'fake-gemini-key-for-tests';
const FAKE_OPENAI = 'fake-openai-key-for-tests';

const geminiOnly: Env = {
  GEMINI_API_KEY: FAKE_GEMINI,
  CHAT_PRIMARY_PROVIDER: 'gemini',
  CHAT_PRIMARY_MODEL: 'gemini-2.5-flash-lite',
  EMBEDDING_PROVIDER: 'gemini',
  EMBEDDING_MODEL: 'gemini-embedding-001',
  EMBEDDING_DIMENSIONS: '1536',
  MODERATION_PROVIDER: 'gemini',
  MODERATION_MODEL: 'gemini-2.5-flash-lite',
  ANALYSIS_PROVIDER: 'gemini',
  ANALYSIS_MODEL: 'gemini-2.5-flash-lite',
};

function expectConfigError(fn: () => unknown, message: RegExp): void {
  expect(fn).toThrow(ProviderConfigError);
  expect(fn).toThrow(message);
}

describe('provider config — Gemini-only setup', () => {
  it('loads the API config with shared provider key', () => {
    const cfg = loadApiAiConfig(geminiOnly);
    expect(cfg.chatPrimary).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-flash-lite' });
    expect(cfg.chatPrimary.apiKey).toBe(FAKE_GEMINI);
    expect(cfg.embedding.dimensions).toBe(1536);
    expect(cfg.moderation.mode).toBe('llm_classifier');
    expect(cfg.chatFallback).toBeNull();
  });

  it('loads the worker config', () => {
    const cfg = loadWorkerAiConfig(geminiOnly);
    expect(describeProvider(cfg.analysis)).toBe('analysis=gemini:gemini-2.5-flash-lite');
  });
});

describe('provider config — switching is env-only', () => {
  it('switches chat to Anthropic and embeddings to OpenAI', () => {
    const cfg = loadApiAiConfig({
      ...geminiOnly,
      ANTHROPIC_API_KEY: 'fake-anthropic',
      OPENAI_API_KEY: FAKE_OPENAI,
      CHAT_PRIMARY_PROVIDER: 'anthropic',
      CHAT_PRIMARY_MODEL: 'claude-haiku-5-5',
      EMBEDDING_PROVIDER: 'openai',
      EMBEDDING_MODEL: 'text-embedding-3-small',
    });
    expect(cfg.chatPrimary.provider).toBe('anthropic');
    expect(cfg.embedding.apiKey).toBe(FAKE_OPENAI);
  });

  it('supports any OpenAI-compatible API with base URL and role key', () => {
    const cfg = loadProviderConfig(
      {
        CHAT_PRIMARY_PROVIDER: 'openai_compatible',
        CHAT_PRIMARY_MODEL: 'llama-3.3-70b',
        CHAT_PRIMARY_API_KEY: 'fake-compat',
        CHAT_PRIMARY_BASE_URL: 'https://api.example-llm.com/v1/',
      },
      'chat_primary',
    );
    expect(cfg.baseUrl).toBe('https://api.example-llm.com/v1');
  });

  it('allows http only for a localhost OpenAI-compatible server', () => {
    const env = {
      CHAT_PRIMARY_PROVIDER: 'openai_compatible',
      CHAT_PRIMARY_MODEL: 'local-model',
      CHAT_PRIMARY_API_KEY: 'x',
      CHAT_PRIMARY_BASE_URL: 'http://localhost:11434/v1',
    };
    expect(loadProviderConfig(env, 'chat_primary').baseUrl).toBe('http://localhost:11434/v1');
    expectConfigError(
      () =>
        loadProviderConfig(
          { ...env, CHAT_PRIMARY_BASE_URL: 'http://evil.example.com/v1' },
          'chat_primary',
        ),
      /must use https/,
    );
  });

  it('per-role key overrides the provider key', () => {
    const cfg = loadProviderConfig(
      { ...geminiOnly, CHAT_PRIMARY_API_KEY: 'fake-role-key' },
      'chat_primary',
    );
    expect(cfg.apiKey).toBe('fake-role-key');
  });

  it('uses the OpenAI moderation endpoint when moderation provider is openai', () => {
    const cfg = loadApiAiConfig({
      ...geminiOnly,
      OPENAI_API_KEY: FAKE_OPENAI,
      MODERATION_PROVIDER: 'openai',
      MODERATION_MODEL: 'omni-moderation-latest',
    });
    expect(cfg.moderation.mode).toBe('endpoint');
  });
});

describe('provider config — fails closed', () => {
  it('rejects a missing model (no silent default)', () => {
    const { CHAT_PRIMARY_MODEL: _omit, ...env } = geminiOnly;
    expectConfigError(() => loadApiAiConfig(env), /CHAT_PRIMARY_MODEL is not set/);
  });

  it('rejects a missing key', () => {
    const { GEMINI_API_KEY: _omit, ...env } = geminiOnly;
    expectConfigError(() => loadApiAiConfig(env), /CHAT_PRIMARY_API_KEY or GEMINI_API_KEY/);
  });

  it('rejects an unknown provider', () => {
    expectConfigError(
      () => loadApiAiConfig({ ...geminiOnly, CHAT_PRIMARY_PROVIDER: 'acme' }),
      /must be one of/,
    );
  });

  it('rejects Anthropic for embeddings (no embeddings API)', () => {
    expectConfigError(
      () =>
        loadWorkerAiConfig({
          ...geminiOnly,
          ANTHROPIC_API_KEY: 'fake',
          EMBEDDING_PROVIDER: 'anthropic',
          EMBEDDING_MODEL: 'any',
        }),
      /does not support embedding/,
    );
  });

  it('rejects a dimension that does not match the database column', () => {
    expectConfigError(
      () => loadWorkerAiConfig({ ...geminiOnly, EMBEDDING_DIMENSIONS: '768' }),
      /must be 1536/,
    );
  });

  it('rejects moderation endpoint mode for a provider without one', () => {
    expectConfigError(
      () => loadApiAiConfig({ ...geminiOnly, MODERATION_MODE: 'endpoint' }),
      /does not support moderation_endpoint/,
    );
  });

  it('rejects a base URL on a non-compatible provider (key exfiltration guard)', () => {
    expectConfigError(
      () => loadApiAiConfig({ ...geminiOnly, CHAT_PRIMARY_BASE_URL: 'https://proxy.example.com' }),
      /only allowed for openai_compatible/,
    );
  });

  it('rejects base URLs with embedded credentials', () => {
    expectConfigError(
      () =>
        loadProviderConfig(
          {
            CHAT_PRIMARY_PROVIDER: 'openai_compatible',
            CHAT_PRIMARY_MODEL: 'm',
            CHAT_PRIMARY_API_KEY: 'x',
            CHAT_PRIMARY_BASE_URL: 'https://user:pass@api.example.com',
          },
          'chat_primary',
        ),
      /must not embed credentials/,
    );
  });

  it('never includes key values in error messages', () => {
    try {
      loadApiAiConfig({ ...geminiOnly, EMBEDDING_DIMENSIONS: 'abc' });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(FAKE_GEMINI);
    }
  });
});

describe('provider config — fallback quota independence', () => {
  it('flags a fallback that shares provider and key with primary', () => {
    const cfg = loadApiAiConfig({
      ...geminiOnly,
      CHAT_FALLBACK_PROVIDER: 'gemini',
      CHAT_FALLBACK_MODEL: 'gemini-3.1-flash-lite',
    });
    expect(cfg.chatFallback?.sharesQuotaWithPrimary).toBe(true);
  });

  it('marks a different-provider fallback as independent', () => {
    const cfg = loadApiAiConfig({
      ...geminiOnly,
      OPENAI_API_KEY: FAKE_OPENAI,
      CHAT_FALLBACK_PROVIDER: 'openai',
      CHAT_FALLBACK_MODEL: 'gpt-small',
    });
    expect(cfg.chatFallback?.sharesQuotaWithPrimary).toBe(false);
  });
});
