// P8 entry: one `<script>` tag boots one widget (UI_SCHEMA §2).
// Singleton guard (`window.__ragbotWidget` / `customElements.get`) makes
// duplicate script tags reuse the existing instance.

import { fetchHistory, newIdempotencyKey, streamChat } from './api.js';
import { buildContactCard } from './contact-card.js';
import { requestChallenge } from './challenge.js';
import { loadPublicConfig, parseEmbedOptions } from './public-config.js';
import { sanitizeSources } from './render.js';
import { clearSession, createSession, readSession } from './session.js';
import type { WidgetPublicConfig, WidgetState } from './types.js';
import { createWidgetUi } from './ui.js';

export const WIDGET_GLOBAL = '__ragbotWidget';
const ELEMENT_NAME = 'ragbot-widget';

interface WidgetInstance {
  readonly setState: (state: WidgetState) => void;
}

function globals(): { readonly w: Record<string, unknown> } {
  return { w: window as unknown as Record<string, unknown> };
}

/**
 * DOM `fetch` behind the widget's injectable-fetch seam (unit tests inject
 * fakes). The cast is safe: every widget fetch interface is a subset of
 * `RequestInit`/`Response`.
 */
function domFetch(
  url: string,
  init: {
    readonly headers: Readonly<Record<string, string>>;
    readonly method?: string | undefined;
    readonly body?: string | undefined;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<Response> {
  return fetch(url, init as RequestInit);
}

/**
 * P8-D3 (review follow-up): merely *touching* `window.localStorage` throws a
 * SecurityError on opaque origins (`about:blank` embeds, sandboxed iframes)
 * and with blocked cookies. Probe inside try/catch and degrade to
 * `undefined` (config cache skipped) or an in-memory tab store (sessions keep
 * working for the page lifetime).
 */
function safeWindowStorage(kind: 'localStorage' | 'sessionStorage'): Storage | undefined {
  try {
    const store = window[kind];
    void store.length;
    return store;
  } catch {
    return undefined;
  }
}

function createMemoryStore(): {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
} {
  const backing = new Map<string, string>();
  return {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
  };
}

function currentScriptAttrs(): Record<string, string | undefined> {
  const script = document.currentScript;
  const out: Record<string, string | undefined> = {};
  if (!(script instanceof HTMLScriptElement)) return out;
  for (const name of script.getAttributeNames()) {
    if (name.startsWith('data-')) out[name] = script.getAttribute(name) ?? undefined;
  }
  return out;
}

function fallbackConfig(botSlug: string): WidgetPublicConfig {
  return {
    botId: '',
    botSlug,
    displayName: 'Support',
    greeting: 'Hello. Ask a question and I will answer from our help centre.',
    suggestedQuestions: [],
    primaryColor: '#3155D9',
    position: 'bottom-right',
    supportedLanguages: ['en'],
    escalationLabel: 'Contact support',
    escalationMessages: { en: 'I do not have that information. Our team can help:' },
  };
}

async function boot(host: HTMLElement, attrs: Record<string, string | undefined>): Promise<void> {
  const options = parseEmbedOptions(attrs);
  const turnstileSiteKey = options.turnstileSiteKey;
  const localStore = safeWindowStorage('localStorage');
  const sessionStore = safeWindowStorage('sessionStorage') ?? createMemoryStore();
  let config: WidgetPublicConfig;
  try {
    const loaded = await loadPublicConfig({
      supabaseUrl: options.supabaseUrl,
      publishableKey: options.supabasePublishableKey,
      botSlug: options.botSlug,
      fetchFn: domFetch,
      storage: localStore,
    });
    config = loaded.config;
  } catch {
    config = fallbackConfig(options.botSlug);
  }

  let conversationId: string | null = null;
  const initialSession = readSession(sessionStore, options.botSlug, Date.now());
  let boundSessionToken: string | null = initialSession?.token ?? null;
  const clearConversationBinding = (): void => {
    conversationId = null;
    try {
      sessionStore.removeItem(`ragbot.conversation.${options.botSlug}`);
    } catch {
      // The in-memory binding is cleared even if storage is unavailable.
    }
  };
  const clearSessionContext = (): void => {
    clearSession(sessionStore, options.botSlug);
    clearConversationBinding();
    boundSessionToken = null;
  };
  let stopController: AbortController | null = null;
  let creatingSession = false;
  let ui: ReturnType<typeof createWidgetUi> | null = null;

  const sendMessage = async (message: string): Promise<void> => {
    if (ui === null) return;
    if (ui.getState() === 'connecting' || ui.getState() === 'streaming') return;
    ui.setState('connecting');
    ui.appendUserMessage(message);
    const assistant = ui.appendAssistantStart();
    const stop = new AbortController();
    stopController = stop;
    try {
      creatingSession = true;
      const session = await createSession({
        apiUrl: options.apiUrl,
        botSlug: options.botSlug,
        fetchFn: domFetch,
        storage: sessionStore,
        nowMs: Date.now(),
        signal: stop.signal,
        getChallengeToken:
          turnstileSiteKey === undefined
            ? undefined
            : () =>
                requestChallenge({
                  host,
                  siteKey: turnstileSiteKey,
                  signal: stop.signal,
                }),
      });
      if (stop.signal.aborted || stopController !== stop) throw new Error('SESSION_CANCELLED');
      if (boundSessionToken !== session.token) {
        const hadSessionContext = boundSessionToken !== null || conversationId !== null;
        clearConversationBinding();
        boundSessionToken = session.token;
        if (hadSessionContext)
          ui.appendStatusNotice(
            'A new session has started. Earlier messages are local history and are not sent as context.',
          );
      }
      creatingSession = false;
      let streamError: string | null = null;
      let sources: {
        readonly title: string;
        readonly section?: string | undefined;
        readonly excerpt?: string | undefined;
      }[] = [];
      await streamChat({
        apiUrl: options.apiUrl,
        token: session.token,
        idempotencyKey: newIdempotencyKey(),
        botSlug: options.botSlug,
        conversationId,
        message,
        signal: stop.signal,
        fetchFn: domFetch,
        onEvent: (event) => {
          if (ui === null) return;
          switch (event.event) {
            case 'meta':
              conversationId = event.data.conversationId;
              // P8-D4: transitions are not idempotent — only move when the
              // state actually changes. A duplicate `meta` must not throw.
              if (ui.getState() === 'connecting') ui.setState('streaming');
              try {
                sessionStore.setItem(`ragbot.conversation.${options.botSlug}`, conversationId);
              } catch {
                // Persistence is best-effort; the turn works without it.
              }
              break;
            case 'delta':
              // P8-D4: every turn after the first delta is already
              // `streaming` — re-setting it threw and broke all multi-delta
              // streams (E2E only sent one delta, so it passed vacuously).
              if (ui.getState() !== 'streaming') ui.setState('streaming');
              assistant.appendDelta(event.data.text);
              break;
            case 'sources':
              sources = sanitizeSources(event.data.sources);
              ui.appendSources(sources);
              break;
            case 'handoff':
              try {
                ui.appendContactCard(
                  buildContactCard({
                    config,
                    handoff: event.data,
                    preferredLanguage: config.supportedLanguages[0] ?? 'en',
                  }),
                );
              } catch {
                ui.appendStatusNotice(
                  config.escalationMessages[config.supportedLanguages[0] ?? 'en'] ?? '',
                );
              }
              break;
            case 'done':
              assistant.finish(event.data.status);
              ui.setState('ready');
              break;
            case 'error':
              // P8-D2 (review R6): `error` is terminal — finish the node so
              // screen readers get the terminal announcement.
              assistant.finish('failed');
              streamError = event.data.code;
              if (event.data.code === 'SESSION_EXPIRED' || event.data.code === 'FORBIDDEN') {
                clearSessionContext();
                if (ui.getState() !== 'ready' && ui.getState() !== 'closed') ui.setState('ready');
                ui.appendStatusNotice(
                  'Session expired. Earlier messages are local history. Your next message starts a new session.',
                );
              } else if (
                event.data.code === 'RATE_LIMITED' ||
                event.data.code === 'BUDGET_EXCEEDED'
              ) {
                ui.setState('limited');
                ui.appendStatusNotice('Too many requests. Please try again later.');
              } else {
                ui.setState('unavailable');
                try {
                  ui.appendContactCard(
                    buildContactCard({
                      config,
                      handoff: {
                        reason: 'unavailable',
                        message:
                          config.escalationMessages[config.supportedLanguages[0] ?? 'en'] ?? '',
                        prominent: true,
                        contact: {},
                      },
                      preferredLanguage: config.supportedLanguages[0] ?? 'en',
                    }),
                  );
                } catch {
                  ui.appendStatusNotice('The service is unavailable. Please try again later.');
                }
              }
              break;
          }
          if (streamError !== null) stopController = null;
        },
      });
      if (stop.signal.aborted) {
        assistant.finish('partial');
        ui.appendStatusNotice('Stopped. The partial answer above is all that arrived.');
        ui.setState('ready');
      }
    } catch (error) {
      if (stopController !== stop && stop.signal.aborted) {
        assistant.finish('partial');
        return;
      }
      // P8-D2 (review R2): a user abort rejects the fetch. It is not an
      // outage — report the partial answer, never "service unavailable".
      // (The post-stream `aborted` check below only covers races where the
      // stream already ended.)
      if (stop.signal.aborted) {
        assistant.finish('partial');
        ui.appendStatusNotice('Stopped. The partial answer above is all that arrived.');
        if (ui.getState() !== 'ready' && ui.getState() !== 'closed') ui.setState('ready');
        return;
      }
      const code = error instanceof Error ? error.message : 'CHAT_FAILED';
      if (code === 'STREAM_INTERRUPTED') {
        assistant.finish('partial');
        ui.appendStatusNotice(
          'The connection ended before the answer finished. The text above is partial. You can send a new message.',
        );
        if (ui.getState() !== 'ready' && ui.getState() !== 'closed') ui.setState('ready');
        return;
      } else if (code === 'CHALLENGE_FAILED' || (creatingSession && code === 'FORBIDDEN')) {
        assistant.finish('failed');
        ui.setState('ready');
        ui.appendStatusNotice(
          code === 'CHALLENGE_FAILED'
            ? 'Verification could not finish. Please send your message again to retry.'
            : 'Verification or session access was refused. Please retry or contact support.',
        );
        return;
      } else if (code === 'IDEMPOTENT_IN_PROGRESS') {
        ui.appendStatusNotice('Your previous message is still being answered.');
      } else if (code === 'SESSION_EXPIRED' || code === 'FORBIDDEN') {
        clearSessionContext();
        assistant.finish('failed');
        if (ui.getState() !== 'ready' && ui.getState() !== 'closed') ui.setState('ready');
        ui.appendStatusNotice(
          'Session expired. Earlier messages are local history. Your next message starts a new session.',
        );
        return;
      } else {
        ui.setState('unavailable');
        ui.appendStatusNotice('The service is unavailable. Please try again later.');
      }
      assistant.finish('failed');
      // P8-D2 (review R1): never re-set the current state — self-transitions
      // throw for every state except closed/ready, which crashed mid-stream
      // network failures. Only `connecting` still needs an explicit recovery.
      if (ui.getState() === 'connecting') ui.setState('ready');
    } finally {
      if (stopController === stop) {
        creatingSession = false;
        stopController = null;
      }
    }
  };

  ui = createWidgetUi(host, config, {
    onOpen: () => ui?.setState('ready'),
    onClose: () => {
      if (creatingSession) stopController?.abort();
      ui?.setState('closed');
    },
    onSend: (message) => void sendMessage(message),
    onStop: () => stopController?.abort(),
    onReset: () => {
      clearSessionContext();
    },
    onSuggestedQuestion: (question) => void sendMessage(question),
  });
  ui.setState('closed');

  const session = initialSession;
  if (session !== null && conversationId === null) {
    try {
      const stored = sessionStore.getItem(`ragbot.conversation.${options.botSlug}`);
      if (stored !== null) {
        const page = await fetchHistory({
          apiUrl: options.apiUrl,
          token: session.token,
          conversationId: stored,
          fetchFn: domFetch,
        });
        // A restore started at boot must not rebind a refreshed/reset session,
        // overwrite a conversation started meanwhile, or append stale history.
        if (
          boundSessionToken !== session.token ||
          conversationId !== null ||
          stopController !== null ||
          readSession(sessionStore, options.botSlug, Date.now())?.token !== session.token
        )
          return;
        conversationId = page.conversationId;
        // P8-D2 (review R4): UI_SCHEMA §7 restores the transcript, not just
        // the questions. Assistant turns render as plain text; their sources
        // are not available from this endpoint, so none are shown.
        for (const item of page.messages) {
          if (item.role === 'user') {
            ui.appendUserMessage(item.content);
          } else if (item.role === 'assistant') {
            const past = ui.appendAssistantStart();
            past.appendDelta(item.content);
            past.finish('complete');
          }
        }
      }
    } catch {
      // History restore is best-effort; the widget works without it.
    }
  }
}

function initFromScript(attrs: Record<string, string | undefined>): void {
  const { w } = globals();
  if (w[WIDGET_GLOBAL] !== undefined) return;
  if (typeof customElements !== 'undefined' && customElements.get(ELEMENT_NAME) !== undefined)
    return;
  // P8-D2 (review R3): an author-placed host boots via `connectedCallback`
  // when `define()` below upgrades it — do not create a second host.
  // `markBooting` also stops the double boot where `boot()` suspends on the
  // config fetch and the following `appendChild` re-enters `connectedCallback`
  // (double config fetch + a doomed second `attachShadow`, previously).
  const authorHost = document.querySelector(ELEMENT_NAME);
  if (authorHost instanceof HTMLElement) {
    w[WIDGET_GLOBAL] = { host: authorHost, ready: Promise.resolve(null) };
    defineWidgetElement(attrs);
    return;
  }
  const host = document.createElement(ELEMENT_NAME);
  if (!markBooting(host)) return;
  const bootPromise = (async (): Promise<WidgetInstance | null> => {
    try {
      await boot(host, attrs);
      return null;
    } catch {
      // Let a later (e.g. dynamically injected) tag retry; concurrent tags
      // already deduped on the pending global above.
      delete w[WIDGET_GLOBAL];
      return null;
    }
  })();
  w[WIDGET_GLOBAL] = { host, ready: bootPromise };
  document.documentElement.appendChild(host);
  defineWidgetElement(attrs);
}

const BOOT_MARK = '__ragbotBooting';

/** One boot per host. Returns false when this host already started booting. */
function markBooting(host: HTMLElement): boolean {
  const record = host as unknown as Record<string, unknown>;
  if (record[BOOT_MARK] === true) return false;
  record[BOOT_MARK] = true;
  return true;
}

function defineWidgetElement(attrs: Record<string, string | undefined>): void {
  if (typeof customElements === 'undefined' || customElements.get(ELEMENT_NAME) !== undefined) {
    return;
  }
  customElements.define(
    ELEMENT_NAME,
    class extends HTMLElement {
      connectedCallback(): void {
        if (this.shadowRoot || !markBooting(this)) return;
        boot(this, attrs).catch(() => undefined);
      }
    },
  );
}

if (typeof document !== 'undefined') {
  // currentScript is only available while this bundle executes. Snapshot its
  // attributes before DOMContentLoaded or a later custom-element upgrade.
  const attrs = currentScriptAttrs();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initFromScript(attrs), { once: true });
  } else {
    initFromScript(attrs);
  }
}
