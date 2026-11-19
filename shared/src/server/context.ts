// Validated server-side chat settings and contact context.
import { z } from 'zod';

const optionalText = z.string().nullable();

export const chatContextSchema = z.looseObject({
  bot: z.looseObject({
    id: z.uuid(),
    slug: z.string(),
    enabled: z.boolean(),
    display_name: z.string(),
    identity_prompt: z.string(),
    tone: z.string(),
    scope: z.string(),
    allowed_languages: z.array(z.string()),
    embedding_model: z.string(),
    embedding_dimensions: z.int(),
    settings_version: z.int(),
    corpus_version: z.number().int().min(0),
  }),
  settings: z.looseObject({
    feature_flags: z.record(z.string(), z.unknown()),
    handoff_policy: z.record(z.string(), z.unknown()),
    cache_policy: z.record(z.string(), z.unknown()).optional(),
  }),
  contact: z.looseObject({
    supported_languages: z.array(z.string()),
    escalation_label: z.string(),
    escalation_messages: z.record(z.string(), z.string()),
    email: optionalText,
    phone: optionalText,
    whatsapp_url: optionalText,
    page_url: optionalText,
    business_hours: z.record(z.string(), z.string()).nullable(),
    timezone: optionalText,
  }),
});

export type ChatContext = z.output<typeof chatContextSchema>;
