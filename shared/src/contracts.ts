/**
 * Public and admin API contracts (TECH_SPECS §2–§6.2) plus the canonical enum
 * value lists shared with the database CHECK constraints (DATABASE_SCHEMA).
 *
 * Browser-safe: no Node imports, no runtime dependencies. Optional properties are
 * written as `?: T | undefined` so Zod-inferred types are assignable under
 * `exactOptionalPropertyTypes` (conformance is asserted in schemas.ts).
 *
 * There is intentionally no feedback route (ADR 0011).
 */

import type { ErrorEnvelope } from './errors.js';

// ---------------------------------------------------------------------------
// Canonical value lists. The SQL CHECK constraints in supabase/migrations use
// the identical lists; do not add or reorder values without a migration.
// (VECTOR_DIMENSIONS = 1536 lives in providers.ts.)
// ---------------------------------------------------------------------------

export const ADMIN_ROLES = ['owner', 'admin', 'analyst'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const DOCUMENT_STATUSES = ['draft', 'indexing', 'ready', 'failed', 'deleted'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DISCLOSURE_POLICIES = ['public_answer', 'excluded'] as const;
export type DisclosurePolicy = (typeof DISCLOSURE_POLICIES)[number];

export const DOCUMENT_VERSION_STATUSES = [
  'pending_upload',
  'uploaded',
  'extracting',
  'embedding',
  'ready',
  'failed',
  'superseded',
] as const;
export type DocumentVersionStatus = (typeof DOCUMENT_VERSION_STATUSES)[number];

export const MEDIA_TYPES = ['application/pdf', 'text/markdown', 'text/plain'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const EXTRACTION_METHODS = ['pdf_text', 'markdown', 'plain_text'] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

export const CONVERSATION_STATUSES = ['open', 'closed'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** Roles a visitor may ever receive. `system` is excluded by construction (ADR 0009). */
export const VISITOR_VISIBLE_ROLES = ['user', 'assistant'] as const;
export type VisitorVisibleRole = (typeof VISITOR_VISIBLE_ROLES)[number];

export const MESSAGE_STATUSES = ['complete', 'partial', 'failed', 'blocked'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const HANDOFF_REASONS = [
  'no_knowledge',
  'out_of_scope',
  'human_requested',
  'blocked',
  'unavailable',
  'repeated_no_knowledge',
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export const JOB_TYPES = [
  'index_document',
  'analyze_conversation',
  'cleanup',
  'warm_answer_cache',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobState = (typeof JOB_STATES)[number];

export const REQUEST_RUN_STATES = [
  'reserved',
  'running',
  'succeeded',
  'failed',
  'partial',
] as const;
export type RequestRunState = (typeof REQUEST_RUN_STATES)[number];

export const BUDGET_RESERVATION_STATES = ['reserved', 'settled', 'released', 'expired'] as const;
export type BudgetReservationState = (typeof BUDGET_RESERVATION_STATES)[number];

export const ANALYSIS_STATUSES = ['pending', 'complete', 'failed'] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const SENTIMENTS = ['positive', 'neutral', 'negative'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const USAGE_OPERATIONS = [
  'chat',
  'embedding_query',
  'embedding_index',
  'moderation',
  'analysis',
  'answer_cache_hit',
] as const;
export type UsageOperation = (typeof USAGE_OPERATIONS)[number];

export const MODERATION_VERDICTS = ['allow', 'block'] as const;
export type ModerationVerdictValue = (typeof MODERATION_VERDICTS)[number];

export const WIDGET_POSITIONS = ['bottom-right', 'bottom-left'] as const;
export type WidgetPosition = (typeof WIDGET_POSITIONS)[number];

/** Chunk IDs shown to the model and cited back; restricted so they cannot carry delimiters. */
export const CHUNK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

// ---------------------------------------------------------------------------
// Contact routing (PRD W-16)
// ---------------------------------------------------------------------------

/** Keys are a weekday (`sat`) or an inclusive range (`mon-fri`); values are `HH:MM-HH:MM`. */
export type BusinessHours = Readonly<Record<string, string>>;

/** Contact details as delivered in a `handoff` event. Server configuration only, never model output. */
export interface HandoffContact {
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly whatsapp_url?: string | undefined;
  readonly page_url?: string | undefined;
  readonly business_hours?: BusinessHours | undefined;
  readonly timezone?: string | undefined;
}

/** Contact fields as stored in `public_bot_config`. */
export interface ContactBlock {
  readonly escalation_label: string;
  readonly escalation_messages: Readonly<Record<string, string>>;
  readonly contact_email?: string | undefined;
  readonly contact_phone?: string | undefined;
  readonly contact_whatsapp_url?: string | undefined;
  readonly contact_page_url?: string | undefined;
  readonly business_hours?: BusinessHours | undefined;
  readonly timezone?: string | undefined;
}

export interface PublicBotConfig extends ContactBlock {
  readonly bot_id: string;
  readonly bot_slug: string;
  readonly display_name: string;
  readonly greeting: string;
  readonly suggested_questions: readonly string[];
  readonly primary_color: string;
  readonly position: WidgetPosition;
  readonly privacy_url?: string | undefined;
  readonly supported_languages: readonly string[];
  readonly updated_at?: string | undefined;
}

// ---------------------------------------------------------------------------
// Visitor token
// ---------------------------------------------------------------------------

/** Claims bound into the signed visitor token (seconds since epoch for iat/exp). */
export interface VisitorTokenClaims {
  readonly bot_id: string;
  readonly session_id: string;
  readonly token_version: number;
  readonly iat: number;
  readonly exp: number;
}

// ---------------------------------------------------------------------------
// Public routes (TECH_SPECS §2)
// ---------------------------------------------------------------------------

/** GET /health/live and GET /health/ready: minimal, no details. */
export interface HealthResponse {
  readonly status: 'ok';
}

/** POST /v1/sessions */
export interface CreateSessionRequest {
  readonly bot_slug: string;
  /** Bot-challenge token (ADR 0010); required when the challenge is enabled for the bot. */
  readonly challenge_token?: string | undefined;
}
export interface CreateSessionResponse {
  readonly token: string;
  /** ISO 8601 UTC timestamp. */
  readonly expires_at: string;
}

/** POST /v1/chat body. Headers: `Authorization: Bearer <visitor-token>`, `Idempotency-Key: <uuid>`. */
export interface ChatRequest {
  readonly bot_slug: string;
  readonly conversation_id: string | null;
  readonly message: string;
  readonly preferred_language?: string | undefined;
}

/** POST /v1/entries */
export interface CreateEntryRequest {
  readonly conversation_id: string | null;
  readonly schema_key: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Explicit consent is mandatory; stored as `data_entries.consent_at`. */
  readonly consent: true;
}
export interface CreateEntryResponse {
  readonly entry_id: string;
}

/**
 * A message as returned to a visitor. `role` cannot be `system`: the type makes
 * returning a system row a compile error, and the history query enforces it in SQL.
 */
export interface HistoryMessage {
  readonly id: string;
  readonly role: VisitorVisibleRole;
  readonly content: string;
  readonly status: MessageStatus;
  readonly handoff_reason?: HandoffReason | undefined;
  /** ISO 8601 UTC timestamp. */
  readonly created_at: string;
}

/** GET /v1/conversations/:id (same session only, bounded, oldest first). */
export interface ConversationHistoryResponse {
  readonly conversation_id: string;
  readonly messages: readonly HistoryMessage[];
  /** True when older messages exist beyond the server-enforced bound. */
  readonly has_more: boolean;
}

// ---------------------------------------------------------------------------
// Chat events (TECH_SPECS §4)
// ---------------------------------------------------------------------------

export interface MetaEventData {
  readonly request_id: string;
  readonly conversation_id: string;
  readonly message_id: string;
}

export interface DeltaEventData {
  readonly text: string;
}

/** A server-validated display reference. Private documents never carry a public download URL. */
export interface SourceRef {
  readonly chunk_id: string;
  readonly title: string;
  readonly section?: string | undefined;
  readonly excerpt?: string | undefined;
  /** Only for sources that are meant to be public; https only. */
  readonly url?: string | undefined;
}

export interface SourcesEventData {
  readonly sources: readonly SourceRef[];
}

export interface HandoffEventData {
  readonly reason: HandoffReason;
  /** Localised escalation message from server configuration. */
  readonly message: string;
  readonly prominent: boolean;
  readonly contact: HandoffContact;
}

export interface DoneEventData {
  readonly status: MessageStatus;
}

export type ErrorEventData = ErrorEnvelope;

export type SseEvent =
  | { readonly event: 'meta'; readonly data: MetaEventData }
  | { readonly event: 'delta'; readonly data: DeltaEventData }
  | { readonly event: 'sources'; readonly data: SourcesEventData }
  | { readonly event: 'handoff'; readonly data: HandoffEventData }
  | { readonly event: 'done'; readonly data: DoneEventData }
  | { readonly event: 'error'; readonly data: ErrorEventData };

export type SseEventName = SseEvent['event'];
export const SSE_EVENT_NAMES = ['meta', 'delta', 'sources', 'handoff', 'done', 'error'] as const;

// ---------------------------------------------------------------------------
// Administrative routes (TECH_SPECS §3). All require a Supabase access token,
// active membership, required role and applicable MFA assurance.
// ---------------------------------------------------------------------------

/** POST /v1/admin/documents */
export interface AdminCreateDocumentRequest {
  readonly bot_id: string;
  readonly title: string;
  readonly filename: string;
  readonly media_type: MediaType;
  readonly size_bytes: number;
  readonly disclosure_policy: DisclosurePolicy;
}
export interface AdminCreateDocumentResponse {
  readonly document_id: string;
  readonly version_id: string;
  readonly upload_url: string;
  /** ISO 8601 UTC timestamp. */
  readonly upload_expires_at: string;
}

/** POST /v1/admin/documents/:id/complete */
export interface AdminCompleteDocumentRequest {
  readonly version_id: string;
}
export interface AdminCompleteDocumentResponse {
  readonly document_id: string;
  readonly version_id: string;
  readonly job_id: string;
}

/** POST /v1/admin/documents/:id/reindex */
export interface AdminReindexDocumentRequest {
  /** Defaults to the document's current permitted version when omitted. */
  readonly version_id?: string | undefined;
}
export interface AdminReindexDocumentResponse {
  readonly job_id: string;
}

/** POST /v1/admin/documents/:id/download */
export interface AdminDownloadDocumentResponse {
  readonly download_url: string;
  /** ISO 8601 UTC timestamp (short-lived). */
  readonly expires_at: string;
}

/** DELETE /v1/admin/documents/:id: retrieval is excluded immediately; cleanup is queued. */
export interface AdminDeleteDocumentResponse {
  readonly document_id: string;
  readonly status: 'deleted';
  readonly cleanup_job_id: string;
}

/**
 * PATCH /v1/admin/bot-settings: whitelisted fields only (see `botSettingsPatchSchema`).
 * Every field is optional; `null` clears an optional contact field.
 */
export interface AdminBotSettingsPatchRequest {
  readonly bot_id: string;
  readonly patch: AdminBotSettingsPatch;
}
export interface AdminBotSettingsPatch {
  readonly display_name?: string | undefined;
  readonly greeting?: string | undefined;
  readonly suggested_questions?: readonly string[] | undefined;
  readonly primary_color?: string | undefined;
  readonly position?: WidgetPosition | undefined;
  readonly privacy_url?: string | null | undefined;
  readonly supported_languages?: readonly string[] | undefined;
  readonly escalation_label?: string | undefined;
  readonly escalation_messages?: Readonly<Record<string, string>> | undefined;
  readonly contact_email?: string | null | undefined;
  readonly contact_phone?: string | null | undefined;
  readonly contact_whatsapp_url?: string | null | undefined;
  readonly contact_page_url?: string | null | undefined;
  readonly business_hours?: BusinessHours | null | undefined;
  readonly timezone?: string | null | undefined;
  readonly tone?: string | undefined;
  readonly scope?: string | undefined;
}
export interface AdminBotSettingsPatchResponse {
  readonly bot_id: string;
  readonly settings_version: number;
}

/** POST /v1/admin/conversations/:id/delete (retention-aware workflow). */
export interface AdminDeleteConversationResponse {
  readonly conversation_id: string;
  readonly status: 'deletion_queued' | 'deleted';
}

// ---------------------------------------------------------------------------
// Route table: the single list of routes the API exposes.
// ---------------------------------------------------------------------------

export const PUBLIC_ROUTES = [
  { method: 'GET', path: '/health/live' },
  { method: 'GET', path: '/health/ready' },
  { method: 'POST', path: '/v1/sessions' },
  { method: 'POST', path: '/v1/chat' },
  { method: 'POST', path: '/v1/entries' },
  { method: 'GET', path: '/v1/conversations/:id' },
] as const;

export const ADMIN_ROUTES = [
  { method: 'POST', path: '/v1/admin/documents' },
  { method: 'POST', path: '/v1/admin/documents/:id/complete' },
  { method: 'POST', path: '/v1/admin/documents/:id/reindex' },
  { method: 'POST', path: '/v1/admin/documents/:id/download' },
  { method: 'DELETE', path: '/v1/admin/documents/:id' },
  { method: 'PATCH', path: '/v1/admin/bot-settings' },
  { method: 'POST', path: '/v1/admin/conversations/:id/delete' },
] as const;
