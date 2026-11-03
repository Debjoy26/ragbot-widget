/**
 * AI provider configuration (ADR 0014).
 *
 * Every AI role (chat, embedding, moderation, analysis) is configured purely
 * from environment variables, so switching vendor or model is a config change:
 *
 *   <ROLE>_PROVIDER = gemini | openai | anthropic | openai_compatible
 *   <ROLE>_MODEL    = exact model ID (no defaults — fail closed)
 *   <ROLE>_API_KEY  = optional per-role key; otherwise the provider key
 *                     (GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY)
 *   <ROLE>_BASE_URL = required for openai_compatible (any OpenAI-style API)
 *
 * Missing or invalid values throw ProviderConfigError. Error messages name
 * variables, never their values, so keys cannot leak into logs.
 */

export const PROVIDER_KINDS = ['gemini', 'openai', 'anthropic', 'openai_compatible'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const AI_ROLES = [
  'chat_primary',
  'chat_fallback',
  'embedding',
  'moderation',
  'analysis',
] as const;
export type AiRole = (typeof AI_ROLES)[number];

export type Capability = 'chat' | 'embedding' | 'moderation_endpoint';

/** What each provider kind can do. Anthropic has no embeddings API. */
export const PROVIDER_CAPABILITIES: Readonly<Record<ProviderKind, readonly Capability[]>> = {
  gemini: ['chat', 'embedding'],
  openai: ['chat', 'embedding', 'moderation_endpoint'],
  anthropic: ['chat'],
  openai_compatible: ['chat', 'embedding'],
};

/** Fixed by the database contract (`002_vectors.sql`, ADR 0002). */
export const VECTOR_DIMENSIONS = 1536;

const PROVIDER_KEY_VARS: Readonly<Record<Exclude<ProviderKind, 'openai_compatible'>, string>> = {
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

const ROLE_PREFIX: Readonly<Record<AiRole, string>> = {
  chat_primary: 'CHAT_PRIMARY',
  chat_fallback: 'CHAT_FALLBACK',
  embedding: 'EMBEDDING',
  moderation: 'MODERATION',
  analysis: 'ANALYSIS',
};

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export type Env = Readonly<Record<string, string | undefined>>;

export interface ProviderConfig {
  readonly role: AiRole;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly apiKey: string;
  /** Only set for openai_compatible. */
  readonly baseUrl: string | null;
}

export interface EmbeddingConfig extends ProviderConfig {
  readonly dimensions: number;
}

export type ModerationMode = 'endpoint' | 'llm_classifier';

export interface ModerationConfig extends ProviderConfig {
  /** `endpoint` = dedicated moderation API (OpenAI); `llm_classifier` = classify with a chat model. */
  readonly mode: ModerationMode;
}

export interface FallbackConfig extends ProviderConfig {
  /** True when fallback uses the same provider and key as primary: no independent quota (ARCHITECTURE §5). */
  readonly sharesQuotaWithPrimary: boolean;
}

export interface ApiAiConfig {
  readonly chatPrimary: ProviderConfig;
  readonly chatFallback: FallbackConfig | null;
  readonly embedding: EmbeddingConfig;
  readonly moderation: ModerationConfig;
}

export interface WorkerAiConfig {
  readonly embedding: EmbeddingConfig;
  readonly analysis: ProviderConfig;
}

export class ProviderConfigError extends Error {
  override readonly name = 'ProviderConfigError';
}

function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function requireVar(env: Env, name: string): string {
  const value = read(env, name);
  if (value === undefined) throw new ProviderConfigError(`${name} is not set`);
  return value;
}

function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value);
}

function parseBaseUrl(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderConfigError(`${name} is not a valid URL`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new ProviderConfigError(`${name} must use https (http allowed only for localhost)`);
  }
  if (url.username || url.password) {
    throw new ProviderConfigError(`${name} must not embed credentials`);
  }
  return url.toString().replace(/\/$/, '');
}

function requireCapability(role: AiRole, provider: ProviderKind, capability: Capability): void {
  if (!PROVIDER_CAPABILITIES[provider].includes(capability)) {
    throw new ProviderConfigError(`${role}: provider "${provider}" does not support ${capability}`);
  }
}

