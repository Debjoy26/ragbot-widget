-- seed.sql — DEV ONLY. Runs on `supabase db reset` against the LOCAL stack.
-- No admin users, keys, tokens or client data. Contact details are placeholders (example.com).
-- Production values (daily cap, contact channels, retention confirmation) are supplied per client at onboarding (P12).

insert into public.bot_profiles (
  id, slug, identity_prompt, tone, scope, allowed_languages,
  embedding_model, embedding_dimensions, enabled
) values (
  '00000000-0000-4000-8000-0000000000b1',
  'dev-bot',
  'DEV PLACEHOLDER: You are a helpful support assistant for the Example Co. website.',
  'friendly and concise',
  'DEV PLACEHOLDER: questions about the sample documents only',
  array['en'],
  'gemini-embedding-001',  -- ADR 0014 default; dimension fixed at 1536 (ADR 0002)
  1536,
  true
);

insert into public.public_bot_config (
  bot_id, bot_slug, display_name, greeting, suggested_questions, primary_color, position,
  privacy_url, supported_languages, escalation_label, escalation_messages,
  contact_email, contact_phone, contact_whatsapp_url, contact_page_url, business_hours, timezone
) values (
  '00000000-0000-4000-8000-0000000000b1',
  'dev-bot',
  'Dev Assistant',
  'Hi! Ask me about the sample documents.',
  '["What can you help with?"]'::jsonb,
  '#2563eb',
  'bottom-right',
  'https://example.com/privacy',
  array['en'],
  'Contact support',
  '{"en": "I could not find that. Please contact support@example.com."}'::jsonb,
  'support@example.com',
  null,
  null,
  null,
  '{"mon": {"open": "09:00", "close": "17:00"}, "tue": {"open": "09:00", "close": "17:00"}, "wed": {"open": "09:00", "close": "17:00"}, "thu": {"open": "09:00", "close": "17:00"}, "fri": {"open": "09:00", "close": "17:00"}}'::jsonb,
  'Asia/Kolkata'
);

-- Conservative limits from ADR 0007; retention from ADR 0006; handoff defaults from ADR 0013;
-- answer cache OFF by default (ADR 0012).
insert into public.client_settings (
  bot_id, allowed_origins, rate_policy, budget_policy, retention_policy,
  upload_policy, handoff_policy, cache_policy, feature_flags
) values (
  '00000000-0000-4000-8000-0000000000b1',
  array['http://localhost:3000', 'http://127.0.0.1:3000'],
  '{
    "message_per_session": {"limit": 20, "window_seconds": 600},
    "message_per_ip": {"limit": 60, "window_seconds": 3600},
    "session_create_per_ip": {"limit": 10, "window_seconds": 3600},
    "concurrent_requests_per_session": 1,
    "max_message_chars": 2000,
    "max_output_tokens": 800
  }'::jsonb,
  '{"daily_cap_usd": 5}'::jsonb,
  '{"conversation_days": 90, "usage_months": 13}'::jsonb,
  '{"max_bytes": 20971520, "max_pages": 300}'::jsonb,
  '{
    "repeated_no_knowledge_threshold": 2,
    "triggers": ["no_knowledge", "out_of_scope", "human_requested", "blocked", "unavailable", "repeated_no_knowledge"]
  }'::jsonb,
  '{"answer_cache_enabled": false, "answer_cache_ttl_seconds": 86400, "kill_switch": false}'::jsonb,
  '{}'::jsonb
);
