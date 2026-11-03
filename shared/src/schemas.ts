/**
 * Runtime schemas (Zod 4) for every untrusted or cross-process payload.
 * Browser-safe: no Node imports.
 *
 * Rules enforced throughout (handover §4, UI_SCHEMA §5–§6.1):
 * - request bodies are strict: unknown fields are rejected, never ignored
 * - public text is plain text: no angle brackets or control characters
 * - URLs are https only; phone numbers are E.164; time zones are IANA
 */

import { z } from 'zod';
import {
  ADMIN_ROLES,
  ANALYSIS_STATUSES,
  BUDGET_RESERVATION_STATES,
  CHUNK_ID_PATTERN,
  CONVERSATION_STATUSES,
  DISCLOSURE_POLICIES,
  DOCUMENT_STATUSES,
  DOCUMENT_VERSION_STATUSES,
  EXTRACTION_METHODS,
  HANDOFF_REASONS,
  JOB_STATES,
  JOB_TYPES,
  MEDIA_TYPES,
  MESSAGE_ROLES,
  MESSAGE_STATUSES,
  MODERATION_VERDICTS,
  REQUEST_RUN_STATES,
  SENTIMENTS,
  USAGE_OPERATIONS,
  VISITOR_VISIBLE_ROLES,
  WEEKDAYS,
  WIDGET_POSITIONS,
  type AdminBotSettingsPatch,
  type ChatRequest,
  type ContactBlock,
  type CreateEntryRequest,
  type CreateSessionRequest,
  type ConversationHistoryResponse,
  type HandoffContact,
  type PublicBotConfig,
  type SseEvent,
  type VisitorTokenClaims,
} from './contracts.js';
import { ERROR_CODES } from './errors.js';

// ---------------------------------------------------------------------------
// Enum schemas built from the canonical tuples
// ---------------------------------------------------------------------------

export const adminRoleSchema = z.enum(ADMIN_ROLES);
export const documentStatusSchema = z.enum(DOCUMENT_STATUSES);
export const disclosurePolicySchema = z.enum(DISCLOSURE_POLICIES);
export const documentVersionStatusSchema = z.enum(DOCUMENT_VERSION_STATUSES);
export const mediaTypeSchema = z.enum(MEDIA_TYPES);
export const extractionMethodSchema = z.enum(EXTRACTION_METHODS);
export const conversationStatusSchema = z.enum(CONVERSATION_STATUSES);
export const messageRoleSchema = z.enum(MESSAGE_ROLES);
export const messageStatusSchema = z.enum(MESSAGE_STATUSES);
export const handoffReasonSchema = z.enum(HANDOFF_REASONS);
export const jobTypeSchema = z.enum(JOB_TYPES);
export const jobStateSchema = z.enum(JOB_STATES);
export const requestRunStateSchema = z.enum(REQUEST_RUN_STATES);
export const budgetReservationStateSchema = z.enum(BUDGET_RESERVATION_STATES);
export const analysisStatusSchema = z.enum(ANALYSIS_STATUSES);
export const sentimentSchema = z.enum(SENTIMENTS);
export const usageOperationSchema = z.enum(USAGE_OPERATIONS);
export const moderationVerdictSchema = z.enum(MODERATION_VERDICTS);
export const widgetPositionSchema = z.enum(WIDGET_POSITIONS);
export const errorCodeSchema = z.enum(ERROR_CODES);

// ---------------------------------------------------------------------------
// Primitive validators
// ---------------------------------------------------------------------------

function hasControlChars(value: string, allowWhitespace: boolean): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (allowWhitespace && (c === 0x0a || c === 0x09)) continue;
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Plain text: trimmed, bounded, no angle brackets (no HTML) and no control characters. */
export function plainText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !/[<>]/.test(v), 'must be plain text without HTML')
    .refine((v) => !hasControlChars(v, false), 'must not contain control characters');
}

/** Admin-authored free text (tone/scope): newlines allowed, control characters are not. */
export function freeText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !hasControlChars(v, true), 'must not contain control characters');
}

export const uuidSchema = z.uuid();

/** Lower-case slug used in the embed snippet and chat requests. */
export const BOT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const botSlugSchema = z.string().regex(BOT_SLUG_PATTERN);

export const LANGUAGE_TAG_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
export const languageTagSchema = z.string().regex(LANGUAGE_TAG_PATTERN);

export const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const emailSchema = z.email().max(254);

export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;
export const phoneE164Schema = z.string().regex(E164_PATTERN);