/** Loads one role. Throws ProviderConfigError on any missing/invalid value. */
export function loadProviderConfig(env: Env, role: AiRole): ProviderConfig {
  const prefix = ROLE_PREFIX[role];
  const providerVar = `${prefix}_PROVIDER`;
  const provider = requireVar(env, providerVar);
  if (!isProviderKind(provider)) {
    throw new ProviderConfigError(`${providerVar} must be one of: ${PROVIDER_KINDS.join(', ')}`);
  }

  const modelVar = `${prefix}_MODEL`;
  const model = requireVar(env, modelVar);
  if (!MODEL_ID.test(model)) throw new ProviderConfigError(`${modelVar} is not a valid model ID`);

  const roleKeyVar = `${prefix}_API_KEY`;
  const baseUrlVar = `${prefix}_BASE_URL`;
  let apiKey: string;
  let baseUrl: string | null = null;

  if (provider === 'openai_compatible') {
    apiKey = requireVar(env, roleKeyVar);
    baseUrl = parseBaseUrl(baseUrlVar, requireVar(env, baseUrlVar));
  } else {
    if (read(env, baseUrlVar) !== undefined) {
      throw new ProviderConfigError(`${baseUrlVar} is only allowed for openai_compatible`);
    }
    const providerKeyVar = PROVIDER_KEY_VARS[provider];
    const key = read(env, roleKeyVar) ?? read(env, providerKeyVar);
    if (key === undefined) {
      throw new ProviderConfigError(`${roleKeyVar} or ${providerKeyVar} must be set`);
    }
    apiKey = key;
  }

  requireCapability(role, provider, role === 'embedding' ? 'embedding' : 'chat');
  return { role, provider, model, apiKey, baseUrl };
}

export function loadEmbeddingConfig(env: Env): EmbeddingConfig {
  const base = loadProviderConfig(env, 'embedding');
  const raw = requireVar(env, 'EMBEDDING_DIMENSIONS');
  const dimensions = Number(raw);
  if (dimensions !== VECTOR_DIMENSIONS) {
    throw new ProviderConfigError(
      `EMBEDDING_DIMENSIONS must be ${VECTOR_DIMENSIONS} to match the database vector column`,
    );
  }
  return { ...base, dimensions };
}

export function loadModerationConfig(env: Env): ModerationConfig {
  const prefix = ROLE_PREFIX.moderation;
  const providerVar = `${prefix}_PROVIDER`;
  const provider = requireVar(env, providerVar);
  if (!isProviderKind(provider)) {
    throw new ProviderConfigError(`${providerVar} must be one of: ${PROVIDER_KINDS.join(', ')}`);
  }
  const defaultMode: ModerationMode = provider === 'openai' ? 'endpoint' : 'llm_classifier';
  const mode = read(env, 'MODERATION_MODE') ?? defaultMode;
  if (mode !== 'endpoint' && mode !== 'llm_classifier') {
    throw new ProviderConfigError('MODERATION_MODE must be endpoint or llm_classifier');
  }
  if (mode === 'endpoint') requireCapability('moderation', provider, 'moderation_endpoint');
  // loadProviderConfig checks the provider can chat; an endpoint provider (openai) always can.
  const base = loadProviderConfig(env, 'moderation');
  return { ...base, mode };
}

export function loadFallbackConfig(env: Env, primary: ProviderConfig): FallbackConfig | null {
  if (read(env, `${ROLE_PREFIX.chat_fallback}_PROVIDER`) === undefined) return null;
  const fallback = loadProviderConfig(env, 'chat_fallback');
  const sharesQuotaWithPrimary =
    fallback.provider === primary.provider &&
    fallback.apiKey === primary.apiKey &&
    fallback.baseUrl === primary.baseUrl;
  return { ...fallback, sharesQuotaWithPrimary };
}

/** Everything the Render API needs. Throws on the first invalid role. */
export function loadApiAiConfig(env: Env): ApiAiConfig {
  const chatPrimary = loadProviderConfig(env, 'chat_primary');
  return {
    chatPrimary,
    chatFallback: loadFallbackConfig(env, chatPrimary),
    embedding: loadEmbeddingConfig(env),
    moderation: loadModerationConfig(env),
  };
}

/** Everything the Render worker needs (no chat or visitor-token secrets). */
export function loadWorkerAiConfig(env: Env): WorkerAiConfig {
  return {
    embedding: loadEmbeddingConfig(env),
    analysis: loadProviderConfig(env, 'analysis'),
  };
}

