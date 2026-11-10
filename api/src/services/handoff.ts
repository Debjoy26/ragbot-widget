// Contact routing (PRD W-05, W-16; TECH_SPECS section 6.1; ADR 0013). P7.
//
// Decides WHEN a visitor is routed to the business's contact details and builds the `handoff`
// event. Two rules are absolute:
//  * Contact values and the escalation message come from server configuration (`public_bot_config`
//    through get_chat_context), never from model output or from the browser.
//  * A trigger that is switched off in `handoff_policy.triggers` suppresses the `handoff` EVENT for
//    that reason only. The reason is still stored on the message (the knowledge-gap view needs it)
//    and the localised message is still shown as the answer text.
//
// Triggers: no_knowledge, repeated_no_knowledge, human_requested, blocked, out_of_scope,
// unavailable. Nothing in here logs; the text of a visitor message is only matched, never kept.

import { z } from 'zod';
import {
  HANDOFF_REASONS,
  handoffContactSchema,
  handoffReasonSchema,
  normaliseExcerpt,
  type HandoffContact,
  type HandoffEventData,
  type HandoffReason,
} from '@ragbot/shared';
import { AppError } from '../lib/errors.js';
import type { ChatContext } from './conversations.js';

/** ADR 0013: used only when the key is absent from `handoff_policy`. */
export const DEFAULT_REPEATED_THRESHOLD = 2;

export interface HandoffPolicy {
  /** Misses (including the current one) after which the card is shown prominently. */
  readonly threshold: number;
  readonly triggers: ReadonlySet<HandoffReason>;
}

const policySchema = z.looseObject({
  repeated_no_knowledge_threshold: z.int().min(1).max(1000).optional(),
  triggers: z.array(handoffReasonSchema).optional(),
});

/**
 * Reads `client_settings.handoff_policy`. A missing key takes the ADR 0013 default (threshold 2,
 * every trigger on); a key that is present but invalid is INTERNAL_ERROR (fail closed, before
 * anything is spent).
 */
export function parseHandoffPolicy(raw: Readonly<Record<string, unknown>>): HandoffPolicy {
  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) throw new AppError('INTERNAL_ERROR', { internalName: 'handoff_policy_bad' });
  return {
    threshold: parsed.data.repeated_no_knowledge_threshold ?? DEFAULT_REPEATED_THRESHOLD,
    triggers: new Set(parsed.data.triggers ?? HANDOFF_REASONS),
  };
}

/**
 * `repeated_no_knowledge` when this miss is the threshold-th one in the conversation, else
 * `no_knowledge`. `priorNoKnowledge` counts the earlier misses stored for the conversation. If the
 * repeated trigger is switched off the plain reason is used.
 */
export function noKnowledgeReason(
  priorNoKnowledge: number,
  policy: HandoffPolicy,
): 'no_knowledge' | 'repeated_no_knowledge' {
  return priorNoKnowledge + 1 >= policy.threshold && policy.triggers.has('repeated_no_knowledge')
    ? 'repeated_no_knowledge'
    : 'no_knowledge';
}

// ---------------------------------------------------------------------------
// Deterministic "I want a person" matcher
// ---------------------------------------------------------------------------
//
// A match skips retrieval and generation and answers with the contact card, so a false positive
// costs the visitor their answer. The matcher is therefore conservative: a phrase counts only with
//  * an INTENT in front of a verb ("I want to", "can I", "how do I", "please", "let me", or an
//    imperative at the start of the message), or
//  * a second-person possessive in front of a contact noun ("your phone number"), or
//  * a first-person request for a person ("I need a human").
// Nouns and verbs alone ("contact information", "customer service", "phone number format",
// "contact support hours") never match: those are ordinary questions. A subtler request is caught
// by the model's `CONTACT: REQUESTED` header instead. All patterns are linear: bounded
// alternations joined by single literal spaces (the text is whitespace-collapsed first).

const PERSON =
  '(?:human|person|people|agent|representative|rep|operator|staff|employee|advis[eo]r|consultant|someone|somebody|team|manager|support|owner|sales|customer\\s+(?:service|support|care))(?!\\s+resources)\\b';