export function isHttpsUrl(value: string): boolean {
  if (value.length > 2048 || /[\s<>"'\\]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname !== '' && !url.username && !url.password;
}
export const httpsUrlSchema = z.string().refine(isHttpsUrl, 'must be an https URL');

export function isIanaTimeZone(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
export const timezoneSchema = z.string().refine(isIanaTimeZone, 'must be an IANA time zone');

const HOURS_RANGE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_KEY = new RegExp(`^(${WEEKDAYS.join('|')})(?:-(${WEEKDAYS.join('|')}))?$`);

function validHoursRange(value: string): boolean {
  const m = HOURS_RANGE.exec(value);
  if (!m) return false;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  return end > start;
}

function validDayKey(key: string): boolean {
  const m = DAY_KEY.exec(key);
  if (!m) return false;
  if (m[2] === undefined) return true;
  return (
    WEEKDAYS.indexOf(m[1] as (typeof WEEKDAYS)[number]) <
    WEEKDAYS.indexOf(m[2] as (typeof WEEKDAYS)[number])
  );
}

/** `{ "mon-fri": "09:00-18:00", "sat": "10:00-14:00" }` */
export const businessHoursSchema = z
  .record(z.string(), z.string())
  .refine((hours) => Object.keys(hours).length >= 1 && Object.keys(hours).length <= 7, {
    message: 'business_hours must have 1..7 entries',
  })
  .refine(
    (hours) => Object.entries(hours).every(([k, v]) => validDayKey(k) && validHoursRange(v)),
    { message: 'business_hours keys must be weekdays or ranges and values HH:MM-HH:MM' },
  );

const escalationMessageSchema = plainText(300);
export const escalationMessagesSchema = z
  .record(languageTagSchema, escalationMessageSchema)
  .refine((m) => Object.keys(m).length >= 1 && Object.keys(m).length <= 20, {
    message: 'escalation_messages must have 1..20 languages',
  });

export const supportedLanguagesSchema = z
  .array(languageTagSchema)
  .min(1)
  .max(20)
  .refine((l) => new Set(l).size === l.length, 'languages must be unique');

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/** Visitor message limit (ADR 0007). */
export const MAX_MESSAGE_CHARS = 2000;

export const idempotencyKeySchema = z.uuid();

/** POST /v1/chat. Strict: context/system/history/messages/api_key and any other extra field are rejected. */
export const chatRequestSchema = z.strictObject({
  bot_slug: botSlugSchema,
  conversation_id: z.uuid().nullable(),
  message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  preferred_language: languageTagSchema.optional(),
});

export const createSessionRequestSchema = z.strictObject({
  bot_slug: botSlugSchema,
  challenge_token: z.string().min(1).max(4096).optional(),
});

export const createSessionResponseSchema = z.strictObject({
  token: z.string().min(1).max(4096),
  expires_at: z.iso.datetime(),
});

// ---------------------------------------------------------------------------
// Contact block and public bot config
// ---------------------------------------------------------------------------

function hasChannel(c: {
  email?: string | null | undefined;
  phone?: string | null | undefined;
  whatsapp?: string | null | undefined;
  page?: string | null | undefined;
}): boolean {
  return [c.email, c.phone, c.whatsapp, c.page].some((v) => typeof v === 'string' && v !== '');
}

/** Database nulls become `undefined` so omitted channels are simply absent. */
function dbOptional<T extends z.ZodType>(schema: T) {
  return schema.nullish().transform((v): z.output<T> | undefined => v ?? undefined);
}

const contactFieldShape = {
  contact_email: dbOptional(emailSchema),
  contact_phone: dbOptional(phoneE164Schema),
  contact_whatsapp_url: dbOptional(httpsUrlSchema),
  contact_page_url: dbOptional(httpsUrlSchema),
  business_hours: dbOptional(businessHoursSchema),
  timezone: dbOptional(timezoneSchema),
};

const contactBlockShape = {
  escalation_label: plainText(60),
  escalation_messages: escalationMessagesSchema,
  ...contactFieldShape,
};

function checkContactBlock(
  value: {
    contact_email?: string | undefined;
    contact_phone?: string | undefined;
    contact_whatsapp_url?: string | undefined;
    contact_page_url?: string | undefined;
    business_hours?: unknown;
    timezone?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    !hasChannel({
      email: value.contact_email,
      phone: value.contact_phone,
      whatsapp: value.contact_whatsapp_url,
      page: value.contact_page_url,
    })
  ) {
    ctx.addIssue({ code: 'custom', message: 'at least one contact channel is required' });
  }
  if (value.business_hours !== undefined && value.timezone === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['timezone'],
      message: 'timezone is required with business_hours',
    });
  }
}

/** The contact block of `public_bot_config` (PRD W-16): needs at least one channel. */
export const contactBlockSchema = z.object(contactBlockShape).superRefine(checkContactBlock);

/** `public_bot_config` as served to the widget. Unknown keys are stripped, never passed through. */
export const publicBotConfigSchema = z
  .object({
    bot_id: z.uuid(),
    bot_slug: botSlugSchema,
    display_name: plainText(80),
    greeting: plainText(500),
    suggested_questions: z.array(plainText(200)).max(6),
    primary_color: hexColorSchema,
    position: widgetPositionSchema,
    privacy_url: dbOptional(httpsUrlSchema),
    supported_languages: supportedLanguagesSchema,
    updated_at: dbOptional(z.iso.datetime({ offset: true })),
    ...contactBlockShape,
  })
  .superRefine((value, ctx) => {
    checkContactBlock(value, ctx);
    // ADR 0013: an escalation message for every supported language (and none for unsupported ones).
    const supported = new Set(value.supported_languages);
    const messaged = new Set(Object.keys(value.escalation_messages));
    for (const lang of supported) {
      if (!messaged.has(lang)) {
        ctx.addIssue({
          code: 'custom',
          path: ['escalation_messages'],
          message: `missing escalation message for ${lang}`,
        });
      }
    }
    for (const lang of messaged) {
      if (!supported.has(lang)) {
        ctx.addIssue({
          code: 'custom',
          path: ['escalation_messages'],
          message: `escalation message for unsupported language ${lang}`,
        });
      }
    }
  });

/** Contact details inside a `handoff` event (values come from server config only). */
export const handoffContactSchema = z
  .strictObject({
    email: emailSchema.optional(),
    phone: phoneE164Schema.optional(),
    whatsapp_url: httpsUrlSchema.optional(),
    page_url: httpsUrlSchema.optional(),
    business_hours: businessHoursSchema.optional(),
    timezone: timezoneSchema.optional(),
  })
  .superRefine((c, ctx) => {
    if (
      !hasChannel({ email: c.email, phone: c.phone, whatsapp: c.whatsapp_url, page: c.page_url })
    ) {
      ctx.addIssue({ code: 'custom', message: 'at least one contact channel is required' });
    }
    if (c.business_hours !== undefined && c.timezone === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['timezone'],
        message: 'timezone is required with business_hours',
      });
    }
  });

