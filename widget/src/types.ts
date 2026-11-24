// P8 widget shared types. Mirrors the browser-visible parts of
// `shared/src/contracts.ts` (PublicBotConfig, ChatRequest, SseEvent) without a
// runtime dependency on `@ragbot/shared`, so the widget bundle stays
// self-contained. Field-level rules match `publicBotConfigSchema`,
// `handoffContactSchema` and `chatRequestSchema` (TECH_SPECS §4, UI_SCHEMA §5).

export interface EmbedOptions {
  readonly botSlug: string;
  readonly apiUrl: string;
  readonly supabaseUrl: string;
  readonly supabasePublishableKey: string;
  readonly turnstileSiteKey?: string | undefined;
  /** ADR 0022 public widget key (`wgk_` + 32 hex). Public ID only, never auth. */
  readonly widgetKey?: string | undefined;
}

export type WidgetState =
  | 'booting'
  | 'closed'
  | 'ready'
  | 'connecting'
  | 'streaming'
  | 'limited'
  | 'blocked'
  | 'unavailable';

export type HandoffReason =
  | 'no_knowledge'
  | 'out_of_scope'
  | 'human_requested'
  | 'blocked'
  | 'unavailable'
  | 'repeated_no_knowledge';

export interface WidgetContact {
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly whatsappUrl?: string | undefined;
  readonly pageUrl?: string | undefined;
  readonly businessHours?: Readonly<Record<string, string>> | undefined;
  readonly timezone?: string | undefined;
}

export interface WidgetPublicConfig {
  readonly botId: string;
  readonly botSlug: string;
  readonly displayName: string;
  readonly greeting: string;
  readonly suggestedQuestions: readonly string[];
  readonly primaryColor: string;
  readonly position: 'bottom-right' | 'bottom-left';
  readonly privacyUrl?: string | undefined;
  readonly supportedLanguages: readonly string[];
  readonly escalationLabel: string;
  readonly escalationMessages: Readonly<Record<string, string>>;
  readonly contactEmail?: string | undefined;
  readonly contactPhone?: string | undefined;
  readonly contactWhatsappUrl?: string | undefined;
  readonly contactPageUrl?: string | undefined;
  readonly businessHours?: Readonly<Record<string, string>> | undefined;
  readonly timezone?: string | undefined;
}

export interface WidgetSourceRef {
  readonly chunkId: string;
  readonly title: string;
  readonly section?: string | undefined;
  readonly excerpt?: string | undefined;
  readonly url?: string | undefined;
}

export interface WidgetHandoff {
  readonly reason: HandoffReason;
  readonly message: string;
  readonly prominent: boolean;
  /** Wire shape from the `handoff` event (`TECH_SPECS §4`); mapped to camelCase by `mergeContact`. */
  readonly contact: WireHandoffContact;
}

/** Contact block inside a server `handoff` event. Values are server config only. */
export interface WireHandoffContact {
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly whatsapp_url?: string | undefined;
  readonly page_url?: string | undefined;
  readonly business_hours?: Readonly<Record<string, string>> | undefined;
  readonly timezone?: string | undefined;
}

export type SseParsedEvent =
  | {
      readonly event: 'meta';
      readonly data: {
        readonly requestId: string;
        readonly conversationId: string;
        readonly messageId: string;
      };
    }
  | { readonly event: 'delta'; readonly data: { readonly text: string } }
  | { readonly event: 'sources'; readonly data: { readonly sources: readonly WidgetSourceRef[] } }
  | { readonly event: 'handoff'; readonly data: WidgetHandoff }
  | { readonly event: 'done'; readonly data: { readonly status: string } }
  | {
      readonly event: 'error';
      readonly data: {
        readonly code: string;
        readonly requestId?: string | undefined;
        readonly retryable?: boolean | undefined;
      };
    };

export const SSE_EVENT_NAMES: readonly string[] = [
  'meta',
  'delta',
  'sources',
  'handoff',
  'done',
  'error',
];