/** A person, optionally with an article and "real/live/actual" in front. */
const PERSON_NP = `(?:(?:a|an|the|your|some|any|one\\s+of\\s+your)\\s+)?(?:(?:real|live|actual)\\s+)?${PERSON}`;
/** A team or organisation, for contact verbs ("contact the team", "reach your support team"). */
const GROUP_NP =
  '(?:(?:the|your|a)\\s+(?:(?:support|sales|customer\\s+service|customer\\s+care|customer\\s+support)\\s+)?(?:team|company|office|staff|business))';
/** What a visitor may contact: you, a team, or a person. */
const CONTACT_OBJECT = `(?:you(?:\\s+(?:guys|folks|all|directly))?|${GROUP_NP}|${PERSON_NP})`;

const ADVERBS = '(?:(?:just|really|actually|also|quickly|directly|best|urgently|simply)\\s+)*';
/** Phrases that put an intent in front of a bare verb. */
const INTENT =
  '(?:' +
  [
    // I want to / I need to / I would like to / I'd like to / I wanna
    '(?:i|we)(?:\\s+(?:would|will|really|just|still|also|do))*\\s+(?:want|wanna|need|wish|like|love|prefer|have)\\s+to',
    "(?:i|we)\\s*'?d\\s+(?:(?:really|just|also)\\s+)*(?:like|love|prefer)\\s+to",
    '(?:i|we)\\s+wanna',
    // can I / could we / may I
    '(?:can|could|may|might|should|would|will)\\s+(?:i|we|you)(?:\\s+(?:please|just|also))*',
    'let\\s+(?:me|us)',
    'how\\s+(?:can|do|could|should|would|may|might)\\s+(?:i|we)(?:\\s+(?:best|even|please|just))*',
    'how\\s+to',
    "(?:i|we)\\s*(?:'m|'re|\\s+am|\\s+are)\\s+(?:trying|looking|hoping|wanting)\\s+to",
    'is\\s+it\\s+possible\\s+to',
    'please',
  ].join('|') +
  ')';
/** Start of the message, after greetings: an imperative needs no other intent. */
const GREETING = '(?:(?:hey|hi|hello|ok|okay|yes|yeah|so|well|hmm)[ ,.!]+)*';
const GUARD = `(?:^${GREETING}|${INTENT}\\s+)${ADVERBS}`;

/** What may follow a contact request: the end, or a word that continues it. */
const END_REQUEST =
  '(?=\\s*(?:[?.!,;:)]|$)|\\s+(?:please|pls|plz|thanks|thank|now|today|directly|asap|by|via|on|at|through|over|to|about|for|regarding|with|because|so|and|or|if|when|instead)\\b)';
/** Stricter end for a noun phrase ("your email" ends; "your email policy" does not). */
const END_NOUN =
  '(?=\\s*(?:[?.!,;:)]|$)|\\s+(?:please|pls|plz|thanks|thank|again|now|today|asap|directly)\\b)';
const END_WANT =
  '(?=\\s*(?:[?.!,;:)]|$)|\\s+(?:please|pls|plz|thanks|thank|now|today|asap|instead|rather|who|that|not)\\b)';

const CONTACT_NOUN_PREFIX =
  '(?:(?:customer\\s+(?:service|support|care)|support|sales|service|office|main|business|company)\\s+)?';
const CONTACT_NOUN = '(?:phone|telephone|mobile|cell|e-?mail|whatsapp|contact)';
const CONTACT_TRAILER = '(?:number|address|details|info|information|id)';
/** "phone", "email address", "customer service phone number". */
const CONTACT_NP = `${CONTACT_NOUN_PREFIX}${CONTACT_NOUN}(?:\\s+${CONTACT_TRAILER})?`;
/** The same, but only with a trailer ("phone number", not "phone"). */
const CONTACT_NP_STRICT = `${CONTACT_NOUN_PREFIX}${CONTACT_NOUN}\\s+${CONTACT_TRAILER}`;