// ---------------------------------------------------------------------------
// Visitor token claims
// ---------------------------------------------------------------------------

export const visitorTokenClaimsSchema = z
  .strictObject({
    bot_id: z.uuid(),
    session_id: z.uuid(),
    token_version: z.int().min(1),
    iat: z.int().nonnegative(),
    exp: z.int().nonnegative(),
  })
  .refine((c) => c.exp > c.iat, { message: 'exp must be after iat', path: ['exp'] });

/** True when the token must be refused. Fails closed on a non-finite clock. */
export function isTokenExpired(claims: VisitorTokenClaims, nowSeconds: number): boolean {
  return !Number.isFinite(nowSeconds) || nowSeconds >= claims.exp;
}

// ---------------------------------------------------------------------------
// Job payloads, discriminated by job type
// ---------------------------------------------------------------------------

export const indexDocumentPayloadSchema = z.strictObject({
  bot_id: z.uuid(),
  document_id: z.uuid(),
  version_id: z.uuid(),
});

export const analyzeConversationPayloadSchema = z.strictObject({
  bot_id: z.uuid(),
  conversation_id: z.uuid(),
});

export const cleanupPayloadSchema = z
  .strictObject({
    bot_id: z.uuid(),
    scope: z.enum(['document', 'conversation', 'expired']),
    resource_id: z.uuid().optional(),
  })
  .refine((p) => (p.scope === 'expired') === (p.resource_id === undefined), {
    message: 'resource_id is required unless scope is "expired", and forbidden for it',
    path: ['resource_id'],
  });

export const warmAnswerCachePayloadSchema = z.strictObject({
  bot_id: z.uuid(),
  corpus_version: z.int().nonnegative(),
});

