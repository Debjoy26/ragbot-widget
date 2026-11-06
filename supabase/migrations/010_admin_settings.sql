-- 010: P3.5 admin data layer, part 2 (ADR 0017): bot list, settings read and update, enable gate,
-- conversation delete, member list, schema version. Also: admin_document_status gets paging, and
-- admin_retry_version refuses a version older than the live one.
-- Forward-only: 001-009 are never edited. Same rules as 009: browser-callable functions are SECURITY DEFINER
-- with an empty search_path, EXECUTE for authenticated only, and start with public.admin_require() (except
-- schema_version, which any signed-in user may call). Helpers are not executable by any API role.
-- New SQLSTATE use (contract): RB030 stale version or wrong state, RB035 settings invalid, RB037 not found.
--
-- The field rules in admin_validate_settings_patch must accept and reject exactly what
-- botSettingsPatchSchema (shared/src/schemas.ts) does. tests/fixtures/settings-parity.json is run against
-- both. Known, deliberate differences (SQL is stricter, never looser; none is in the fixture):
--   * URLs: the WHATWG parser accepts IP-address hosts, internationalised hosts, "https:host" without
--     slashes, an empty port ("https://a.com:"), a trailing dot, empty credentials ("https://@a.com") and
--     hyphen-edged labels. SQL refuses all of them. SQL stores the scheme in lower case.
--   * Time zones: SQL checks pg_timezone_names (case-insensitive, "Factory" excluded); Node checks its own
--     ICU list. Both accept every name in Intl.supportedValuesOf at the pinned versions; a newer tz
--     release in one but not the other can differ until both are updated.

