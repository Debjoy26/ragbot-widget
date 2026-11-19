// C8 validated warming configuration (plan.md P7.5 C8, PRE-P11 T06).
//
// Opt-in and default-off: without WARM_ENABLED=true the loader returns null and
// the worker starts without warming. With it, every WARM_* value is explicit:
// no defaults, and a missing or invalid value stops the worker at start-up.
// Errors name variables only, never their values.
//
// Secrets: provider keys never enter this loader. Chat and moderation roles
// contribute identities only, so the warmed cache keys are pinned by explicit
// WARM_CHAT_*/WARM_MODERATION_* identity variables that the deployer keeps equal
// to the API's CHAT_*/MODERATION_* values. The key format matches
// api/src/app.ts exactly so warmed entries are looked up by live requests.
// Provider keys for the actual calls are NOT configured here: at registry build
// time (handlers.ts, T13) the worker reuses the key of the already-configured
// embedding/analysis role whose vendor matches, and fails closed at startup when
// no held key matches. No API-only secret ever reaches the worker.
// Generation credentials are wired separately (T13); this loader pins identities,
// limits and prices.
//
// The `ai` object is passed through by reference from loadWorkerConfig, which
// already hides its keys and freezes it. This loader never logs, spreads or
// re-freezes it.
import { z } from 'zod';
import {
  PROVIDER_KINDS,
  type Env,
  type ModerationMode,
  type ProviderKind,
  type WorkerAiConfig,
} from '@ragbot/shared';
import { ConfigError } from './config.js';

export interface WarmingConfig {
  readonly ai: WorkerAiConfig;
  /** Split identities (the key strings stay the source of truth for cache pins). */
  readonly chatProvider: ProviderKind;
  readonly chatModel: string;
  readonly moderationProvider: ProviderKind;
  readonly moderationModel: string;
  readonly contextMaxTokens: number;
  readonly maxOutputTokens: number;
  readonly maxOutputChars: number;
  readonly topK: number;
  readonly minSimilarity: number;
  readonly deadlineMs: number;
  readonly reserveTtlSeconds: number;
  readonly moderationMaxChars: number;
  readonly embeddingPricePerMillionTokens: number;
  readonly chatPrice: { readonly inputPerMillion: number; readonly outputPerMillion: number };
  readonly moderationPrice: { readonly inputPerMillion: number; readonly outputPerMillion: number };
  readonly chatModelKey: string;
  readonly moderationModelKey: string;
  /** Validated WARM_MODERATION_MODE. Endpoint calls are free; the classifier is billed. */
  readonly moderationMode: ModerationMode;
}

const nonEmpty = z.string().trim().min(1);

const integer = (min: number, max: number) =>
  nonEmpty
    .regex(/^\d{1,10}$/)
    .transform((v) => Number(v))
    .pipe(z.number().int().min(min).max(max));

/** A non-negative decimal such as `0.15`. Not exponent notation, not negative, bounded. */
const decimal = (max: number) =>
  nonEmpty
    .regex(/^\d{1,6}(\.\d{1,6})?$/)
    .transform((v) => Number(v))
    .pipe(z.number().finite().min(0).max(max));

/** Warming prices feed budget reservations: zero would make the math meaningless. */
const price = (max: number) => decimal(max).refine((v) => v > 0, { message: 'must be above zero' });

const providerKind: z.ZodType<ProviderKind> = nonEmpty.refine(
  (v): v is ProviderKind => (PROVIDER_KINDS as readonly string[]).includes(v),
  { message: 'must be a known provider' },
);

/** Mirrors shared providers.ts MODEL_ID. Identity only; keys never reach this loader. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const modelId = nonEmpty.regex(MODEL_ID, { message: 'is not a valid model ID' });

const enabledSchema = z.object({
  WARM_CONTEXT_MAX_TOKENS: integer(1, 10_000_000),
  WARM_MAX_OUTPUT_TOKENS: integer(1, 1_000_000),
  WARM_MAX_OUTPUT_CHARS: integer(100, 10_000_000),
  WARM_TOP_K: integer(1, 50),
  WARM_MIN_SIMILARITY: decimal(1),
  WARM_DEADLINE_MS: integer(1, 86_400_000),
  WARM_RESERVE_TTL_SECONDS: integer(60, 86_400),
  WARM_MODERATION_MAX_CHARS: integer(1, 10_000_000),
  WARM_EMBEDDING_PRICE_PER_MILLION_TOKENS: price(10_000),
  WARM_CHAT_PRICE_INPUT_PER_MILLION: price(100_000),
  WARM_CHAT_PRICE_OUTPUT_PER_MILLION: price(100_000),
  WARM_MODERATION_PRICE_INPUT_PER_MILLION: price(100_000),
  WARM_MODERATION_PRICE_OUTPUT_PER_MILLION: price(100_000),
  WARM_CHAT_PROVIDER: providerKind,
  WARM_CHAT_MODEL: modelId,
  WARM_CHAT_FALLBACK_PROVIDER: providerKind.optional(),
  WARM_CHAT_FALLBACK_MODEL: modelId.optional(),
  WARM_MODERATION_PROVIDER: providerKind,
  WARM_MODERATION_MODEL: modelId,
  WARM_MODERATION_MODE: z.enum(['endpoint', 'llm_classifier']),
});

/** The reservation must outlive the invocation deadline with margin (mirrors the API rule). */
const RESERVE_MARGIN_MS = 60_000;