export const jobSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('index_document'), payload: indexDocumentPayloadSchema }),
  z.strictObject({
    type: z.literal('analyze_conversation'),
    payload: analyzeConversationPayloadSchema,
  }),
  z.strictObject({ type: z.literal('cleanup'), payload: cleanupPayloadSchema }),
  z.strictObject({ type: z.literal('warm_answer_cache'), payload: warmAnswerCachePayloadSchema }),
]);
export type Job = z.infer<typeof jobSchema>;

// ---------------------------------------------------------------------------
// Admin: settings whitelist (PATCH /v1/admin/bot-settings)
// ---------------------------------------------------------------------------

/**
 * Only public-config fields plus `bot_profiles.tone` and `.scope` may be patched.
 * Strict on purpose: identity_prompt, embedding_*, allowed_origins, rate/budget/cache/
 * retention/upload policies, feature flags, bot_id and slug are all rejected here.
 * `null` clears an optional contact field. The route must re-validate the merged
 * result with `publicBotConfigSchema` (channel and language cross-checks).
 */
export const botSettingsPatchSchema = z
  .strictObject({
    display_name: plainText(80).optional(),
    greeting: plainText(500).optional(),
    suggested_questions: z.array(plainText(200)).max(6).optional(),
    primary_color: hexColorSchema.optional(),
    position: widgetPositionSchema.optional(),
    privacy_url: httpsUrlSchema.nullable().optional(),
    supported_languages: supportedLanguagesSchema.optional(),
    escalation_label: plainText(60).optional(),
    escalation_messages: escalationMessagesSchema.optional(),
    contact_email: emailSchema.nullable().optional(),
    contact_phone: phoneE164Schema.nullable().optional(),
    contact_whatsapp_url: httpsUrlSchema.nullable().optional(),
    contact_page_url: httpsUrlSchema.nullable().optional(),
    business_hours: businessHoursSchema.nullable().optional(),
    timezone: timezoneSchema.nullable().optional(),
    tone: freeText(500).optional(),
    scope: freeText(2000).optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), {
    message: 'patch must change at least one field',
  });

export const adminBotSettingsPatchRequestSchema = z.strictObject({
  bot_id: z.uuid(),
  patch: botSettingsPatchSchema,
});

// ---------------------------------------------------------------------------
// Admin: documents and conversations
// ---------------------------------------------------------------------------

export const adminCreateDocumentRequestSchema = z.strictObject({
  bot_id: z.uuid(),
  title: plainText(200),
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((v) => !/[/\\]/.test(v) && !hasControlChars(v, false) && !v.includes('..'), {
      message: 'filename must not contain path separators or control characters',
    }),
  media_type: mediaTypeSchema,
  size_bytes: z.int().positive(),
  disclosure_policy: disclosurePolicySchema,
});

export const adminCompleteDocumentRequestSchema = z.strictObject({ version_id: z.uuid() });
export const adminReindexDocumentRequestSchema = z.strictObject({
  version_id: z.uuid().optional(),
});
export const idParamSchema = z.strictObject({ id: z.uuid() });

// ---------------------------------------------------------------------------
// Data entries (POST /v1/entries): explicit, registered, strict form schemas only
// ---------------------------------------------------------------------------

export const SCHEMA_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const schemaKeySchema = z.string().regex(SCHEMA_KEY_PATTERN);

export const createEntryRequestSchema = z.strictObject({
  conversation_id: z.uuid().nullable(),
  schema_key: schemaKeySchema,
  payload: z.record(z.string(), z.unknown()).refine((p) => Object.keys(p).length <= 50, {
    message: 'payload has too many fields',
  }),
  consent: z.literal(true),
});

export type EntryPayloadSchema = z.ZodObject<z.ZodRawShape>;

export type EntryValidationResult =
  | { readonly success: true; readonly data: Record<string, unknown> }
  | {
      readonly success: false;
      readonly reason: 'unknown_schema_key' | 'invalid_payload';
      /** Dotted paths of failing fields only; never echoes submitted values. */
      readonly fields: readonly string[];
    };

export interface EntrySchemaRegistry {
  /** Registers a form schema; it is forced strict so unknown fields are rejected. Throws on a bad or duplicate key. */
  register(schemaKey: string, schema: EntryPayloadSchema): void;
  has(schemaKey: string): boolean;
  keys(): readonly string[];
  validate(schemaKey: string, payload: unknown): EntryValidationResult;
}