const HUMAN_REQUEST_PATTERNS: readonly RegExp[] = [
  // I want to talk to a person / can I speak with a real person / talk to a human
  new RegExp(`${GUARD}(?:talk|speak|chat)\\s+(?:to|with)\\s+${PERSON_NP}`),
  // Connect me to an agent / transfer me to a human (an imperative that names "me")
  new RegExp(
    `\\b(?:connect|transfer|forward|redirect|escalate)\\s+me\\s+(?:to|with)\\s+${PERSON_NP}|\\bput\\s+me\\s+(?:through|on)\\s+(?:to|with)\\s+${PERSON_NP}|\\bget\\s+me\\s+(?:connected|transferred)\\s+(?:to|with)\\s+${PERSON_NP}`,
  ),
  // how can I contact you / I want to call you / can I email the team
  new RegExp(
    `${GUARD}(?:contact|call|phone|e-?mail|mail|whatsapp|text|reach(?:\\s+out\\s+to)?|message|ring)\\s+${CONTACT_OBJECT}${END_REQUEST}`,
  ),
  // how do I get in touch (with ...)
  new RegExp(`${GUARD}get\\s+in\\s+touch(?:\\s+with\\s+${CONTACT_OBJECT})?${END_REQUEST}`),
  // your phone number / your email address / the company's contact details
  new RegExp(`\\b(?:your|ur)\\s+${CONTACT_NP}${END_NOUN}`),
  new RegExp(
    `\\b(?:the\\s+)?(?:company|business|office|shop|store)'?s?\\s+${CONTACT_NP}${END_NOUN}`,
  ),
  // give me the phone number / send me the email address
  new RegExp(
    `\\b(?:give|send|share|tell|show|provide|text|pass)\\s+(?:me|us)\\s+(?:(?:the|a|an)\\s+)?${CONTACT_NP_STRICT}${END_NOUN}`,
  ),
  // what is the phone number / what's the email address
  new RegExp(
    `\\b(?:what|whats|where)(?:\\s+is|\\s+are|'s)?\\s+the\\s+${CONTACT_NP_STRICT}${END_NOUN}`,
  ),
  // I need a human / get me an agent
  new RegExp(
    `\\b(?:(?:i|we)(?:\\s+(?:really|just|still|would|will))*\\s+(?:want|need|prefer|like|love)|(?:i|we)\\s*'d\\s+(?:like|love|prefer)|get\\s+me|give\\s+me)\\s+(?:a|an|the|your|some|one)?\\s*(?:real\\s+|live\\s+|actual\\s+)?(?:human|person|agent|representative|rep|operator|advis[eo]r|consultant|manager|someone)(?!\\s+resources)\\b${END_WANT}`,
  ),
  // The whole message is the request: "human", "agent please", "a real person"
  new RegExp(
    `^${GREETING}(?:(?:a|an|the)\\s+)?(?:(?:real|live|actual)\\s+)?(?:human|person|agent|representative|operator|someone)(?:\\s+(?:please|pls|plz|now|thanks))*\\s*[?.!]*$`,
  ),
  // Spanish
  /(?:quiero|quisiera|necesito|puedo|podr[ií]a|podemos|deseo|busco|me\s+gustar[ií]a|c[oó]mo\s+puedo)\s+(?:\S+\s+){0,2}?(?:hablar|contactar|comunicarme|comunicarse|contactarme)\s+(?:con\s+)?(?:una?\s+)?(?:persona|humano|agente|alguien|ustedes|vosotros|el\s+equipo|soporte|ventas|asesor)/,
  /(?:cu[aá]l\s+es|dame|d[aá]me|p[aá]same)\s+(?:el\s+|su\s+|tu\s+)?(?:n[uú]mero\s+de\s+tel[eé]fono|tel[eé]fono)\b/,
  /\b(?:su|tu|vuestro)\s+n[uú]mero\s+de\s+tel[eé]fono\b/,
  // French
  /(?:je\s+(?:veux|voudrais|souhaite|d[ée]sire|peux|pourrais|dois)|puis-je|pourrais-je|j'aimerais|j'ai\s+besoin\s+de|comment\s+(?:puis-je|je\s+peux|peut-on))\s+(?:\S+\s+){0,2}?(?:parler|contacter|joindre|appeler)\s+(?:[àa]\s+|avec\s+)?(?:un|une|quelqu'un|votre|le|l')?\s*(?:humain|personne|agent|conseiller|conseill[eè]re|[ée]quipe|service\s+client|support|vendeur)/,
  /\b(?:votre|vos)\s+num[ée]ros?\s+de\s+t[ée]l[ée]phone\b/,
  // German
  /\bmit\s+(?:einem|einer|ein)\s+(?:echten\s+|richtigen\s+)?(?:menschen|mitarbeiter|mitarbeiterin|person|berater|beraterin|kundenservice)\s+(?:sprechen|reden|telefonieren|chatten|verbunden\s+werden)\b/,
  /\b(?:ihre|eure|deine)\s+(?:telefonnummer|kontaktdaten)\b/,
];

