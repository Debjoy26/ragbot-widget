/**
 * Public API contracts (TECH_SPECS §2, §4–§5) plus the canonical enum value lists
 * shared with the database CHECK constraints (DATABASE_SCHEMA). The retired
 * `/v1/admin/*` surface is gone (ADR 0017); admin operations are SQL RPCs.
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
/**
 * Turnstile action the widget must render on the session challenge. The API refuses a token whose
 * siteverify response carries a different action (ADR 0010).
 */
export const TURNSTILE_SESSION_ACTION = 'session_create';

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

/**
 * GET /v1/conversations/:id query string. UNCONFIRMED shape (P3-D5 G-17).
 * `before` is the id of the oldest message the client already holds; the server returns
 * the next page of messages older than it. Omitted: the newest page.
 */
export interface ConversationHistoryRequest {
  readonly before?: string | undefined;
}

/** GET /v1/conversations/:id (same session only, bounded, oldest first within a page). */
export interface ConversationHistoryResponse {
  readonly conversation_id: string;
  readonly messages: readonly HistoryMessage[];
  /** True when older messages exist; request them with `before` = id of the first message here. */
  readonly has_more: boolean;
}

/**
 * Response to a duplicate `Idempotency-Key` (same request hash): the stored status of the
 * original run, never a regenerated answer and never message content. UNCONFIRMED shape (G-17);
 * the client fetches content from the history route.
 */
export interface IdempotentReplayResponse {
  readonly request_id: string;
  readonly run_state: RequestRunState;
  readonly conversation_id: string | null;
  readonly message_id: string | null;
  /** Final message status once the run has produced a message; null while it has not. */
  readonly status: MessageStatus | null;
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
// Bot settings patch (whitelist). There is no /v1/admin/* surface: the admin panel
// calls browser-callable SQL RPCs directly under the member's own JWT (ADR 0017), and
// SQL validates the merged result. `botSettingsPatchSchema` is the client-side whitelist.
// ---------------------------------------------------------------------------

/** Whitelisted fields only (see `botSettingsPatchSchema`). `null` clears an optional contact field. */
export interface BotSettingsPatch {
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

// ---------------------------------------------------------------------------
// client_settings JSON keys that SQL reads (fail closed when missing or invalid).
// Other keys inside these objects are not part of this contract.
// ---------------------------------------------------------------------------

export interface BudgetPolicy {
  /** Daily spend cap in USD; read by `reserve_request_budget` (RB002 when missing or invalid). */
  readonly daily_cap_usd: number;
}

export interface RetentionPolicy {
  /** Conversation retention in days (ADR 0006: 90); read by the purge jobs (RB020 when invalid). */
  readonly conversation_days: number;
  /** Usage-record retention in months (ADR 0006: 13). */
  readonly usage_months: number;
}

export interface RatePolicyRequired {
  /** `begin_request_run` per-session concurrency cap (RB002 when missing or invalid). */
  readonly concurrent_requests_per_session: number;
}

export interface QuotaRule {
  readonly limit: number;
  readonly window_seconds: number;
}

export const QUOTA_KINDS = ['register', 'upload', 'reindex', 'write'] as const;
export type QuotaKind = (typeof QUOTA_KINDS)[number];

/** `upload_policy` including the P3.5 keys (RB036 when a required key is missing or invalid). */
export interface UploadPolicy {
  readonly max_bytes: number;
  readonly max_pages: number;
  readonly index_max_attempts: number;
  readonly cleanup_max_attempts: number;
  readonly quotas: Readonly<Record<QuotaKind, QuotaRule>>;
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

// ---------------------------------------------------------------------------
// Browser RPC responses (P3.5-T3). What PostgREST returns for each browser-callable function in
// supabase/migrations/009 and 010. A function declared `returns table` comes back as a JSON array of
// rows; a scalar comes back as the bare value; `void` comes back as null. The matching strict Zod schemas
// are in schemas.ts and are checked against real HTTP responses by tests/integration/admin-real-session.test.ts.
// ---------------------------------------------------------------------------

/** `document_versions.failure_code` (CHECK in the database). */
export const FAILURE_CODES = [
  'FILE_UNSUPPORTED',
  'OCR_REQUIRED',
  'INDEXING_FAILED',
  'BUDGET_EXCEEDED',
  'SUPERSEDED',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export interface AdminRegisterDocumentRow {
  readonly document_id: string;
  readonly version_id: string;
  readonly storage_path: string;
}

export interface AdminAddDocumentVersionRow {
  readonly version_id: string;
  readonly version_number: number;
  readonly storage_path: string;
}

export interface AdminCompleteUploadRow {
  readonly version_id: string;
  readonly status: DocumentVersionStatus;
  readonly job_queued: boolean;
}

export interface AdminRetryVersionRow {
  readonly version_id: string;
  readonly status: DocumentVersionStatus;
}

export interface AdminReindexDocumentRow {
  readonly version_id: string;
  readonly version_number: number;
}

export interface AdminDocumentStatusRow {
  readonly document_id: string;
  readonly title: string;
  readonly status: DocumentStatus;
  readonly active_version_id: string | null;
  readonly latest_version_id: string | null;
  readonly latest_version_number: number | null;
  readonly latest_version_status: DocumentVersionStatus | null;
  readonly batches_done: number | null;
  readonly batches_total: number | null;
  readonly failure_code: FailureCode | null;
}

export interface AdminBotListRow {
  readonly id: string;
  readonly slug: string;
  /** NULL until the bot has a public config row. */
  readonly display_name: string | null;
  readonly enabled: boolean;
  readonly settings_version: number;
}

/** One row. The public-config fields are NULL until a first update creates the config row. */
export interface AdminSettingsRow {
  readonly bot_id: string;
  readonly slug: string;
  readonly enabled: boolean;
  readonly settings_version: number;
  readonly tone: string | null;
  readonly scope: string | null;
  readonly max_bytes: number | null;
  readonly max_pages: number | null;
  readonly display_name: string | null;
  readonly greeting: string | null;
  readonly suggested_questions: readonly string[] | null;
  readonly primary_color: string | null;
  readonly position: WidgetPosition | null;
  readonly privacy_url: string | null;
  readonly supported_languages: readonly string[] | null;
  readonly escalation_label: string | null;
  readonly escalation_messages: Readonly<Record<string, string>> | null;
  readonly contact_email: string | null;
  readonly contact_phone: string | null;
  readonly contact_whatsapp_url: string | null;
  readonly contact_page_url: string | null;
  readonly business_hours: Readonly<Record<string, unknown>> | null;
  readonly timezone: string | null;
}

export interface AdminMemberRow {
  readonly user_id: string;
  readonly role: AdminRole;
  readonly active: boolean;
  /** The member's sign-in email (B-7); NULL if the auth user is gone. */
  readonly label: string | null;
}