function fail(names: readonly string[], detail: string): never {
  const unique = [...new Set(names)];
  throw new ConfigError(unique, `Invalid warming configuration: ${detail}`);
}

/**
 * Validates the environment and returns a frozen warming config, or null when
 * warming is not enabled (missing or false flag: default-off). Throws
 * ConfigError on a warmer that is enabled but misconfigured.
 */
export function loadWarmingConfig(env: Env, ai: WorkerAiConfig): WarmingConfig | null {
  const flag = env['WARM_ENABLED'];
  if (flag === undefined || flag === 'false') return null;
  if (flag !== 'true') fail(['WARM_ENABLED'], 'WARM_ENABLED must be true or false');

  const parsed = enabledSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? 'unknown')))];
    fail(names, names.join(', '));
  }
  const v = parsed.data;

  const [fallbackProviderSet, fallbackModelSet] = [
    v.WARM_CHAT_FALLBACK_PROVIDER !== undefined,
    v.WARM_CHAT_FALLBACK_MODEL !== undefined,
  ];
  if (fallbackProviderSet !== fallbackModelSet) {
    fail(
      ['WARM_CHAT_FALLBACK_PROVIDER', 'WARM_CHAT_FALLBACK_MODEL'],
      'WARM_CHAT_FALLBACK_PROVIDER, WARM_CHAT_FALLBACK_MODEL (fallback provider and model are both required or both absent)',
    );
  }
  if (v.WARM_RESERVE_TTL_SECONDS * 1000 < v.WARM_DEADLINE_MS + RESERVE_MARGIN_MS) {
    fail(
      ['WARM_RESERVE_TTL_SECONDS', 'WARM_DEADLINE_MS'],
      'WARM_RESERVE_TTL_SECONDS, WARM_DEADLINE_MS (the reservation must outlive the deadline plus margin)',
    );
  }

  // Key format matches api/src/app.ts exactly so warmed entries hit live lookups.
  const chatModelKey =
    v.WARM_CHAT_FALLBACK_PROVIDER === undefined || v.WARM_CHAT_FALLBACK_MODEL === undefined
      ? `${v.WARM_CHAT_PROVIDER}/${v.WARM_CHAT_MODEL}`
      : `${v.WARM_CHAT_PROVIDER}/${v.WARM_CHAT_MODEL}|${v.WARM_CHAT_FALLBACK_PROVIDER}/${v.WARM_CHAT_FALLBACK_MODEL}`;
  const moderationModelKey = `${v.WARM_MODERATION_PROVIDER}/${v.WARM_MODERATION_MODEL}/${v.WARM_MODERATION_MODE}`;

  const config: WarmingConfig = {
    ai,
    chatProvider: v.WARM_CHAT_PROVIDER,
    chatModel: v.WARM_CHAT_MODEL,
    moderationProvider: v.WARM_MODERATION_PROVIDER,
    moderationModel: v.WARM_MODERATION_MODEL,
    contextMaxTokens: v.WARM_CONTEXT_MAX_TOKENS,
    maxOutputTokens: v.WARM_MAX_OUTPUT_TOKENS,
    maxOutputChars: v.WARM_MAX_OUTPUT_CHARS,
    topK: v.WARM_TOP_K,
    minSimilarity: v.WARM_MIN_SIMILARITY,
    deadlineMs: v.WARM_DEADLINE_MS,
    reserveTtlSeconds: v.WARM_RESERVE_TTL_SECONDS,
    moderationMaxChars: v.WARM_MODERATION_MAX_CHARS,
    moderationMode: v.WARM_MODERATION_MODE,
    embeddingPricePerMillionTokens: v.WARM_EMBEDDING_PRICE_PER_MILLION_TOKENS,
    chatPrice: Object.freeze({
      inputPerMillion: v.WARM_CHAT_PRICE_INPUT_PER_MILLION,
      outputPerMillion: v.WARM_CHAT_PRICE_OUTPUT_PER_MILLION,
    }),
    moderationPrice: Object.freeze({
      inputPerMillion: v.WARM_MODERATION_PRICE_INPUT_PER_MILLION,
      outputPerMillion: v.WARM_MODERATION_PRICE_OUTPUT_PER_MILLION,
    }),
    chatModelKey,
    moderationModelKey,
  };
  return Object.freeze(config);
}