-- ---------------------------------------------------------------------------
-- admin_audit: same function, wider allowlist (settings, enable and conversation delete). Every other
-- rule is unchanged. changed_fields is a comma-joined list of up to 17 field names (234 characters at
-- most), so only that key may be longer than 200 characters (cap 300). Values are never stored.
-- ---------------------------------------------------------------------------
create or replace function public.admin_audit(p_action text, p_resource_type text, p_resource_id uuid, p_metadata jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_actor   uuid := auth.uid();
  v_allowed text[] := array['bot_id', 'document_id', 'version_id', 'version_number', 'media_type', 'byte_size', 'kind',
                            'changed_fields', 'expected_settings_version', 'settings_version', 'enabled', 'conversation_id'];
  v_key     text;
  v_val     jsonb;
begin
  if v_actor is null then
    raise exception 'admin_audit: no signed-in user' using errcode = 'RB033';
  end if;
  if p_action is null or p_action !~ '^[a-z_]+(\.[a-z_]+)*$' or char_length(p_action) > 64
     or p_resource_type is null or p_resource_type !~ '^[a-z_]+$' or char_length(p_resource_type) > 64 then
    raise exception 'admin_audit: invalid action or resource type' using errcode = '22023';
  end if;
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'admin_audit: metadata must be an object' using errcode = '22023';
  end if;
  for v_key, v_val in select e.key, e.value from jsonb_each(p_metadata) e loop
    if v_key <> all (v_allowed) then
      raise exception 'admin_audit: metadata key is not allowed' using errcode = '22023';
    end if;
    if jsonb_typeof(v_val) not in ('string', 'number', 'boolean', 'null')
       or (jsonb_typeof(v_val) = 'string'
           and char_length(v_val #>> '{}') > case when v_key = 'changed_fields' then 300 else 200 end) then
      raise exception 'admin_audit: metadata values must be short scalars' using errcode = '22023';
    end if;
  end loop;
  insert into public.audit_logs (actor_user_id, action, resource_type, resource_id, safe_metadata)
  values (v_actor, p_action, p_resource_type, p_resource_id::text, p_metadata);
end;
$$;

-- ---------------------------------------------------------------------------
-- Pure validation helpers. They match the JavaScript rules the Zod schema uses:
--   * trim() removes the JavaScript whitespace set (not just spaces)
--   * Zod's .max() counts Unicode code points (char_length); isHttpsUrl counts UTF-16 code units, where a
--     character outside the BMP counts as 2
-- ---------------------------------------------------------------------------

-- JavaScript String.prototype.trim().
create function public.admin_js_trim(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(
           regexp_replace(p_text, '^[\u0009-\u000d    -     　﻿]+', ''),
           '[\u0009-\u000d    -     　﻿]+$', '');
$$;

-- JavaScript string .length (UTF-16 code units). Only isHttpsUrl uses it; Zod's .max() counts code points.
create function public.admin_utf16_length(p_text text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select char_length(regexp_replace(p_text, '[\U00010000-\U0010FFFF]', '__', 'g'));
$$;

-- plainText(max) when p_plain (no angle brackets, no control characters) or freeText(max) otherwise
-- (newline and tab allowed). Trimmed first, 1..p_max code points after trimming. Non-strings fail.
-- Both reject the invisible format characters U+00AD, U+200B-U+200F, U+202A-U+202E, U+2060-U+206F, U+FEFF,
-- U+061C, U+115F, U+1160, U+2800, U+3164, U+FFA0 and U+E0000-U+E007F (one class, the same in the Zod schema).
create function public.admin_text_ok(p_val jsonb, p_max integer, p_plain boolean)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text;
begin
  if p_val is null or jsonb_typeof(p_val) <> 'string' then
    return false;
  end if;
  v := public.admin_js_trim(p_val #>> '{}');
  if v = '' or char_length(v) > p_max then
    return false;
  end if;
  if v ~ '[\u00ad\u061c\u115f\u1160\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufeff\uffa0\U000e0000-\U000e007f]' then
    return false;
  end if;
  if p_plain then
    return v !~ '[<>]' and v !~ '[\u0001-\u001f\u007f]';
  end if;
  return v !~ '[\u0001-\u0008\u000b-\u001f\u007f]';
end;
$$;

-- isHttpsUrl(): https only, 2048 UTF-16 units at most, no whitespace, no C0 or C1 control character, no < > " ' \, no credentials, a host.
-- The host is a dotted name whose last label starts with a letter (a name, never an IP address), with an
-- optional port up to 65535. Stricter than the WHATWG parser on purpose (no IP literals, no IDN, no
-- "https:host" forms, no empty port, no trailing dot): a stricter value is refused, never accepted wrongly.
create function public.admin_url_ok(p_val jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v    text;
  v_port text;
begin
  if p_val is null or jsonb_typeof(p_val) <> 'string' then
    return false;
  end if;
  v := p_val #>> '{}';
  if public.admin_utf16_length(v) > 2048
     or v ~ '[\u0001-\u001f\u007f-\u009f\u0009-\u000d    -     　﻿<>"''\\]' then
    return false;
  end if;
  if v !~ '^[Hh][Tt][Tt][Pp][Ss]://([A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?\.)*[A-Za-z]([A-Za-z0-9_-]*[A-Za-z0-9])?(:[0-9]{1,5})?([/?#].*)?$' then
    return false;
  end if;
  v_port := (regexp_match(v, '^[Hh][Tt][Tt][Pp][Ss]://[^/?#]*:([0-9]+)'))[1];
  if v_port is not null and v_port::integer > 65535 then
    return false;
  end if;
  return true;
end;
$$;

-- Returns the name of the first invalid key of a settings patch (keys in alphabetical order), '_patch'
-- when the patch is not a non-empty object, '_unknown_key' for a key outside the whitelist, or NULL when
-- the patch is valid. It never returns a submitted value.
create function public.admin_validate_settings_patch(p_patch jsonb)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_key  text;
  v_val  jsonb;
  v_el   jsonb;
  v_str  text;
  v_n    integer;
  v_m    text[];
  v_days text[] := array['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  v_hk   text;
  v_hv   jsonb;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    return '_patch';
  end if;

  for v_key, v_val in select e.key, e.value from jsonb_each(p_patch) e order by e.key loop
    if v_key = 'display_name' then
      if not public.admin_text_ok(v_val, 80, true) then return v_key; end if;
    elsif v_key = 'greeting' then
      if not public.admin_text_ok(v_val, 500, true) then return v_key; end if;
    elsif v_key = 'escalation_label' then
      if not public.admin_text_ok(v_val, 60, true) then return v_key; end if;
    elsif v_key = 'tone' then
      -- Single line: no newline or carriage return (scope may have them).
      if not public.admin_text_ok(v_val, 500, false) or public.admin_js_trim(v_val #>> '{}') ~ '[\n\r]' then return v_key; end if;
    elsif v_key = 'scope' then
      if not public.admin_text_ok(v_val, 2000, false) then return v_key; end if;

    elsif v_key = 'suggested_questions' then
      if jsonb_typeof(v_val) <> 'array' or jsonb_array_length(v_val) > 6 then return v_key; end if;
      for v_el in select x.value from jsonb_array_elements(v_val) x loop
        if not public.admin_text_ok(v_el, 200, true) then return v_key; end if;
      end loop;

    elsif v_key = 'primary_color' then
      if jsonb_typeof(v_val) <> 'string' or (v_val #>> '{}') !~ '^#[0-9A-Fa-f]{6}$' then return v_key; end if;
    elsif v_key = 'position' then
      if jsonb_typeof(v_val) <> 'string' or (v_val #>> '{}') not in ('bottom-right', 'bottom-left') then return v_key; end if;

    elsif v_key = 'privacy_url' or v_key = 'contact_whatsapp_url' or v_key = 'contact_page_url' then
      if jsonb_typeof(v_val) <> 'null' and not public.admin_url_ok(v_val) then return v_key; end if;
    elsif v_key = 'contact_phone' then
      if jsonb_typeof(v_val) <> 'null'
         and (jsonb_typeof(v_val) <> 'string' or (v_val #>> '{}') !~ '^\+[1-9][0-9]{6,14}$') then return v_key; end if;
    elsif v_key = 'contact_email' then
      if jsonb_typeof(v_val) <> 'null' then
        if jsonb_typeof(v_val) <> 'string' then return v_key; end if;
        v_str := v_val #>> '{}';
        if char_length(v_str) > 254
           or v_str !~ '^([A-Za-z0-9_''+-]+\.)*[A-Za-z0-9_''+-]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$' then
          return v_key;
        end if;
      end if;

    elsif v_key = 'supported_languages' then
      if jsonb_typeof(v_val) <> 'array' then return v_key; end if;
      v_n := jsonb_array_length(v_val);
      if v_n < 1 or v_n > 20 then return v_key; end if;
      for v_el in select x.value from jsonb_array_elements(v_val) x loop
        if jsonb_typeof(v_el) <> 'string' or (v_el #>> '{}') !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$' then return v_key; end if;
      end loop;
      if (select count(distinct x.value) from jsonb_array_elements(v_val) x) <> v_n then return v_key; end if;

    elsif v_key = 'escalation_messages' then
      if jsonb_typeof(v_val) <> 'object' then return v_key; end if;
      select count(*) into v_n from jsonb_object_keys(v_val);
      if v_n < 1 or v_n > 20 then return v_key; end if;
      for v_hk, v_hv in select x.key, x.value from jsonb_each(v_val) x loop
        if v_hk !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$' or not public.admin_text_ok(v_hv, 300, true) then return v_key; end if;
      end loop;

    elsif v_key = 'timezone' then
      if jsonb_typeof(v_val) <> 'null' then
        if jsonb_typeof(v_val) <> 'string' then return v_key; end if;
        v_str := v_val #>> '{}';
        if v_str !~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'
           or not exists (select 1 from pg_catalog.pg_timezone_names z where lower(z.name) = lower(v_str) and z.name <> 'Factory') then
          return v_key;
        end if;
      end if;

    elsif v_key = 'business_hours' then
      if jsonb_typeof(v_val) <> 'null' then
        if jsonb_typeof(v_val) <> 'object' then return v_key; end if;
        select count(*) into v_n from jsonb_object_keys(v_val);
        if v_n < 1 or v_n > 7 then return v_key; end if;
        for v_hk, v_hv in select x.key, x.value from jsonb_each(v_val) x loop
          v_m := regexp_match(v_hk, '^(mon|tue|wed|thu|fri|sat|sun)(?:-(mon|tue|wed|thu|fri|sat|sun))?$');
          if v_m is null then return v_key; end if;
          if v_m[2] is not null and array_position(v_days, v_m[1]) >= array_position(v_days, v_m[2]) then return v_key; end if;
          if jsonb_typeof(v_hv) <> 'string' then return v_key; end if;
          v_m := regexp_match(v_hv #>> '{}', '^([01][0-9]|2[0-3]):([0-5][0-9])-([01][0-9]|2[0-3]):([0-5][0-9])$');
          if v_m is null or v_m[3]::integer * 60 + v_m[4]::integer <= v_m[1]::integer * 60 + v_m[2]::integer then return v_key; end if;
        end loop;
      end if;

    else
      return '_unknown_key';
    end if;
  end loop;
  return null;
end;
$$;

-- Publish rules for a bot's stored public config and its tone and scope. Returns the first failing rule (a field name or
-- 'config'), or NULL when the config could be served. Used by the enable gate and, while a bot is
-- enabled, after every settings change. Reads the stored row, so it checks the merged result.
create function public.admin_settings_gate_error(p_bot_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  c   public.public_bot_config%rowtype;
  b   public.bot_profiles%rowtype;
  v_e text;
begin
  select * into c from public.public_bot_config x where x.bot_id = p_bot_id;
  if not found then
    return 'config';
  end if;
  select * into b from public.bot_profiles x where x.id = p_bot_id;
  if not found then
    return 'config';
  end if;
  -- Every stored field must pass the same rules a patch does (a row written outside the RPCs too).
  v_e := public.admin_validate_settings_patch(jsonb_strip_nulls(jsonb_build_object(
    'display_name', c.display_name, 'greeting', c.greeting, 'suggested_questions', c.suggested_questions,
    'primary_color', c.primary_color, 'position', c.position, 'privacy_url', c.privacy_url,
    'supported_languages', to_jsonb(c.supported_languages), 'escalation_label', c.escalation_label,
    'escalation_messages', c.escalation_messages, 'contact_email', c.contact_email,
    'contact_phone', c.contact_phone, 'contact_whatsapp_url', c.contact_whatsapp_url,
    'contact_page_url', c.contact_page_url, 'business_hours', c.business_hours, 'timezone', c.timezone,
    'tone', b.tone, 'scope', b.scope)));
  if v_e is not null then
    return v_e;
  end if;
  -- The languages the answer pipeline accepts (bot_profiles) and the ones the widget shows must be the same set.
  if (select array_agg(l order by l) from unnest(b.allowed_languages) l)
     is distinct from (select array_agg(l order by l) from unnest(c.supported_languages) l) then
    return 'supported_languages';
  end if;
  if c.display_name is null then return 'display_name'; end if;
  if c.greeting is null then return 'greeting'; end if;
  if c.primary_color is null then return 'primary_color'; end if;
  if c.escalation_label is null then return 'escalation_label'; end if;
  if c.contact_email is null and c.contact_phone is null and c.contact_whatsapp_url is null and c.contact_page_url is null then
    return 'contact';
  end if;
  if c.business_hours is not null and c.timezone is null then
    return 'timezone';
  end if;
  -- An escalation message for every supported language, and none for an unsupported one (ADR 0013).
  if exists (select 1 from unnest(c.supported_languages) l where not (c.escalation_messages ? l))
     or exists (select 1 from jsonb_object_keys(c.escalation_messages) k where k <> all (c.supported_languages)) then
    return 'escalation_messages';
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_list_bots: the bots of this database (one client), for the bot picker.
-- ---------------------------------------------------------------------------
create function public.admin_list_bots()
returns table (id uuid, slug text, display_name text, enabled boolean, settings_version integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.admin_require(array['owner', 'admin', 'analyst']);
  return query
  select b.id, b.slug, c.display_name, b.enabled, b.settings_version
    from public.bot_profiles b
    left join public.public_bot_config c on c.bot_id = b.id
   order by b.slug, b.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_get_settings: what the settings page shows. Works before the bot is published (the public config
-- fields are NULL until a first update creates the row). Never returns identity_prompt, any policy other
-- than the two upload limits, or allowed_origins. A limit that is missing or not a number comes back NULL.
-- ---------------------------------------------------------------------------
create function public.admin_get_settings(p_bot_id uuid)
returns table (
  bot_id               uuid,
  slug                 text,
  enabled              boolean,
  settings_version     integer,
  tone                 text,
  scope                text,
  max_bytes            bigint,
  max_pages            bigint,
  display_name         text,
  greeting             text,
  suggested_questions  jsonb,
  primary_color        text,
  "position"           text,
  privacy_url          text,
  supported_languages  text[],
  escalation_label     text,
  escalation_messages  jsonb,
  contact_email        text,
  contact_phone        text,
  contact_whatsapp_url text,
  contact_page_url     text,
  business_hours       jsonb,
  timezone             text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.admin_require(array['owner', 'admin', 'analyst']);
  if p_bot_id is null then
    raise exception 'admin_get_settings: bot is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.bot_profiles b where b.id = p_bot_id) then
    raise exception 'admin_get_settings: bot not found' using errcode = 'RB037';
  end if;

  return query
  select b.id, b.slug, b.enabled, b.settings_version, b.tone, b.scope,
         case when jsonb_typeof(cs.upload_policy -> 'max_bytes') = 'number' and (cs.upload_policy ->> 'max_bytes') ~ '^[0-9]{1,15}$'
              then (cs.upload_policy ->> 'max_bytes')::bigint end,
         case when jsonb_typeof(cs.upload_policy -> 'max_pages') = 'number' and (cs.upload_policy ->> 'max_pages') ~ '^[0-9]{1,15}$'
              then (cs.upload_policy ->> 'max_pages')::bigint end,
         c.display_name, c.greeting, c.suggested_questions, c.primary_color, c.position, c.privacy_url,
         c.supported_languages, c.escalation_label, c.escalation_messages, c.contact_email, c.contact_phone,
         c.contact_whatsapp_url, c.contact_page_url, c.business_hours, c.timezone
    from public.bot_profiles b
    left join public.public_bot_config c on c.bot_id = b.id
    left join public.client_settings cs on cs.bot_id = b.id
   where b.id = p_bot_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_update_settings: patch the whitelisted fields. The bot row is locked, a stale version is a
-- conflict, and the merged result is checked: a bot that is enabled must keep a contact channel and an
-- escalation message for each supported language. The audit row lists field names, never values.
-- ---------------------------------------------------------------------------
create function public.admin_update_settings(p_bot_id uuid, p_expected_settings_version integer, p_patch jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_bot     public.bot_profiles%rowtype;
  v_err     text;
  v_created boolean := false;
  v_before  integer;
  v_after   integer;
  v_fields  text;
begin
  perform public.admin_require(array['owner', 'admin']);
  if p_bot_id is null or p_expected_settings_version is null then
    raise exception 'admin_update_settings: bot and expected settings version are required' using errcode = '22023';
  end if;
  v_err := public.admin_validate_settings_patch(p_patch);
  if v_err is not null then
    raise exception 'admin_update_settings: invalid setting (%)', v_err using errcode = 'RB035';
  end if;

  select * into v_bot from public.bot_profiles b where b.id = p_bot_id for update;
  if not found then
    raise exception 'admin_update_settings: bot not found' using errcode = 'RB037';
  end if;
  if v_bot.settings_version <> p_expected_settings_version then
    raise exception 'admin_update_settings: settings changed since they were read' using errcode = 'RB030';
  end if;
  v_before := v_bot.settings_version;
  perform public.admin_consume_quota(p_bot_id, 'write');

  -- A bot without a public config gets one only when this patch brings the two required fields.
  if not exists (select 1 from public.public_bot_config c where c.bot_id = p_bot_id) then
    if not (p_patch ? 'display_name' and p_patch ? 'supported_languages') then
      raise exception 'admin_update_settings: a first update needs display_name and supported_languages' using errcode = 'RB035';
    end if;
    insert into public.public_bot_config (bot_id, bot_slug, display_name, supported_languages)
    values (p_bot_id, v_bot.slug, public.admin_js_trim(p_patch ->> 'display_name'),
            (select array_agg(e.v order by e.o) from jsonb_array_elements_text(p_patch -> 'supported_languages') with ordinality e(v, o)));
    v_created := true;
  end if;

  -- Text fields are stored trimmed (as the schema does); a null clears an optional contact field.
  update public.public_bot_config c set
    display_name         = case when p_patch ? 'display_name' then public.admin_js_trim(p_patch ->> 'display_name') else c.display_name end,
    greeting             = case when p_patch ? 'greeting' then public.admin_js_trim(p_patch ->> 'greeting') else c.greeting end,
    suggested_questions  = case when p_patch ? 'suggested_questions'
                                then (select coalesce(jsonb_agg(public.admin_js_trim(e.v) order by e.o), '[]'::jsonb)
                                        from jsonb_array_elements_text(p_patch -> 'suggested_questions') with ordinality e(v, o))
                                else c.suggested_questions end,
    primary_color        = case when p_patch ? 'primary_color' then p_patch ->> 'primary_color' else c.primary_color end,
    "position"           = case when p_patch ? 'position' then p_patch ->> 'position' else c."position" end,
    privacy_url          = case when p_patch ? 'privacy_url' then regexp_replace(p_patch ->> 'privacy_url', '^[Hh][Tt][Tt][Pp][Ss]://', 'https://') else c.privacy_url end,
    supported_languages  = case when p_patch ? 'supported_languages'
                                then (select array_agg(e.v order by e.o) from jsonb_array_elements_text(p_patch -> 'supported_languages') with ordinality e(v, o))
                                else c.supported_languages end,
    escalation_label     = case when p_patch ? 'escalation_label' then public.admin_js_trim(p_patch ->> 'escalation_label') else c.escalation_label end,
    escalation_messages  = case when p_patch ? 'escalation_messages'
                                then (select jsonb_object_agg(e.key, public.admin_js_trim(e.value #>> '{}')) from jsonb_each(p_patch -> 'escalation_messages') e)
                                else c.escalation_messages end,
    contact_email        = case when p_patch ? 'contact_email' then p_patch ->> 'contact_email' else c.contact_email end,
    contact_phone        = case when p_patch ? 'contact_phone' then p_patch ->> 'contact_phone' else c.contact_phone end,
    contact_whatsapp_url = case when p_patch ? 'contact_whatsapp_url' then regexp_replace(p_patch ->> 'contact_whatsapp_url', '^[Hh][Tt][Tt][Pp][Ss]://', 'https://') else c.contact_whatsapp_url end,
    contact_page_url     = case when p_patch ? 'contact_page_url' then regexp_replace(p_patch ->> 'contact_page_url', '^[Hh][Tt][Tt][Pp][Ss]://', 'https://') else c.contact_page_url end,
    business_hours       = case when p_patch ? 'business_hours' then nullif(p_patch -> 'business_hours', 'null'::jsonb) else c.business_hours end,
    timezone             = case when p_patch ? 'timezone' then p_patch ->> 'timezone' else c.timezone end
   where c.bot_id = p_bot_id;

  -- One update of bot_profiles, so the version moves once for this table. allowed_languages follows
  -- supported_languages (the same list, in the same order): the pipeline and the widget never disagree.
  if p_patch ? 'tone' or p_patch ? 'scope' or p_patch ? 'supported_languages' then
    update public.bot_profiles b set
      tone  = case when p_patch ? 'tone' then public.admin_js_trim(p_patch ->> 'tone') else b.tone end,
      scope = case when p_patch ? 'scope' then public.admin_js_trim(p_patch ->> 'scope') else b.scope end,
      allowed_languages = case when p_patch ? 'supported_languages'
                               then (select array_agg(e.v order by e.o) from jsonb_array_elements_text(p_patch -> 'supported_languages') with ordinality e(v, o))
                               else b.allowed_languages end
     where b.id = p_bot_id;
  end if;

  -- The merged result of an enabled bot must still be servable. Raising rolls everything back.
  if v_bot.enabled then
    v_err := public.admin_settings_gate_error(p_bot_id);
    if v_err is not null then
      raise exception 'admin_update_settings: the change would leave the published settings invalid (%)', v_err
        using errcode = 'RB035';
    end if;
  end if;

  select b.settings_version into v_after from public.bot_profiles b where b.id = p_bot_id;
  if v_created and v_after = v_before then
    -- The first config row is a change even when nothing else moved the version.
    update public.bot_profiles b set settings_version = b.settings_version + 1 where b.id = p_bot_id
    returning b.settings_version into v_after;
  end if;

  select string_agg(k, ',' order by k) into v_fields from jsonb_object_keys(p_patch) k;
  perform public.admin_audit('settings.update', 'bot', p_bot_id,
    jsonb_build_object('bot_id', p_bot_id, 'changed_fields', v_fields,
                       'expected_settings_version', p_expected_settings_version, 'settings_version', v_after));
  return v_after;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_set_bot_enabled: enabling needs a config that passes every publish rule. Disabling is always
-- allowed (even for a bot with no config). Stale version: conflict.
-- ---------------------------------------------------------------------------
create function public.admin_set_bot_enabled(p_bot_id uuid, p_expected_settings_version integer, p_enabled boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_bot   public.bot_profiles%rowtype;
  v_err   text;
  v_after integer;
begin
  perform public.admin_require(array['owner', 'admin']);
  if p_bot_id is null or p_expected_settings_version is null or p_enabled is null then
    raise exception 'admin_set_bot_enabled: bot, expected settings version and the new state are required' using errcode = '22023';
  end if;

  select * into v_bot from public.bot_profiles b where b.id = p_bot_id for update;
  if not found then
    raise exception 'admin_set_bot_enabled: bot not found' using errcode = 'RB037';
  end if;
  if v_bot.settings_version <> p_expected_settings_version then
    raise exception 'admin_set_bot_enabled: settings changed since they were read' using errcode = 'RB030';
  end if;
  -- Disabling is the emergency stop, so it never waits on the write quota.
  if p_enabled then
    perform public.admin_consume_quota(p_bot_id, 'write');
    v_err := public.admin_settings_gate_error(p_bot_id);
    if v_err is not null then
      raise exception 'admin_set_bot_enabled: the settings are not ready to publish (%)', v_err using errcode = 'RB035';
    end if;
  end if;

  update public.bot_profiles b set enabled = p_enabled where b.id = p_bot_id
  returning b.settings_version into v_after;

  perform public.admin_audit(case when p_enabled then 'bot.enable' else 'bot.disable' end, 'bot', p_bot_id,
    jsonb_build_object('bot_id', p_bot_id, 'enabled', p_enabled,
                       'expected_settings_version', p_expected_settings_version, 'settings_version', v_after));
  return v_after;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_delete_conversation: the conversation, its messages, their sources, its analysis and its data
-- entries (all ON DELETE CASCADE, ADR 0016). The audit row holds ids only.
-- ---------------------------------------------------------------------------
create function public.admin_delete_conversation(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bot uuid;
begin
  perform public.admin_require(array['owner', 'admin']);
  if p_conversation_id is null then
    raise exception 'admin_delete_conversation: conversation is required' using errcode = '22023';
  end if;

  select c.bot_id into v_bot from public.conversations c where c.id = p_conversation_id for update;
  if not found then
    raise exception 'admin_delete_conversation: conversation not found' using errcode = 'RB037';
  end if;

  perform public.admin_consume_quota(v_bot, 'write');

  delete from public.conversations where id = p_conversation_id;
  -- A queued analysis of this conversation has nothing left to read (a running one is left to the worker).
  update public.jobs set state = 'cancelled', completed_at = now()
   where type = 'analyze_conversation' and state = 'queued' and payload ->> 'conversation_id' = p_conversation_id::text;

  perform public.admin_audit('conversation.delete', 'conversation', p_conversation_id,
    jsonb_build_object('bot_id', v_bot, 'conversation_id', p_conversation_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_list_members: who has access, for the access page. The label is the sign-in email (B-7).
-- Owners and admins only; analysts cannot see other people's emails.
-- ---------------------------------------------------------------------------
create function public.admin_list_members()
returns table (user_id uuid, role text, active boolean, label text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.admin_require(array['owner', 'admin']);
  return query
  select m.user_id, m.role, m.active, u.email::text
    from public.admin_memberships m
    left join auth.users u on u.id = m.user_id
   order by m.created_at, m.user_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- schema_version: the number of migrations this database has applied. Any signed-in user may ask; it
-- exposes nothing else (SECURITY INVOKER: it reads no table). Raise it with every new migration (a test compares it with the migration history).
-- ---------------------------------------------------------------------------
create function public.schema_version()
returns integer
language sql
stable
set search_path = ''
as $$
  select 10;
$$;

-- ---------------------------------------------------------------------------
-- admin_document_status: paged. Both limit (1..500) and offset (>= 0) are required.
-- ---------------------------------------------------------------------------
drop function public.admin_document_status(uuid);
create function public.admin_document_status(p_bot_id uuid, p_limit integer, p_offset integer)
returns table (
  document_id           uuid,
  title                 text,
  status                text,
  active_version_id     uuid,
  latest_version_id     uuid,
  latest_version_number integer,
  latest_version_status text,
  batches_done          integer,
  batches_total         integer,
  failure_code          text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.admin_require(array['owner', 'admin', 'analyst']);
  if p_bot_id is null then
    raise exception 'admin_document_status: bot is required' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 or p_offset is null or p_offset < 0 then
    raise exception 'admin_document_status: limit must be 1..500 and offset 0 or more' using errcode = '22023';
  end if;
  if not exists (select 1 from public.bot_profiles b where b.id = p_bot_id) then
    raise exception 'admin_document_status: bot not found' using errcode = 'RB037';
  end if;

  return query
  select d.id, d.title, d.status, d.active_version_id,
         lv.id, lv.version_number, lv.status, lv.batches_done, lv.batches_total, lv.failure_code
    from public.documents d
    left join lateral (
      select x.id, x.version_number, x.status, x.batches_done, x.batches_total, x.failure_code
        from public.document_versions x
       where x.document_id = d.id
       order by x.version_number desc
       limit 1
    ) lv on true
   where d.bot_id = p_bot_id and d.deleted_at is null
   order by d.created_at desc, d.id
   limit p_limit offset p_offset;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_retry_version: as in 009, plus (1) a version older than the live one can't be retried (RB030), because
-- activation would refuse it anyway, and (2) a version stuck in uploaded, extracting or embedding with no live
-- job can be retried, so a dead-lettered version can be recovered. The checks come before the quota.
-- ---------------------------------------------------------------------------
create or replace function public.admin_retry_version(p_version_id uuid)
returns table (version_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_doc_id   uuid;
  v_doc      public.documents%rowtype;
  v_ver      public.document_versions%rowtype;
  v_act_num  integer;
  v_attempts bigint;
  v_rows     integer;
begin
  perform public.admin_require(array['owner', 'admin']);
  if p_version_id is null then
    raise exception 'admin_retry_version: version is required' using errcode = '22023';
  end if;

  select v.document_id into v_doc_id from public.document_versions v where v.id = p_version_id;
  if not found then
    raise exception 'admin_retry_version: version not found' using errcode = 'RB037';
  end if;
  select * into v_doc from public.documents d where d.id = v_doc_id for update;
  if not found or v_doc.deleted_at is not null then
    raise exception 'admin_retry_version: version not found' using errcode = 'RB037';
  end if;
  select * into v_ver from public.document_versions v where v.id = p_version_id for update;
  -- A failed version can be retried. So can one that is stuck in uploaded, extracting or embedding with
  -- no live job (its job was dead-lettered). Anything else, or a live job, is a conflict.
  if v_ver.status not in ('failed', 'uploaded', 'extracting', 'embedding') then
    raise exception 'admin_retry_version: this version cannot be retried' using errcode = 'RB030';
  end if;
  if exists (select 1 from public.jobs j
              where j.dedupe_key = 'index:version:' || p_version_id::text and j.state in ('queued', 'running')) then
    raise exception 'admin_retry_version: indexing of this version is still in progress' using errcode = 'RB030';
  end if;
  if v_doc.active_version_id is not null then
    select x.version_number into v_act_num from public.document_versions x where x.id = v_doc.active_version_id;
    if v_ver.version_number < v_act_num then
      raise exception 'admin_retry_version: a version older than the live one cannot be retried' using errcode = 'RB030';
    end if;
  end if;

  v_attempts := public.admin_policy_int(v_doc.bot_id, 'index_max_attempts', 1, 20);
  perform public.admin_consume_quota(v_doc.bot_id, 'reindex');

  update public.document_versions
     set status = 'uploaded', failure_code = null, batches_done = null, batches_total = null, completed_at = null
   where id = p_version_id;
  update public.documents set status = 'indexing'
   where id = v_doc.id and status in ('draft', 'failed') and active_version_id is null;

  insert into public.jobs (type, dedupe_key, payload, max_attempts)
  values ('index_document', 'index:version:' || p_version_id::text,
          jsonb_build_object('bot_id', v_doc.bot_id, 'document_id', v_doc.id, 'version_id', p_version_id),
          v_attempts::integer)
  on conflict (dedupe_key) where state in ('queued', 'running') do nothing;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'admin_retry_version: indexing of this version is still in progress' using errcode = 'RB030';
  end if;

  perform public.admin_audit('document.retry_version', 'document_version', p_version_id,
    jsonb_build_object('bot_id', v_doc.bot_id, 'document_id', v_doc.id, 'version_id', p_version_id,
                       'version_number', v_ver.version_number));
  return query select p_version_id, 'uploaded'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- EXECUTE. Helpers: nobody (the SECURITY DEFINER owner runs them). Browser RPCs: authenticated only.
-- service_role is revoked explicitly: a default ACL may grant it.
-- ---------------------------------------------------------------------------
revoke all on function public.admin_js_trim(text) from public, anon, authenticated, service_role;
revoke all on function public.admin_utf16_length(text) from public, anon, authenticated, service_role;
revoke all on function public.admin_text_ok(jsonb, integer, boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_url_ok(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.admin_validate_settings_patch(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.admin_settings_gate_error(uuid) from public, anon, authenticated, service_role;

revoke all on function public.admin_list_bots() from public, anon, authenticated, service_role;
revoke all on function public.admin_get_settings(uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_update_settings(uuid, integer, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.admin_set_bot_enabled(uuid, integer, boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_delete_conversation(uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_list_members() from public, anon, authenticated, service_role;
revoke all on function public.schema_version() from public, anon, authenticated, service_role;
revoke all on function public.admin_document_status(uuid, integer, integer) from public, anon, authenticated, service_role;

grant execute on function public.admin_list_bots() to authenticated;
grant execute on function public.admin_get_settings(uuid) to authenticated;
grant execute on function public.admin_update_settings(uuid, integer, jsonb) to authenticated;
grant execute on function public.admin_set_bot_enabled(uuid, integer, boolean) to authenticated;
grant execute on function public.admin_delete_conversation(uuid) to authenticated;
grant execute on function public.admin_list_members() to authenticated;
grant execute on function public.schema_version() to authenticated;
grant execute on function public.admin_document_status(uuid, integer, integer) to authenticated;