/** Safe-to-log summary: provider and model only, never keys or URLs. */
export function describeProvider(config: ProviderConfig): string {
  return `${config.role}=${config.provider}:${config.model}`;
}

// ---------------------------------------------------------------------------
// Provider interfaces (P2). Interfaces and error types only — adapters that make
// network calls live in api/ and worker/ (P6/P7). Nothing here touches the network.
// ---------------------------------------------------------------------------

/** Classification every adapter must map upstream failures onto (never raw bodies). */
export const PROVIDER_ERROR_KINDS = [
  'transient',
  'rate_limited',
  'auth',
  'billing',
  'permanent',
] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

/** Only transient and rate-limited failures may be retried or fail over; the rest are configuration/request faults. */
export function isRetryableErrorKind(kind: ProviderErrorKind): boolean {
  return kind === 'transient' || kind === 'rate_limited';
}

/**
 * Classified provider failure. The message must be written by the adapter and must
 * never contain the upstream response body, request content, URLs or keys.
 */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly kind: ProviderErrorKind;
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: { readonly retryAfterSeconds?: number; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }

  /** auth, billing and permanent errors are never retryable. */
  isRetryable(): boolean {
    return isRetryableErrorKind(this.kind);
  }
}

export interface ProviderChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface ChatStreamRequest {
  /** Fixed, cacheable prefix (see prompts.ts). */
  readonly system: string;
  readonly messages: readonly ProviderChatMessage[];
  readonly maxOutputTokens: number;
  // No temperature/top_p: current Claude models reject sampling parameters, and RAG
  // answers use provider defaults. Adapters must not add them.
  /** Aborting must cancel the upstream call (client disconnect means cancellation). */
  readonly signal?: AbortSignal;
}

export interface ChatStreamChunk {
  readonly text: string;
}

export interface ChatUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
}

/**
 * Streams text chunks; the generator's return value is the final usage so the
 * caller can record cost. Throws ProviderError.
 */
export type ChatStream = AsyncGenerator<ChatStreamChunk, ChatUsage, void>;

export interface ChatProvider {
  readonly provider: ProviderKind;
  readonly model: string;
  stream(request: ChatStreamRequest): ChatStream;
}

export type EmbeddingTaskType = 'query' | 'document';

export interface EmbeddingResult {
  readonly vectors: number[][];
  /** Billable input tokens; null only when the provider does not report usage. */
  readonly inputTokens: number | null;
}

export interface EmbedOptions {
  readonly taskType: EmbeddingTaskType;
  readonly signal?: AbortSignal;
}

export interface EmbeddingProvider {
  readonly provider: ProviderKind;
  readonly model: string;
  /** Always VECTOR_DIMENSIONS. */
  readonly dimensions: typeof VECTOR_DIMENSIONS;
  /**
   * One vector of VECTOR_DIMENSIONS per input, in input order, plus usage so query and
   * ingestion embeddings count toward budgets (TECH_SPECS §8).
   */
  embed(texts: readonly string[], options: EmbedOptions): Promise<EmbeddingResult>;
}

export type ModerationVerdict = 'allow' | 'block';

export interface ModerationResult {
  readonly verdict: ModerationVerdict;
  /** Provider/policy category labels; informational only. */
  readonly categories: readonly string[];
  /** Set for llm_classifier mode (billable); null for free moderation endpoints. */
  readonly usage: ChatUsage | null;
}

export interface ModerationProvider {
  readonly provider: ProviderKind;
  readonly model: string;
  moderate(text: string, options?: { readonly signal?: AbortSignal }): Promise<ModerationResult>;
}

/** Throws a permanent ProviderError when a provider returns the wrong shape (never silently pads/truncates). */
export function assertEmbeddingShape(
  vectors: readonly (readonly number[])[],
  expectedCount: number,
): void {
  if (vectors.length !== expectedCount) {
    throw new ProviderError('permanent', 'embedding provider returned an unexpected vector count');
  }
  for (const v of vectors) {
    if (v.length !== VECTOR_DIMENSIONS || v.some((n) => !Number.isFinite(n))) {
      throw new ProviderError('permanent', 'embedding provider returned an invalid vector');
    }
  }
}