/** True when the visitor clearly asks for a person or for contact details. */
export function matchesHumanRequest(message: string): boolean {
  const text = message
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return HUMAN_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Language and event
// ---------------------------------------------------------------------------

const baseTag = (tag: string): string => tag.toLowerCase().split('-')[0] ?? '';

/**
 * The visitor's language when `preferred` is one of the bot's supported languages (exact match, or
 * the same base language), else undefined. An unsupported value is ignored, never trusted.
 */
export function resolveLanguage(
  preferred: string | undefined,
  supported: readonly string[],
): string | undefined {
  if (preferred === undefined) return undefined;
  const wanted = preferred.toLowerCase();
  return (
    supported.find((tag) => tag.toLowerCase() === wanted) ??
    supported.find((tag) => baseTag(tag) === baseTag(wanted))
  );
}

/** Plain text for `HandoffEventData.message` (max 300, no angle brackets, no control characters). */
function plainMessage(value: string): string {
  const text = normaliseExcerpt(value).replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= 300) return text;
  const cut = text.charCodeAt(299);
  return text.slice(0, cut >= 0xd800 && cut <= 0xdbff ? 299 : 300).trim();
}

/**
 * The escalation message for `language`, else for the first supported language, else for the
 * first supported language that has one; '' only when no supported language has a usable message
 * (prepare() refuses such a bot before anything is spent, so a blank reply is never sent). A message
 * counts only if it is not empty once reduced to plain text.
 */
export function escalationMessage(ctx: ChatContext, language: string | undefined): string {
  const { escalation_messages: messages, supported_languages: supported } = ctx.contact;
  const candidates = [...(language === undefined ? [] : [language]), ...supported];
  for (const tag of candidates) {
    const raw = Object.hasOwn(messages, tag) ? messages[tag] : undefined;
    if (raw === undefined) continue;
    const text = plainMessage(raw);
    if (text !== '') return text;
  }
  return '';
}

/** The contact card from configuration; null when it is not a valid card (no channel at all). */
export function contactCard(ctx: ChatContext): HandoffContact | null {
  const c = ctx.contact;
  const card = {
    ...(c.email === null ? {} : { email: c.email }),
    ...(c.phone === null ? {} : { phone: c.phone }),
    ...(c.whatsapp_url === null ? {} : { whatsapp_url: c.whatsapp_url }),
    ...(c.page_url === null ? {} : { page_url: c.page_url }),
    ...(c.timezone === null ? {} : { timezone: c.timezone }),
    ...(c.business_hours === null || c.timezone === null
      ? {}
      : { business_hours: c.business_hours }),
  };
  const parsed = handoffContactSchema.safeParse(card);
  return parsed.success ? parsed.data : null;
}

export interface HandoffPlan {
  readonly reason: HandoffReason;
  /** Localised configured message ('' when none is configured). Shown as the answer text. */
  readonly message: string;
  readonly prominent: boolean;
  /** The event to send; null when the trigger is off or no valid card/message can be built. */
  readonly event: HandoffEventData | null;
  /** Why no event: a code for the log, or null. */
  readonly omitted: 'trigger_disabled' | 'contact_missing' | 'message_missing' | null;
}

/**
 * Builds the routing decision for `reason`. `prominent` is true for `repeated_no_knowledge`.
 *
 * A missing message: the shared `handoff` schema requires a non-empty message (plainText, min 1),
 * so an event with an empty one cannot be validated or sent. The event is omitted (`omitted` =
 * `message_missing`, logged as a code by the caller) rather than weakening the schema.
 */
export function planHandoff(
  reason: HandoffReason,
  ctx: ChatContext,
  language: string | undefined,
  policy: HandoffPolicy,
): HandoffPlan {
  const message = escalationMessage(ctx, language);
  const prominent = reason === 'repeated_no_knowledge';
  if (!policy.triggers.has(reason)) {
    return { reason, message, prominent, event: null, omitted: 'trigger_disabled' };
  }
  const contact = contactCard(ctx);
  if (contact === null) {
    return { reason, message, prominent, event: null, omitted: 'contact_missing' };
  }
  if (message === '')
    return { reason, message, prominent, event: null, omitted: 'message_missing' };
  return {
    reason,
    message,
    prominent,
    event: { reason, message, prominent, contact },
    omitted: null,
  };
}