export function createEntrySchemaRegistry(): EntrySchemaRegistry {
  const schemas = new Map<string, z.ZodObject<z.ZodRawShape>>();
  return {
    register(schemaKey, schema) {
      if (!SCHEMA_KEY_PATTERN.test(schemaKey)) throw new Error('invalid schema_key');
      if (schemas.has(schemaKey)) throw new Error('schema_key already registered');
      schemas.set(schemaKey, z.strictObject(schema.shape));
    },
    has: (schemaKey) => schemas.has(schemaKey),
    keys: () => [...schemas.keys()],
    validate(schemaKey, payload) {
      const schema = schemas.get(schemaKey);
      if (schema === undefined) return { success: false, reason: 'unknown_schema_key', fields: [] };
      const result = schema.safeParse(payload);
      if (result.success) return { success: true, data: result.data };
      return {
        success: false,
        reason: 'invalid_payload',
        fields: result.error.issues.map((i) => i.path.join('.')),
      };
    },
  };
}

/** Empty by default: no entry form is accepted until a client form is explicitly registered (fail closed). */
export const entrySchemaRegistry: EntrySchemaRegistry = createEntrySchemaRegistry();

// ---------------------------------------------------------------------------
// Conversation history (visitor): role is limited to user/assistant
// ---------------------------------------------------------------------------

export const historyMessageSchema = z.strictObject({
  id: z.uuid(),
  role: z.enum(VISITOR_VISIBLE_ROLES),
  content: z.string(),
  status: messageStatusSchema,
  handoff_reason: handoffReasonSchema.optional(),
  created_at: z.iso.datetime({ offset: true }),
});

export const conversationHistoryResponseSchema = z.strictObject({
  conversation_id: z.uuid(),
  messages: z.array(historyMessageSchema).max(200),
  has_more: z.boolean(),
});

// ---------------------------------------------------------------------------
// SSE events (TECH_SPECS §4)
// ---------------------------------------------------------------------------

export const errorEnvelopeSchema = z.strictObject({
  code: errorCodeSchema,
  request_id: z.string().min(1).max(64),
  retry_after_seconds: z.int().nonnegative().optional(),
});

export const sourceRefSchema = z.strictObject({
  chunk_id: z.string().regex(CHUNK_ID_PATTERN),
  title: plainText(200),
  section: plainText(200).optional(),
  excerpt: plainText(1000).optional(),
  url: httpsUrlSchema.optional(),
});

export const sseEventSchema = z.discriminatedUnion('event', [
  z.strictObject({
    event: z.literal('meta'),
    data: z.strictObject({
      request_id: z.string().min(1).max(64),
      conversation_id: z.uuid(),
      message_id: z.uuid(),
    }),
  }),
  z.strictObject({ event: z.literal('delta'), data: z.strictObject({ text: z.string() }) }),
  z.strictObject({
    event: z.literal('sources'),
    data: z.strictObject({ sources: z.array(sourceRefSchema).max(20) }),
  }),
  z.strictObject({
    event: z.literal('handoff'),
    data: z.strictObject({
      reason: handoffReasonSchema,
      message: plainText(300),
      prominent: z.boolean(),
      contact: handoffContactSchema,
    }),
  }),
  z.strictObject({
    event: z.literal('done'),
    data: z.strictObject({ status: messageStatusSchema }),
  }),
  z.strictObject({ event: z.literal('error'), data: errorEnvelopeSchema }),
]);

// ---------------------------------------------------------------------------
// Compile-time conformance: schema output must stay assignable to the contract types.
// (Type-only; erased at runtime.)
// ---------------------------------------------------------------------------

type AssertAssignable<_Actual extends Expected, Expected> = true;
export type SchemaConformance = [
  AssertAssignable<z.output<typeof chatRequestSchema>, ChatRequest>,
  AssertAssignable<z.output<typeof createSessionRequestSchema>, CreateSessionRequest>,
  AssertAssignable<z.output<typeof contactBlockSchema>, ContactBlock>,
  AssertAssignable<z.output<typeof publicBotConfigSchema>, PublicBotConfig>,
  AssertAssignable<z.output<typeof handoffContactSchema>, HandoffContact>,
  AssertAssignable<z.output<typeof visitorTokenClaimsSchema>, VisitorTokenClaims>,
  AssertAssignable<z.output<typeof botSettingsPatchSchema>, AdminBotSettingsPatch>,
  AssertAssignable<z.output<typeof createEntryRequestSchema>, CreateEntryRequest>,
  AssertAssignable<z.output<typeof conversationHistoryResponseSchema>, ConversationHistoryResponse>,
  AssertAssignable<z.output<typeof sseEventSchema>, SseEvent>,
];
