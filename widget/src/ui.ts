// P8 UI: Shadow-DOM custom element tree and state machine
// (UI_SCHEMA §3/§4/§6). All text is inserted via `textContent`; links are
// built only by the contact-card module from validated config. Model text is
// never turned into anchors.

import type { WidgetPublicConfig, WidgetState } from './types.js';
import type { ContactCardData } from './contact-card.js';

export interface UiCallbacks {
  readonly onOpen: () => void;
  readonly onClose: () => void;
  readonly onSend: (message: string) => void;
  readonly onStop: () => void;
  readonly onReset: () => void;
  readonly onSuggestedQuestion: (question: string) => void;
}

export interface WidgetUi {
  readonly root: ShadowRoot;
  readonly setState: (state: WidgetState) => void;
  readonly getState: () => WidgetState;
  readonly appendUserMessage: (text: string) => void;
  readonly appendAssistantStart: () => {
    readonly appendDelta: (text: string) => void;
    readonly finish: (status: string) => void;
  };
  readonly appendSources: (
    sources: readonly {
      readonly title: string;
      readonly section?: string | undefined;
      readonly excerpt?: string | undefined;
    }[],
  ) => void;
  readonly appendContactCard: (card: ContactCardData) => void;
  readonly appendStatusNotice: (text: string) => void;
  readonly setComposerEnabled: (enabled: boolean) => void;
  readonly announce: (text: string) => void;
  readonly destroy: () => void;
}

