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

const PERSON =
  '(?:human|person|people|agent|representative|rep|operator|staff|employee|advis[eo]r|consultant|someone|somebody|team|manager|support|owner|sales)';

/**
 * English first, with common phrasings in Spanish, French and German. It is a convenience that
 * skips retrieval and generation for an unmistakable request; any other language, or a subtler
 * request, is caught by the model's `CONTACT: REQUESTED` header instead.
 */
const HUMAN_REQUEST_PATTERNS: readonly RegExp[] = [
  new RegExp(
    `\\b(?:talk|speak|chat|connect|get\\s+connected|get\\s+transferred|transfer\\s+me)\\s+(?:to|with)\\s+(?:a|an|the|your|some|any)?\\s*(?:real\\s+|live\\s+|actual\\s+)?${PERSON}\\b`,
  ),
  /\b(?:real|live|actual)\s+(?:person|human|agent)\b/,
  new RegExp(
    `\\b(?:contact|call|phone|e-?mail|mail|whatsapp|text|reach|message|ring)\\s+(?:you|us|them|the\\s+(?:team|company|office|staff|business)|a\\s+${PERSON}|${PERSON})\\b`,
  ),
  /\b(?:your|the\s+company'?s?|the\s+business'?s?|support|sales|office)\s+(?:phone|telephone|mobile|e-?mail|contact|whatsapp)(?:\s+(?:number|address|details|info|information))?\b/,
  /\b(?:phone|telephone|mobile|contact|whatsapp)\s+(?:number|details|info|information)\b/,
  /\bhow\s+(?:can|do|could|should|would)\s+i\s+(?:contact|reach|call|e-?mail|get\s+in\s+touch)\b/,
  /\bget\s+in\s+touch\b/,
  /\b(?:i\s+want|i\s*'?d\s+like|i\s+need|can\s+i|could\s+i|may\s+i|let\s+me)\s+(?:to\s+)?(?:talk|speak|chat)\b/,
  /\bcustomer\s+(?:service|support|care)\b/,
  // Spanish
  /\b(?:hablar|contactar|comunicarme|comunicarse)\s+con\s+(?:una?\s+)?(?:persona|humano|agente|alguien|ustedes|vosotros|el\s+equipo)\b/,
  /\bn[uú]mero\s+de\s+tel[eé]fono\b/,
  // French
  /\b(?:parler|contacter|joindre)\s+(?:[àa]\s+|avec\s+)?(?:un|une|quelqu'un|votre)?\s*(?:humain|personne|agent|conseiller|[ée]quipe|service)\b/,
  /\bnum[ée]ro\s+de\s+t[ée]l[ée]phone\b/,
  // German
  /\b(?:mit\s+(?:einem|einer)\s+(?:menschen|mitarbeiter|mitarbeiterin|person|berater|beraterin))\b/,
  /\b(?:telefonnummer|kontaktdaten)\b/,
];

/** True when the visitor clearly asks for a person or for contact details. */
export function matchesHumanRequest(message: string): boolean {
  const text = message.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
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

/** The escalation message for `language`, else for the first supported language, else ''. */
export function escalationMessage(ctx: ChatContext, language: string | undefined): string {
  const { escalation_messages: messages, supported_languages: supported } = ctx.contact;
  const first = supported[0];
  const raw =
    (language === undefined ? undefined : messages[language]) ??
    (first === undefined ? undefined : messages[first]);
  return raw === undefined ? '' : plainMessage(raw);
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