const CSS = `
:host { all: initial; font-family: system-ui, -apple-system, sans-serif; }
.launcher { position: fixed; z-index: 2147483000; width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer; color: #fff; font-size: 24px; }
.launcher.bottom-right { right: 20px; bottom: 20px; }
.launcher.bottom-left { left: 20px; bottom: 20px; }
.launcher:focus-visible { outline: 3px solid #000; outline-offset: 2px; }
.panel { position: fixed; z-index: 2147483001; width: min(380px, calc(100vw - 32px)); height: min(600px, calc(100dvh - 100px)); display: flex; flex-direction: column; border-radius: 12px; overflow: hidden; background: #fff; color: #111; box-shadow: 0 8px 40px rgba(0,0,0,.25); }
.panel.bottom-right { right: 20px; bottom: 88px; }
.panel.bottom-left { left: 20px; bottom: 88px; }
.panel[hidden] { display: none; }
.header { display: flex; align-items: center; gap: 8px; padding: 12px; color: #fff; }
.header .name { font-weight: 600; }
.header .ai-label { font-size: 11px; opacity: .85; border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; }
.header button { margin-left: auto; background: transparent; border: none; color: inherit; font-size: 18px; cursor: pointer; }
.notice { font-size: 12px; padding: 8px 12px; background: #f4f4f5; color: #444; }
.transcript { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.msg { max-width: 90%; padding: 8px 12px; border-radius: 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.user { align-self: flex-end; background: #e8eefc; }
.msg.assistant { align-self: flex-start; background: #f4f4f5; }
.sources { font-size: 12px; color: #444; }
.sources li { margin: 2px 0; }
.contact-card { border: 1px solid #ddd; border-radius: 10px; padding: 10px 12px; background: #fff8e6; }
.contact-card h3 { margin: 0 0 4px; font-size: 14px; }
.contact-card p { margin: 0 0 8px; font-size: 13px; }
.contact-card .links { display: flex; flex-wrap: wrap; gap: 8px; }
.contact-card a { font-size: 13px; padding: 6px 10px; border-radius: 6px; background: #111; color: #fff; text-decoration: none; }
.contact-card a:focus-visible { outline: 3px solid #000; outline-offset: 2px; }
.status { font-size: 12px; color: #666; text-align: center; }
.composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #eee; }
.composer textarea { flex: 1; resize: none; font: inherit; padding: 8px; border: 1px solid #ccc; border-radius: 8px; }
.composer button { padding: 8px 14px; border-radius: 8px; border: none; cursor: pointer; color: #fff; }
.footer { font-size: 11px; color: #666; padding: 8px 12px; border-top: 1px solid #eee; display: flex; justify-content: space-between; gap: 8px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

function setText(node: { textContent: string | null }, text: string): void {
  node.textContent = text;
}

/** Allowed state transitions; anything else is a programming error. */
const TRANSITIONS: Readonly<Record<WidgetState, readonly WidgetState[]>> = {
  booting: ['closed'],
  closed: ['ready', 'closed'],
  // P8-D2 (review R1): `ready` must accept late terminal events (an `error`
  // frame can arrive after `done` on a hostile path), and every terminal
  // state must allow a retry via `connecting` — otherwise the widget wedges
  // after any limit/block/outage with an unhandled throw.
  ready: ['connecting', 'closed', 'ready', 'limited', 'blocked', 'unavailable'],
  connecting: ['streaming', 'limited', 'blocked', 'unavailable', 'ready', 'closed'],
  streaming: ['ready', 'limited', 'blocked', 'unavailable', 'closed'],
  limited: ['ready', 'closed', 'connecting'],
  blocked: ['ready', 'closed', 'connecting'],
  unavailable: ['ready', 'closed', 'connecting'],
};

/** Pure transition check (unit-tested in node; the state machine itself needs DOM). */
export function isTransitionAllowed(from: WidgetState, to: WidgetState): boolean {
  return TRANSITIONS[from]?.includes(to) === true;
}

export function createWidgetUi(
  host: HTMLElement,
  config: WidgetPublicConfig,
  callbacks: UiCallbacks,
): WidgetUi {
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  let state: WidgetState = 'booting';
  let lastFocused: Element | null = null;
  let announceTimer: number | null = null;
  let pendingAnnouncement = '';

  const launcher = el('button', `launcher ${config.position}`) as HTMLButtonElement;
  launcher.style.background = config.primaryColor;
  setText(launcher, '✦');
  launcher.setAttribute('aria-label', config.displayName);
  launcher.setAttribute('aria-haspopup', 'dialog');

  const panel = el('section', `panel ${config.position}`) as HTMLElement;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', config.displayName);
  panel.hidden = true;

  const header = el('div', 'header') as HTMLElement;
  header.style.background = config.primaryColor;
  const name = el('span', 'name');
  setText(name, config.displayName);
  const aiLabel = el('span', 'ai-label');
  setText(aiLabel, 'AI');
  const closeButton = el('button') as HTMLButtonElement;
  setText(closeButton, '✕');
  closeButton.setAttribute('aria-label', 'Close chat');
  header.append(name, aiLabel, closeButton);

  const notice = el('div', 'notice');
  setText(notice, 'AI answers from approved knowledge. Do not share sensitive data.');

  const transcript = el('div', 'transcript') as HTMLElement;
  transcript.setAttribute('role', 'log');
  transcript.setAttribute('aria-label', 'Conversation');

  const liveRegion = el('div', 'sr-only') as HTMLElement;
  liveRegion.setAttribute('aria-live', 'polite');

  const greeting = el('div', 'msg assistant');
  greeting.setAttribute('dir', 'auto');
  setText(greeting, config.greeting);
  transcript.appendChild(greeting);
  for (const question of config.suggestedQuestions) {
    const button = el('button', 'msg assistant') as HTMLButtonElement;
    button.setAttribute('dir', 'auto');
    setText(button, question);
    button.addEventListener('click', () => callbacks.onSuggestedQuestion(question));
    transcript.appendChild(button);
  }

  const composer = el('div', 'composer');
  const textarea = el('textarea') as HTMLTextAreaElement;
  textarea.setAttribute('aria-label', 'Message');
  textarea.rows = 2;
  const sendButton = el('button') as HTMLButtonElement;
  sendButton.style.background = config.primaryColor;
  setText(sendButton, 'Send');
  const stopButton = el('button') as HTMLButtonElement;
  stopButton.style.background = '#666';
  setText(stopButton, 'Stop');
  stopButton.hidden = true;
  composer.append(textarea, sendButton, stopButton);

  const footer = el('div', 'footer');
  const disclosure = el('span');
  setText(disclosure, 'AI-generated answers');
  const escalationLink = el('a') as HTMLAnchorElement;
  setText(escalationLink, config.escalationLabel);
  if (config.contactPageUrl !== undefined) escalationLink.href = config.contactPageUrl;
  else if (config.contactEmail !== undefined) escalationLink.href = `mailto:${config.contactEmail}`;
  footer.append(disclosure, escalationLink);

  panel.append(header, notice, transcript, liveRegion, composer, footer);
  root.append(launcher, panel);

  const ui: WidgetUi = {
    root,
    setState(next: WidgetState): void {
      const allowed = TRANSITIONS[state] ?? [];
      if (!allowed.includes(next)) throw new Error(`invalid widget transition ${state} -> ${next}`);
      state = next;
      panel.hidden = next === 'closed' || next === 'booting';
      launcher.hidden = next !== 'closed' && next !== 'booting';
      const busy = next === 'connecting' || next === 'streaming';
      sendButton.hidden = busy;
      stopButton.hidden = !busy;
      textarea.disabled = busy || next === 'booting';
      if (next === 'closed' && lastFocused instanceof HTMLElement) lastFocused.focus();
    },
    getState: () => state,
    appendUserMessage(text: string): void {
      const node = el('div', 'msg user');
      // `dir=auto`: direction follows content (UI_SCHEMA §6 RTL support).
      node.setAttribute('dir', 'auto');
      setText(node, text);
      transcript.appendChild(node);
      transcript.scrollTop = transcript.scrollHeight;
    },
    appendAssistantStart(): {
      readonly appendDelta: (text: string) => void;
      readonly finish: (status: string) => void;
    } {
      const node = el('div', 'msg assistant');
      node.setAttribute('dir', 'auto');
      transcript.appendChild(node);
      let full = '';
      return {
        appendDelta(text: string): void {
          full += text;
          setText(node, full);
          transcript.scrollTop = transcript.scrollHeight;
        },
        finish(status: string): void {
          node.setAttribute('data-status', status);
          ui.announce(status === 'complete' ? 'Answer received.' : `Answer ${status}.`);
        },
      };
    },
    appendSources(sources): void {
      if (sources.length === 0) return;
      const list = el('ul', 'sources') as HTMLUListElement;
      for (const source of sources) {
        const item = document.createElement('li');
        setText(
          item,
          source.section !== undefined ? `${source.title} — ${source.section}` : source.title,
        );
        list.appendChild(item);
      }
      transcript.appendChild(list);
      transcript.scrollTop = transcript.scrollHeight;
    },
    appendContactCard(card: ContactCardData): void {
      const wrap = el('div', 'contact-card') as HTMLElement;
      const heading = el('h3');
      setText(heading, card.heading);
      const message = el('p');
      setText(message, card.message);
      wrap.append(heading, message);
      const links = el('div', 'links');
      for (const link of card.links) {
        const anchor = el('a') as HTMLAnchorElement;
        setText(anchor, link.label);
        anchor.href = link.href;
        anchor.rel = 'noopener';
        links.appendChild(anchor);
      }
      wrap.appendChild(links);
      if (card.businessHoursText !== undefined) {
        const hours = el('p');
        const hint = card.openNow === null ? '' : card.openNow ? ' · Open now' : ' · Closed';
        setText(hours, `${card.businessHoursText}${hint}`);
        wrap.appendChild(hours);
      }
      transcript.appendChild(wrap);
      if (card.prominent) {
        const pinned = wrap.cloneNode(true);
        composer.before(pinned);
      }
      transcript.scrollTop = transcript.scrollHeight;
      ui.announce(`${card.heading}. ${card.message}`);
    },
    appendStatusNotice(text: string): void {
      const node = el('div', 'status');
      setText(node, text);
      transcript.appendChild(node);
      transcript.scrollTop = transcript.scrollHeight;
    },
    setComposerEnabled(enabled: boolean): void {
      textarea.disabled = !enabled;
      sendButton.disabled = !enabled;
    },
    announce(text: string): void {
      pendingAnnouncement = text;
      if (announceTimer !== null) return;
      announceTimer = window.setTimeout(() => {
        announceTimer = null;
        setText(liveRegion, pendingAnnouncement);
        pendingAnnouncement = '';
      }, 800);
    },
    destroy(): void {
      if (announceTimer !== null) window.clearTimeout(announceTimer);
      root.replaceChildren();
    },
  };

  const submit = (): void => {
    const value = textarea.value.trim();
    if (value.length === 0) return;
    textarea.value = '';
    callbacks.onSend(value);
  };
  sendButton.addEventListener('click', submit);
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });
  stopButton.addEventListener('click', () => callbacks.onStop());
  const open = (): void => {
    lastFocused = document.activeElement;
    callbacks.onOpen();
    textarea.focus();
  };
  launcher.addEventListener('click', open);
  closeButton.addEventListener('click', () => callbacks.onClose());
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') callbacks.onClose();
  });

  return ui;
}
