


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."activate_document_version"("p_document_id" "uuid", "p_version_id" "uuid", "p_expected_chunks" integer) RETURNS bigint
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  v_doc     public.documents%rowtype;
  v_ver     public.document_versions%rowtype;
  v_act_num integer;
  v_chunks  integer;
  v_corpus  bigint;
  v_model   text;
begin
  if p_document_id is null or p_version_id is null or p_expected_chunks is null or p_expected_chunks < 1 then
    raise exception 'activate_document_version: document, version and a positive expected chunk count are required'
      using errcode = '22023';
  end if;

  select * into v_doc from public.documents where id = p_document_id for update;
  if not found or v_doc.deleted_at is not null then
    raise exception 'activate_document_version: document not found or deleted' using errcode = 'RB010';
  end if;

  select * into v_ver from public.document_versions
   where id = p_version_id and document_id = p_document_id for update;
  if not found then
    raise exception 'activate_document_version: version does not belong to document' using errcode = 'RB010';
  end if;

  if v_doc.active_version_id = p_version_id then
    select b.corpus_version into v_corpus from public.bot_profiles b where b.id = v_doc.bot_id;
    return v_corpus;
  end if;

  if v_doc.active_version_id is not null then
    select x.version_number into v_act_num from public.document_versions x where x.id = v_doc.active_version_id;
    if v_ver.version_number < v_act_num then
      raise exception 'activate_document_version: an older version cannot replace a newer active version'
        using errcode = 'RB011';
    end if;
  end if;

  if v_ver.status <> 'embedding' then
    raise exception 'activate_document_version: version status must be embedding' using errcode = 'RB011';
  end if;

  -- The version must have been embedded with the bot's current embedding model (never mix models).
  select b.embedding_model into v_model from public.bot_profiles b where b.id = v_doc.bot_id;
  if v_ver.embedding_model is null or v_model is null or v_ver.embedding_model <> v_model then
    raise exception 'activate_document_version: version embedding model does not match the bot embedding model'
      using errcode = 'RB011';
  end if;

  select count(*) into v_chunks from public.document_chunks where document_version_id = p_version_id;
  if v_chunks <> p_expected_chunks then
    raise exception 'activate_document_version: chunk count mismatch (expected %, found %)', p_expected_chunks, v_chunks
      using errcode = 'RB011';
  end if;
  -- Contiguous chunk indexes 0..n-1: no gaps.
  if exists (
    select 1 from public.document_chunks
     where document_version_id = p_version_id
    having min(chunk_index) <> 0 or max(chunk_index) <> v_chunks - 1
  ) then
    raise exception 'activate_document_version: chunk indexes are not contiguous' using errcode = 'RB011';
  end if;

  if v_doc.active_version_id is not null then
    update public.document_versions set status = 'superseded'
     where id = v_doc.active_version_id and status = 'ready';
  end if;

  update public.document_versions set status = 'ready', completed_at = now() where id = p_version_id;
  update public.documents set active_version_id = p_version_id, status = 'ready' where id = p_document_id;

  update public.bot_profiles set corpus_version = corpus_version + 1
   where id = v_doc.bot_id
  returning corpus_version into v_corpus;

  return v_corpus;
end;
$$;


ALTER FUNCTION "public"."activate_document_version"("p_document_id" "uuid", "p_version_id" "uuid", "p_expected_chunks" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."activate_version_for_job"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_expected_chunks" integer) RETURNS bigint
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
#variable_conflict use_column
declare
  v_doc    uuid;
  v_corpus bigint;
begin
  select f.document_id into v_doc from public.index_job_fence(p_job_id, p_worker, p_version_id) f;
  if p_expected_chunks is null or p_expected_chunks < 1 then
    raise exception 'activate_version_for_job: a positive expected chunk count is required' using errcode = '22023';
  end if;
  v_corpus := public.activate_document_version(v_doc, p_version_id, p_expected_chunks);
  return v_corpus;
end;
$$;


ALTER FUNCTION "public"."activate_version_for_job"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_expected_chunks" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_add_document_version"("p_document_id" "uuid", "p_media_type" "text", "p_byte_size" bigint) RETURNS TABLE("version_id" "uuid", "version_number" integer, "storage_path" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
#variable_conflict use_column
declare
  v_doc  public.documents%rowtype;
  v_max  bigint;
  v_ver  uuid := gen_random_uuid();
  v_num  integer;
  v_path text;
begin
  perform public.admin_require(array['owner', 'admin']);

  if p_document_id is null or p_media_type is null or p_byte_size is null then
    raise exception 'admin_add_document_version: all arguments are required' using errcode = '22023';
  end if;
  if p_media_type not in ('application/pdf', 'text/markdown', 'text/plain') then
    raise exception 'admin_add_document_version: unsupported media type' using errcode = '22023';
  end if;
  if p_byte_size < 1 then
    raise exception 'admin_add_document_version: byte size must be positive' using errcode = '22023';
  end if;

  select * into v_doc from public.documents d where d.id = p_document_id for update;
  if not found or v_doc.deleted_at is not null then
    raise exception 'admin_add_document_version: document not found' using errcode = 'RB037';
  end if;

  v_max := public.admin_policy_int(v_doc.bot_id, 'max_bytes', 1, 1099511627776);
  if p_byte_size > v_max then
    raise exception 'admin_add_document_version: file is larger than the upload limit' using errcode = 'RB031';
  end if;
  perform public.admin_consume_quota(v_doc.bot_id, 'register');

  select coalesce(max(x.version_number), 0) + 1 into v_num
    from public.document_versions x where x.document_id = p_document_id;
  v_path := v_doc.bot_id::text || '/' || p_document_id::text || '/' || v_ver::text || '/original.'
    || case p_media_type when 'application/pdf' then 'pdf' when 'text/markdown' then 'md' else 'txt' end;

  insert into public.document_versions (id, document_id, version_number, storage_path, media_type, byte_size)
  values (v_ver, p_document_id, v_num, v_path, p_media_type, p_byte_size);

  perform public.admin_audit('document.add_version', 'document_version', v_ver,
    jsonb_build_object('bot_id', v_doc.bot_id, 'document_id', p_document_id, 'version_id', v_ver,
                       'version_number', v_num, 'media_type', p_media_type, 'byte_size', p_byte_size));
  return query select v_ver, v_num, v_path;
end;
$$;


ALTER FUNCTION "public"."admin_add_document_version"("p_document_id" "uuid", "p_media_type" "text", "p_byte_size" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_audit"("p_action" "text", "p_resource_type" "text", "p_resource_id" "uuid", "p_metadata" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $_$
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
$_$;


ALTER FUNCTION "public"."admin_audit"("p_action" "text", "p_resource_type" "text", "p_resource_id" "uuid", "p_metadata" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_complete_upload"("p_version_id" "uuid") RETURNS TABLE("version_id" "uuid", "status" "text", "job_queued" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
#variable_conflict use_column
declare
  v_doc_id   uuid;
  v_doc      public.documents%rowtype;
  v_ver      public.document_versions%rowtype;
  v_attempts bigint;
  v_max      bigint;
  v_meta     jsonb;
  v_size_txt text;
  v_size     bigint;
  v_rows     integer;
begin
  perform public.admin_require(array['owner', 'admin']);
  if p_version_id is null then
    raise exception 'admin_complete_upload: version is required' using errcode = '22023';
  end if;

  select v.document_id into v_doc_id from public.document_versions v where v.id = p_version_id;
  if not found then
    raise exception 'admin_complete_upload: version not found' using errcode = 'RB037';
  end if;
  select * into v_doc from public.documents d where d.id = v_doc_id for update;
  if not found or v_doc.deleted_at is not null then
    raise exception 'admin_complete_upload: version not found' using errcode = 'RB037';
  end if;
  select * into v_ver from public.document_versions v where v.id = p_version_id for update;

  if v_ver.status <> 'pending_upload' then
    return query select v_ver.id, v_ver.status, false;
    return;
  end if;

  v_attempts := public.admin_policy_int(v_doc.bot_id, 'index_max_attempts', 1, 20);
  v_max := public.admin_policy_int(v_doc.bot_id, 'max_bytes', 1, 1099511627776);

  select o.metadata into v_meta from storage.objects o
   where o.bucket_id = 'knowledge' and o.name = v_ver.storage_path;
  if not found then
    raise exception 'admin_complete_upload: the file has not been uploaded' using errcode = 'RB038';
  end if;
  v_size_txt := v_meta ->> 'size';
  if v_size_txt is null or v_size_txt !~ '^[0-9]{1,15}$' then
    raise exception 'admin_complete_upload: the uploaded file size is unknown' using errcode = 'RB038';
  end if;
  v_size := v_size_txt::bigint;
  if v_size > v_max then
    raise exception 'admin_complete_upload: file is larger than the upload limit' using errcode = 'RB031';
  end if;
  if v_ver.byte_size is null or v_size <> v_ver.byte_size then
    raise exception 'admin_complete_upload: file size differs from the registered size' using errcode = 'RB030';
  end if;
  -- The object's content type (parameters such as "; charset=" ignored) must be the registered media type.
  -- A missing content type is a mismatch (fail closed).
  if lower(btrim(split_part(coalesce(v_meta ->> 'mimetype', ''), ';', 1))) <> v_ver.media_type then
    raise exception 'admin_complete_upload: file type differs from the registered media type' using errcode = 'RB030';
  end if;

  perform public.admin_consume_quota(v_doc.bot_id, 'upload');

  update public.document_versions set status = 'uploaded', upload_etag = v_meta ->> 'eTag' where id = p_version_id;
  -- A draft (or failed, never live) document starts indexing; a ready document keeps serving its live version.
  update public.documents set status = 'indexing'
   where id = v_doc.id and status in ('draft', 'failed') and active_version_id is null;

  insert into public.jobs (type, dedupe_key, payload, max_attempts)
  values ('index_document', 'index:version:' || p_version_id::text,
          jsonb_build_object('bot_id', v_doc.bot_id, 'document_id', v_doc.id, 'version_id', p_version_id),
          v_attempts::integer)
  on conflict (dedupe_key) where state in ('queued', 'running') do nothing;
  get diagnostics v_rows = row_count;

  perform public.admin_audit('document.complete_upload', 'document_version', p_version_id,
    jsonb_build_object('bot_id', v_doc.bot_id, 'document_id', v_doc.id, 'version_id', p_version_id,
                       'byte_size', v_size));
  return query select p_version_id, 'uploaded'::text, v_rows = 1;
end;
$_$;


ALTER FUNCTION "public"."admin_complete_upload"("p_version_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_consume_quota"("p_bot_id" "uuid", "p_kind" "text") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $_$
declare
  v_q   jsonb;
  v_lim text;
  v_win text;
  v_key text;
  v_ok  boolean;
begin
  if p_bot_id is null or p_kind is null or p_kind not in ('register', 'upload', 'reindex', 'write') then
    raise exception 'admin_consume_quota: bot and a known quota kind are required' using errcode = '22023';
  end if;
  select cs.upload_policy -> 'quotas' -> p_kind into v_q from public.client_settings cs where cs.bot_id = p_bot_id;
  if not found or v_q is null or jsonb_typeof(v_q) <> 'object' then
    raise exception 'quota % is missing', p_kind using errcode = 'RB036';
  end if;
  v_lim := case when jsonb_typeof(v_q -> 'limit') = 'number' then v_q ->> 'limit' end;
  v_win := case when jsonb_typeof(v_q -> 'window_seconds') = 'number' then v_q ->> 'window_seconds' end;
  if v_lim is null or v_lim !~ '^[1-9][0-9]{0,5}$' or v_win is null or v_win !~ '^[1-9][0-9]{0,4}$'
     or v_win::integer > 86400 then
    raise exception 'quota % is invalid', p_kind using errcode = 'RB036';
  end if;
  v_key := encode(sha256(convert_to('admin_quota:' || p_bot_id::text || ':' || p_kind, 'utf8')), 'hex');
  select r.allowed into v_ok from public.record_rate_limit_attempt(v_key, v_win::integer, v_lim::integer) r;
  if not coalesce(v_ok, false) then
    raise exception 'quota % exceeded', p_kind using errcode = 'RB034';
  end if;
end;
$_$;


ALTER FUNCTION "public"."admin_consume_quota"("p_bot_id" "uuid", "p_kind" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_delete_conversation"("p_conversation_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."admin_delete_conversation"("p_conversation_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_delete_document"("p_document_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_doc      public.documents%rowtype;
  v_attempts bigint;
begin
  perform public.admin_require(array['owner', 'admin']);
  if p_document_id is null then
    raise exception 'admin_delete_document: document is required' using errcode = '22023';
  end if;

  select * into v_doc from public.documents d where d.id = p_document_id for update;
  if not found then
    raise exception 'admin_delete_document: document not found' using errcode = 'RB037';
  end if;

  if v_doc.deleted_at is not null then
    return;
  end if;

  v_attempts := public.admin_policy_int(v_doc.bot_id, 'cleanup_max_attempts', 1, 20);
  perform public.admin_consume_quota(v_doc.bot_id, 'write');
  perform public.mark_document_deleted(p_document_id, v_attempts::integer);
  update public.jobs set state = 'cancelled', completed_at = now()
   where type = 'index_document' and state = 'queued' and payload ->> 'document_id' = p_document_id::text;

  perform public.admin_audit('document.delete', 'document', p_document_id,
    jsonb_build_object('bot_id', v_doc.bot_id, 'document_id', p_document_id));
end;
$$;


ALTER FUNCTION "public"."admin_delete_document"("p_document_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_document_status"("p_bot_id" "uuid", "p_limit" integer, "p_offset" integer) RETURNS TABLE("document_id" "uuid", "title" "text", "status" "text", "active_version_id" "uuid", "latest_version_id" "uuid", "latest_version_number" integer, "latest_version_status" "text", "batches_done" integer, "batches_total" integer, "failure_code" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."admin_document_status"("p_bot_id" "uuid", "p_limit" integer, "p_offset" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_get_settings"("p_bot_id" "uuid") RETURNS TABLE("bot_id" "uuid", "slug" "text", "enabled" boolean, "settings_version" integer, "tone" "text", "scope" "text", "max_bytes" bigint, "max_pages" bigint, "display_name" "text", "greeting" "text", "suggested_questions" "jsonb", "primary_color" "text", "position" "text", "privacy_url" "text", "supported_languages" "text"[], "escalation_label" "text", "escalation_messages" "jsonb", "contact_email" "text", "contact_phone" "text", "contact_whatsapp_url" "text", "contact_page_url" "text", "business_hours" "jsonb", "timezone" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
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
$_$;


ALTER FUNCTION "public"."admin_get_settings"("p_bot_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_js_trim"("p_text" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $_$
  select regexp_replace(
           regexp_replace(p_text, '^[\u0009-\u000d    -     　﻿]+', ''),
           '[\u0009-\u000d    -     　﻿]+$', '');
$_$;


ALTER FUNCTION "public"."admin_js_trim"("p_text" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_list_bots"() RETURNS TABLE("id" "uuid", "slug" "text", "display_name" "text", "enabled" boolean, "settings_version" integer)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."admin_list_bots"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_list_members"() RETURNS TABLE("user_id" "uuid", "role" "text", "active" boolean, "label" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."admin_list_members"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_policy_int"("p_bot_id" "uuid", "p_key" "text", "p_min" bigint, "p_max" bigint) RETURNS bigint
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $_$
declare
  v_val jsonb;
  v_n   bigint;
begin
  select cs.upload_policy -> p_key into v_val from public.client_settings cs where cs.bot_id = p_bot_id;
  if not found or v_val is null or jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}') !~ '^[0-9]{1,15}$' then
    raise exception 'upload policy % is missing or invalid', p_key using errcode = 'RB036';
  end if;
  v_n := (v_val #>> '{}')::bigint;
  if v_n < p_min or v_n > p_max then
    raise exception 'upload policy % is out of range', p_key using errcode = 'RB036';
  end if;
  return v_n;
end;
$_$;


ALTER FUNCTION "public"."admin_policy_int"("p_bot_id" "uuid", "p_key" "text", "p_min" bigint, "p_max" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_register_document"("p_bot_id" "uuid", "p_title" "text", "p_media_type" "text", "p_byte_size" bigint, "p_disclosure_policy" "text") RETURNS TABLE("document_id" "uuid", "version_id" "uuid", "storage_path" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
#variable_conflict use_column
declare
  v_title text;
  v_max   bigint;
  v_doc   uuid := gen_random_uuid();
  v_ver   uuid := gen_random_uuid();
  v_path  text;
begin
  perform public.admin_require(array['owner', 'admin']);

  if p_bot_id is null or p_title is null or p_media_type is null or p_byte_size is null
     or p_disclosure_policy is null then
    raise exception 'admin_register_document: all arguments are required' using errcode = '22023';
  end if;
  v_title := btrim(p_title);
  if char_length(v_title) not between 1 and 200 or p_title ~ '[[:cntrl:]]' then
    raise exception 'admin_register_document: title must be 1..200 characters without control characters'
      using errcode = '22023';
  end if;
  if p_media_type not in ('application/pdf', 'text/markdown', 'text/plain') then
    raise exception 'admin_register_document: unsupported media type' using errcode = '22023';
  end if;
  if p_byte_size < 1 then
    raise exception 'admin_register_document: byte size must be positive' using errcode = '22023';
  end if;
  if p_disclosure_policy not in ('public_answer', 'excluded') then
    raise exception 'admin_register_document: invalid disclosure policy' using errcode = '22023';
  end if;

  if not exists (select 1 from public.bot_profiles b where b.id = p_bot_id) then
    raise exception 'admin_register_document: bot not found' using errcode = 'RB037';
  end if;
  v_max := public.admin_policy_int(p_bot_id, 'max_bytes', 1, 1099511627776);
  if p_byte_size > v_max then
    raise exception 'admin_register_document: file is larger than the upload limit' using errcode = 'RB031';
  end if;
  perform public.admin_consume_quota(p_bot_id, 'register');

  v_path := p_bot_id::text || '/' || v_doc::text || '/' || v_ver::text || '/original.'
    || case p_media_type when 'application/pdf' then 'pdf' when 'text/markdown' then 'md' else 'txt' end;

  insert into public.documents (id, bot_id, title, disclosure_policy, created_by)
  values (v_doc, p_bot_id, v_title, p_disclosure_policy, auth.uid());
  insert into public.document_versions (id, document_id, version_number, storage_path, media_type, byte_size)
  values (v_ver, v_doc, 1, v_path, p_media_type, p_byte_size);

  perform public.admin_audit('document.register', 'document', v_doc,
    jsonb_build_object('bot_id', p_bot_id, 'document_id', v_doc, 'version_id', v_ver,
                       'media_type', p_media_type, 'byte_size', p_byte_size));
  return query select v_doc, v_ver, v_path;
end;
$$;


ALTER FUNCTION "public"."admin_register_document"("p_bot_id" "uuid", "p_title" "text", "p_media_type" "text", "p_byte_size" bigint, "p_disclosure_policy" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_reindex_document"("p_document_id" "uuid") RETURNS TABLE("version_id" "uuid", "version_number" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
#variable_conflict use_column
declare
  v_doc      public.documents%rowtype;
  v_act      public.document_versions%rowtype;
  v_attempts bigint;
  v_ver      uuid := gen_random_uuid();
  v_num      integer;
begin
  perform public.admin_require(array['owner', 'admin']);
  if p_document_id is null then
    raise exception 'admin_reindex_document: document is required' using errcode = '22023';
  end if;

  select * into v_doc from public.documents d where d.id = p_document_id for update;
  if not found or v_doc.deleted_at is not null then
    raise exception 'admin_reindex_document: document not found' using errcode = 'RB037';
  end if;
  if v_doc.active_version_id is null then
    raise exception 'admin_reindex_document: the document has no active version' using errcode = 'RB030';
  end if;
  select * into v_act from public.document_versions x where x.id = v_doc.active_version_id;

  v_attempts := public.admin_policy_int(v_doc.bot_id, 'index_max_attempts', 1, 20);
  perform public.admin_consume_quota(v_doc.bot_id, 'reindex');

  select max(x.version_number) + 1 into v_num from public.document_versions x where x.document_id = p_document_id;
  insert into public.document_versions (id, document_id, version_number, storage_path, media_type, byte_size, status, upload_etag, checksum)
  values (v_ver, p_document_id, v_num, v_act.storage_path, v_act.media_type, v_act.byte_size, 'uploaded', v_act.upload_etag, v_act.checksum);

  insert into public.jobs (type, dedupe_key, payload, max_attempts)
  values ('index_document', 'index:version:' || v_ver::text,
          jsonb_build_object('bot_id', v_doc.bot_id, 'document_id', p_document_id, 'version_id', v_ver),
          v_attempts::integer);

  perform public.admin_audit('document.reindex', 'document_version', v_ver,
    jsonb_build_object('bot_id', v_doc.bot_id, 'document_id', p_document_id, 'version_id', v_ver,
                       'version_number', v_num));
  return query select v_ver, v_num;
end;
$$;


ALTER FUNCTION "public"."admin_reindex_document"("p_document_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_request_download"("p_version_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_ver public.document_versions%rowtype;
  v_doc public.documents%rowtype;
begin
  perform public.admin_require(array['owner', 'admin']);
  if p_version_id is null then
    raise exception 'admin_request_download: version is required' using errcode = '22023';
  end if;

  select * into v_ver from public.document_versions v where v.id = p_version_id;
  if not found then
    raise exception 'admin_request_download: version not found' using errcode = 'RB037';
  end if;
  select * into v_doc from public.documents d where d.id = v_ver.document_id;
  if not found or v_doc.deleted_at is not null then
    raise exception 'admin_request_download: version not found' using errcode = 'RB037';
  end if;
  perform public.admin_consume_quota(v_doc.bot_id, 'write');

  perform public.admin_audit('document.download', 'document_version', p_version_id,
    jsonb_build_object('bot_id', v_doc.bot_id, 'document_id', v_doc.id, 'version_id', p_version_id));
  return v_ver.storage_path;
end;
$$;


ALTER FUNCTION "public"."admin_request_download"("p_version_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_require"("p_roles" "text"[]) RETURNS "void"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $$
begin
  if not public.is_active_member(p_roles) then
    raise exception 'not authorized' using errcode = 'RB033';
  end if;
  if not public.is_active_member_mfa(p_roles) then
    raise exception 'multi-factor session required' using errcode = 'RB032';
  end if;
end;
$$;


ALTER FUNCTION "public"."admin_require"("p_roles" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_retry_version"("p_version_id" "uuid") RETURNS TABLE("version_id" "uuid", "status" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."admin_retry_version"("p_version_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_set_bot_enabled"("p_bot_id" "uuid", "p_expected_settings_version" integer, "p_enabled" boolean) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."admin_set_bot_enabled"("p_bot_id" "uuid", "p_expected_settings_version" integer, "p_enabled" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_settings_gate_error"("p_bot_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."admin_settings_gate_error"("p_bot_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_text_ok"("p_val" "jsonb", "p_max" integer, "p_plain" boolean) RETURNS boolean
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."admin_text_ok"("p_val" "jsonb", "p_max" integer, "p_plain" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_update_settings"("p_bot_id" "uuid", "p_expected_settings_version" integer, "p_patch" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."admin_update_settings"("p_bot_id" "uuid", "p_expected_settings_version" integer, "p_patch" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_url_ok"("p_val" "jsonb") RETURNS boolean
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO ''
    AS $_$
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
$_$;


ALTER FUNCTION "public"."admin_url_ok"("p_val" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_utf16_length"("p_text" "text") RETURNS integer
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
  select char_length(regexp_replace(p_text, '[\U00010000-\U0010FFFF]', '__', 'g'));
$$;


ALTER FUNCTION "public"."admin_utf16_length"("p_text" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_validate_settings_patch"("p_patch" "jsonb") RETURNS "text"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $_$
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
$_$;


ALTER FUNCTION "public"."admin_validate_settings_patch"("p_patch" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."analysis_job_fence"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) RETURNS TABLE("bot_id" "uuid", "conversation_id" "uuid")
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
declare v_job public.jobs%rowtype;
begin
  select * into v_job from public.jobs j where j.id = p_job_id for share;
  if not found or p_worker is null or btrim(p_worker) = '' or p_generation is null or p_generation < 1
     or v_job.type <> 'analyze_conversation' or v_job.state <> 'running'
     or v_job.locked_by is distinct from p_worker or v_job.analysis_generation <> p_generation
     or v_job.locked_until is null or v_job.locked_until <= clock_timestamp() then
    raise exception 'analysis job: lease not held' using errcode = 'RB013';
  end if;
  return query select c.bot_id, c.id from public.conversations c
    where c.id::text = v_job.payload ->> 'conversation_id'
      and c.bot_id::text = v_job.payload ->> 'bot_id' for share of c;
  if not found then
    raise exception 'analysis job: conversation not found' using errcode = 'RB037';
  end if;
end;
$$;


ALTER FUNCTION "public"."analysis_job_fence"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."audit_logs_append_only"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if tg_op = 'UPDATE'
     and old.actor_user_id is not null
     and new.actor_user_id is null
     and (new.id, new.action, new.resource_type, new.resource_id, new.request_id, new.safe_metadata, new.created_at)
         is not distinct from
         (old.id, old.action, old.resource_type, old.resource_id, old.request_id, old.safe_metadata, old.created_at) then
    return new;
  end if;
  raise exception 'audit_logs is append-only' using errcode = '42501';
end;
$$;


ALTER FUNCTION "public"."audit_logs_append_only"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."audit_logs_no_truncate"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  raise exception 'audit_logs is append-only' using errcode = '42501';
end;
$$;


ALTER FUNCTION "public"."audit_logs_no_truncate"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."audit_logs_no_truncate"() IS 'Trigger function: stops TRUNCATE of audit_logs by any role. A table owner can still drop or disable the trigger, so this is not protection against the owner.';



CREATE OR REPLACE FUNCTION "public"."begin_request_run"("p_bot_id" "uuid", "p_visitor_session_id" "uuid", "p_token_version" integer, "p_idempotency_key" "text", "p_request_hash" "text") RETURNS TABLE("run_id" "uuid", "outcome" "text")
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
#variable_conflict use_column
declare
  v_sess     public.visitor_sessions%rowtype;
  v_enabled  boolean;
  v_cap_text text;
  v_cap      integer;
  v_existing public.request_runs%rowtype;
  v_active   integer;
  v_id       uuid;
begin
  if p_bot_id is null or p_visitor_session_id is null or p_token_version is null or p_token_version < 1
     or p_idempotency_key is null or p_request_hash is null
     or p_idempotency_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'begin_request_run: bot, session, token version, canonical uuid idempotency key and sha256 hex hash are required'
      using errcode = '22023';
  end if;

  select b.enabled into v_enabled from public.bot_profiles b where b.id = p_bot_id for share;
  if found and not v_enabled then
    raise exception 'begin_request_run: bot is disabled' using errcode = 'RB039';
  end if;

  select * into v_sess from public.visitor_sessions s
   where s.id = p_visitor_session_id and s.bot_id = p_bot_id for update;
  if not found or v_sess.revoked_at is not null or v_sess.expires_at <= now()
     or v_sess.token_version <> p_token_version then
    raise exception 'begin_request_run: visitor session is not valid' using errcode = 'RB004';
  end if;

  select cs.rate_policy ->> 'concurrent_requests_per_session' into v_cap_text
    from public.client_settings cs where cs.bot_id = p_bot_id;
  if not found then
    raise exception 'begin_request_run: no client settings for bot' using errcode = 'RB002';
  end if;
  if v_cap_text is null or v_cap_text !~ '^[1-9][0-9]{0,3}$' then
    raise exception 'begin_request_run: concurrent_requests_per_session is missing or invalid' using errcode = 'RB002';
  end if;
  v_cap := v_cap_text::integer;

  select * into v_existing from public.request_runs r
   where r.bot_id = p_bot_id and r.visitor_session_id = p_visitor_session_id and r.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_hash = p_request_hash then
      return query select v_existing.id, 'duplicate'::text;
    else
      return query select null::uuid, 'hash_mismatch'::text;
    end if;
    return;
  end if;

  select count(*)::integer into v_active from public.request_runs r
   where r.bot_id = p_bot_id and r.visitor_session_id = p_visitor_session_id
     and r.state in ('running', 'reserved');
  if v_active >= v_cap then
    return query select null::uuid, 'concurrency_limited'::text;
    return;
  end if;

  insert into public.request_runs (bot_id, visitor_session_id, idempotency_key, request_hash)
  values (p_bot_id, p_visitor_session_id, p_idempotency_key, p_request_hash)
  returning id into v_id;
  return query select v_id, 'new'::text;
end;
$_$;


ALTER FUNCTION "public"."begin_request_run"("p_bot_id" "uuid", "p_visitor_session_id" "uuid", "p_token_version" integer, "p_idempotency_key" "text", "p_request_hash" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bot_profiles_bump_settings_version"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  new.settings_version := old.settings_version + 1;
  return new;
end;
$$;


ALTER FUNCTION "public"."bot_profiles_bump_settings_version"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bot_profiles_guard_embedding_change"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if (new.embedding_model is distinct from old.embedding_model
      or new.embedding_dimensions is distinct from old.embedding_dimensions)
     and exists (
       select 1
         from public.documents d
         join public.document_versions v on v.document_id = d.id
         join public.document_chunks c on c.document_version_id = v.id
        where d.bot_id = old.id
     ) then
    raise exception 'bot_profiles: embedding model change requires reindex' using errcode = 'RB012';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."bot_profiles_guard_embedding_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bot_profiles_sync_published"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  update public.public_bot_config set is_published = new.enabled where bot_id = new.id;
  return null;
end;
$$;


ALTER FUNCTION "public"."bot_profiles_sync_published"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bump_analysis_generation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if new.type = 'analyze_conversation' and new.state = 'running'
     and (old.state <> 'running' or new.attempts <> old.attempts or new.locked_by is distinct from old.locked_by) then
    new.analysis_generation := old.analysis_generation + 1;
    new.analysis_claim_revision := new.analysis_requested_revision;
    new.analysis_context_revision := 0;
    new.analysis_context_generation := 0;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."bump_analysis_generation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bump_bot_settings_version"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if (to_jsonb(new) - 'updated_at' - 'is_published') is distinct from (to_jsonb(old) - 'updated_at' - 'is_published') then
    update public.bot_profiles set settings_version = settings_version + 1 where id = new.bot_id;
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."bump_bot_settings_version"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bump_warm_generation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if new.type = 'warm_answer_cache' and new.state = 'running'
     and (old.state <> 'running' or new.attempts <> old.attempts
       or new.locked_by is distinct from old.locked_by) then
    new.warm_generation := old.warm_generation + 1;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."bump_warm_generation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cache_delete_answer"("p_key_hash" "text") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_delete_answer: invalid key hash' using errcode = '22023';
  end if;
  delete from public.answer_cache where cache_key_hash = p_key_hash;
end;
$_$;


ALTER FUNCTION "public"."cache_delete_answer"("p_key_hash" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cache_delete_retrieval"("p_key_hash" "text") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_delete_retrieval: invalid key hash' using errcode = '22023';
  end if;
  delete from public.retrieval_cache where key_hash = p_key_hash;
end;
$_$;


ALTER FUNCTION "public"."cache_delete_retrieval"("p_key_hash" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cache_get_answer"("p_key_hash" "text") RETURNS TABLE("bot_id" "uuid", "cache_key_hash" "text", "language" "text", "answer_text" "text", "source_refs" "jsonb", "handoff_reason" "text", "corpus_version" bigint, "settings_version" integer, "prompt_template_version" "text", "chat_model" "text", "expires_at" timestamp with time zone)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_get_answer: invalid key hash' using errcode = '22023';
  end if;
  return query
  select c.bot_id, c.cache_key_hash, c.language, c.answer_text, c.source_refs, c.handoff_reason, c.corpus_version, c.settings_version, c.prompt_template_version, c.chat_model, c.expires_at
    from public.answer_cache c
   where c.cache_key_hash = p_key_hash
     and c.expires_at > now()
   limit 1;
end;
$_$;


ALTER FUNCTION "public"."cache_get_answer"("p_key_hash" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cache_get_moderation"("p_key_hash" "text") RETURNS TABLE("key_hash" "text", "policy_version" "text", "verdict" "text", "expires_at" timestamp with time zone)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_get_moderation: invalid key hash' using errcode = '22023';
  end if;
  return query
  select c.key_hash, c.policy_version, c.verdict, c.expires_at
    from public.moderation_cache c
   where c.key_hash = p_key_hash
     and c.expires_at > now()
   limit 1;
end;
$_$;


ALTER FUNCTION "public"."cache_get_moderation"("p_key_hash" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cache_get_query_embedding"("p_key_hash" "text") RETURNS TABLE("key_hash" "text", "embedding_model" "text", "embedding_dimensions" integer, "embedding" "text", "expires_at" timestamp with time zone)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_get_query_embedding: invalid key hash' using errcode = '22023';
  end if;
  return query
  select c.key_hash, c.embedding_model, c.embedding_dimensions, c.embedding::text, c.expires_at
    from public.query_embedding_cache c
   where c.key_hash = p_key_hash
     and c.expires_at > now()
   limit 1;
end;
$_$;


ALTER FUNCTION "public"."cache_get_query_embedding"("p_key_hash" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cache_get_retrieval"("p_key_hash" "text") RETURNS TABLE("bot_id" "uuid", "corpus_version" bigint, "embedding_hash" "text", "k" integer, "threshold" double precision, "language" "text", "chunk_refs" "jsonb", "expires_at" timestamp with time zone)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_get_retrieval: invalid key hash' using errcode = '22023';
  end if;
  return query
  select c.bot_id, c.corpus_version, c.embedding_hash, c.k, c.threshold, c.language, c.chunk_refs, c.expires_at
    from public.retrieval_cache c
   where c.key_hash = p_key_hash
     and c.expires_at > now()
   limit 1;
end;
$_$;


ALTER FUNCTION "public"."cache_get_retrieval"("p_key_hash" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cache_set_answer"("p_bot_id" "uuid", "p_key_hash" "text", "p_language" "text", "p_answer_text" "text", "p_source_refs" "jsonb", "p_handoff_reason" "text", "p_corpus_version" bigint, "p_settings_version" integer, "p_prompt_template_version" "text", "p_chat_model" "text", "p_expires_at" timestamp with time zone) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
begin
  if p_bot_id is null then
    raise exception 'cache_set_answer: bot is required' using errcode = '22023';
  end if;
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_set_answer: invalid key hash' using errcode = '22023';
  end if;
  if p_answer_text is null or p_answer_text = '' or length(p_answer_text) > 20000 then
    raise exception 'cache_set_answer: invalid answer' using errcode = '22023';
  end if;
  if p_source_refs is null or jsonb_typeof(p_source_refs) != 'array' then
    raise exception 'cache_set_answer: invalid sources' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'cache_set_answer: invalid expiry' using errcode = '22023';
  end if;
  insert into public.answer_cache (bot_id, cache_key_hash, language, answer_text, source_refs, handoff_reason, corpus_version, settings_version, prompt_template_version, chat_model, expires_at, hit_count)
  values (p_bot_id, p_key_hash, p_language, p_answer_text, p_source_refs, p_handoff_reason, p_corpus_version, p_settings_version, p_prompt_template_version, p_chat_model, p_expires_at, 0)
  on conflict (cache_key_hash) do update set
    bot_id = excluded.bot_id,
    language = excluded.language,
    answer_text = excluded.answer_text,
    source_refs = excluded.source_refs,
    handoff_reason = excluded.handoff_reason,
    corpus_version = excluded.corpus_version,
    settings_version = excluded.settings_version,
    prompt_template_version = excluded.prompt_template_version,
    chat_model = excluded.chat_model,
    expires_at = excluded.expires_at;
end;
$_$;


ALTER FUNCTION "public"."cache_set_answer"("p_bot_id" "uuid", "p_key_hash" "text", "p_language" "text", "p_answer_text" "text", "p_source_refs" "jsonb", "p_handoff_reason" "text", "p_corpus_version" bigint, "p_settings_version" integer, "p_prompt_template_version" "text", "p_chat_model" "text", "p_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cache_set_moderation"("p_key_hash" "text", "p_policy_version" "text", "p_verdict" "text", "p_model" "text", "p_expires_at" timestamp with time zone) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_set_moderation: invalid key hash' using errcode = '22023';
  end if;
  if p_policy_version is null or p_policy_version = '' or length(p_policy_version) > 64 then
    raise exception 'cache_set_moderation: invalid policy version' using errcode = '22023';
  end if;
  if p_verdict is null or p_verdict not in ('allow', 'block') then
    raise exception 'cache_set_moderation: invalid verdict' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'cache_set_moderation: invalid expiry' using errcode = '22023';
  end if;
  insert into public.moderation_cache (key_hash, policy_version, verdict, moderation_model, expires_at)
  values (p_key_hash, p_policy_version, p_verdict, nullif(p_model, ''), p_expires_at)
  on conflict (key_hash) do update set
    policy_version = excluded.policy_version,
    verdict = excluded.verdict,
    moderation_model = excluded.moderation_model,
    expires_at = excluded.expires_at;
end;
$_$;


ALTER FUNCTION "public"."cache_set_moderation"("p_key_hash" "text", "p_policy_version" "text", "p_verdict" "text", "p_model" "text", "p_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cache_set_query_embedding"("p_key_hash" "text", "p_model" "text", "p_dimensions" integer, "p_embedding_text" "text", "p_expires_at" timestamp with time zone) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_set_query_embedding: invalid key hash' using errcode = '22023';
  end if;
  if p_model is null or p_model = '' or length(p_model) > 128 then
    raise exception 'cache_set_query_embedding: invalid model' using errcode = '22023';
  end if;
  if p_dimensions is null or p_dimensions != 1536 then
    raise exception 'cache_set_query_embedding: dimensions must be 1536' using errcode = '22023';
  end if;
  if p_embedding_text is null or p_embedding_text = '' then
    raise exception 'cache_set_query_embedding: invalid embedding' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'cache_set_query_embedding: invalid expiry' using errcode = '22023';
  end if;
  insert into public.query_embedding_cache (key_hash, embedding_model, embedding_dimensions, embedding, expires_at, last_hit_at)
  values (p_key_hash, p_model, p_dimensions, p_embedding_text::extensions.vector(1536), p_expires_at, null)
  on conflict (key_hash) do update set
    embedding_model = excluded.embedding_model,
    embedding_dimensions = excluded.embedding_dimensions,
    embedding = excluded.embedding,
    expires_at = excluded.expires_at,
    last_hit_at = now();
end;
$_$;


ALTER FUNCTION "public"."cache_set_query_embedding"("p_key_hash" "text", "p_model" "text", "p_dimensions" integer, "p_embedding_text" "text", "p_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cache_set_retrieval"("p_key_hash" "text", "p_bot_id" "uuid", "p_corpus_version" bigint, "p_embedding_hash" "text", "p_k" integer, "p_threshold" double precision, "p_language" "text", "p_chunk_refs" "jsonb", "p_expires_at" timestamp with time zone) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_set_retrieval: invalid key hash' using errcode = '22023';
  end if;
  if p_bot_id is null then
    raise exception 'cache_set_retrieval: bot is required' using errcode = '22023';
  end if;
  if p_embedding_hash is null or p_embedding_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_set_retrieval: invalid embedding hash' using errcode = '22023';
  end if;
  if p_k is null or p_k < 1 or p_k > 50 then
    raise exception 'cache_set_retrieval: invalid k' using errcode = '22023';
  end if;
  if p_chunk_refs is null or jsonb_typeof(p_chunk_refs) != 'array' then
    raise exception 'cache_set_retrieval: invalid refs' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'cache_set_retrieval: invalid expiry' using errcode = '22023';
  end if;
  insert into public.retrieval_cache (key_hash, bot_id, corpus_version, embedding_hash, k, threshold, language, chunk_refs, expires_at)
  values (p_key_hash, p_bot_id, p_corpus_version, p_embedding_hash, p_k, p_threshold, p_language, p_chunk_refs, p_expires_at)
  on conflict (key_hash) do update set
    bot_id = excluded.bot_id,
    corpus_version = excluded.corpus_version,
    embedding_hash = excluded.embedding_hash,
    k = excluded.k,
    threshold = excluded.threshold,
    language = excluded.language,
    chunk_refs = excluded.chunk_refs,
    expires_at = excluded.expires_at;
end;
$_$;


ALTER FUNCTION "public"."cache_set_retrieval"("p_key_hash" "text", "p_bot_id" "uuid", "p_corpus_version" bigint, "p_embedding_hash" "text", "p_k" integer, "p_threshold" double precision, "p_language" "text", "p_chunk_refs" "jsonb", "p_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cache_touch_answer"("p_key_hash" "text") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'cache_touch_answer: invalid key hash' using errcode = '22023';
  end if;
  update public.answer_cache set hit_count = hit_count + 1, last_hit_at = now() where cache_key_hash = p_key_hash;
end;
$_$;


ALTER FUNCTION "public"."cache_touch_answer"("p_key_hash" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "type" "text" NOT NULL,
    "dedupe_key" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "state" "text" DEFAULT 'queued'::"text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "max_attempts" integer NOT NULL,
    "available_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "locked_until" timestamp with time zone,
    "locked_by" "text",
    "progress" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "analysis_generation" integer DEFAULT 0 NOT NULL,
    "analysis_requested_revision" bigint DEFAULT 0 NOT NULL,
    "analysis_claim_revision" bigint DEFAULT 0 NOT NULL,
    "analysis_context_revision" bigint DEFAULT 0 NOT NULL,
    "analysis_context_generation" integer DEFAULT 0 NOT NULL,
    "warm_generation" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "jobs_analysis_claim_revision_check" CHECK (("analysis_claim_revision" >= 0)),
    CONSTRAINT "jobs_analysis_context_generation_check" CHECK (("analysis_context_generation" >= 0)),
    CONSTRAINT "jobs_analysis_context_revision_check" CHECK (("analysis_context_revision" >= 0)),
    CONSTRAINT "jobs_analysis_generation_check" CHECK (("analysis_generation" >= 0)),
    CONSTRAINT "jobs_analysis_requested_revision_check" CHECK (("analysis_requested_revision" >= 0)),
    CONSTRAINT "jobs_attempts_check" CHECK (("attempts" >= 0)),
    CONSTRAINT "jobs_max_attempts_check" CHECK (("max_attempts" >= 1)),
    CONSTRAINT "jobs_payload_type" CHECK (("jsonb_typeof"("payload") = 'object'::"text")),
    CONSTRAINT "jobs_progress_type" CHECK (("jsonb_typeof"("progress") = 'object'::"text")),
    CONSTRAINT "jobs_state_check" CHECK (("state" = ANY (ARRAY['queued'::"text", 'running'::"text", 'succeeded'::"text", 'failed'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "jobs_type_check" CHECK (("type" = ANY (ARRAY['index_document'::"text", 'analyze_conversation'::"text", 'cleanup'::"text", 'warm_answer_cache'::"text"]))),
    CONSTRAINT "jobs_warm_generation_check" CHECK (("warm_generation" >= 0))
);


ALTER TABLE "public"."jobs" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_jobs"("p_worker" "text", "p_limit" integer, "p_lease_seconds" integer, "p_types" "text"[] DEFAULT NULL::"text"[]) RETURNS SETOF "public"."jobs"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if p_worker is null or btrim(p_worker) = '' then
    raise exception 'claim_jobs: worker id is required' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'claim_jobs: limit must be between 1 and 100' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'claim_jobs: lease seconds must be between 1 and 3600' using errcode = '22023';
  end if;

  -- Dead-letter expired leases that have no attempts left.
  update public.jobs j
     set state = 'failed',
         locked_until = null,
         locked_by = null,
         completed_at = now(),
         last_error = 'lease expired; max attempts reached'
   where j.id in (
     select x.id from public.jobs x
      where x.state = 'running'
        and x.locked_until < now()
        and x.attempts >= x.max_attempts
        and (p_types is null or x.type = any (p_types))
      for update skip locked
   );

  return query
  with due as (
    select j.id
      from public.jobs j
     where j.attempts < j.max_attempts
       and (p_types is null or j.type = any (p_types))
       and (
         (j.state = 'queued' and j.available_at <= now())
         or (j.state = 'running' and j.locked_until < now())
       )
     order by j.available_at, j.created_at
     limit p_limit
     for update skip locked
  )
  update public.jobs j
     set state = 'running',
         attempts = j.attempts + 1,
         locked_by = p_worker,
         locked_until = now() + make_interval(secs => p_lease_seconds)
    from due
   where j.id = due.id
  returning j.*;
end;
$$;


ALTER FUNCTION "public"."claim_jobs"("p_worker" "text", "p_limit" integer, "p_lease_seconds" integer, "p_types" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_document"("p_document_id" "uuid", "p_batch" integer) RETURNS TABLE("deleted_chunks" integer, "done" boolean)
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
#variable_conflict use_column
declare
  v_deleted timestamptz;
  v_ids     uuid[];
  v_n       integer;
  v_left    boolean;
begin
  if p_document_id is null or p_batch is null or p_batch < 1 or p_batch > 1000 then
    raise exception 'cleanup_document: document and batch (1..1000) are required' using errcode = '22023';
  end if;
  select d.deleted_at into v_deleted from public.documents d where d.id = p_document_id;
  if not found then
    raise exception 'cleanup_document: document not found' using errcode = 'RB010';
  end if;
  if v_deleted is null then
    raise exception 'cleanup_document: the document is not deleted' using errcode = 'RB030';
  end if;

  -- The ids are chosen first, into an array, and deleted by a separate statement. "delete ... where id in (select ...
  -- limit n for update skip locked)" can be planned as a nested-loop semi join that re-runs the subquery for every outer
  -- row; the lock then skips rows this statement has already deleted, so each re-run takes new rows and the batch
  -- limit is overrun (all chunks go).
  select coalesce(array_agg(y.id), '{}'::uuid[]) into v_ids
    from (select x.id
            from public.document_chunks x
            join public.document_versions v on v.id = x.document_version_id
           where v.document_id = p_document_id
           limit p_batch
             for update of x skip locked) y;
  delete from public.document_chunks c where c.id = any (v_ids);
  get diagnostics v_n = row_count;

  select exists (
    select 1 from public.document_chunks x
      join public.document_versions v on v.id = x.document_version_id
     where v.document_id = p_document_id) into v_left;

  return query select v_n, not v_left;
end;
$$;


ALTER FUNCTION "public"."cleanup_document"("p_document_id" "uuid", "p_batch" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_storage_targets"("p_document_id" "uuid") RETURNS TABLE("storage_path" "text")
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
#variable_conflict use_column
declare
  v_deleted timestamptz;
begin
  if p_document_id is null then
    raise exception 'cleanup_storage_targets: document is required' using errcode = '22023';
  end if;
  select d.deleted_at into v_deleted from public.documents d where d.id = p_document_id;
  if not found then
    raise exception 'cleanup_storage_targets: document not found' using errcode = 'RB010';
  end if;
  if v_deleted is null then
    raise exception 'cleanup_storage_targets: the document is not deleted' using errcode = 'RB030';
  end if;

  return query
  select distinct v.storage_path
    from public.document_versions v
   where v.document_id = p_document_id
     and not exists (
       select 1
         from public.document_versions o
         join public.documents od on od.id = o.document_id
        where o.storage_path = v.storage_path and od.deleted_at is null);
end;
$$;


ALTER FUNCTION "public"."cleanup_storage_targets"("p_document_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_job"("p_job_id" "uuid", "p_worker" "text") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = '' then
    raise exception 'complete_job: job and worker id are required' using errcode = '22023';
  end if;
  update public.jobs
     set state = 'succeeded', completed_at = now(), locked_until = null, locked_by = null, last_error = null
   where id = p_job_id and state = 'running' and locked_by = p_worker;
  if not found then
    raise exception 'complete_job: lease not held' using errcode = 'RB013';
  end if;
end;
$$;


ALTER FUNCTION "public"."complete_job"("p_job_id" "uuid", "p_worker" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_data_entry"("p_bot_id" "uuid", "p_conversation_id" "uuid", "p_schema_key" "text", "p_payload" "jsonb", "p_consent_at" timestamp with time zone) RETURNS TABLE("entry_id" "uuid")
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
#variable_conflict use_column
declare
  v_id uuid;
begin
  if p_bot_id is null then
    raise exception 'create_data_entry: bot is required' using errcode = '22023';
  end if;
  if p_schema_key is null or p_schema_key !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'create_data_entry: schema_key is required' using errcode = '22023';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'create_data_entry: payload must be an object' using errcode = '22023';
  end if;
  if p_consent_at is null then
    raise exception 'create_data_entry: consent timestamp is required (W-13)' using errcode = '22023';
  end if;

  if p_conversation_id is not null then
    perform 1
      from public.conversations c
     where c.id = p_conversation_id
       and c.bot_id = p_bot_id;
    if not found then
      raise exception 'create_data_entry: conversation not found or not owned' using errcode = 'RB037';
    end if;
  else
    perform 1 from public.bot_profiles b where b.id = p_bot_id;
    if not found then
      raise exception 'create_data_entry: conversation not found or not owned' using errcode = 'RB037';
    end if;
  end if;

  insert into public.data_entries as e (bot_id, conversation_id, schema_key, payload, consent_at)
  values (p_bot_id, p_conversation_id, p_schema_key, p_payload, p_consent_at)
  returning e.id into v_id;

  return query select v_id;
end;
$_$;


ALTER FUNCTION "public"."create_data_entry"("p_bot_id" "uuid", "p_conversation_id" "uuid", "p_schema_key" "text", "p_payload" "jsonb", "p_consent_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_visitor_session"("p_bot_id" "uuid", "p_ttl_seconds" integer) RETURNS TABLE("session_id" "uuid", "token_version" integer, "expires_at" timestamp with time zone)
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
#variable_conflict use_column
declare
  v_enabled boolean;
  v_id      uuid;
  v_version integer;
  v_expires timestamptz;
begin
  if p_bot_id is null or p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 86400 then
    raise exception 'create_visitor_session: bot and ttl (60..86400s) are required' using errcode = '22023';
  end if;

  select b.enabled into v_enabled from public.bot_profiles b where b.id = p_bot_id for share;
  if not found or not v_enabled then
    raise exception 'create_visitor_session: bot is disabled or unknown' using errcode = 'RB039';
  end if;

  insert into public.visitor_sessions as s (bot_id, expires_at)
  values (p_bot_id, now() + make_interval(secs => p_ttl_seconds))
  returning s.id, s.token_version, s.expires_at into v_id, v_version, v_expires;

  return query select v_id, v_version, v_expires;
end;
$$;


ALTER FUNCTION "public"."create_visitor_session"("p_bot_id" "uuid", "p_ttl_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enqueue_warm_after_version_change"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if new.corpus_version is distinct from old.corpus_version
     or new.settings_version is distinct from old.settings_version then
    perform public.queue_warm_job(new.id);
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."enqueue_warm_after_version_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."expire_abandoned_uploads"("p_older_than_hours" integer, "p_batch" integer) RETURNS TABLE("version_id" "uuid", "storage_path" "text")
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
#variable_conflict use_column
declare
  v_ids uuid[];
begin
  if p_older_than_hours is null or p_older_than_hours < 1 or p_older_than_hours > 8760
     or p_batch is null or p_batch < 1 or p_batch > 1000 then
    raise exception 'expire_abandoned_uploads: hours (1..8760) and batch (1..1000) are required' using errcode = '22023';
  end if;

  select coalesce(array_agg(x.id), '{}'::uuid[]) into v_ids
    from (select v.id
            from public.document_versions v
           where v.status = 'pending_upload' and v.created_at < now() - make_interval(hours => p_older_than_hours)
           order by v.created_at, v.id
           limit p_batch) x;

  perform 1 from public.documents d
   where d.id in (select v.document_id from public.document_versions v where v.id = any (v_ids))
   order by d.id
     for no key update;

  return query
  with f as (
    update public.document_versions v
       set status = 'failed', failure_code = 'INDEXING_FAILED', completed_at = now()
     where v.id = any (v_ids) and v.status = 'pending_upload'
    returning v.id, v.document_id, v.storage_path
  ), d as (
    update public.documents dd set status = 'failed'
     where dd.id in (select f.document_id from f) and dd.active_version_id is null and dd.status in ('draft', 'indexing')
    returning dd.id
  )
  select f.id, f.storage_path
    from f
   where not exists (select 1 from public.document_versions o where o.storage_path = f.storage_path and o.id <> f.id);
end;
$$;


ALTER FUNCTION "public"."expire_abandoned_uploads"("p_older_than_hours" integer, "p_batch" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."expire_stale_budget_reservations"("p_batch" integer) RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare v_n integer;
begin
  if p_batch is null or p_batch < 1 or p_batch > 10000 then
    raise exception 'expire_stale_budget_reservations: batch must be 1..10000' using errcode = '22023';
  end if;
  with stale as (
    select r.id from public.budget_reservations r
     where r.state = 'reserved' and r.expires_at < now()
     order by r.expires_at
     limit p_batch
     for update skip locked
  )
  update public.budget_reservations r set state = 'expired' from stale where r.id = stale.id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


ALTER FUNCTION "public"."expire_stale_budget_reservations"("p_batch" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."expire_stuck_request_runs"("p_older_than_seconds" integer, "p_batch" integer) RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare v_n integer;
begin
  if p_older_than_seconds is null or p_older_than_seconds < 60 or p_older_than_seconds > 86400 then
    raise exception 'expire_stuck_request_runs: older-than seconds must be 60..86400' using errcode = '22023';
  end if;
  if p_batch is null or p_batch < 1 or p_batch > 10000 then
    raise exception 'expire_stuck_request_runs: batch must be 1..10000' using errcode = '22023';
  end if;
  with stuck as (
    select r.id from public.request_runs r
     where r.state in ('reserved', 'running')
       and r.started_at < now() - make_interval(secs => p_older_than_seconds)
     order by r.started_at
     limit p_batch
     for update skip locked
  ),
  failed as (
    update public.request_runs r
       set state = 'failed', finished_at = now()
      from stuck
     where r.id = stuck.id
    returning r.id
  ),
  expired as (
    update public.budget_reservations b
       set state = 'expired'
      from failed
     where b.request_id = failed.id and b.state = 'reserved'
    returning b.id
  )
  select count(*)::integer into v_n from failed;
  return v_n;
end;
$$;


ALTER FUNCTION "public"."expire_stuck_request_runs"("p_older_than_seconds" integer, "p_batch" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."expire_stuck_request_runs"("p_older_than_seconds" integer, "p_batch" integer) IS 'Fails runs stuck in reserved/running and marks their reserved budget reservations expired (not released). An expired reservation stops counting toward the cap but remains settleable, so a slow request''s real spend is still counted. Supersedes older comments that say the reaper releases them.';



CREATE OR REPLACE FUNCTION "public"."expire_visitor_sessions"("p_batch" integer, "p_grace_seconds" integer) RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare v_n integer;
begin
  if p_batch is null or p_batch < 1 or p_batch > 10000 then
    raise exception 'expire_visitor_sessions: batch must be 1..10000' using errcode = '22023';
  end if;
  if p_grace_seconds is null or p_grace_seconds < 1 or p_grace_seconds > 86400 then
    raise exception 'expire_visitor_sessions: grace seconds must be 1..86400' using errcode = '22023';
  end if;
  with doomed as (
    select s.id from public.visitor_sessions s
     where s.expires_at < now() - make_interval(secs => p_grace_seconds)
     order by s.expires_at
     limit p_batch
     for update skip locked
  )
  delete from public.visitor_sessions s using doomed where s.id = doomed.id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


ALTER FUNCTION "public"."expire_visitor_sessions"("p_batch" integer, "p_grace_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fail_analysis_job"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
declare v_conversation uuid;
begin
  select f.conversation_id into v_conversation from public.analysis_job_fence(p_job_id, p_worker, p_generation) f;
  perform public.fail_conversation_analysis(v_conversation);
end;
$$;


ALTER FUNCTION "public"."fail_analysis_job"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fail_conversation_analysis"("p_conversation_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
#variable_conflict use_column
begin
  if p_conversation_id is null then
    raise exception 'fail_conversation_analysis: conversation is required' using errcode = '22023';
  end if;
  perform 1 from public.conversations c where c.id = p_conversation_id;
  if not found then
    raise exception 'fail_conversation_analysis: conversation not found or not owned' using errcode = 'RB037';
  end if;

  insert into public.conversation_analysis as a (conversation_id, status)
  values (p_conversation_id, 'failed')
  on conflict (conversation_id) do update
     set status = 'failed';
end;
$$;


ALTER FUNCTION "public"."fail_conversation_analysis"("p_conversation_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fail_document_version"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_failure_code" "text") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
#variable_conflict use_column
declare
  v_doc    uuid;
  v_status text;
begin
  select f.document_id into v_doc from public.index_job_fence(p_job_id, p_worker, p_version_id) f;
  if p_failure_code is null
     or p_failure_code not in ('FILE_UNSUPPORTED', 'OCR_REQUIRED', 'INDEXING_FAILED', 'BUDGET_EXCEEDED', 'SUPERSEDED') then
    raise exception 'fail_document_version: unknown failure code' using errcode = '22023';
  end if;

  select v.status into v_status from public.document_versions v where v.id = p_version_id for update;
  if v_status = 'failed' then
    return;
  end if;
  if v_status not in ('uploaded', 'extracting', 'embedding') then
    raise exception 'fail_document_version: version is not being indexed' using errcode = 'RB030';
  end if;

  update public.document_versions v
     set status = 'failed', failure_code = p_failure_code, completed_at = now()
   where v.id = p_version_id;
  update public.documents d set status = 'failed'
   where d.id = v_doc and d.active_version_id is null and d.status in ('draft', 'indexing');
end;
$$;


ALTER FUNCTION "public"."fail_document_version"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_failure_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fail_job"("p_job_id" "uuid", "p_worker" "text", "p_error" "text") RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  v_state text;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = '' or p_error is null then
    raise exception 'fail_job: job, worker id and error text are required' using errcode = '22023';
  end if;
  update public.jobs j
     set state = case when j.attempts >= j.max_attempts then 'failed' else 'queued' end,
         completed_at = case when j.attempts >= j.max_attempts then now() else null end,
         available_at = case when j.attempts >= j.max_attempts then j.available_at else now() end,
         locked_until = null,
         locked_by = null,
         last_error = left(p_error, 1000)
   where j.id = p_job_id and j.state = 'running' and j.locked_by = p_worker
  returning j.state into v_state;
  if not found then
    raise exception 'fail_job: lease not held' using errcode = 'RB013';
  end if;
  return v_state;
end;
$$;


ALTER FUNCTION "public"."fail_job"("p_job_id" "uuid", "p_worker" "text", "p_error" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fail_orphaned_index_versions"("p_batch" integer) RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
#variable_conflict use_column
declare
  v_ids uuid[];
  v_n   integer;
begin
  if p_batch is null or p_batch < 1 or p_batch > 1000 then
    raise exception 'fail_orphaned_index_versions: batch (1..1000) is required' using errcode = '22023';
  end if;

  select coalesce(array_agg(x.id), '{}'::uuid[]) into v_ids
    from (select v.id
            from public.document_versions v
           where v.status in ('uploaded', 'extracting', 'embedding')
             and (select j.state from public.jobs j
                   where j.type = 'index_document' and j.payload ->> 'version_id' = v.id::text
                   order by j.created_at desc, j.id desc limit 1) in ('failed', 'cancelled')
           order by v.created_at, v.id
           limit p_batch) x;

  perform 1 from public.documents d
   where d.id in (select v.document_id from public.document_versions v where v.id = any (v_ids))
   order by d.id
     for no key update;

  with f as (
    update public.document_versions v
       set status = 'failed', failure_code = 'INDEXING_FAILED', completed_at = now()
     where v.id = any (v_ids)
       and v.status in ('uploaded', 'extracting', 'embedding')
       and (select j.state from public.jobs j
             where j.type = 'index_document' and j.payload ->> 'version_id' = v.id::text
             order by j.created_at desc, j.id desc limit 1) in ('failed', 'cancelled')
    returning v.id, v.document_id
  ), d as (
    update public.documents dd set status = 'failed'
     where dd.id in (select f.document_id from f) and dd.active_version_id is null and dd.status in ('draft', 'indexing')
    returning dd.id
  )
  select count(*)::integer into v_n from f;
  return v_n;
end;
$$;


ALTER FUNCTION "public"."fail_orphaned_index_versions"("p_batch" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finish_chat_turn"("p_bot_id" "uuid", "p_visitor_session_id" "uuid", "p_run_id" "uuid", "p_message_id" "uuid", "p_conversation_id" "uuid", "p_user_message_id" "uuid", "p_content" "text", "p_status" "text", "p_provider" "text", "p_model" "text", "p_handoff_reason" "text", "p_sources" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
#variable_conflict use_column
declare
  v_uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_state   text;
  v_n       integer;
  v_e       jsonb;
  v_now     timestamptz := clock_timestamp();
begin
  if p_bot_id is null or p_visitor_session_id is null or p_run_id is null or p_message_id is null
     or p_conversation_id is null or p_user_message_id is null then
    raise exception 'finish_chat_turn: bot, session, run, message, conversation and question are required' using errcode = '22023';
  end if;
  if p_content is null then
    raise exception 'finish_chat_turn: content is required (it may be empty)' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('complete', 'partial', 'failed', 'blocked') then
    raise exception 'finish_chat_turn: unknown status' using errcode = '22023';
  end if;
  if p_handoff_reason is not null
     and p_handoff_reason not in ('no_knowledge', 'out_of_scope', 'human_requested', 'blocked', 'unavailable', 'repeated_no_knowledge') then
    raise exception 'finish_chat_turn: unknown handoff reason' using errcode = '22023';
  end if;
  if (p_provider is not null and char_length(p_provider) > 100) or (p_model is not null and char_length(p_model) > 200) then
    raise exception 'finish_chat_turn: provider or model is too long' using errcode = '22023';
  end if;

  -- The shape of every source, before any lock is taken.
  if p_sources is null or jsonb_typeof(p_sources) <> 'array' then
    raise exception 'finish_chat_turn: sources must be a JSON array' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_sources);
  if v_n > 20 then
    raise exception 'finish_chat_turn: at most 20 sources' using errcode = '22023';
  end if;
  -- Bounded loop: at most 20 elements.
  for i in 0 .. v_n - 1 loop
    v_e := p_sources -> i;
    if jsonb_typeof(v_e) is distinct from 'object' then
      raise exception 'finish_chat_turn: each source must be an object' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'chunk_id') is distinct from 'string' or (v_e ->> 'chunk_id') !~* v_uuid_re then
      raise exception 'finish_chat_turn: source chunk_id must be a uuid' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'document_version_id') is distinct from 'string' or (v_e ->> 'document_version_id') !~* v_uuid_re then
      raise exception 'finish_chat_turn: source document_version_id must be a uuid' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'source_label') is distinct from 'string' or char_length(v_e ->> 'source_label') not between 1 and 300 then
      raise exception 'finish_chat_turn: source_label must be 1..300 characters' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'excerpt') is not null and jsonb_typeof(v_e -> 'excerpt') not in ('string', 'null') then
      raise exception 'finish_chat_turn: excerpt must be text' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'excerpt') = 'string' and char_length(v_e ->> 'excerpt') > 500 then
      raise exception 'finish_chat_turn: excerpt is longer than 500 characters' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'section') is not null and jsonb_typeof(v_e -> 'section') not in ('string', 'null') then
      raise exception 'finish_chat_turn: section must be text' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'section') = 'string' and char_length(v_e ->> 'section') > 300 then
      raise exception 'finish_chat_turn: section is longer than 300 characters' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'page_number') is not null and jsonb_typeof(v_e -> 'page_number') not in ('number', 'null') then
      raise exception 'finish_chat_turn: page_number must be a positive integer' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'page_number') = 'number' and (v_e ->> 'page_number') !~ '^[1-9][0-9]{0,8}$' then
      raise exception 'finish_chat_turn: page_number must be a positive integer' using errcode = '22023';
    end if;
  end loop;

  -- 2. The run (this function takes no session lock: it inserts no row that references the session).
  select r.state into v_state
    from public.request_runs r
   where r.id = p_run_id and r.bot_id = p_bot_id and r.visitor_session_id = p_visitor_session_id
     for no key update;
  if not found or v_state not in ('reserved', 'running') then
    raise exception 'finish_chat_turn: not found' using errcode = 'RB037';
  end if;

  -- 3. The conversation, then the question.
  perform 1 from public.conversations c
   where c.id = p_conversation_id and c.bot_id = p_bot_id and c.visitor_session_id = p_visitor_session_id
     and c.status = 'open'
     for no key update;
  if not found then
    raise exception 'finish_chat_turn: not found' using errcode = 'RB037';
  end if;
  perform 1 from public.messages m
   where m.id = p_user_message_id and m.conversation_id = p_conversation_id and m.role = 'user' and m.request_id = p_run_id;
  if not found then
    raise exception 'finish_chat_turn: not found' using errcode = 'RB037';
  end if;

  if exists (select 1 from public.messages m where m.request_id = p_run_id and m.role = 'assistant' and m.id <> p_message_id) then
    raise exception 'finish_chat_turn: this run already has its answer' using errcode = 'RB030';
  end if;

  -- 4. Every source must be a chunk of that version, of a document of THIS bot. The rows are locked until commit.
  for i in 0 .. v_n - 1 loop
    v_e := p_sources -> i;
    perform 1
      from public.document_chunks c
      join public.document_versions v on v.id = c.document_version_id
      join public.documents d on d.id = v.document_id
     where c.id = (v_e ->> 'chunk_id')::uuid
       and v.id = (v_e ->> 'document_version_id')::uuid
       and d.bot_id = p_bot_id
       for key share of c;
    if not found then
      raise exception 'finish_chat_turn: a source is not a chunk of this bot''s version' using errcode = '22023';
    end if;
  end loop;

  insert into public.messages (id, conversation_id, request_id, reply_to_message_id, role, content, status, provider, model,
                               handoff_reason, created_at)
  values (p_message_id, p_conversation_id, p_run_id, p_user_message_id, 'assistant', p_content, p_status, p_provider, p_model,
          p_handoff_reason, v_now);

  -- P7-D2: a question refused by moderation is marked 'blocked' itself, so the history sent to the model can exclude
  -- it by its own status instead of by its position (two turns of one conversation may interleave).
  if p_status = 'blocked' and p_handoff_reason = 'blocked' then
    update public.messages m set status = 'blocked' where m.id = p_user_message_id and m.role = 'user';
  end if;

  insert into public.message_sources (message_id, chunk_id, document_version_id, source_label, excerpt, page_number, section)
  select p_message_id,
         (t.x ->> 'chunk_id')::uuid,
         (t.x ->> 'document_version_id')::uuid,
         t.x ->> 'source_label',
         t.x ->> 'excerpt',
         (t.x ->> 'page_number')::integer,
         t.x ->> 'section'
    from jsonb_array_elements(p_sources) with ordinality as t(x, ord)
   order by t.ord;

  update public.conversations c set last_message_at = v_now where c.id = p_conversation_id;
end;
$_$;


ALTER FUNCTION "public"."finish_chat_turn"("p_bot_id" "uuid", "p_visitor_session_id" "uuid", "p_run_id" "uuid", "p_message_id" "uuid", "p_conversation_id" "uuid", "p_user_message_id" "uuid", "p_content" "text", "p_status" "text", "p_provider" "text", "p_model" "text", "p_handoff_reason" "text", "p_sources" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_analysis_context"("p_conversation_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
#variable_conflict use_column
declare
  v_bot_id uuid;
begin
  if p_conversation_id is null then
    raise exception 'get_analysis_context: conversation is required' using errcode = '22023';
  end if;

  select c.bot_id into v_bot_id
    from public.conversations c
   where c.id = p_conversation_id;
  if not found then
    raise exception 'get_analysis_context: conversation not found or not owned' using errcode = 'RB037';
  end if;

  return jsonb_build_object(
    'bot', (
      select jsonb_build_object(
        'identity_prompt', b.identity_prompt,
        'tone', b.tone,
        'scope', b.scope,
        'allowed_languages', b.allowed_languages
      )
        from public.bot_profiles b
       where b.id = v_bot_id
    ),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object('role', m.role, 'content', m.content) order by m.created_at, m.id)
        from (
          select m.role, m.content, m.created_at, m.id
            from public.messages m
           where m.conversation_id = p_conversation_id
             and m.role in ('user', 'assistant')
             and m.status in ('complete', 'partial')
           order by m.created_at desc, m.id desc
           limit 20
        ) m
    ), '[]'::jsonb)
  );
end;
$$;


ALTER FUNCTION "public"."get_analysis_context"("p_conversation_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_analysis_job_context"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
declare v_conversation uuid;
begin
  -- Take the stronger job lock first, before the fence takes the conversation
  -- share lock. Enqueue cannot advance the watermark while this snapshot is read.
  perform 1 from public.jobs j where j.id = p_job_id for update;
  select f.conversation_id into v_conversation
    from public.analysis_job_fence(p_job_id, p_worker, p_generation) f;
  update public.jobs set analysis_context_revision = analysis_requested_revision,
    analysis_context_generation = p_generation where id = p_job_id;
  return public.get_analysis_context(v_conversation);
end;
$$;


ALTER FUNCTION "public"."get_analysis_job_context"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_chat_context"("p_bot_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
#variable_conflict use_column
declare
  v_bot public.bot_profiles%rowtype;
  v_set public.client_settings%rowtype;
  v_pub public.public_bot_config%rowtype;
begin
  if p_bot_id is null then
    raise exception 'get_chat_context: bot is required' using errcode = '22023';
  end if;

  select * into v_bot from public.bot_profiles b where b.id = p_bot_id;
  if not found then
    raise exception 'get_chat_context: bot not found' using errcode = 'RB037';
  end if;
  select * into v_set from public.client_settings cs where cs.bot_id = p_bot_id;
  if not found then
    raise exception 'get_chat_context: client settings are missing' using errcode = 'RB036';
  end if;
  select * into v_pub from public.public_bot_config pc where pc.bot_id = p_bot_id;
  if not found then
    raise exception 'get_chat_context: public bot config is missing' using errcode = 'RB036';
  end if;

  return jsonb_build_object(
    'bot', jsonb_build_object(
      'id', v_bot.id,
      'slug', v_bot.slug,
      'enabled', v_bot.enabled,
      'display_name', v_pub.display_name,
      'identity_prompt', v_bot.identity_prompt,
      'tone', coalesce(v_bot.tone, ''),
      'scope', coalesce(v_bot.scope, ''),
      'allowed_languages', to_jsonb(v_bot.allowed_languages),
      'embedding_model', v_bot.embedding_model,
      'embedding_dimensions', v_bot.embedding_dimensions,
      'settings_version', v_bot.settings_version,
      'corpus_version', v_bot.corpus_version),
    'settings', jsonb_build_object(
      'feature_flags', v_set.feature_flags,
      'handoff_policy', v_set.handoff_policy,
      'cache_policy', coalesce(v_set.cache_policy, '{}'::jsonb)),
    'contact', jsonb_build_object(
      'supported_languages', to_jsonb(v_pub.supported_languages),
      'escalation_label', v_pub.escalation_label,
      'escalation_messages', v_pub.escalation_messages,
      'email', v_pub.contact_email,
      'phone', v_pub.contact_phone,
      'whatsapp_url', v_pub.contact_whatsapp_url,
      'page_url', v_pub.contact_page_url,
      'business_hours', v_pub.business_hours,
      'timezone', v_pub.timezone));
end;
$$;


ALTER FUNCTION "public"."get_chat_context"("p_bot_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_chunks_by_ids"("p_chunk_ids" "uuid"[], "p_bot_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("chunk_id" "uuid", "document_id" "uuid", "document_version_id" "uuid", "document_title" "text", "chunk_index" integer, "content" "text", "page_number" integer, "section" "text", "similarity" double precision)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
begin
  if p_chunk_ids is null or array_length(p_chunk_ids, 1) is null or array_length(p_chunk_ids, 1) < 1 or array_length(p_chunk_ids, 1) > 50 then
    raise exception 'get_chunks_by_ids: 1..50 ids required' using errcode = '22023';
  end if;
  return query
  select c.id, d.id, c.document_version_id, d.title, c.chunk_index, c.content, c.page_number, c.section, 1.0::double precision
    from public.document_chunks c
    join public.document_versions v on v.id = c.document_version_id
    join public.documents d on d.id = v.document_id
   where c.id = any (p_chunk_ids)
     and (p_bot_id is null or d.bot_id = p_bot_id)
     and v.status = 'ready'
     and d.deleted_at is null
     and d.status <> 'deleted'
     and d.disclosure_policy = 'public_answer';
end;
$$;


ALTER FUNCTION "public"."get_chunks_by_ids"("p_chunk_ids" "uuid"[], "p_bot_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_conversation_history"("p_bot_id" "uuid", "p_visitor_session_id" "uuid", "p_conversation_id" "uuid", "p_before" "uuid", "p_limit" integer) RETURNS TABLE("id" "uuid", "role" "text", "content" "text", "status" "text", "handoff_reason" "text", "created_at" timestamp with time zone, "has_more" boolean)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
#variable_conflict use_column
declare
  v_before_at timestamptz;
begin
  if p_bot_id is null or p_visitor_session_id is null or p_conversation_id is null
     or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'get_conversation_history: bot, session, conversation and a limit of 1..100 are required' using errcode = '22023';
  end if;

  perform 1 from public.conversations c
   where c.id = p_conversation_id and c.bot_id = p_bot_id and c.visitor_session_id = p_visitor_session_id;
  if not found then
    raise exception 'get_conversation_history: not found' using errcode = 'RB037';
  end if;

  if p_before is not null then
    select m.created_at into v_before_at
      from public.messages m
     where m.id = p_before and m.conversation_id = p_conversation_id and m.role in ('user', 'assistant');
    if not found then
      raise exception 'get_conversation_history: not found' using errcode = 'RB037';
    end if;
  end if;

  return query
  with page as (
    select m.id, m.role, m.content, m.status, m.handoff_reason, m.created_at
      from public.messages m
     where m.conversation_id = p_conversation_id
       and m.role in ('user', 'assistant')
       and (p_before is null or (m.created_at, m.id) < (v_before_at, p_before))
     order by m.created_at desc, m.id desc
     limit p_limit + 1
  ), ranked as (
    select pg.id, pg.role, pg.content, pg.status, pg.handoff_reason, pg.created_at,
           row_number() over (order by pg.created_at desc, pg.id desc) as rn,
           count(*) over () as total
      from page pg
  )
  select rk.id, rk.role, rk.content, rk.status, rk.handoff_reason, rk.created_at, rk.total > p_limit
    from ranked rk
   where rk.rn <= p_limit
   order by rk.created_at, rk.id;
end;
$$;


ALTER FUNCTION "public"."get_conversation_history"("p_bot_id" "uuid", "p_visitor_session_id" "uuid", "p_conversation_id" "uuid", "p_before" "uuid", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_index_job_context"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid") RETURNS TABLE("bot_id" "uuid", "document_id" "uuid", "version_id" "uuid", "version_number" integer, "status" "text", "storage_path" "text", "media_type" "text", "byte_size" bigint, "upload_etag" "text", "embedding_model" "text", "max_bytes" bigint, "max_pages" bigint, "active_version_id" "uuid", "active_version_number" integer, "batches_done" integer, "written_chunks" integer, "stored_chunking_version" "text", "stored_extraction_version" "text", "stored_embedding_model" "text")
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
#variable_conflict use_column
declare
  v_written integer;
  v_bot     uuid;
  v_doc     uuid;
  v_ver     public.document_versions%rowtype;
  v_active  uuid;
  v_act_num integer;
  v_model   text;
  v_policy  jsonb;
  v_bytes   bigint;
  v_pages   bigint;
begin
  select f.bot_id, f.document_id into v_bot, v_doc from public.index_job_fence(p_job_id, p_worker, p_version_id) f;

  select * into v_ver from public.document_versions v where v.id = p_version_id for update;
  select d.active_version_id into v_active from public.documents d where d.id = v_doc;
  if v_active is not null then
    select x.version_number into v_act_num from public.document_versions x where x.id = v_active;
  end if;
  select b.embedding_model into v_model from public.bot_profiles b where b.id = v_bot;
  select count(*)::integer into v_written from public.document_chunks c where c.document_version_id = p_version_id;

  select cs.upload_policy into v_policy from public.client_settings cs where cs.bot_id = v_bot;
  if not found or v_policy is null
     or jsonb_typeof(v_policy -> 'max_bytes') is distinct from 'number' or (v_policy ->> 'max_bytes') !~ '^[0-9]{1,15}$'
     or jsonb_typeof(v_policy -> 'max_pages') is distinct from 'number' or (v_policy ->> 'max_pages') !~ '^[0-9]{1,15}$' then
    raise exception 'upload policy max_bytes and max_pages are missing or invalid' using errcode = 'RB036';
  end if;
  v_bytes := (v_policy ->> 'max_bytes')::bigint;
  v_pages := (v_policy ->> 'max_pages')::bigint;
  if v_bytes < 1 or v_bytes > 1099511627776 or v_pages < 1 or v_pages > 1000000 then
    raise exception 'upload policy max_bytes or max_pages is out of range' using errcode = 'RB036';
  end if;

  return query select v_bot, v_doc, v_ver.id, v_ver.version_number, v_ver.status, v_ver.storage_path, v_ver.media_type,
                      v_ver.byte_size, v_ver.upload_etag, v_model, v_bytes, v_pages, v_active, v_act_num,
                      v_ver.batches_done, v_written, v_ver.chunking_version, v_ver.extraction_version, v_ver.embedding_model;
end;
$_$;


ALTER FUNCTION "public"."get_index_job_context"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_rate_policy"("p_bot_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
declare
  v_enabled boolean;
  v_rate    jsonb;
begin
  if p_bot_id is null then
    raise exception 'get_rate_policy: bot is required' using errcode = '22023';
  end if;

  select b.enabled into v_enabled from public.bot_profiles b where b.id = p_bot_id;
  if not found or not v_enabled then
    raise exception 'get_rate_policy: bot is disabled or unknown' using errcode = 'RB039';
  end if;

  select cs.rate_policy into v_rate from public.client_settings cs where cs.bot_id = p_bot_id;
  if not found then
    raise exception 'get_rate_policy: no client settings for bot' using errcode = 'RB036';
  end if;
  return v_rate;
end;
$$;


ALTER FUNCTION "public"."get_rate_policy"("p_bot_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_request_run"("p_bot_id" "uuid", "p_run_id" "uuid") RETURNS TABLE("run_state" "text", "conversation_id" "uuid", "message_id" "uuid", "message_status" "text")
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
begin
  if p_bot_id is null or p_run_id is null then
    raise exception 'get_request_run: bot and run are required' using errcode = '22023';
  end if;

  return query
  select r.state, m.conversation_id, m.id, m.status
    from public.request_runs r
    left join lateral (
      select am.conversation_id, am.id, am.status
        from public.messages am
        join public.conversations c on c.id = am.conversation_id and c.bot_id = r.bot_id
       where am.request_id = r.id and am.role = 'assistant'
       order by am.created_at desc, am.id desc
       limit 1
    ) m on true
   where r.id = p_run_id and r.bot_id = p_bot_id;
end;
$$;


ALTER FUNCTION "public"."get_request_run"("p_bot_id" "uuid", "p_run_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_session_policy"("p_bot_slug" "text") RETURNS TABLE("bot_id" "uuid", "enabled" boolean, "turnstile_required" boolean, "session_limit" integer, "session_window_seconds" integer, "bot_session_limit" integer, "bot_session_window_seconds" integer)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
#variable_conflict use_column
declare
  v_bot_id   uuid;
  v_enabled  boolean;
  v_rate     jsonb;
  v_flags    jsonb;
  v_pol      jsonb;
  v_limit    text;
  v_window   text;
  v_bot_pol  jsonb;
  v_bot_limit  text;
  v_bot_window text;
begin
  if p_bot_slug is null or p_bot_slug = '' then
    raise exception 'get_session_policy: bot slug is required' using errcode = '22023';
  end if;

  select b.id, b.enabled into v_bot_id, v_enabled from public.bot_profiles b where b.slug = p_bot_slug;
  if not found then
    return;
  end if;
  if not v_enabled then
    return query select v_bot_id, false, null::boolean, null::integer, null::integer, null::integer, null::integer;
    return;
  end if;

  select cs.rate_policy, cs.feature_flags into v_rate, v_flags
    from public.client_settings cs where cs.bot_id = v_bot_id;
  if not found then
    raise exception 'get_session_policy: no client settings for bot' using errcode = 'RB036';
  end if;

  v_pol := v_rate -> 'session_create_per_ip';
  if v_pol is null or jsonb_typeof(v_pol) <> 'object'
     or jsonb_typeof(v_pol -> 'limit') is distinct from 'number'
     or jsonb_typeof(v_pol -> 'window_seconds') is distinct from 'number' then
    raise exception 'get_session_policy: session_create_per_ip is missing or invalid' using errcode = 'RB036';
  end if;
  v_limit  := v_pol ->> 'limit';
  v_window := v_pol ->> 'window_seconds';
  if v_limit !~ '^[1-9][0-9]{0,8}$' or v_window !~ '^[1-9][0-9]{0,5}$' or v_window::integer > 86400 then
    raise exception 'get_session_policy: session_create_per_ip is missing or invalid' using errcode = 'RB036';
  end if;

  v_bot_pol := v_rate -> 'session_create_per_bot';
  if v_bot_pol is null or jsonb_typeof(v_bot_pol) <> 'object'
     or jsonb_typeof(v_bot_pol -> 'limit') is distinct from 'number'
     or jsonb_typeof(v_bot_pol -> 'window_seconds') is distinct from 'number' then
    raise exception 'get_session_policy: session_create_per_bot is missing or invalid' using errcode = 'RB036';
  end if;
  v_bot_limit  := v_bot_pol ->> 'limit';
  v_bot_window := v_bot_pol ->> 'window_seconds';
  if v_bot_limit !~ '^[1-9][0-9]{0,8}$' or v_bot_window !~ '^[1-9][0-9]{0,5}$' or v_bot_window::integer > 86400 then
    raise exception 'get_session_policy: session_create_per_bot is missing or invalid' using errcode = 'RB036';
  end if;

  return query select v_bot_id, v_enabled,
    case when jsonb_typeof(v_flags -> 'turnstile_required') = 'boolean'
         then (v_flags ->> 'turnstile_required')::boolean else true end,
    v_limit::integer, v_window::integer, v_bot_limit::integer, v_bot_window::integer;
end;
$_$;


ALTER FUNCTION "public"."get_session_policy"("p_bot_slug" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_warm_job_context"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
declare v_bot_id uuid; v_bot public.bot_profiles%rowtype; v_policy jsonb;
  v_payload jsonb; v_suggested jsonb; v_faq jsonb; v_questions jsonb; v_languages jsonb;
begin
  v_bot_id := public.warm_job_fence(p_job_id, p_worker, p_generation);
  select * into v_bot from public.bot_profiles b where b.id = v_bot_id;
  if not found then return jsonb_build_object('state', 'superseded'); end if;
  select j.payload into v_payload from public.jobs j where j.id = p_job_id;
  if v_payload->>'corpus_version' is distinct from v_bot.corpus_version::text
     or v_payload->>'settings_version' is distinct from v_bot.settings_version::text then
    return jsonb_build_object('state', 'superseded');
  end if;
  select cs.cache_policy into v_policy from public.client_settings cs where cs.bot_id = v_bot_id;
  if not v_bot.enabled or not public.warm_policy_enabled(v_policy) then
    return jsonb_build_object('state', 'disabled');
  end if;
  select c.suggested_questions into v_suggested from public.public_bot_config c where c.bot_id = v_bot_id;
  v_suggested := coalesce(v_suggested, '[]'::jsonb);
  v_faq := coalesce(v_policy->'warm_questions', '[]'::jsonb);
  if jsonb_typeof(v_suggested) <> 'array' or jsonb_typeof(v_faq) <> 'array'
     or jsonb_array_length(v_faq) > 12 then
    raise exception 'warm job: invalid questions policy' using errcode = '22023';
  end if;
  if exists(select 1 from jsonb_array_elements(v_suggested || v_faq) q(value)
    where jsonb_typeof(q.value) <> 'string'
      or char_length(q.value #>> '{}') not between 1 and 2000) then
    raise exception 'warm job: invalid question' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(q.value order by q.ord), '[]'::jsonb) into v_questions
    from (select value, ord from jsonb_array_elements(v_suggested || v_faq)
      with ordinality q(value, ord) order by ord limit 12) q;
  select coalesce(jsonb_agg(q.value order by q.value), '[""]'::jsonb) into v_languages
    from (select distinct value from jsonb_array_elements_text(
      '[""]'::jsonb || to_jsonb(v_bot.allowed_languages)) q(value)) q;
  if jsonb_array_length(v_languages) > 21 then
    raise exception 'warm job: invalid language policy' using errcode = '22023';
  end if;
  return jsonb_build_object('state', 'ready', 'context', public.get_chat_context(v_bot_id),
    'questions', v_questions, 'languages', v_languages);
end;
$$;


ALTER FUNCTION "public"."get_warm_job_context"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."heartbeat_job"("p_job_id" "uuid", "p_worker" "text", "p_lease_seconds" integer) RETURNS timestamp with time zone
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  v_until timestamptz;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = '' then
    raise exception 'heartbeat_job: job and worker id are required' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'heartbeat_job: lease seconds must be between 1 and 3600' using errcode = '22023';
  end if;
  update public.jobs
     set locked_until = now() + make_interval(secs => p_lease_seconds)
   where id = p_job_id and state = 'running' and locked_by = p_worker
  returning locked_until into v_until;
  if not found then
    raise exception 'heartbeat_job: lease not held' using errcode = 'RB013';
  end if;
  return v_until;
end;
$$;


ALTER FUNCTION "public"."heartbeat_job"("p_job_id" "uuid", "p_worker" "text", "p_lease_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."index_job_fence"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid") RETURNS TABLE("bot_id" "uuid", "document_id" "uuid")
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
#variable_conflict use_column
declare
  v_doc_id  uuid;
  v_bot_id  uuid;
  v_deleted timestamptz;
  v_job     public.jobs%rowtype;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = '' or p_version_id is null then
    raise exception 'index_job_fence: job, worker and version are required' using errcode = '22023';
  end if;

  select v.document_id into v_doc_id from public.document_versions v where v.id = p_version_id;
  if not found then
    raise exception 'index job: lease not held' using errcode = 'RB013';
  end if;

  perform 1 from public.documents d where d.id = v_doc_id for no key update;
  select * into v_job from public.jobs j where j.id = p_job_id for share;
  if not found
     or v_job.state <> 'running'
     or v_job.locked_by is distinct from p_worker
     or v_job.locked_until is null or v_job.locked_until <= clock_timestamp()
     or v_job.type <> 'index_document'
     or (v_job.payload ->> 'version_id') is distinct from p_version_id::text
     or ((v_job.payload ? 'document_id') and (v_job.payload ->> 'document_id') is distinct from v_doc_id::text) then
    raise exception 'index job: lease not held' using errcode = 'RB013';
  end if;

  select d.bot_id, d.deleted_at into v_bot_id, v_deleted from public.documents d where d.id = v_doc_id;
  if not found or v_deleted is not null then
    raise exception 'index job: document not found or deleted' using errcode = 'RB010';
  end if;

  return query select v_bot_id, v_doc_id;
end;
$$;


ALTER FUNCTION "public"."index_job_fence"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_active_member"("p_roles" "text"[]) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select coalesce(
    (
      select exists (
        select 1
        from public.admin_memberships m
        where m.user_id = (select auth.uid())
          and m.active
          and m.role = any (p_roles)
      )
    ),
    false
  );
$$;


ALTER FUNCTION "public"."is_active_member"("p_roles" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_active_member_mfa"("p_roles" "text"[]) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select coalesce((select auth.jwt() ->> 'aal') = 'aal2', false)
     and public.is_active_member(p_roles);
$$;


ALTER FUNCTION "public"."is_active_member_mfa"("p_roles" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."job_status_summary"() RETURNS TABLE("job_type" "text", "job_state" "text", "job_count" bigint)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if not public.is_active_member_mfa(array['owner', 'admin', 'analyst']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return query
  select j.type, j.state, count(*)::bigint
  from public.jobs j
  group by j.type, j.state
  order by j.type, j.state;
end;
$$;


ALTER FUNCTION "public"."job_status_summary"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."knowledge_gaps"("p_from" "date", "p_to" "date", "p_limit" integer) RETURNS TABLE("handoff_reason" "text", "question" "text", "occurrences" bigint, "last_seen" timestamp with time zone)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_is_admin boolean;
begin
  if not public.is_active_member_mfa(array['owner', 'admin', 'analyst']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'knowledge_gaps: invalid date range' using errcode = '22023';
  end if;
  if (p_to - p_from) + 1 > 92 then
    raise exception 'knowledge_gaps: range must not exceed 92 days' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'knowledge_gaps: limit must be between 1 and 200' using errcode = '22023';
  end if;

  v_is_admin := public.is_active_member_mfa(array['owner', 'admin']);

  return query
  select
    a.handoff_reason,
    left(btrim(q.content), 500),
    count(*)::bigint,
    max(a.created_at)
  from public.messages a
  cross join lateral (
    select u.content
    from public.messages u
    where u.conversation_id = a.conversation_id
      and u.role = 'user'
      and case
            when a.reply_to_message_id is not null then u.id = a.reply_to_message_id
            when a.request_id is not null then u.request_id = a.request_id
            else u.created_at <= a.created_at
          end
    order by u.created_at desc, u.id desc
    limit 1
  ) q
  where a.handoff_reason is not null
    and a.role = 'assistant'
    and (v_is_admin or a.handoff_reason <> 'blocked')
    and a.created_at >= (p_from::timestamp at time zone 'UTC')
    and a.created_at <  ((p_to + 1)::timestamp at time zone 'UTC')
  group by a.handoff_reason, left(btrim(q.content), 500)
  order by count(*) desc, max(a.created_at) desc
  limit p_limit;
end;
$$;


ALTER FUNCTION "public"."knowledge_gaps"("p_from" "date", "p_to" "date", "p_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."knowledge_gaps"("p_from" "date", "p_to" "date", "p_limit" integer) IS 'Unanswered-question report for MFA members. Hiding handoff_reason=blocked from analysts is a UX filter only: analysts can read public.messages directly (P3-D2 N4).';



CREATE OR REPLACE FUNCTION "public"."mark_document_deleted"("p_document_id" "uuid", "p_cleanup_max_attempts" integer) RETURNS bigint
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  v_doc    public.documents%rowtype;
  v_corpus bigint;
begin
  if p_document_id is null or p_cleanup_max_attempts is null or p_cleanup_max_attempts < 1 then
    raise exception 'mark_document_deleted: document and positive max attempts are required'
      using errcode = '22023';
  end if;

  select * into v_doc from public.documents where id = p_document_id for update;
  if not found then
    raise exception 'mark_document_deleted: document not found' using errcode = 'RB010';
  end if;

  if v_doc.deleted_at is null then
    update public.documents set deleted_at = now(), status = 'deleted' where id = p_document_id;
    update public.bot_profiles set corpus_version = corpus_version + 1
     where id = v_doc.bot_id
    returning corpus_version into v_corpus;
  else
    select b.corpus_version into v_corpus from public.bot_profiles b where b.id = v_doc.bot_id;
  end if;

  insert into public.jobs (type, dedupe_key, payload, max_attempts)
  values (
    'cleanup',
    'cleanup:document:' || p_document_id::text,
    jsonb_build_object('bot_id', v_doc.bot_id, 'scope', 'document', 'resource_id', p_document_id),
    p_cleanup_max_attempts
  )
  on conflict (dedupe_key) where state in ('queued', 'running') do nothing;

  return v_corpus;
end;
$$;


ALTER FUNCTION "public"."mark_document_deleted"("p_document_id" "uuid", "p_cleanup_max_attempts" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_document_chunks"("p_bot_id" "uuid", "p_query_embedding" "extensions"."vector", "p_match_count" integer, "p_min_similarity" double precision DEFAULT NULL::double precision) RETURNS TABLE("chunk_id" "uuid", "document_id" "uuid", "document_version_id" "uuid", "document_title" "text", "chunk_index" integer, "content" "text", "page_number" integer, "section" "text", "metadata" "jsonb", "similarity" double precision)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    SET "hnsw.iterative_scan" TO 'strict_order'
    AS $$
begin
  if p_bot_id is null or p_query_embedding is null then
    raise exception 'match_document_chunks: bot id and query embedding are required'
      using errcode = '22023';
  end if;
  if p_match_count is null or p_match_count < 1 or p_match_count > 50 then
    raise exception 'match_document_chunks: match count must be between 1 and 50'
      using errcode = '22023';
  end if;
  if p_min_similarity is not null and (p_min_similarity < -1 or p_min_similarity > 1) then
    raise exception 'match_document_chunks: min similarity must be between -1 and 1'
      using errcode = '22023';
  end if;

  return query
  select
    c.id,
    d.id,
    c.document_version_id,
    d.title,
    c.chunk_index,
    c.content,
    c.page_number,
    c.section,
    c.metadata,
    (1 - (c.embedding operator(extensions.<=>) p_query_embedding))::double precision as similarity
  from public.document_chunks c
  join public.document_versions v on v.id = c.document_version_id
  join public.documents d on d.id = v.document_id
  join public.bot_profiles b on b.id = d.bot_id
  where d.bot_id = p_bot_id
    and v.embedding_model = b.embedding_model
    and d.active_version_id = c.document_version_id
    and v.status = 'ready'
    and d.deleted_at is null
    and d.status <> 'deleted'
    and d.disclosure_policy = 'public_answer'
    and (
      p_min_similarity is null
      or (1 - (c.embedding operator(extensions.<=>) p_query_embedding)) >= p_min_similarity
    )
  order by c.embedding operator(extensions.<=>) p_query_embedding
  limit p_match_count;
end;
$$;


ALTER FUNCTION "public"."match_document_chunks"("p_bot_id" "uuid", "p_query_embedding" "extensions"."vector", "p_match_count" integer, "p_min_similarity" double precision) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."message_sources_check_ownership"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  v_bot       uuid;
  v_ver_bot   uuid;
  v_chunk_bot uuid;
  v_chunk_ver uuid;
  v_chunk_chg boolean;
  v_ver_chg   boolean;
begin
  if tg_op = 'UPDATE' then
    v_chunk_chg := new.chunk_id is not null and new.chunk_id is distinct from old.chunk_id;
    v_ver_chg   := new.document_version_id is not null and new.document_version_id is distinct from old.document_version_id;
    if new.message_id is not distinct from old.message_id and not v_chunk_chg and not v_ver_chg then
      return new;
    end if;
  end if;
  if new.chunk_id is null and new.document_version_id is null then
    return new;
  end if;

  select c.bot_id into v_bot
    from public.messages m join public.conversations c on c.id = m.conversation_id
   where m.id = new.message_id;
  if not found then
    raise exception 'message_sources: message not found' using errcode = '23514';
  end if;

  if new.document_version_id is not null then
    select d.bot_id into v_ver_bot
      from public.document_versions v join public.documents d on d.id = v.document_id
     where v.id = new.document_version_id;
    if not found or v_ver_bot <> v_bot then
      raise exception 'message_sources: document version does not belong to the message bot' using errcode = '23514';
    end if;
  end if;

  if new.chunk_id is not null then
    select ch.document_version_id, d.bot_id into v_chunk_ver, v_chunk_bot
      from public.document_chunks ch
      join public.document_versions v on v.id = ch.document_version_id
      join public.documents d on d.id = v.document_id
     where ch.id = new.chunk_id;
    if not found or v_chunk_bot <> v_bot then
      raise exception 'message_sources: chunk does not belong to the message bot' using errcode = '23514';
    end if;
    if new.document_version_id is not null and v_chunk_ver <> new.document_version_id then
      raise exception 'message_sources: chunk does not belong to the document version' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."message_sources_check_ownership"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."messages_check_reply_to"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  v_conv uuid;
  v_role text;
begin
  if tg_op = 'UPDATE' and old.role = 'user'
     and (new.role is distinct from old.role or new.conversation_id is distinct from old.conversation_id)
     and exists (select 1 from public.messages m where m.reply_to_message_id = old.id) then
    raise exception 'messages: a message that is the target of reply_to_message_id cannot change role or conversation'
      using errcode = '23514';
  end if;

  if new.reply_to_message_id is not null then
    select m.conversation_id, m.role into v_conv, v_role
      from public.messages m where m.id = new.reply_to_message_id
      for share;
    if not found or v_conv is distinct from new.conversation_id or v_role <> 'user' then
      raise exception 'messages: reply_to_message_id must reference a user message of the same conversation'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."messages_check_reply_to"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prune_superseded_chunks"("p_batch" integer) RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
#variable_conflict use_column
declare
  v_ids uuid[];
  v_n   integer;
begin
  if p_batch is null or p_batch < 1 or p_batch > 1000 then
    raise exception 'prune_superseded_chunks: batch (1..1000) is required' using errcode = '22023';
  end if;

  -- Ids first, then the delete (see cleanup_document: an IN subquery with LIMIT and FOR UPDATE can overrun the batch).
  select coalesce(array_agg(y.id), '{}'::uuid[]) into v_ids
    from (select x.id
            from public.document_chunks x
            join public.document_versions v on v.id = x.document_version_id
           where v.status = 'superseded'
           limit p_batch
             for update of x skip locked) y;
  delete from public.document_chunks c where c.id = any (v_ids);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


ALTER FUNCTION "public"."prune_superseded_chunks"("p_batch" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."public_bot_config_sync_published"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  new.is_published := coalesce((select b.enabled from public.bot_profiles b where b.id = new.bot_id), false);
  return new;
end;
$$;


ALTER FUNCTION "public"."public_bot_config_sync_published"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."publish_warm_answer"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_key_hash" "text", "p_bot_id" "uuid", "p_language" "text", "p_raw_question" "text", "p_answer_text" "text", "p_source_refs" "jsonb", "p_handoff_reason" "text", "p_status" "text", "p_moderated" boolean, "p_truncated" boolean, "p_prompt_template_version" "text", "p_chat_model" "text", "p_corpus_version" bigint, "p_settings_version" integer, "p_expires_at" timestamp with time zone) RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
declare v_bot_id uuid; v_bot public.bot_profiles%rowtype; v_policy jsonb;
  v_corpus bigint; v_settings integer; r jsonb;
  v_chunk uuid; v_version uuid;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = ''
     or p_generation is null or p_generation < 1
     or p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$'
     or p_bot_id is null
     or p_language is null or char_length(p_language) > 16
     or p_raw_question is null or char_length(p_raw_question) < 1
     or char_length(p_raw_question) > 2000
     or p_answer_text is null or p_answer_text = ''
     or char_length(p_answer_text) > 20000
     or p_source_refs is null or jsonb_typeof(p_source_refs) != 'array'
     or jsonb_array_length(p_source_refs) > 20
     or (p_handoff_reason is not null and p_handoff_reason not in
       ('no_knowledge','out_of_scope','human_requested','blocked','unavailable','repeated_no_knowledge'))
     or p_status is null or p_status not in ('complete','partial','failed','blocked')
     or p_moderated is null
     or p_truncated is null
     or p_prompt_template_version is null or p_prompt_template_version = ''
     or char_length(p_prompt_template_version) > 64
     or p_chat_model is null or p_chat_model = '' or char_length(p_chat_model) > 128
     or p_corpus_version is null
     or p_settings_version is null
     or p_expires_at is null or p_expires_at <= now() then
    raise exception 'warm publish: invalid answer record' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p_source_refs) as value loop
    if jsonb_typeof(r) != 'object'
       or r->>'chunk_id' is null
       or r->>'document_version_id' is null
       or lower(r->>'chunk_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or lower(r->>'document_version_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'warm publish: invalid answer citation' using errcode = '22023';
    end if;
  end loop;
  v_bot_id := public.warm_job_fence(p_job_id, p_worker, p_generation);
  if p_bot_id is distinct from v_bot_id then
    raise exception 'warm publish: job not found for bot' using errcode = 'RB004';
  end if;
  select cs.cache_policy into v_policy from public.client_settings cs
    where cs.bot_id = v_bot_id for update;
  if not found then
    raise exception 'warm publish: no client settings for bot' using errcode = 'RB002';
  end if;
  select * into v_bot from public.bot_profiles b where b.id = v_bot_id for share;
  if not found then
    raise exception 'warm publish: bot not found' using errcode = 'RB004';
  end if;
  if not v_bot.enabled or not public.warm_policy_enabled(v_policy)
     or not public.warm_layer_enabled(v_policy, 'c7') then
    return false;
  end if;
  select (j.payload->>'corpus_version')::bigint, (j.payload->>'settings_version')::integer
    into v_corpus, v_settings from public.jobs j where j.id = p_job_id;
  if v_corpus is distinct from v_bot.corpus_version
     or v_settings is distinct from v_bot.settings_version
     or p_corpus_version is distinct from v_bot.corpus_version
     or p_settings_version is distinct from v_bot.settings_version then
    return false;
  end if;
  if p_status is distinct from 'complete' then
    return false;
  end if;
  if not p_moderated then
    return false;
  end if;
  if p_truncated then
    return false;
  end if;
  if p_prompt_template_version is distinct from 'rag-v2' then
    return false;
  end if;
  if p_handoff_reason = 'blocked' then
    return false;
  end if;
  if p_raw_question ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
     or p_answer_text ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
     or p_raw_question ~ '\+[1-9][0-9]{6,14}'
     or p_answer_text ~ '\+[1-9][0-9]{6,14}'
     or p_raw_question ~ '[0-9]{3}-[0-9]{3}-[0-9]{4}'
     or p_answer_text ~ '[0-9]{3}-[0-9]{3}-[0-9]{4}'
     or p_raw_question ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}'
     or p_answer_text ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}'
     or p_raw_question ~ '[0-9]{9,12}'
     or p_answer_text ~ '[0-9]{9,12}' then
    return false;
  end if;
  if p_raw_question ~* 'mailto:|tel:|whatsapp|contact@'
     or p_answer_text ~* 'mailto:|tel:|whatsapp|contact@' then
    return false;
  end if;
  if jsonb_array_length(p_source_refs) = 0 and p_handoff_reason is null then
    return false;
  end if;
  for r in select value from jsonb_array_elements(p_source_refs) as value loop
    v_chunk := (r->>'chunk_id')::uuid;
    v_version := (r->>'document_version_id')::uuid;
    if not exists(select 1 from public.document_chunks c
        join public.document_versions v on v.id = c.document_version_id
        join public.documents d on d.id = v.document_id
        where c.id = v_chunk and c.document_version_id = v_version
          and d.bot_id = v_bot_id
          and v.status = 'ready'
          and d.deleted_at is null and d.status <> 'deleted'
          and d.disclosure_policy = 'public_answer') then
      return false;
    end if;
  end loop;
  perform public.cache_set_answer(p_bot_id, p_key_hash, p_language, p_answer_text,
    p_source_refs, p_handoff_reason, v_bot.corpus_version, v_bot.settings_version,
    p_prompt_template_version, p_chat_model, p_expires_at);
  return true;
end;
$_$;


ALTER FUNCTION "public"."publish_warm_answer"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_key_hash" "text", "p_bot_id" "uuid", "p_language" "text", "p_raw_question" "text", "p_answer_text" "text", "p_source_refs" "jsonb", "p_handoff_reason" "text", "p_status" "text", "p_moderated" boolean, "p_truncated" boolean, "p_prompt_template_version" "text", "p_chat_model" "text", "p_corpus_version" bigint, "p_settings_version" integer, "p_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."publish_warm_embedding"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_key_hash" "text", "p_model" "text", "p_dimensions" integer, "p_embedding_text" "text", "p_expires_at" timestamp with time zone) RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
declare v_bot_id uuid; v_bot public.bot_profiles%rowtype; v_policy jsonb;
  v_corpus bigint; v_settings integer;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = ''
     or p_generation is null or p_generation < 1
     or p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$'
     or p_model is null or p_model = '' or length(p_model) > 128
     or p_dimensions is null or p_dimensions < 1 or p_dimensions > 100000
     or p_embedding_text is null or p_embedding_text = ''
     or p_expires_at is null or p_expires_at <= now() then
    raise exception 'warm publish: invalid embedding record' using errcode = '22023';
  end if;
  v_bot_id := public.warm_job_fence(p_job_id, p_worker, p_generation);
  select cs.cache_policy into v_policy from public.client_settings cs
    where cs.bot_id = v_bot_id for update;
  if not found then
    raise exception 'warm publish: no client settings for bot' using errcode = 'RB002';
  end if;
  select * into v_bot from public.bot_profiles b where b.id = v_bot_id for share;
  if not found then
    raise exception 'warm publish: bot not found' using errcode = 'RB004';
  end if;
  if not v_bot.enabled or not public.warm_policy_enabled(v_policy)
     or not public.warm_layer_enabled(v_policy, 'c4') then
    return false;
  end if;
  select (j.payload->>'corpus_version')::bigint, (j.payload->>'settings_version')::integer
    into v_corpus, v_settings from public.jobs j where j.id = p_job_id;
  if v_corpus is distinct from v_bot.corpus_version
     or v_settings is distinct from v_bot.settings_version then
    return false;
  end if;
  if p_model is distinct from v_bot.embedding_model
     or p_dimensions is distinct from v_bot.embedding_dimensions then
    return false;
  end if;
  perform public.cache_set_query_embedding(p_key_hash, p_model, p_dimensions,
    p_embedding_text, p_expires_at);
  return true;
end;
$_$;


ALTER FUNCTION "public"."publish_warm_embedding"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_key_hash" "text", "p_model" "text", "p_dimensions" integer, "p_embedding_text" "text", "p_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."publish_warm_moderation"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_key_hash" "text", "p_policy_version" "text", "p_verdict" "text", "p_model" "text", "p_expires_at" timestamp with time zone) RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
declare v_bot_id uuid; v_bot public.bot_profiles%rowtype; v_policy jsonb;
  v_corpus bigint; v_settings integer;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = ''
     or p_generation is null or p_generation < 1
     or p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$'
     or p_policy_version is null or p_policy_version = '' or length(p_policy_version) > 64
     or p_verdict is null or p_verdict not in ('allow', 'block')
     or p_model is null or p_model = '' or length(p_model) > 128
     or p_expires_at is null or p_expires_at <= now() then
    raise exception 'warm publish: invalid moderation record' using errcode = '22023';
  end if;
  v_bot_id := public.warm_job_fence(p_job_id, p_worker, p_generation);
  select cs.cache_policy into v_policy from public.client_settings cs
    where cs.bot_id = v_bot_id for update;
  if not found then
    raise exception 'warm publish: no client settings for bot' using errcode = 'RB002';
  end if;
  select * into v_bot from public.bot_profiles b where b.id = v_bot_id for share;
  if not found then
    raise exception 'warm publish: bot not found' using errcode = 'RB004';
  end if;
  if not v_bot.enabled or not public.warm_policy_enabled(v_policy)
     or not public.warm_layer_enabled(v_policy, 'c6') then
    return false;
  end if;
  select (j.payload->>'corpus_version')::bigint, (j.payload->>'settings_version')::integer
    into v_corpus, v_settings from public.jobs j where j.id = p_job_id;
  if v_corpus is distinct from v_bot.corpus_version
     or v_settings is distinct from v_bot.settings_version then
    return false;
  end if;
  -- No per-bot moderation model lives in the database: identity matching rests
  -- on the T06-validated worker configuration, deployed equal to the API's.
  perform public.cache_set_moderation(p_key_hash, p_policy_version, p_verdict,
    p_model, p_expires_at);
  return true;
end;
$_$;


ALTER FUNCTION "public"."publish_warm_moderation"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_key_hash" "text", "p_policy_version" "text", "p_verdict" "text", "p_model" "text", "p_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."publish_warm_retrieval"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_key_hash" "text", "p_bot_id" "uuid", "p_corpus_version" bigint, "p_embedding_hash" "text", "p_k" integer, "p_threshold" double precision, "p_language" "text", "p_chunk_refs" "jsonb", "p_expires_at" timestamp with time zone) RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
declare v_bot_id uuid; v_bot public.bot_profiles%rowtype; v_policy jsonb;
  v_corpus bigint; v_settings integer; r jsonb;
  v_chunk uuid; v_version uuid;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = ''
     or p_generation is null or p_generation < 1
     or p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$'
     or p_bot_id is null
     or p_embedding_hash is null or p_embedding_hash !~ '^[0-9a-f]{64}$'
     or p_k is null or p_k < 1 or p_k > 50 or p_threshold is null
     or p_chunk_refs is null or jsonb_typeof(p_chunk_refs) != 'array'
     or p_expires_at is null or p_expires_at <= now() then
    raise exception 'warm publish: invalid retrieval record' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p_chunk_refs) as value loop
    if jsonb_typeof(r) != 'object'
       or r->>'chunk_id' is null
       or r->>'document_version_id' is null
       or lower(r->>'chunk_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or lower(r->>'document_version_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'warm publish: invalid retrieval citation' using errcode = '22023';
    end if;
  end loop;
  v_bot_id := public.warm_job_fence(p_job_id, p_worker, p_generation);
  if p_bot_id is distinct from v_bot_id then
    raise exception 'warm publish: job not found for bot' using errcode = 'RB004';
  end if;
  select cs.cache_policy into v_policy from public.client_settings cs
    where cs.bot_id = v_bot_id for update;
  if not found then
    raise exception 'warm publish: no client settings for bot' using errcode = 'RB002';
  end if;
  select * into v_bot from public.bot_profiles b where b.id = v_bot_id for share;
  if not found then
    raise exception 'warm publish: bot not found' using errcode = 'RB004';
  end if;
  if not v_bot.enabled or not public.warm_policy_enabled(v_policy)
     or not public.warm_layer_enabled(v_policy, 'c5') then
    return false;
  end if;
  select (j.payload->>'corpus_version')::bigint, (j.payload->>'settings_version')::integer
    into v_corpus, v_settings from public.jobs j where j.id = p_job_id;
  if v_corpus is distinct from v_bot.corpus_version
     or v_settings is distinct from v_bot.settings_version
     or p_corpus_version is distinct from v_bot.corpus_version then
    return false;
  end if;
  for r in select value from jsonb_array_elements(p_chunk_refs) as value loop
    v_chunk := (r->>'chunk_id')::uuid;
    v_version := (r->>'document_version_id')::uuid;
    if not exists(select 1 from public.document_chunks c
        join public.document_versions v on v.id = c.document_version_id
        join public.documents d on d.id = v.document_id
        where c.id = v_chunk and c.document_version_id = v_version
          and d.bot_id = v_bot_id
          and v.status = 'ready'
          and d.deleted_at is null and d.status <> 'deleted'
          and d.disclosure_policy = 'public_answer') then
      return false;
    end if;
  end loop;
  if not exists(select 1 from public.query_embedding_cache c
      where c.embedding_model = v_bot.embedding_model
        and c.embedding_dimensions = v_bot.embedding_dimensions
        and c.expires_at > now()) then
    raise exception 'warm publish: no live embedding for bot model' using errcode = 'RB003';
  end if;
  perform public.cache_set_retrieval(p_key_hash, p_bot_id, p_corpus_version, p_embedding_hash,
    p_k, p_threshold, p_language, p_chunk_refs, p_expires_at);
  return true;
end;
$_$;


ALTER FUNCTION "public"."publish_warm_retrieval"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_key_hash" "text", "p_bot_id" "uuid", "p_corpus_version" bigint, "p_embedding_hash" "text", "p_k" integer, "p_threshold" double precision, "p_language" "text", "p_chunk_refs" "jsonb", "p_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."purge_expired_caches"("p_batch" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  v_q integer;
  v_m integer;
  v_a integer;
  v_r integer;
begin
  if p_batch is null or p_batch < 1 or p_batch > 100000 then
    raise exception 'purge_expired_caches: batch must be 1..100000' using errcode = '22023';
  end if;
  delete from public.query_embedding_cache
   where key_hash in (select c.key_hash from public.query_embedding_cache c where c.expires_at < now() limit p_batch);
  get diagnostics v_q = row_count;
  delete from public.moderation_cache
   where key_hash in (select c.key_hash from public.moderation_cache c where c.expires_at < now() limit p_batch);
  get diagnostics v_m = row_count;
  delete from public.answer_cache
   where id in (
     select c.id
       from public.answer_cache c
       join public.bot_profiles b on b.id = c.bot_id
      where c.expires_at < now()
         or c.corpus_version < b.corpus_version
         or c.settings_version < b.settings_version
      limit p_batch
   );
  get diagnostics v_a = row_count;
  delete from public.retrieval_cache
   where key_hash in (select c.key_hash from public.retrieval_cache c where c.expires_at < now() limit p_batch);
  get diagnostics v_r = row_count;
  return jsonb_build_object('query_embedding_cache', v_q, 'moderation_cache', v_m, 'answer_cache', v_a, 'retrieval_cache', v_r);
end;
$$;


ALTER FUNCTION "public"."purge_expired_caches"("p_batch" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."purge_expired_conversations"("p_batch" integer) RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $_$
declare
  v_n   integer := 0;
  v_cnt integer;
  r     record;
begin
  if p_batch is null or p_batch < 1 or p_batch > 10000 then
    raise exception 'purge_expired_conversations: batch must be 1..10000' using errcode = '22023';
  end if;

  -- Fail closed before deleting anything.
  if exists (
    select 1
      from public.bot_profiles b
      left join public.client_settings cs on cs.bot_id = b.id
     where cs.bot_id is null
        or coalesce(cs.retention_policy ->> 'conversation_days', '') !~ '^[1-9][0-9]{0,5}$'
  ) then
    raise exception 'purge_expired_conversations: conversation retention is not configured for every bot'
      using errcode = 'RB020';
  end if;

  for r in
    select cs.bot_id, (cs.retention_policy ->> 'conversation_days')::integer as days
      from public.client_settings cs
  loop
    with doomed as (
      select c.id from public.conversations c
       where c.bot_id = r.bot_id
         and coalesce(c.last_message_at, c.created_at) < now() - make_interval(days => r.days)
       order by coalesce(c.last_message_at, c.created_at)
       limit greatest(p_batch - v_n, 0)
       for update skip locked
    )
    delete from public.conversations c using doomed where c.id = doomed.id;
    get diagnostics v_cnt = row_count;
    v_n := v_n + v_cnt;
  end loop;
  return v_n;
end;
$_$;


ALTER FUNCTION "public"."purge_expired_conversations"("p_batch" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."purge_expired_data_entries"("p_batch" integer) RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $_$
declare
  v_n   integer := 0;
  v_cnt integer;
  v_ids uuid[];
  r     record;
begin
  if p_batch is null or p_batch < 1 or p_batch > 10000 then
    raise exception 'purge_expired_data_entries: batch must be 1..10000' using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.bot_profiles b
      left join public.client_settings cs on cs.bot_id = b.id
     where cs.bot_id is null
        or coalesce(cs.retention_policy ->> 'conversation_days', '') !~ '^[1-9][0-9]{0,5}$'
  ) then
    raise exception 'purge_expired_data_entries: conversation retention is not configured for every bot'
      using errcode = 'RB020';
  end if;

  for r in
    select cs.bot_id, (cs.retention_policy ->> 'conversation_days')::integer as days
      from public.client_settings cs
  loop
    exit when v_n >= p_batch;
    select coalesce(array_agg(x.id), '{}'::uuid[]) into v_ids
      from (
        select e.id from public.data_entries e
         where e.bot_id = r.bot_id
           and e.conversation_id is null
           and e.created_at < now() - make_interval(days => r.days)
         order by e.created_at
         limit p_batch - v_n
         for update skip locked
      ) x;
    delete from public.data_entries d where d.id = any (v_ids);
    get diagnostics v_cnt = row_count;
    v_n := v_n + v_cnt;
  end loop;
  return v_n;
end;
$_$;


ALTER FUNCTION "public"."purge_expired_data_entries"("p_batch" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."purge_expired_rate_limit_buckets"("p_batch" integer) RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare v_n integer;
begin
  if p_batch is null or p_batch < 1 or p_batch > 100000 then
    raise exception 'purge_expired_rate_limit_buckets: batch must be 1..100000' using errcode = '22023';
  end if;
  with doomed as (
    select b.key_hash, b.window_start, b.window_seconds from public.rate_limit_buckets b
     where b.expires_at < now()
     limit p_batch
     for update skip locked
  )
  delete from public.rate_limit_buckets b using doomed
   where b.key_hash = doomed.key_hash
     and b.window_start = doomed.window_start
     and b.window_seconds = doomed.window_seconds;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


ALTER FUNCTION "public"."purge_expired_rate_limit_buckets"("p_batch" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."purge_expired_usage_records"("p_batch" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $_$
declare
  v_u   integer := 0;
  v_b   integer := 0;
  v_cnt integer;
  r     record;
begin
  if p_batch is null or p_batch < 1 or p_batch > 100000 then
    raise exception 'purge_expired_usage_records: batch must be 1..100000' using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.bot_profiles b
      left join public.client_settings cs on cs.bot_id = b.id
     where cs.bot_id is null
        or coalesce(cs.retention_policy ->> 'usage_months', '') !~ '^[1-9][0-9]{0,3}$'
  ) then
    raise exception 'purge_expired_usage_records: usage retention is not configured for every bot'
      using errcode = 'RB020';
  end if;

  for r in
    select cs.bot_id, (cs.retention_policy ->> 'usage_months')::integer as months
      from public.client_settings cs
  loop
    delete from public.usage_events
     where id in (
       select u.id from public.usage_events u
        where u.bot_id = r.bot_id and u.created_at < now() - make_interval(months => r.months)
        limit greatest(p_batch - v_u, 0)
     );
    get diagnostics v_cnt = row_count;
    v_u := v_u + v_cnt;

    delete from public.budget_reservations
     where id in (
       select br.id from public.budget_reservations br
        where br.bot_id = r.bot_id
          and br.state <> 'reserved'
          and br.created_at < now() - make_interval(months => r.months)
        limit greatest(p_batch - v_b, 0)
     );
    get diagnostics v_cnt = row_count;
    v_b := v_b + v_cnt;
  end loop;
  return jsonb_build_object('usage_events', v_u, 'budget_reservations', v_b);
end;
$_$;


ALTER FUNCTION "public"."purge_expired_usage_records"("p_batch" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."purge_terminal_jobs"("p_older_than_days" integer, "p_batch" integer) RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare v_n integer;
begin
  if p_older_than_days is null or p_older_than_days < 1 or p_older_than_days > 3650 then
    raise exception 'purge_terminal_jobs: older-than days must be 1..3650' using errcode = '22023';
  end if;
  if p_batch is null or p_batch < 1 or p_batch > 10000 then
    raise exception 'purge_terminal_jobs: batch must be 1..10000' using errcode = '22023';
  end if;
  with doomed as (
    select j.id from public.jobs j
     where j.state in ('succeeded', 'failed', 'cancelled')
       and coalesce(j.completed_at, j.created_at) < now() - make_interval(days => p_older_than_days)
     order by coalesce(j.completed_at, j.created_at)
     limit p_batch
     for update skip locked
  )
  delete from public.jobs j using doomed where j.id = doomed.id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


ALTER FUNCTION "public"."purge_terminal_jobs"("p_older_than_days" integer, "p_batch" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."queue_analysis_job"("p_bot_id" "uuid", "p_conversation_id" "uuid", "p_debounce_seconds" integer) RETURNS "uuid"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
declare v_id uuid;
begin
  if p_bot_id is null or p_conversation_id is null or p_debounce_seconds is null
     or p_debounce_seconds not between 0 and 3600 then
    raise exception 'analysis queue: invalid arguments' using errcode = '22023';
  end if;
  if not exists(select 1 from public.conversations c where c.id = p_conversation_id and c.bot_id = p_bot_id) then
    raise exception 'analysis queue: conversation not found' using errcode = 'RB037';
  end if;
  insert into public.jobs as j(type, dedupe_key, payload, max_attempts, available_at, analysis_requested_revision)
    values('analyze_conversation', 'analyze_conversation:' || p_conversation_id::text,
      jsonb_build_object('bot_id', p_bot_id, 'conversation_id', p_conversation_id), 5,
      now() + make_interval(secs => p_debounce_seconds), 1)
    on conflict (dedupe_key) where state in ('queued', 'running') do update
      set analysis_requested_revision = j.analysis_requested_revision + 1,
          available_at = greatest(j.available_at, excluded.available_at)
    returning j.id into v_id;
  return v_id;
end;
$$;


ALTER FUNCTION "public"."queue_analysis_job"("p_bot_id" "uuid", "p_conversation_id" "uuid", "p_debounce_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."queue_warm_job"("p_bot_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
declare v_bot public.bot_profiles%rowtype; v_policy jsonb; v_id uuid; v_max_attempts integer;
begin
  select * into v_bot from public.bot_profiles b where b.id = p_bot_id;
  if not found or not v_bot.enabled then return null; end if;
  select cs.cache_policy into v_policy from public.client_settings cs where cs.bot_id = p_bot_id;
  if not public.warm_policy_enabled(v_policy) then return null; end if;
  -- Explicit operator policy, no retry default. Validate before casting so
  -- nulls, strings, fractions and out-of-range numbers fail with a stable code.
  if jsonb_typeof(v_policy->'warm_max_attempts') is distinct from 'number'
     or v_policy->>'warm_max_attempts' !~ '^(10|[1-9])$' then
    raise exception 'warm job: retry limit must be an integer from 1 to 10' using errcode = '22023';
  end if;
  v_max_attempts := (v_policy->>'warm_max_attempts')::integer;
  insert into public.jobs(type, payload, max_attempts)
    values('warm_answer_cache', jsonb_build_object('bot_id', v_bot.id,
      'corpus_version', v_bot.corpus_version, 'settings_version', v_bot.settings_version), v_max_attempts)
    on conflict ((payload->>'bot_id'), (payload->>'corpus_version'), (payload->>'settings_version'))
      where type = 'warm_answer_cache' do nothing returning id into v_id;
  if v_id is null then
    select j.id into v_id from public.jobs j where j.type = 'warm_answer_cache'
      and j.payload->>'bot_id' = v_bot.id::text
      and j.payload->>'corpus_version' = v_bot.corpus_version::text
      and j.payload->>'settings_version' = v_bot.settings_version::text;
  end if;
  return v_id;
end;
$_$;


ALTER FUNCTION "public"."queue_warm_job"("p_bot_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_analysis_usage"("p_job_id" "uuid", "p_generation" integer, "p_reservation_id" "uuid", "p_provider" "text", "p_model" "text", "p_input_tokens" integer, "p_output_tokens" integer, "p_estimated_cost" numeric, "p_latency_ms" integer) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
declare v_bot uuid; v_state text; v_cost numeric;
begin
  if p_input_tokens is null or p_input_tokens < 0 or p_output_tokens is null or p_output_tokens < 0
     or p_estimated_cost is null or p_estimated_cost < 0 or p_estimated_cost >= 100000000
     or p_latency_ms is null or p_latency_ms < 0 or p_provider is null or char_length(p_provider) > 100
     or p_model is null or char_length(p_model) > 200 then
    raise exception 'analysis usage: invalid counts' using errcode = '22023';
  end if;
  select br.bot_id into v_bot from public.budget_reservations br
    where br.id = p_reservation_id and br.job_id = p_job_id and br.analysis_generation = p_generation;
  if not found then raise exception 'analysis usage: reservation mismatch' using errcode = 'RB003'; end if;
  perform 1 from public.client_settings cs where cs.bot_id = v_bot for update;
  if not found then raise exception 'analysis usage: policy missing' using errcode = 'RB002'; end if;
  select br.state into v_state from public.budget_reservations br where br.id = p_reservation_id for update;
  v_cost := ceil(p_estimated_cost * 1000000) / 1000000;
  insert into public.usage_events as ue(bot_id, job_id, budget_reservation_id, provider, model, operation, input_tokens, output_tokens, estimated_cost, latency_ms)
    values(v_bot, p_job_id, p_reservation_id, p_provider, p_model, 'analysis', p_input_tokens, p_output_tokens, v_cost, p_latency_ms)
    on conflict (budget_reservation_id) where budget_reservation_id is not null do update
    set input_tokens = greatest(ue.input_tokens, excluded.input_tokens), output_tokens = greatest(ue.output_tokens, excluded.output_tokens),
        estimated_cost = greatest(ue.estimated_cost, excluded.estimated_cost), latency_ms = greatest(ue.latency_ms, excluded.latency_ms);
  if v_state in ('settled', 'released') then
    update public.budget_reservations br set state = 'settled', amount = greatest(br.amount, v_cost) where br.id = p_reservation_id;
  end if;
end;
$$;


ALTER FUNCTION "public"."record_analysis_usage"("p_job_id" "uuid", "p_generation" integer, "p_reservation_id" "uuid", "p_provider" "text", "p_model" "text", "p_input_tokens" integer, "p_output_tokens" integer, "p_estimated_cost" numeric, "p_latency_ms" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_rate_limit_attempt"("p_key_hash" "text", "p_window_seconds" integer, "p_limit" integer) RETURNS TABLE("request_count" integer, "allowed" boolean, "window_start" timestamp with time zone, "window_expires_at" timestamp with time zone)
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
#variable_conflict use_column
declare
  v_start timestamptz;
  v_count integer;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'record_rate_limit_attempt: key must be a 64-char lowercase hex digest' using errcode = '22023';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'record_rate_limit_attempt: window must be 1..86400 seconds' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'record_rate_limit_attempt: limit must be positive' using errcode = '22023';
  end if;

  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limit_buckets as b (key_hash, window_start, window_seconds, request_count, expires_at)
  values (p_key_hash, v_start, p_window_seconds, 1, v_start + make_interval(secs => p_window_seconds))
  on conflict (key_hash, window_start, window_seconds)
  do update set request_count = case
                              when b.request_count::bigint >= p_limit::bigint + 1 then b.request_count
                              else b.request_count + 1
                            end
  returning b.request_count into v_count;

  return query
  select v_count, v_count <= p_limit, v_start, v_start + make_interval(secs => p_window_seconds);
end;
$_$;


ALTER FUNCTION "public"."record_rate_limit_attempt"("p_key_hash" "text", "p_window_seconds" integer, "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_request_usage"("p_bot_id" "uuid", "p_run_id" "uuid", "p_provider" "text", "p_model" "text", "p_operation" "text", "p_input_tokens" integer, "p_output_tokens" integer, "p_estimated_cost" numeric, "p_latency_ms" integer) RETURNS "uuid"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
#variable_conflict use_column
declare
  v_id uuid;
begin
  if p_bot_id is null or p_run_id is null
     or p_operation is null or p_operation not in ('chat', 'embedding_query', 'moderation')
     or p_input_tokens is null or p_input_tokens < 0
     or p_output_tokens is null or p_output_tokens < 0
     or p_estimated_cost is null or p_estimated_cost < 0 or p_estimated_cost >= 100000000
     or (p_latency_ms is not null and p_latency_ms < 0)
     or (p_provider is not null and char_length(p_provider) > 100)
     or (p_model is not null and char_length(p_model) > 200) then
    raise exception 'record_request_usage: bot, run, a known operation and non-negative counts are required' using errcode = '22023';
  end if;

  perform 1 from public.request_runs r where r.id = p_run_id and r.bot_id = p_bot_id for key share;
  if not found then
    raise exception 'record_request_usage: not found' using errcode = 'RB037';
  end if;

  insert into public.usage_events (bot_id, request_id, provider, model, operation, input_tokens, output_tokens,
                                   estimated_cost, latency_ms)
  values (p_bot_id, p_run_id, p_provider, p_model, p_operation, p_input_tokens, p_output_tokens,
          p_estimated_cost, p_latency_ms)
  returning id into v_id;
  return v_id;
end;
$$;


ALTER FUNCTION "public"."record_request_usage"("p_bot_id" "uuid", "p_run_id" "uuid", "p_provider" "text", "p_model" "text", "p_operation" "text", "p_input_tokens" integer, "p_output_tokens" integer, "p_estimated_cost" numeric, "p_latency_ms" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_usage_event"("p_bot_id" "uuid", "p_job_id" "uuid", "p_provider" "text", "p_model" "text", "p_operation" "text", "p_input_tokens" integer, "p_estimated_cost" numeric, "p_latency_ms" integer) RETURNS "uuid"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
#variable_conflict use_column
declare
  v_job_bot text;
  v_id      uuid;
begin
  if p_bot_id is null
     or p_operation is null
        or p_operation not in ('chat', 'embedding_query', 'embedding_index', 'moderation', 'analysis', 'answer_cache_hit')
     or p_input_tokens is null or p_input_tokens < 0
     or p_estimated_cost is null or p_estimated_cost < 0 or p_estimated_cost >= 100000000
     or (p_latency_ms is not null and p_latency_ms < 0)
     or (p_provider is not null and char_length(p_provider) > 100)
     or (p_model is not null and char_length(p_model) > 200) then
    raise exception 'record_usage_event: bot, a known operation and non-negative counts are required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.bot_profiles b where b.id = p_bot_id) then
    raise exception 'record_usage_event: bot not found' using errcode = '22023';
  end if;
  if p_job_id is not null then
    select j.payload ->> 'bot_id' into v_job_bot from public.jobs j where j.id = p_job_id;
    if not found or (v_job_bot is not null and v_job_bot <> p_bot_id::text) then
      raise exception 'record_usage_event: job not found for bot' using errcode = '22023';
    end if;
  end if;

  insert into public.usage_events (bot_id, job_id, provider, model, operation, input_tokens, estimated_cost, latency_ms)
  values (p_bot_id, p_job_id, p_provider, p_model, p_operation, p_input_tokens, p_estimated_cost, p_latency_ms)
  returning id into v_id;
  return v_id;
end;
$$;


ALTER FUNCTION "public"."record_usage_event"("p_bot_id" "uuid", "p_job_id" "uuid", "p_provider" "text", "p_model" "text", "p_operation" "text", "p_input_tokens" integer, "p_estimated_cost" numeric, "p_latency_ms" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_warm_usage"("p_job_id" "uuid", "p_generation" integer, "p_question_hash" "text", "p_reservation_id" "uuid", "p_invocation_id" "uuid", "p_provider" "text", "p_model" "text", "p_operation" "text", "p_input_tokens" integer, "p_output_tokens" integer, "p_estimated_cost" numeric, "p_latency_ms" integer, "p_final" boolean) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
declare
  v_bot uuid;
  v_cost numeric;
begin
  if p_job_id is null or p_generation is null or p_generation < 1
     or p_question_hash is null or p_question_hash !~ '^[0-9a-f]{64}$'
     or p_reservation_id is null or p_invocation_id is null
     or p_provider is null or char_length(p_provider) > 100
     or p_model is null or char_length(p_model) > 200
     or p_operation is null or p_operation not in
       ('chat', 'embedding_query', 'embedding_index', 'moderation', 'analysis', 'answer_cache_hit')
     or p_input_tokens is null or p_input_tokens < 0
     or p_output_tokens is null or p_output_tokens < 0
     or p_estimated_cost is null or p_estimated_cost < 0 or p_estimated_cost >= 100000000
     or p_latency_ms is null or p_latency_ms < 0 or p_final is null then
    raise exception 'warm usage: invalid invocation report' using errcode = '22023';
  end if;

  -- Original binding only: the reservation must belong to this job, generation
  -- and question. No lease or job-state check, so a late report after a
  -- takeover still lands on its own reservation.
  select br.bot_id into v_bot from public.budget_reservations br
   where br.id = p_reservation_id and br.job_id = p_job_id
     and br.warm_generation = p_generation and br.question_hash = p_question_hash;
  if not found then
    raise exception 'warm usage: reservation mismatch' using errcode = 'RB003';
  end if;
  perform 1 from public.client_settings cs where cs.bot_id = v_bot for update;
  if not found then
    raise exception 'warm usage: policy missing' using errcode = 'RB002';
  end if;
  perform 1 from public.budget_reservations br where br.id = p_reservation_id for update;

  v_cost := ceil(p_estimated_cost * 1000000) / 1000000;
  insert into public.usage_events as ue(bot_id, job_id, warm_reservation_id, warm_invocation_id,
    provider, model, operation, input_tokens, output_tokens, estimated_cost, latency_ms, state)
    values(v_bot, p_job_id, p_reservation_id, p_invocation_id, p_provider, p_model, p_operation,
      p_input_tokens, p_output_tokens, v_cost, p_latency_ms,
      case when p_final then 'final' else 'pending' end)
    on conflict (warm_reservation_id, warm_invocation_id)
      where warm_reservation_id is not null do update
    set input_tokens = greatest(ue.input_tokens, excluded.input_tokens),
        output_tokens = greatest(ue.output_tokens, excluded.output_tokens),
        estimated_cost = greatest(ue.estimated_cost, excluded.estimated_cost),
        latency_ms = greatest(ue.latency_ms, excluded.latency_ms),
        state = case when excluded.state = 'final' then 'final' else ue.state end;
end;
$_$;


ALTER FUNCTION "public"."record_warm_usage"("p_job_id" "uuid", "p_generation" integer, "p_question_hash" "text", "p_reservation_id" "uuid", "p_invocation_id" "uuid", "p_provider" "text", "p_model" "text", "p_operation" "text", "p_input_tokens" integer, "p_output_tokens" integer, "p_estimated_cost" numeric, "p_latency_ms" integer, "p_final" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_budget_reservation"("p_bot_id" "uuid", "p_reservation_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
begin
  if p_bot_id is null or p_reservation_id is null then
    raise exception 'release_budget_reservation: bot and reservation are required' using errcode = '22023';
  end if;

  perform 1 from public.client_settings cs where cs.bot_id = p_bot_id for update;
  if not found then
    raise exception 'release_budget_reservation: no client settings for bot' using errcode = 'RB002';
  end if;

  update public.budget_reservations set state = 'released'
   where id = p_reservation_id and bot_id = p_bot_id and state = 'reserved';
  if not found then
    raise exception 'release_budget_reservation: reservation is not active' using errcode = 'RB003';
  end if;
end;
$$;


ALTER FUNCTION "public"."release_budget_reservation"("p_bot_id" "uuid", "p_reservation_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_index_budget"("p_job_id" "uuid", "p_worker" "text", "p_reservation_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
#variable_conflict use_column
declare
  v_ver  text;
  v_bot  uuid;
  v_res  public.budget_reservations%rowtype;
  v_used numeric;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = '' or p_reservation_id is null then
    raise exception 'release_index_budget: job, worker and reservation are required' using errcode = '22023';
  end if;
  select j.payload ->> 'version_id' into v_ver from public.jobs j where j.id = p_job_id;
  if not found or v_ver is null or v_ver !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'index job: lease not held' using errcode = 'RB013';
  end if;
  select f.bot_id into v_bot from public.index_job_fence(p_job_id, p_worker, v_ver::uuid) f;

  perform 1 from public.client_settings cs where cs.bot_id = v_bot for update;
  if not found then
    raise exception 'release_index_budget: no client settings for bot' using errcode = 'RB002';
  end if;

  select * into v_res from public.budget_reservations br
   where br.id = p_reservation_id and br.job_id = p_job_id and br.bot_id = v_bot and br.state = 'reserved' for update;
  if not found then
    raise exception 'release_index_budget: reservation is not active' using errcode = 'RB003';
  end if;
  -- Usage recorded in this row's window (a stale worker's batch, review P6-R5 #2) is real spend: settle at it
  -- instead of releasing. With no usage the row is released as before.
  select least(coalesce(sum(ue.estimated_cost), 0), 99999999.999999) into v_used
    from public.usage_events ue
   where ue.job_id = v_res.job_id
     and ue.operation = 'embedding_index'
     and ue.created_at >= v_res.created_at;
  if v_used > 0 then
    update public.budget_reservations br set state = 'settled', amount = v_used where br.id = v_res.id;
  else
    update public.budget_reservations br set state = 'released' where br.id = v_res.id;
  end if;
end;
$_$;


ALTER FUNCTION "public"."release_index_budget"("p_job_id" "uuid", "p_worker" "text", "p_reservation_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_job_lease"("p_job_id" "uuid", "p_worker" "text") RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = '' then
    raise exception 'release_job_lease: job and worker id are required' using errcode = '22023';
  end if;

  update public.jobs j
     set state = 'queued',
         locked_by = null,
         locked_until = null,
         attempts = greatest(j.attempts - 1, 0),
         available_at = now()
   where j.id = p_job_id and j.state = 'running' and j.locked_by = p_worker;
  return found;
end;
$$;


ALTER FUNCTION "public"."release_job_lease"("p_job_id" "uuid", "p_worker" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."request_runs_check_state_transition"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if new.state is not distinct from old.state then
    return new;
  end if;
  if old.state = 'reserved' and new.state = 'running' then
    return new;
  end if;
  if old.state in ('reserved', 'running') and new.state in ('succeeded', 'failed', 'partial') then
    return new;
  end if;
  raise exception 'request_runs: state cannot change from % to %', old.state, new.state
    using errcode = '23514';
end;
$$;


ALTER FUNCTION "public"."request_runs_check_state_transition"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reserve_analysis_budget"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_amount" numeric, "p_ttl_seconds" integer) RETURNS "uuid"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
declare v_bot uuid; v_policy jsonb; v_cap text; v_spent numeric; v_id uuid;
begin
  if p_amount is null or p_amount <= 0 or p_amount >= 100000000
     or p_ttl_seconds is null or p_ttl_seconds not between 1 and 86400 then
    raise exception 'analysis budget: invalid amount or TTL' using errcode = '22023';
  end if;
  select f.bot_id into v_bot from public.analysis_job_fence(p_job_id, p_worker, p_generation) f;
  select cs.budget_policy into v_policy from public.client_settings cs where cs.bot_id = v_bot for update;
  v_cap := v_policy ->> 'daily_cap_usd';
  if v_cap is null or v_cap !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'analysis budget: policy missing' using errcode = 'RB002';
  end if;
  select br.id into v_id from public.budget_reservations br
    where br.job_id = p_job_id and br.analysis_generation = p_generation;
  if found then
    if exists(select 1 from public.budget_reservations br where br.id = v_id and br.state in ('reserved', 'expired'))
       and not exists(select 1 from public.usage_events ue where ue.budget_reservation_id = v_id) then
      return v_id;
    end if;
    raise exception 'analysis budget: invocation already accounted' using errcode = 'RB003';
  end if;

  update public.budget_reservations br set state = 'settled',
    amount = coalesce((select sum(ue.estimated_cost) from public.usage_events ue where ue.budget_reservation_id = br.id), br.amount)
    where br.job_id = p_job_id and br.analysis_generation is not null and br.state in ('reserved', 'expired');
  select coalesce(sum(br.amount), 0) into v_spent from public.budget_reservations br
    where br.bot_id = v_bot
      and br.created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')
      and (br.state = 'settled' or (br.state = 'reserved' and (br.job_id is not null or br.expires_at > now()))
        or (br.state = 'expired' and br.job_id is not null));
  if v_spent + ceil(p_amount * 1000000) / 1000000 > v_cap::numeric then
    raise exception 'analysis budget: daily cap exceeded' using errcode = 'RB001';
  end if;
  insert into public.budget_reservations(bot_id, job_id, analysis_generation, amount, state, expires_at)
    values(v_bot, p_job_id, p_generation, ceil(p_amount * 1000000) / 1000000, 'reserved', now() + make_interval(secs => p_ttl_seconds)) returning id into v_id;
  return v_id;
end;
$_$;


ALTER FUNCTION "public"."reserve_analysis_budget"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_amount" numeric, "p_ttl_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reserve_index_budget"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_amount" numeric, "p_ttl_seconds" integer) RETURNS "uuid"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
#variable_conflict use_column
declare
  v_bot      uuid;
  v_policy   jsonb;
  v_cap_text text;
  v_cap      numeric;
  v_spent    numeric;
  v_day      timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  v_id       uuid;
begin
  if p_amount is null or p_amount <= 0 or p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 86400 then
    raise exception 'reserve_index_budget: positive amount and ttl (1..86400s) are required' using errcode = '22023';
  end if;
  select f.bot_id into v_bot from public.index_job_fence(p_job_id, p_worker, p_version_id) f;

  -- No disabled-bot check here: knowledge is indexed before a bot is enabled. Chat start refuses a
  -- disabled bot instead (begin_request_run, reserve_request_budget).

  select cs.budget_policy into v_policy from public.client_settings cs where cs.bot_id = v_bot for update;
  if not found then
    raise exception 'reserve_index_budget: no client settings for bot' using errcode = 'RB002';
  end if;
  v_cap_text := v_policy ->> 'daily_cap_usd';
  if v_cap_text is null or v_cap_text !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'reserve_index_budget: daily cap is missing or invalid' using errcode = 'RB002';
  end if;
  v_cap := v_cap_text::numeric;

  -- The settings row is locked, so no other reservation of this bot runs now.
  -- The fence proves the caller holds the job now, and a worker reserves once per attempt, so every unsettled row of
  -- this job belongs to an earlier attempt that can no longer settle it (a lost lease is taken over running ->
  -- running by claim_jobs, so the maintenance sweep would not see it before this reserve). Settle those rows here, at
  -- the embedding_index usage recorded in each row's window, before the cap check (review P6-R5 #1): otherwise a
  -- crashed attempt's full reservation counts beside the retry's and can fail the retry with BUDGET_EXCEEDED.
  -- Window: [the row's created_at, the job's next row's created_at, or infinity), as in
  -- settle_orphaned_index_reservations. A refused reserve (RB001) rolls this back with the rest of the statement.
  update public.budget_reservations br
     set state = 'settled',
         amount = least(
           (select coalesce(sum(ue.estimated_cost), 0)
              from public.usage_events ue
             where ue.job_id = br.job_id
               and ue.operation = 'embedding_index'
               and ue.created_at >= br.created_at
               and ue.created_at < coalesce((select min(n.created_at) from public.budget_reservations n
                                              where n.job_id = br.job_id and (n.created_at, n.id) > (br.created_at, br.id)),
                                            'infinity'::timestamptz)),
           99999999.999999)
   where br.job_id = p_job_id and br.state in ('reserved', 'expired');

  select coalesce(sum(br.amount), 0) into v_spent
    from public.budget_reservations br
   where br.bot_id = v_bot
     and br.created_at >= v_day
     and (br.state = 'settled'
          -- A request reservation counts until expires_at; a job reservation counts while 'reserved' whatever its
          -- expires_at says, because the worker that holds the job may still be running and will settle it. Only
          -- settle or release by that holder, or settle_orphaned_index_reservations (for a row nobody can settle
          -- any more), ends that. The holder's fence (RB013) stops a stale worker, so it does NOT settle the row.
          or (br.state = 'reserved' and (br.job_id is not null or br.expires_at > now()))
          -- The same for a job reservation that expire_stale_budget_reservations already marked 'expired'.
          or (br.state = 'expired' and br.job_id is not null));

  if v_spent + p_amount > v_cap then
    raise exception 'reserve_index_budget: daily budget exceeded' using errcode = 'RB001';
  end if;

  insert into public.budget_reservations (bot_id, job_id, amount, state, expires_at)
  values (v_bot, p_job_id, p_amount, 'reserved', now() + make_interval(secs => p_ttl_seconds))
  returning id into v_id;
  return v_id;
end;
$_$;


ALTER FUNCTION "public"."reserve_index_budget"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_amount" numeric, "p_ttl_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reserve_request_budget"("p_bot_id" "uuid", "p_request_id" "uuid", "p_amount" numeric, "p_ttl_seconds" integer) RETURNS "uuid"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
declare
  v_enabled   boolean;
  v_policy    jsonb;
  v_cap_text  text;
  v_cap       numeric;
  v_spent     numeric;
  v_day       timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  v_existing  public.budget_reservations%rowtype;
  v_run_state text;
  v_id        uuid;
begin
  if p_bot_id is null or p_request_id is null or p_amount is null or p_amount <= 0
     or p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 86400 then
    raise exception 'reserve_request_budget: bot, request, positive amount and ttl (1..86400s) are required'
      using errcode = '22023';
  end if;

  select b.enabled into v_enabled from public.bot_profiles b where b.id = p_bot_id for share;
  if found and not v_enabled then
    raise exception 'reserve_request_budget: bot is disabled' using errcode = 'RB039';
  end if;

  select cs.budget_policy into v_policy
    from public.client_settings cs where cs.bot_id = p_bot_id for update;
  if not found then
    raise exception 'reserve_request_budget: no client settings for bot' using errcode = 'RB002';
  end if;

  v_cap_text := v_policy ->> 'daily_cap_usd';
  if v_cap_text is null or v_cap_text !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'reserve_request_budget: daily cap is missing or invalid' using errcode = 'RB002';
  end if;
  v_cap := v_cap_text::numeric;

  select r.state into v_run_state
    from public.request_runs r where r.id = p_request_id and r.bot_id = p_bot_id
    for share;
  if not found then
    raise exception 'reserve_request_budget: request not found for bot' using errcode = 'RB004';
  end if;

  select * into v_existing from public.budget_reservations br where br.request_id = p_request_id;
  if found then
    if v_existing.bot_id = p_bot_id and v_existing.state in ('reserved', 'settled') then
      return v_existing.id;
    end if;
    raise exception 'reserve_request_budget: existing reservation is not reusable' using errcode = 'RB004';
  end if;

  -- New reservation only: the run must still be live.
  if v_run_state not in ('reserved', 'running') then
    raise exception 'reserve_request_budget: request is not active' using errcode = 'RB004';
  end if;

  select coalesce(sum(br.amount), 0) into v_spent
    from public.budget_reservations br
   where br.bot_id = p_bot_id
     and br.created_at >= v_day
     and (br.state = 'settled'
          -- A request reservation counts until expires_at. A job (indexing) reservation counts while 'reserved'
          -- whatever its expires_at says, and while 'expired', as reserve_index_budget counts it: the worker
          -- holding the job may still settle it, so the room stays taken until it is settled or released by that
          -- holder, or settled by settle_orphaned_index_reservations once no holder can (lost lease, released
          -- lease, dead-lettered job). A stale worker cannot settle it: the fence (RB013) refuses it.
          or (br.state = 'reserved' and (br.job_id is not null or br.expires_at > now()))
          or (br.state = 'expired' and br.job_id is not null));

  if v_spent + p_amount > v_cap then
    raise exception 'reserve_request_budget: daily budget exceeded' using errcode = 'RB001';
  end if;

  insert into public.budget_reservations (bot_id, request_id, amount, state, expires_at)
  values (p_bot_id, p_request_id, p_amount, 'reserved', now() + make_interval(secs => p_ttl_seconds))
  returning id into v_id;

  return v_id;
end;
$_$;


ALTER FUNCTION "public"."reserve_request_budget"("p_bot_id" "uuid", "p_request_id" "uuid", "p_amount" numeric, "p_ttl_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reserve_warm_budget"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_question_hash" "text", "p_amount" numeric, "p_ttl_seconds" integer) RETURNS "uuid"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
declare
  v_job public.jobs%rowtype;
  v_job_found boolean;
  v_bot_id uuid;
  v_bot public.bot_profiles%rowtype;
  v_cache_policy jsonb;
  v_budget_policy jsonb;
  v_cap text;
  v_spent numeric;
  v_day timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  v_existing uuid;
  v_existing_state text;
  v_rounded numeric;
  v_id uuid;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = ''
     or p_generation is null or p_generation < 1
     or p_question_hash is null or p_question_hash !~ '^[0-9a-f]{64}$'
     or p_amount is null or p_amount <= 0 or p_amount >= 100000000
     or p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 86400 then
    raise exception 'warm budget: job, worker, generation, question hash, positive amount and ttl (1..86400s) are required'
      using errcode = '22023';
  end if;

  -- Lease first (fence order): only the holder of the live claim may reserve.
  -- Precise failures: unknown/wrong-type job (RB004), malformed payload
  -- (22023), then liveness of the held claim (RB013).
  select * into v_job from public.jobs j where j.id = p_job_id for share;
  v_job_found := found;
  if not v_job_found then
    raise exception 'warm budget: job not found for bot' using errcode = 'RB004';
  end if;
  begin v_bot_id := (v_job.payload->>'bot_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'warm budget: invalid payload' using errcode = '22023';
  end;
  if v_bot_id is null then
    raise exception 'warm budget: invalid payload' using errcode = '22023';
  end if;
  if v_job.type is distinct from 'warm_answer_cache' then
    raise exception 'warm budget: job not found for bot' using errcode = 'RB004';
  end if;
  if v_job.state <> 'running'
     or v_job.locked_by is distinct from p_worker
     or v_job.warm_generation <> p_generation
     or v_job.locked_until is null or v_job.locked_until <= clock_timestamp() then
    raise exception 'warm budget: lease not held' using errcode = 'RB013';
  end if;

  -- Serialize on client_settings, then the bot row, then recheck the snapshot.
  select cs.cache_policy, cs.budget_policy into v_cache_policy, v_budget_policy
    from public.client_settings cs where cs.bot_id = v_bot_id for update;
  if not found then
    raise exception 'warm budget: no client settings for bot' using errcode = 'RB002';
  end if;
  v_cap := v_budget_policy ->> 'daily_cap_usd';
  if v_cap is null or v_cap !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'warm budget: daily cap is missing or invalid' using errcode = 'RB002';
  end if;

  select * into v_bot from public.bot_profiles b where b.id = v_bot_id for share;
  if not found then
    raise exception 'warm budget: job not found for bot' using errcode = 'RB004';
  end if;
  if not v_bot.enabled or not public.warm_policy_enabled(v_cache_policy)
     or (v_job.payload->>'corpus_version') is distinct from v_bot.corpus_version::text
     or (v_job.payload->>'settings_version') is distinct from v_bot.settings_version::text then
    return null;
  end if;

  -- Idempotent per (job, generation, question). A settled or released row means
  -- this invocation was already accounted: it cannot reserve again.
  select br.id, br.state into v_existing, v_existing_state from public.budget_reservations br
   where br.job_id = p_job_id and br.warm_generation = p_generation
     and br.question_hash = p_question_hash;
  if found then
    if v_existing_state in ('reserved', 'expired') then
      return v_existing;
    end if;
    raise exception 'warm budget: invocation already accounted' using errcode = 'RB003';
  end if;

  select coalesce(sum(br.amount), 0) into v_spent
    from public.budget_reservations br
   where br.bot_id = v_bot_id
     and br.created_at >= v_day
     and (br.state = 'settled' or (br.state = 'reserved' and br.expires_at > now())
          -- A stale worker can still settle a lapsed job reservation, so it keeps
          -- counting until the day ends.
          or (br.state = 'expired' and br.job_id is not null));

  v_rounded := ceil(p_amount * 1000000) / 1000000;
  if v_spent + v_rounded > v_cap::numeric then
    raise exception 'warm budget: daily budget exceeded' using errcode = 'RB001';
  end if;

  insert into public.budget_reservations
    (bot_id, job_id, warm_generation, question_hash, amount, state, expires_at)
    values (v_bot_id, p_job_id, p_generation, p_question_hash,
      v_rounded, 'reserved', now() + make_interval(secs => p_ttl_seconds))
    returning id into v_id;
  return v_id;
end;
$_$;


ALTER FUNCTION "public"."reserve_warm_budget"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_question_hash" "text", "p_amount" numeric, "p_ttl_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reset_version_chunks"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
#variable_conflict use_column
declare
  v_status text;
  v_n      integer;
begin
  perform 1 from public.index_job_fence(p_job_id, p_worker, p_version_id);

  select v.status into v_status from public.document_versions v where v.id = p_version_id for update;
  if v_status not in ('uploaded', 'extracting', 'embedding') then
    raise exception 'reset_version_chunks: version is not being indexed' using errcode = 'RB030';
  end if;

  delete from public.document_chunks c where c.document_version_id = p_version_id;
  get diagnostics v_n = row_count;

  update public.document_versions v set batches_done = 0, batches_total = null where v.id = p_version_id;
  return v_n;
end;
$$;


ALTER FUNCTION "public"."reset_version_chunks"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."retry_job_later"("p_job_id" "uuid", "p_worker" "text", "p_error_code" "text", "p_delay_seconds" integer) RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
#variable_conflict use_column
declare
  v_type    text;
  v_payload jsonb;
  v_doc     uuid;
  v_ver     uuid;
  v_state   text;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = '' then
    raise exception 'retry_job_later: job and worker id are required' using errcode = '22023';
  end if;
  if p_error_code is null or p_error_code !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'retry_job_later: error code must be 1..64 characters of a-z, 0-9 and _' using errcode = '22023';
  end if;
  if p_delay_seconds is null or p_delay_seconds < 1 or p_delay_seconds > 3600 then
    raise exception 'retry_job_later: delay must be between 1 and 3600 seconds' using errcode = '22023';
  end if;

  -- Learn the document without a lock, so the document can be locked before the job (lock order above).
  select j.type, j.payload into v_type, v_payload from public.jobs j where j.id = p_job_id;
  if not found then
    raise exception 'retry_job_later: lease not held' using errcode = 'RB013';
  end if;
  if v_type = 'index_document' then
    if (v_payload ->> 'document_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_doc := (v_payload ->> 'document_id')::uuid;
    end if;
    if (v_payload ->> 'version_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_ver := (v_payload ->> 'version_id')::uuid;
    end if;
    if v_doc is not null then
      perform 1 from public.documents d where d.id = v_doc for no key update;
    end if;
  end if;

  update public.jobs j
     set state = case when j.attempts >= j.max_attempts then 'failed' else 'queued' end,
         completed_at = case when j.attempts >= j.max_attempts then now() else null end,
         available_at = case when j.attempts >= j.max_attempts then j.available_at
                             else now() + make_interval(secs => p_delay_seconds) end,
         locked_until = null,
         locked_by = null,
         last_error = p_error_code
   where j.id = p_job_id and j.state = 'running' and j.locked_by = p_worker
  returning j.state into v_state;
  if not found then
    raise exception 'retry_job_later: lease not held' using errcode = 'RB013';
  end if;

  if v_state = 'failed' and v_type = 'index_document' and v_ver is not null and v_doc is not null then
    update public.document_versions v
       set status = 'failed', failure_code = 'INDEXING_FAILED', completed_at = now()
     where v.id = v_ver and v.document_id = v_doc and v.status in ('uploaded', 'extracting', 'embedding');
    if found then
      update public.documents d set status = 'failed'
       where d.id = v_doc and d.active_version_id is null and d.status in ('draft', 'indexing');
    end if;
  end if;

  return v_state;
end;
$_$;


ALTER FUNCTION "public"."retry_job_later"("p_job_id" "uuid", "p_worker" "text", "p_error_code" "text", "p_delay_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."save_analysis_job_result"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_summary" "text", "p_sentiment" "text", "p_intent" "text", "p_analysis_version" "text") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
declare v_conversation uuid;
begin
  select f.conversation_id into v_conversation from public.analysis_job_fence(p_job_id, p_worker, p_generation) f;
  perform public.save_conversation_analysis(v_conversation, p_summary, p_sentiment, p_intent, p_analysis_version);
end;
$$;


ALTER FUNCTION "public"."save_analysis_job_result"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_summary" "text", "p_sentiment" "text", "p_intent" "text", "p_analysis_version" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."save_conversation_analysis"("p_conversation_id" "uuid", "p_summary" "text", "p_sentiment" "text", "p_intent" "text", "p_analysis_version" "text") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
#variable_conflict use_column
begin
  if p_conversation_id is null then
    raise exception 'save_conversation_analysis: conversation is required' using errcode = '22023';
  end if;
  if p_summary is null or char_length(p_summary) = 0 or char_length(p_summary) > 2000 then
    raise exception 'save_conversation_analysis: summary is required (1..2000 chars)' using errcode = '22023';
  end if;
  if p_sentiment is null or p_sentiment not in ('positive', 'neutral', 'negative') then
    raise exception 'save_conversation_analysis: sentiment must be positive, neutral or negative' using errcode = '22023';
  end if;
  if p_intent is null or char_length(p_intent) = 0 or char_length(p_intent) > 200 then
    raise exception 'save_conversation_analysis: intent is required (1..200 chars)' using errcode = '22023';
  end if;
  if p_analysis_version is null or p_analysis_version !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then
    raise exception 'save_conversation_analysis: analysis version is required' using errcode = '22023';
  end if;
  perform 1 from public.conversations c where c.id = p_conversation_id;
  if not found then
    raise exception 'save_conversation_analysis: conversation not found or not owned' using errcode = 'RB037';
  end if;

  insert into public.conversation_analysis as a
    (conversation_id, summary, sentiment, intent, analysis_version, status)
  values (p_conversation_id, p_summary, p_sentiment, p_intent, p_analysis_version, 'complete')
  on conflict (conversation_id) do update
     set summary = excluded.summary,
         sentiment = excluded.sentiment,
         intent = excluded.intent,
         analysis_version = excluded.analysis_version,
         status = 'complete';
end;
$_$;


ALTER FUNCTION "public"."save_conversation_analysis"("p_conversation_id" "uuid", "p_summary" "text", "p_sentiment" "text", "p_intent" "text", "p_analysis_version" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."schedule_analysis_successor"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
declare v_covered bigint;
begin
  if old.type <> 'analyze_conversation' or old.state <> 'running'
     or new.state not in ('succeeded', 'failed') then return new; end if;
  v_covered := case when old.analysis_context_generation = old.analysis_generation
    then old.analysis_context_revision else old.analysis_claim_revision end;
  if new.analysis_requested_revision > v_covered
     and exists(select 1 from public.conversations c
       where c.id::text = new.payload ->> 'conversation_id' and c.bot_id::text = new.payload ->> 'bot_id') then
    -- Reuse the live row: no insert can race the partial unique dedupe index.
    -- The next claim increments generation, preserving earlier budget identity.
    new.state := 'queued';
    new.attempts := 0;
    new.available_at := greatest(new.available_at, now());
    new.locked_by := null;
    new.locked_until := null;
    new.completed_at := null;
    new.last_error := null;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."schedule_analysis_successor"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."schema_version"() RETURNS integer
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$ select 27; $$;


ALTER FUNCTION "public"."schema_version"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_request_run_state"("p_bot_id" "uuid", "p_run_id" "uuid", "p_state" "text") RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
begin
  if p_bot_id is null or p_run_id is null or p_state is null
     or p_state not in ('running', 'succeeded', 'failed', 'partial') then
    raise exception 'set_request_run_state: bot, run and a target state (running, succeeded, failed, partial) are required'
      using errcode = '22023';
  end if;

  update public.request_runs r
     set state = p_state,
         finished_at = case when p_state = 'running' then r.finished_at else now() end
   where r.id = p_run_id and r.bot_id = p_bot_id
     and r.state in ('reserved', 'running') and r.state <> p_state;
  return found;
end;
$$;


ALTER FUNCTION "public"."set_request_run_state"("p_bot_id" "uuid", "p_run_id" "uuid", "p_state" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."settle_analysis_budget"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_reservation_id" "uuid", "p_actual" numeric) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
declare v_bot uuid; v_used numeric; v_state text;
begin
  if p_actual is null or p_actual < 0 or p_actual >= 100000000 then
    raise exception 'analysis budget: invalid actual cost' using errcode = '22023';
  end if;
  select f.bot_id into v_bot from public.analysis_job_fence(p_job_id, p_worker, p_generation) f;
  perform 1 from public.client_settings cs where cs.bot_id = v_bot for update;
  if not found then raise exception 'analysis budget: policy missing' using errcode = 'RB002'; end if;
  select br.state into v_state from public.budget_reservations br
    where br.id = p_reservation_id and br.job_id = p_job_id and br.bot_id = v_bot and br.analysis_generation = p_generation for update;
  if not found or v_state not in ('reserved', 'expired') then
    raise exception 'analysis budget: reservation not active' using errcode = 'RB003';
  end if;
  select sum(ue.estimated_cost) into v_used from public.usage_events ue where ue.budget_reservation_id = p_reservation_id;
  update public.budget_reservations br set
    state = case when p_actual = 0 and v_used is null then 'released' else 'settled' end,
    amount = greatest(ceil(p_actual * 1000000) / 1000000, coalesce(v_used, 0)) where br.id = p_reservation_id;
end;
$$;


ALTER FUNCTION "public"."settle_analysis_budget"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_reservation_id" "uuid", "p_actual" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."settle_budget_reservation"("p_bot_id" "uuid", "p_reservation_id" "uuid", "p_actual_amount" numeric) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
declare
  v_res public.budget_reservations%rowtype;
begin
  if p_bot_id is null or p_reservation_id is null or p_actual_amount is null or p_actual_amount < 0 then
    raise exception 'settle_budget_reservation: bot, reservation and non-negative amount are required'
      using errcode = '22023';
  end if;

  perform 1 from public.client_settings cs where cs.bot_id = p_bot_id for update;
  if not found then
    raise exception 'settle_budget_reservation: no client settings for bot' using errcode = 'RB002';
  end if;

  select * into v_res from public.budget_reservations br
   where br.id = p_reservation_id and br.bot_id = p_bot_id for update;
  if not found or v_res.state not in ('reserved', 'expired') then
    raise exception 'settle_budget_reservation: reservation is not settleable' using errcode = 'RB003';
  end if;

  update public.budget_reservations set state = 'settled', amount = p_actual_amount where id = v_res.id;
end;
$$;


ALTER FUNCTION "public"."settle_budget_reservation"("p_bot_id" "uuid", "p_reservation_id" "uuid", "p_actual_amount" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."settle_index_budget"("p_job_id" "uuid", "p_worker" "text", "p_reservation_id" "uuid", "p_actual" numeric) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
#variable_conflict use_column
declare
  v_ver text;
  v_bot uuid;
  v_res public.budget_reservations%rowtype;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = '' or p_reservation_id is null
     or p_actual is null or p_actual < 0 then
    raise exception 'settle_index_budget: job, worker, reservation and a non-negative amount are required' using errcode = '22023';
  end if;
  select j.payload ->> 'version_id' into v_ver from public.jobs j where j.id = p_job_id;
  if not found or v_ver is null or v_ver !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'index job: lease not held' using errcode = 'RB013';
  end if;
  select f.bot_id into v_bot from public.index_job_fence(p_job_id, p_worker, v_ver::uuid) f;

  perform 1 from public.client_settings cs where cs.bot_id = v_bot for update;
  if not found then
    raise exception 'settle_index_budget: no client settings for bot' using errcode = 'RB002';
  end if;

  select * into v_res from public.budget_reservations br
   where br.id = p_reservation_id and br.job_id = p_job_id and br.bot_id = v_bot for update;
  if not found or v_res.state not in ('reserved', 'expired') then
    raise exception 'settle_index_budget: reservation is not settleable' using errcode = 'RB003';
  end if;

  -- Never below the usage recorded in this row's window (review P6-R5 #2): a stale worker's usage recorded after
  -- this attempt reserved lands here, and so does any batch the holder recorded but did not count. The holder's own
  -- p_actual already includes its rows, so in the normal case the two are equal.
  update public.budget_reservations br
     set state = 'settled',
         amount = greatest(p_actual, least(
           (select coalesce(sum(ue.estimated_cost), 0)
              from public.usage_events ue
             where ue.job_id = v_res.job_id
               and ue.operation = 'embedding_index'
               and ue.created_at >= v_res.created_at
               and ue.created_at < coalesce((select min(n.created_at) from public.budget_reservations n
                                              where n.job_id = v_res.job_id and (n.created_at, n.id) > (v_res.created_at, v_res.id)),
                                            'infinity'::timestamptz)),
           99999999.999999))
   where br.id = v_res.id;
end;
$_$;


ALTER FUNCTION "public"."settle_index_budget"("p_job_id" "uuid", "p_worker" "text", "p_reservation_id" "uuid", "p_actual" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."settle_orphaned_analysis_reservations"("p_batch" integer) RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
declare v_ids uuid[]; v_n integer;
begin
  if p_batch is null or p_batch not between 1 and 1000 then raise exception 'analysis recovery: invalid batch' using errcode = '22023'; end if;
  select array_agg(x.id) into v_ids from (
    select br.id from public.budget_reservations br where br.analysis_generation is not null and br.state in ('reserved', 'expired')
      and not exists(select 1 from public.jobs j where j.id = br.job_id and j.state = 'running' and j.analysis_generation = br.analysis_generation)
      order by br.created_at, br.id limit p_batch for update of br skip locked) x;
  update public.budget_reservations br set state = 'settled',
    amount = coalesce((select sum(ue.estimated_cost) from public.usage_events ue where ue.budget_reservation_id = br.id), br.amount)
    where br.id = any(v_ids) and br.state in ('reserved', 'expired')
      and not exists(select 1 from public.jobs j where j.id = br.job_id and j.state = 'running' and j.analysis_generation = br.analysis_generation);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


ALTER FUNCTION "public"."settle_orphaned_analysis_reservations"("p_batch" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."settle_orphaned_index_reservations"("p_batch" integer) RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
#variable_conflict use_column
declare
  v_ids uuid[];
  v_n   integer;
begin
  if p_batch is null or p_batch < 1 or p_batch > 1000 then
    raise exception 'settle_orphaned_index_reservations: batch (1..1000) is required' using errcode = '22023';
  end if;

  select coalesce(array_agg(x.id), '{}'::uuid[]) into v_ids
    from (select br.id
            from public.budget_reservations br
           where br.analysis_generation is null and br.warm_generation is null and br.job_id is not null
             and br.state in ('reserved', 'expired')
             and (exists (select 1 from public.budget_reservations n
                           where n.job_id = br.job_id and (n.created_at, n.id) > (br.created_at, br.id))
                  or not exists (select 1 from public.jobs j where j.id = br.job_id and j.state = 'running'))
            order by br.created_at, br.id
            limit p_batch
              for update of br skip locked) x;

  update public.budget_reservations br
     set state = 'settled',
         amount = least(
           (select coalesce(sum(ue.estimated_cost), 0)
              from public.usage_events ue
             where ue.job_id = br.job_id
               and ue.operation = 'embedding_index'
               and ue.created_at >= br.created_at
               and ue.created_at < coalesce((select min(n.created_at) from public.budget_reservations n
                                              where n.job_id = br.job_id and (n.created_at, n.id) > (br.created_at, br.id)),
                                            'infinity'::timestamptz)),
           99999999.999999)
    where br.id = any (v_ids)
      and br.analysis_generation is null and br.warm_generation is null and br.job_id is not null
      and br.state in ('reserved', 'expired')
      and (exists (select 1 from public.budget_reservations n
                    where n.job_id = br.job_id and (n.created_at, n.id) > (br.created_at, br.id))
           or not exists (select 1 from public.jobs j where j.id = br.job_id and j.state = 'running'));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


ALTER FUNCTION "public"."settle_orphaned_index_reservations"("p_batch" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."settle_orphaned_warm_reservations"("p_batch" integer) RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
declare v_ids uuid[]; v_n integer;
begin
  if p_batch is null or p_batch not between 1 and 1000 then
    raise exception 'warm recovery: invalid batch' using errcode = '22023';
  end if;
  select array_agg(x.id) into v_ids from (
    select br.id from public.budget_reservations br where br.warm_generation is not null
      and br.state in ('reserved', 'expired')
      and not exists(select 1 from public.jobs j where j.id = br.job_id and j.state = 'running'
        and j.warm_generation = br.warm_generation)
      order by br.created_at, br.id limit p_batch for update of br skip locked) x;
  update public.budget_reservations br set state = 'settled',
    amount = coalesce((select sum(ue.estimated_cost) from public.usage_events ue
      where ue.warm_reservation_id = br.id), br.amount)
    where br.id = any(v_ids) and br.state in ('reserved', 'expired')
      and not exists(select 1 from public.jobs j where j.id = br.job_id and j.state = 'running'
        and j.warm_generation = br.warm_generation);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


ALTER FUNCTION "public"."settle_orphaned_warm_reservations"("p_batch" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."settle_warm_budget"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_question_hash" "text", "p_reservation_id" "uuid", "p_actual" numeric) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
declare v_bot uuid; v_used numeric; v_state text;
begin
  if p_job_id is null or p_worker is null or btrim(p_worker) = ''
     or p_generation is null or p_generation < 1
     or p_question_hash is null or p_question_hash !~ '^[0-9a-f]{64}$'
     or p_reservation_id is null or p_actual is null or p_actual < 0 or p_actual >= 100000000 then
    raise exception 'warm budget: invalid settle request' using errcode = '22023';
  end if;
  select public.warm_job_fence(p_job_id, p_worker, p_generation) into v_bot;
  perform 1 from public.client_settings cs where cs.bot_id = v_bot for update;
  if not found then raise exception 'warm budget: policy missing' using errcode = 'RB002'; end if;
  select br.state into v_state from public.budget_reservations br
   where br.id = p_reservation_id and br.job_id = p_job_id and br.bot_id = v_bot
     and br.warm_generation = p_generation and br.question_hash = p_question_hash for update;
  if not found or v_state not in ('reserved', 'expired') then
    raise exception 'warm budget: reservation not active' using errcode = 'RB003';
  end if;
  select sum(ue.estimated_cost) into v_used from public.usage_events ue
   where ue.warm_reservation_id = p_reservation_id;

  -- actual=0 releases only if no usage was recorded. A recorded zero-cost call
  -- is still settled. Failed usage writes retain the worker's conservative cost.
  update public.budget_reservations br set
    state = case when p_actual = 0 and v_used is null then 'released' else 'settled' end,
    amount = greatest(ceil(p_actual * 1000000) / 1000000, coalesce(v_used, 0))
    where br.id = p_reservation_id;
end;
$_$;


ALTER FUNCTION "public"."settle_warm_budget"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_question_hash" "text", "p_reservation_id" "uuid", "p_actual" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."start_chat_turn"("p_bot_id" "uuid", "p_visitor_session_id" "uuid", "p_run_id" "uuid", "p_conversation_id" "uuid", "p_content" "text") RETURNS TABLE("conversation_id" "uuid", "user_message_id" "uuid", "prior_no_knowledge" integer)
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
#variable_conflict use_column
declare
  v_content text;
  v_state   text;
  v_conv    uuid;
  v_msg     uuid := gen_random_uuid();
  v_prior   integer := 0;
  v_now     timestamptz := clock_timestamp();
begin
  if p_bot_id is null or p_visitor_session_id is null or p_run_id is null then
    raise exception 'start_chat_turn: bot, session and run are required' using errcode = '22023';
  end if;
  if p_content is null then
    raise exception 'start_chat_turn: content is required' using errcode = '22023';
  end if;
  v_content := regexp_replace(p_content, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  if char_length(v_content) not between 1 and 2000 then
    raise exception 'start_chat_turn: content must be 1..2000 characters' using errcode = '22023';
  end if;

  -- 1. The session (lock order above).
  perform 1 from public.visitor_sessions s
   where s.id = p_visitor_session_id and s.bot_id = p_bot_id
     for key share;
  if not found then
    raise exception 'start_chat_turn: not found' using errcode = 'RB037';
  end if;

  -- 2. The run: this bot, this session, still live.
  select r.state into v_state
    from public.request_runs r
   where r.id = p_run_id and r.bot_id = p_bot_id and r.visitor_session_id = p_visitor_session_id
     for no key update;
  if not found or v_state not in ('reserved', 'running') then
    raise exception 'start_chat_turn: not found' using errcode = 'RB037';
  end if;
  if exists (select 1 from public.messages m where m.request_id = p_run_id and m.role = 'user') then
    raise exception 'start_chat_turn: this run already has its question' using errcode = 'RB030';
  end if;

  -- 3. The conversation.
  if p_conversation_id is null then
    insert into public.conversations (bot_id, visitor_session_id, status, last_message_at)
    values (p_bot_id, p_visitor_session_id, 'open', v_now)
    returning id into v_conv;
  else
    select c.id into v_conv
      from public.conversations c
     where c.id = p_conversation_id and c.bot_id = p_bot_id and c.visitor_session_id = p_visitor_session_id
       and c.status = 'open'
       for no key update;
    if not found then
      raise exception 'start_chat_turn: not found' using errcode = 'RB037';
    end if;
    select count(*)::integer into v_prior
      from public.messages m
     where m.conversation_id = v_conv and m.role = 'assistant'
       and m.handoff_reason in ('no_knowledge', 'repeated_no_knowledge');
    update public.conversations c set last_message_at = v_now where c.id = v_conv;
  end if;

  insert into public.messages (id, conversation_id, request_id, role, content, status, created_at)
  values (v_msg, v_conv, p_run_id, 'user', v_content, 'complete', v_now);

  return query select v_conv, v_msg, v_prior;
end;
$_$;


ALTER FUNCTION "public"."start_chat_turn"("p_bot_id" "uuid", "p_visitor_session_id" "uuid", "p_run_id" "uuid", "p_conversation_id" "uuid", "p_content" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_version_progress"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_patch" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
#variable_conflict use_column
declare
  v_ver     public.document_versions%rowtype;
  v_status  text;
  v_done    integer;
  v_total   integer;
  v_sum     text;
  v_method  text;
  v_xver    text;
  v_cver    text;
  v_model   text;
  v_cur     integer;
  v_new     integer;
begin
  perform 1 from public.index_job_fence(p_job_id, p_worker, p_version_id);

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'update_version_progress: a non-empty patch object is required' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_patch) k
              where k <> all (array['status', 'batches_done', 'batches_total', 'checksum', 'extraction_method',
                                    'extraction_version', 'chunking_version', 'embedding_model'])) then
    raise exception 'update_version_progress: unknown key in patch' using errcode = '22023';
  end if;

  select * into v_ver from public.document_versions v where v.id = p_version_id for update;
  if v_ver.status not in ('uploaded', 'extracting', 'embedding') then
    raise exception 'update_version_progress: version is not being indexed' using errcode = 'RB030';
  end if;

  if p_patch ? 'status' then
    if jsonb_typeof(p_patch -> 'status') is distinct from 'string' or (p_patch ->> 'status') not in ('extracting', 'embedding') then
      raise exception 'update_version_progress: status must be extracting or embedding' using errcode = '22023';
    end if;
    v_status := p_patch ->> 'status';
    v_cur := case v_ver.status when 'uploaded' then 1 when 'extracting' then 2 else 3 end;
    v_new := case v_status when 'extracting' then 2 else 3 end;
    if v_new < v_cur then
      raise exception 'update_version_progress: status cannot move backward' using errcode = '22023';
    end if;
  end if;
  if p_patch ? 'batches_done' then
    if jsonb_typeof(p_patch -> 'batches_done') is distinct from 'number' or (p_patch ->> 'batches_done') !~ '^[0-9]{1,9}$' then
      raise exception 'update_version_progress: batches_done must be a non-negative integer' using errcode = '22023';
    end if;
    v_done := (p_patch ->> 'batches_done')::integer;
  end if;
  if p_patch ? 'batches_total' then
    if jsonb_typeof(p_patch -> 'batches_total') is distinct from 'number' or (p_patch ->> 'batches_total') !~ '^[0-9]{1,9}$' then
      raise exception 'update_version_progress: batches_total must be a non-negative integer' using errcode = '22023';
    end if;
    v_total := (p_patch ->> 'batches_total')::integer;
  end if;
  if coalesce(v_done, v_ver.batches_done) is not null and coalesce(v_total, v_ver.batches_total) is not null
     and coalesce(v_done, v_ver.batches_done) > coalesce(v_total, v_ver.batches_total) then
    raise exception 'update_version_progress: batches_done cannot exceed batches_total' using errcode = '22023';
  end if;
  if p_patch ? 'checksum' then
    if jsonb_typeof(p_patch -> 'checksum') is distinct from 'string' or (p_patch ->> 'checksum') !~ '^[0-9a-f]{64}$' then
      raise exception 'update_version_progress: checksum must be 64 lowercase hex characters' using errcode = '22023';
    end if;
    v_sum := p_patch ->> 'checksum';
  end if;
  if p_patch ? 'extraction_method' then
    if jsonb_typeof(p_patch -> 'extraction_method') is distinct from 'string'
       or (p_patch ->> 'extraction_method') not in ('pdf_text', 'markdown', 'plain_text') then
      raise exception 'update_version_progress: unknown extraction_method' using errcode = '22023';
    end if;
    v_method := p_patch ->> 'extraction_method';
  end if;
  if p_patch ? 'extraction_version' then
    if jsonb_typeof(p_patch -> 'extraction_version') is distinct from 'string'
       or char_length(p_patch ->> 'extraction_version') not between 1 and 64 then
      raise exception 'update_version_progress: extraction_version must be 1..64 characters' using errcode = '22023';
    end if;
    v_xver := p_patch ->> 'extraction_version';
  end if;
  if p_patch ? 'chunking_version' then
    if jsonb_typeof(p_patch -> 'chunking_version') is distinct from 'string'
       or char_length(p_patch ->> 'chunking_version') not between 1 and 64 then
      raise exception 'update_version_progress: chunking_version must be 1..64 characters' using errcode = '22023';
    end if;
    v_cver := p_patch ->> 'chunking_version';
  end if;
  if p_patch ? 'embedding_model' then
    if jsonb_typeof(p_patch -> 'embedding_model') is distinct from 'string'
       or char_length(p_patch ->> 'embedding_model') not between 1 and 200 then
      raise exception 'update_version_progress: embedding_model must be 1..200 characters' using errcode = '22023';
    end if;
    v_model := p_patch ->> 'embedding_model';
  end if;

  update public.document_versions v
     set status            = coalesce(v_status, v.status),
         batches_done      = coalesce(v_done, v.batches_done),
         batches_total     = coalesce(v_total, v.batches_total),
         checksum          = coalesce(v_sum, v.checksum),
         extraction_method = coalesce(v_method, v.extraction_method),
         extraction_version = coalesce(v_xver, v.extraction_version),
         chunking_version  = coalesce(v_cver, v.chunking_version),
         embedding_model   = coalesce(v_model, v.embedding_model)
   where v.id = p_version_id;
end;
$_$;


ALTER FUNCTION "public"."update_version_progress"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_patch" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."usage_daily_summary"("p_from" "date", "p_to" "date") RETURNS TABLE("usage_day" "date", "bot_id" "uuid", "operation" "text", "event_count" bigint, "input_tokens" bigint, "output_tokens" bigint, "estimated_cost" numeric)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if not public.is_active_member_mfa(array['owner', 'admin', 'analyst']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'usage_daily_summary: invalid date range' using errcode = '22023';
  end if;
  if (p_to - p_from) + 1 > 92 then
    raise exception 'usage_daily_summary: range must not exceed 92 days' using errcode = '22023';
  end if;

  return query
  select
    (u.created_at at time zone 'UTC')::date,
    u.bot_id,
    u.operation,
    count(*)::bigint,
    coalesce(sum(u.input_tokens), 0)::bigint,
    coalesce(sum(u.output_tokens), 0)::bigint,
    coalesce(sum(u.estimated_cost), 0)
  from public.usage_events u
  where u.created_at >= (p_from::timestamp at time zone 'UTC')
    and u.created_at <  ((p_to + 1)::timestamp at time zone 'UTC')
  group by 1, 2, 3
  order by 1, 2, 3;
end;
$$;


ALTER FUNCTION "public"."usage_daily_summary"("p_from" "date", "p_to" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."warm_job_fence"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) RETURNS "uuid"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $$
declare v_job public.jobs%rowtype; v_bot uuid;
begin
  select * into v_job from public.jobs j where j.id = p_job_id for share;
  if not found or p_worker is null or btrim(p_worker) = ''
     or p_generation is null or p_generation < 1
     or v_job.type <> 'warm_answer_cache' or v_job.state <> 'running'
     or v_job.locked_by is distinct from p_worker
     or v_job.warm_generation <> p_generation
     or v_job.locked_until is null or v_job.locked_until <= clock_timestamp() then
    raise exception 'warm job: lease not held' using errcode = 'RB013';
  end if;
  begin v_bot := (v_job.payload->>'bot_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'warm job: invalid payload' using errcode = '22023';
  end;
  if v_bot is null then raise exception 'warm job: invalid payload' using errcode = '22023'; end if;
  return v_bot;
end;
$$;


ALTER FUNCTION "public"."warm_job_fence"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."warm_layer_enabled"("p_policy" "jsonb", "p_layer" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
  select coalesce(jsonb_typeof(p_policy) = 'object'
    and p_policy->'kill_switch' is distinct from 'true'::jsonb
    and p_policy->'enabled' is distinct from 'false'::jsonb
    and case p_layer
      when 'c4' then p_policy->'c4' is distinct from 'false'::jsonb
        and p_policy->'embedding' is distinct from 'false'::jsonb
        and p_policy->'embeddings' is distinct from 'false'::jsonb
        and p_policy->'query_embedding' is distinct from 'false'::jsonb
      when 'c5' then p_policy->'c5' is distinct from 'false'::jsonb
        and p_policy->'retrieval' is distinct from 'false'::jsonb
        and p_policy->'retrieval_cache' is distinct from 'false'::jsonb
      when 'c6' then p_policy->'c6' is distinct from 'false'::jsonb
        and p_policy->'moderation' is distinct from 'false'::jsonb
        and p_policy->'moderation_cache' is distinct from 'false'::jsonb
      when 'c7' then p_policy->'c7' is distinct from 'false'::jsonb
        and p_policy->'answer_cache' is distinct from 'false'::jsonb
        and p_policy->'answer' is distinct from 'false'::jsonb
        and (p_policy->'c7' = 'true'::jsonb
          or p_policy->'answer_cache' = 'true'::jsonb
          or p_policy->'answer' = 'true'::jsonb
          or p_policy->'enabled' = 'true'::jsonb)
      else false end, false);
$$;


ALTER FUNCTION "public"."warm_layer_enabled"("p_policy" "jsonb", "p_layer" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."warm_policy_enabled"("p_policy" "jsonb") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
  select coalesce(jsonb_typeof(p_policy) = 'object'
    and p_policy->'warm_enabled' = 'true'::jsonb
    and p_policy->'enabled' is distinct from 'false'::jsonb
    and p_policy->'kill_switch' is distinct from 'true'::jsonb
    and p_policy->'killSwitch' is distinct from 'true'::jsonb, false);
$$;


ALTER FUNCTION "public"."warm_policy_enabled"("p_policy" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."write_document_chunks"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_chunks" "jsonb") RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    SET "lock_timeout" TO '2s'
    AS $_$
#variable_conflict use_column
declare
  v_status text;
  v_n      integer;
  v_e      jsonb;
  v_emb    jsonb;
begin
  perform 1 from public.index_job_fence(p_job_id, p_worker, p_version_id);

  select v.status into v_status from public.document_versions v where v.id = p_version_id for update;
  if v_status <> 'embedding' then
    raise exception 'write_document_chunks: version status must be embedding' using errcode = 'RB030';
  end if;

  if p_chunks is null or jsonb_typeof(p_chunks) <> 'array' then
    raise exception 'write_document_chunks: chunks must be a JSON array' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_chunks);
  if v_n < 1 or v_n > 200 then
    raise exception 'write_document_chunks: between 1 and 200 chunks per call' using errcode = '22023';
  end if;

  -- Bounded loop: at most 200 elements.
  for i in 0 .. v_n - 1 loop
    v_e := p_chunks -> i;
    if jsonb_typeof(v_e) is distinct from 'object' then
      raise exception 'write_document_chunks: each chunk must be an object' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'chunk_index') is distinct from 'number' or (v_e ->> 'chunk_index') !~ '^[0-9]{1,9}$' then
      raise exception 'write_document_chunks: chunk_index must be a non-negative integer' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'content') is distinct from 'string' or char_length(v_e ->> 'content') not between 1 and 100000 then
      raise exception 'write_document_chunks: content must be 1..100000 characters' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'token_count') in ('number') and (v_e ->> 'token_count') !~ '^[0-9]{1,9}$' then
      raise exception 'write_document_chunks: token_count must be a non-negative integer' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'token_count') is not null and jsonb_typeof(v_e -> 'token_count') not in ('number', 'null') then
      raise exception 'write_document_chunks: token_count must be a non-negative integer' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'page_number') = 'number' and (v_e ->> 'page_number') !~ '^[1-9][0-9]{0,8}$' then
      raise exception 'write_document_chunks: page_number must be a positive integer' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'page_number') is not null and jsonb_typeof(v_e -> 'page_number') not in ('number', 'null') then
      raise exception 'write_document_chunks: page_number must be a positive integer' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'section') is not null and jsonb_typeof(v_e -> 'section') not in ('string', 'null') then
      raise exception 'write_document_chunks: section must be text' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'section') = 'string' and char_length(v_e ->> 'section') > 500 then
      raise exception 'write_document_chunks: section is longer than 500 characters' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'metadata') is not null and jsonb_typeof(v_e -> 'metadata') not in ('object', 'null') then
      raise exception 'write_document_chunks: metadata must be an object' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'metadata') = 'object' and octet_length((v_e -> 'metadata')::text) > 20000 then
      raise exception 'write_document_chunks: metadata is larger than 20000 bytes' using errcode = '22023';
    end if;
    v_emb := v_e -> 'embedding';
    if jsonb_typeof(v_emb) is distinct from 'array' or jsonb_array_length(v_emb) <> 1536 then
      raise exception 'write_document_chunks: embedding must be an array of 1536 numbers' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(v_emb) x where jsonb_typeof(x) <> 'number') then
      raise exception 'write_document_chunks: embedding must contain numbers only' using errcode = '22023';
    end if;
  end loop;
  if (select count(distinct (x ->> 'chunk_index')::integer) from jsonb_array_elements(p_chunks) x) <> v_n then
    raise exception 'write_document_chunks: duplicate chunk_index in one call' using errcode = '22023';
  end if;

  insert into public.document_chunks as c
    (document_version_id, chunk_index, content, token_count, page_number, section, metadata, embedding)
  select p_version_id,
         (x ->> 'chunk_index')::integer,
         x ->> 'content',
         (x ->> 'token_count')::integer,
         (x ->> 'page_number')::integer,
         x ->> 'section',
         case when jsonb_typeof(x -> 'metadata') = 'object' then x -> 'metadata' else '{}'::jsonb end,
         (x -> 'embedding')::text::extensions.vector(1536)
    from jsonb_array_elements(p_chunks) x
  on conflict (document_version_id, chunk_index) do update
     set content = excluded.content,
         token_count = excluded.token_count,
         page_number = excluded.page_number,
         section = excluded.section,
         metadata = excluded.metadata,
         embedding = excluded.embedding;

  return v_n;
end;
$_$;


ALTER FUNCTION "public"."write_document_chunks"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_chunks" "jsonb") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_memberships" (
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "admin_memberships_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'admin'::"text", 'analyst'::"text"])))
);


ALTER TABLE "public"."admin_memberships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."answer_cache" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "bot_id" "uuid" NOT NULL,
    "cache_key_hash" "text" NOT NULL,
    "language" "text" NOT NULL,
    "answer_text" "text" NOT NULL,
    "source_refs" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "handoff_reason" "text",
    "corpus_version" bigint NOT NULL,
    "settings_version" integer NOT NULL,
    "prompt_template_version" "text" NOT NULL,
    "chat_model" "text" NOT NULL,
    "hit_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_hit_at" timestamp with time zone,
    "expires_at" timestamp with time zone NOT NULL,
    CONSTRAINT "answer_cache_handoff_reason_check" CHECK ((("handoff_reason" IS NULL) OR ("handoff_reason" = ANY (ARRAY['no_knowledge'::"text", 'out_of_scope'::"text", 'human_requested'::"text", 'blocked'::"text", 'unavailable'::"text", 'repeated_no_knowledge'::"text"])))),
    CONSTRAINT "answer_cache_hit_count_check" CHECK (("hit_count" >= 0)),
    CONSTRAINT "answer_cache_key_hash_check" CHECK (("cache_key_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "answer_cache_source_refs_type" CHECK (("jsonb_typeof"("source_refs") = 'array'::"text"))
);


ALTER TABLE "public"."answer_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "actor_user_id" "uuid",
    "action" "text" NOT NULL,
    "resource_type" "text" NOT NULL,
    "resource_id" "text",
    "request_id" "uuid",
    "safe_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "audit_logs_metadata_type" CHECK (("jsonb_typeof"("safe_metadata") = 'object'::"text"))
);


ALTER TABLE "public"."audit_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bot_profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "identity_prompt" "text" NOT NULL,
    "tone" "text",
    "scope" "text",
    "allowed_languages" "text"[] NOT NULL,
    "embedding_model" "text" NOT NULL,
    "embedding_dimensions" integer NOT NULL,
    "settings_version" integer DEFAULT 1 NOT NULL,
    "corpus_version" bigint DEFAULT 0 NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "bot_profiles_corpus_version_check" CHECK (("corpus_version" >= 0)),
    CONSTRAINT "bot_profiles_embedding_dimensions_check" CHECK (("embedding_dimensions" = 1536)),
    CONSTRAINT "bot_profiles_languages_nonempty" CHECK (("cardinality"("allowed_languages") > 0)),
    CONSTRAINT "bot_profiles_settings_version_check" CHECK (("settings_version" >= 1)),
    CONSTRAINT "bot_profiles_slug_format" CHECK (("slug" ~ '^[a-z0-9][a-z0-9-]{0,62}$'::"text"))
);


ALTER TABLE "public"."bot_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."budget_reservations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "bot_id" "uuid" NOT NULL,
    "request_id" "uuid",
    "amount" numeric(14,6) NOT NULL,
    "state" "text" DEFAULT 'reserved'::"text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "job_id" "uuid",
    "analysis_generation" integer,
    "warm_generation" integer,
    "question_hash" "text",
    CONSTRAINT "budget_reservations_amount_check" CHECK (("amount" >= (0)::numeric)),
    CONSTRAINT "budget_reservations_analysis_generation_check" CHECK (("analysis_generation" > 0)),
    CONSTRAINT "budget_reservations_owner_check" CHECK ((("request_id" IS NULL) OR ("job_id" IS NULL))),
    CONSTRAINT "budget_reservations_question_hash_check" CHECK (("question_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "budget_reservations_state_check" CHECK (("state" = ANY (ARRAY['reserved'::"text", 'settled'::"text", 'released'::"text", 'expired'::"text"]))),
    CONSTRAINT "budget_reservations_warm_analysis_check" CHECK ((NOT (("analysis_generation" IS NOT NULL) AND ("warm_generation" IS NOT NULL)))),
    CONSTRAINT "budget_reservations_warm_check" CHECK ((("warm_generation" IS NULL) = ("question_hash" IS NULL))),
    CONSTRAINT "budget_reservations_warm_generation_check" CHECK (("warm_generation" > 0))
);


ALTER TABLE "public"."budget_reservations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."client_settings" (
    "bot_id" "uuid" NOT NULL,
    "allowed_origins" "text"[] NOT NULL,
    "rate_policy" "jsonb" NOT NULL,
    "budget_policy" "jsonb" NOT NULL,
    "retention_policy" "jsonb" NOT NULL,
    "upload_policy" "jsonb" NOT NULL,
    "handoff_policy" "jsonb" NOT NULL,
    "cache_policy" "jsonb" NOT NULL,
    "feature_flags" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "client_settings_policy_types" CHECK ((("jsonb_typeof"("rate_policy") = 'object'::"text") AND ("jsonb_typeof"("budget_policy") = 'object'::"text") AND ("jsonb_typeof"("retention_policy") = 'object'::"text") AND ("jsonb_typeof"("upload_policy") = 'object'::"text") AND ("jsonb_typeof"("handoff_policy") = 'object'::"text") AND ("jsonb_typeof"("cache_policy") = 'object'::"text") AND ("jsonb_typeof"("feature_flags") = 'object'::"text")))
);


ALTER TABLE "public"."client_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversation_analysis" (
    "conversation_id" "uuid" NOT NULL,
    "summary" "text",
    "sentiment" "text",
    "intent" "text",
    "analysis_version" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "conversation_analysis_sentiment_check" CHECK ((("sentiment" IS NULL) OR ("sentiment" = ANY (ARRAY['positive'::"text", 'neutral'::"text", 'negative'::"text"])))),
    CONSTRAINT "conversation_analysis_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'complete'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."conversation_analysis" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "bot_id" "uuid" NOT NULL,
    "visitor_session_id" "uuid",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_message_at" timestamp with time zone,
    "closed_at" timestamp with time zone,
    CONSTRAINT "conversations_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."conversations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."data_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "bot_id" "uuid" NOT NULL,
    "conversation_id" "uuid",
    "schema_key" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "consent_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "data_entries_payload_type" CHECK (("jsonb_typeof"("payload") = 'object'::"text"))
);


ALTER TABLE "public"."data_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."document_chunks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "document_version_id" "uuid" NOT NULL,
    "chunk_index" integer NOT NULL,
    "content" "text" NOT NULL,
    "token_count" integer,
    "page_number" integer,
    "section" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "embedding" "extensions"."vector"(1536) NOT NULL,
    CONSTRAINT "document_chunks_index_check" CHECK (("chunk_index" >= 0)),
    CONSTRAINT "document_chunks_metadata_type" CHECK (("jsonb_typeof"("metadata") = 'object'::"text")),
    CONSTRAINT "document_chunks_page_check" CHECK ((("page_number" IS NULL) OR ("page_number" >= 1))),
    CONSTRAINT "document_chunks_token_count_check" CHECK ((("token_count" IS NULL) OR ("token_count" >= 0)))
);


ALTER TABLE "public"."document_chunks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."document_versions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "document_id" "uuid" NOT NULL,
    "version_number" integer NOT NULL,
    "storage_path" "text" NOT NULL,
    "checksum" "text",
    "media_type" "text" NOT NULL,
    "byte_size" bigint,
    "extraction_method" "text",
    "embedding_model" "text",
    "status" "text" DEFAULT 'pending_upload'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "failure_code" "text",
    "batches_done" integer,
    "batches_total" integer,
    "chunking_version" "text",
    "extraction_version" "text",
    "upload_etag" "text",
    CONSTRAINT "document_versions_batches_done_check" CHECK ((("batches_done" IS NULL) OR ("batches_done" >= 0))),
    CONSTRAINT "document_versions_batches_order_check" CHECK ((("batches_done" IS NULL) OR ("batches_total" IS NULL) OR ("batches_done" <= "batches_total"))),
    CONSTRAINT "document_versions_batches_total_check" CHECK ((("batches_total" IS NULL) OR ("batches_total" >= 0))),
    CONSTRAINT "document_versions_byte_size_check" CHECK ((("byte_size" IS NULL) OR ("byte_size" > 0))),
    CONSTRAINT "document_versions_chunking_version_check" CHECK ((("chunking_version" IS NULL) OR (("char_length"("chunking_version") >= 1) AND ("char_length"("chunking_version") <= 64)))),
    CONSTRAINT "document_versions_extraction_method_check" CHECK ((("extraction_method" IS NULL) OR ("extraction_method" = ANY (ARRAY['pdf_text'::"text", 'markdown'::"text", 'plain_text'::"text"])))),
    CONSTRAINT "document_versions_extraction_version_check" CHECK ((("extraction_version" IS NULL) OR (("char_length"("extraction_version") >= 1) AND ("char_length"("extraction_version") <= 64)))),
    CONSTRAINT "document_versions_failure_code_check" CHECK ((("failure_code" IS NULL) OR ("failure_code" = ANY (ARRAY['FILE_UNSUPPORTED'::"text", 'OCR_REQUIRED'::"text", 'INDEXING_FAILED'::"text", 'BUDGET_EXCEEDED'::"text", 'SUPERSEDED'::"text"])))),
    CONSTRAINT "document_versions_media_type_check" CHECK (("media_type" = ANY (ARRAY['application/pdf'::"text", 'text/markdown'::"text", 'text/plain'::"text"]))),
    CONSTRAINT "document_versions_status_check" CHECK (("status" = ANY (ARRAY['pending_upload'::"text", 'uploaded'::"text", 'extracting'::"text", 'embedding'::"text", 'ready'::"text", 'failed'::"text", 'superseded'::"text"]))),
    CONSTRAINT "document_versions_storage_path_check" CHECK ((("storage_path" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/[:cntrl:]]{1,255}$'::"text") AND ("storage_path" !~ '\.\.'::"text") AND ("storage_path" !~ '/\.$'::"text"))),
    CONSTRAINT "document_versions_version_number_check" CHECK (("version_number" >= 1))
);


ALTER TABLE "public"."document_versions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "bot_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "active_version_id" "uuid",
    "disclosure_policy" "text" DEFAULT 'excluded'::"text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "documents_deleted_consistent" CHECK ((("status" = 'deleted'::"text") = ("deleted_at" IS NOT NULL))),
    CONSTRAINT "documents_disclosure_policy_check" CHECK (("disclosure_policy" = ANY (ARRAY['public_answer'::"text", 'excluded'::"text"]))),
    CONSTRAINT "documents_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'indexing'::"text", 'ready'::"text", 'failed'::"text", 'deleted'::"text"])))
);


ALTER TABLE "public"."documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_sources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "message_id" "uuid" NOT NULL,
    "chunk_id" "uuid",
    "document_version_id" "uuid",
    "source_label" "text" NOT NULL,
    "excerpt" "text",
    "page_number" integer,
    "section" "text",
    CONSTRAINT "message_sources_page_number_check" CHECK ((("page_number" IS NULL) OR ("page_number" >= 1)))
);


ALTER TABLE "public"."message_sources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "request_id" "uuid",
    "reply_to_message_id" "uuid",
    "role" "text" NOT NULL,
    "content" "text" NOT NULL,
    "status" "text" DEFAULT 'complete'::"text" NOT NULL,
    "provider" "text",
    "model" "text",
    "handoff_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "messages_handoff_reason_check" CHECK ((("handoff_reason" IS NULL) OR ("handoff_reason" = ANY (ARRAY['no_knowledge'::"text", 'out_of_scope'::"text", 'human_requested'::"text", 'blocked'::"text", 'unavailable'::"text", 'repeated_no_knowledge'::"text"])))),
    CONSTRAINT "messages_reply_to_check" CHECK ((("reply_to_message_id" IS NULL) OR (("role" = 'assistant'::"text") AND ("reply_to_message_id" <> "id")))),
    CONSTRAINT "messages_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text", 'system'::"text"]))),
    CONSTRAINT "messages_status_check" CHECK (("status" = ANY (ARRAY['complete'::"text", 'partial'::"text", 'failed'::"text", 'blocked'::"text"])))
);


ALTER TABLE "public"."messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."moderation_cache" (
    "key_hash" "text" NOT NULL,
    "policy_version" "text" NOT NULL,
    "verdict" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "moderation_model" "text",
    CONSTRAINT "moderation_cache_key_hash_check" CHECK (("key_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "moderation_cache_verdict_check" CHECK (("verdict" = ANY (ARRAY['allow'::"text", 'block'::"text"])))
);


ALTER TABLE "public"."moderation_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."public_bot_config" (
    "bot_id" "uuid" NOT NULL,
    "bot_slug" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "greeting" "text",
    "suggested_questions" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "primary_color" "text",
    "position" "text" DEFAULT 'bottom-right'::"text" NOT NULL,
    "privacy_url" "text",
    "supported_languages" "text"[] NOT NULL,
    "escalation_label" "text",
    "escalation_messages" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "contact_email" "text",
    "contact_phone" "text",
    "contact_whatsapp_url" "text",
    "contact_page_url" "text",
    "business_hours" "jsonb",
    "timezone" "text",
    "is_published" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "public_bot_config_color_check" CHECK ((("primary_color" IS NULL) OR ("primary_color" ~ '^#[0-9a-fA-F]{6}$'::"text"))),
    CONSTRAINT "public_bot_config_email_format" CHECK ((("contact_email" IS NULL) OR ("contact_email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'::"text"))),
    CONSTRAINT "public_bot_config_escalation_type" CHECK (("jsonb_typeof"("escalation_messages") = 'object'::"text")),
    CONSTRAINT "public_bot_config_hours_type" CHECK ((("business_hours" IS NULL) OR ("jsonb_typeof"("business_hours") = 'object'::"text"))),
    CONSTRAINT "public_bot_config_languages_nonempty" CHECK (("cardinality"("supported_languages") > 0)),
    CONSTRAINT "public_bot_config_page_https" CHECK ((("contact_page_url" IS NULL) OR ("contact_page_url" ~ '^https://[^\s]+$'::"text"))),
    CONSTRAINT "public_bot_config_phone_e164" CHECK ((("contact_phone" IS NULL) OR ("contact_phone" ~ '^\+[1-9][0-9]{6,14}$'::"text"))),
    CONSTRAINT "public_bot_config_position_check" CHECK (("position" = ANY (ARRAY['bottom-right'::"text", 'bottom-left'::"text"]))),
    CONSTRAINT "public_bot_config_privacy_url_https" CHECK ((("privacy_url" IS NULL) OR ("privacy_url" ~ '^https://[^\s]+$'::"text"))),
    CONSTRAINT "public_bot_config_suggested_type" CHECK (("jsonb_typeof"("suggested_questions") = 'array'::"text")),
    CONSTRAINT "public_bot_config_whatsapp_https" CHECK ((("contact_whatsapp_url" IS NULL) OR ("contact_whatsapp_url" ~ '^https://[^\s]+$'::"text")))
);


ALTER TABLE "public"."public_bot_config" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."query_embedding_cache" (
    "key_hash" "text" NOT NULL,
    "embedding_model" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_hit_at" timestamp with time zone,
    "expires_at" timestamp with time zone NOT NULL,
    "embedding" "extensions"."vector"(1536) NOT NULL,
    "embedding_dimensions" integer,
    CONSTRAINT "query_embedding_cache_dimensions_check" CHECK ((("embedding_dimensions" IS NULL) OR ("embedding_dimensions" = 1536))),
    CONSTRAINT "query_embedding_cache_key_hash_check" CHECK (("key_hash" ~ '^[0-9a-f]{64}$'::"text"))
);


ALTER TABLE "public"."query_embedding_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rate_limit_buckets" (
    "key_hash" "text" NOT NULL,
    "window_start" timestamp with time zone NOT NULL,
    "window_seconds" integer NOT NULL,
    "request_count" integer DEFAULT 0 NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    CONSTRAINT "rate_limit_buckets_count_check" CHECK (("request_count" >= 0)),
    CONSTRAINT "rate_limit_buckets_key_hash_check" CHECK (("key_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "rate_limit_buckets_window_check" CHECK ((("window_seconds" >= 1) AND ("window_seconds" <= 86400)))
);


ALTER TABLE "public"."rate_limit_buckets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."request_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "bot_id" "uuid" NOT NULL,
    "visitor_session_id" "uuid" NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "request_hash" "text" NOT NULL,
    "state" "text" DEFAULT 'reserved'::"text" NOT NULL,
    "reserved_tokens" integer DEFAULT 0 NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    CONSTRAINT "request_runs_idempotency_key_format" CHECK (("idempotency_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::"text")),
    CONSTRAINT "request_runs_request_hash_format" CHECK (("request_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "request_runs_reserved_tokens_check" CHECK (("reserved_tokens" >= 0)),
    CONSTRAINT "request_runs_state_check" CHECK (("state" = ANY (ARRAY['reserved'::"text", 'running'::"text", 'succeeded'::"text", 'failed'::"text", 'partial'::"text"])))
);


ALTER TABLE "public"."request_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."retrieval_cache" (
    "key_hash" "text" NOT NULL,
    "bot_id" "uuid" NOT NULL,
    "corpus_version" bigint NOT NULL,
    "embedding_hash" "text" NOT NULL,
    "k" integer NOT NULL,
    "threshold" double precision NOT NULL,
    "language" "text" NOT NULL,
    "chunk_refs" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    CONSTRAINT "retrieval_cache_chunk_refs_type" CHECK (("jsonb_typeof"("chunk_refs") = 'array'::"text")),
    CONSTRAINT "retrieval_cache_embedding_hash_check" CHECK (("embedding_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "retrieval_cache_k_check" CHECK ((("k" >= 1) AND ("k" <= 50))),
    CONSTRAINT "retrieval_cache_key_hash_check" CHECK (("key_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "retrieval_cache_threshold_check" CHECK ((("threshold" >= ('-1'::integer)::double precision) AND ("threshold" <= (1)::double precision)))
);


ALTER TABLE "public"."retrieval_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."usage_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "bot_id" "uuid" NOT NULL,
    "request_id" "uuid",
    "job_id" "uuid",
    "provider" "text",
    "model" "text",
    "operation" "text" NOT NULL,
    "input_tokens" integer DEFAULT 0 NOT NULL,
    "output_tokens" integer DEFAULT 0 NOT NULL,
    "estimated_cost" numeric(14,6) DEFAULT 0 NOT NULL,
    "latency_ms" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "budget_reservation_id" "uuid",
    "warm_reservation_id" "uuid",
    "warm_invocation_id" "uuid",
    "state" "text" DEFAULT 'final'::"text" NOT NULL,
    CONSTRAINT "usage_events_cost_check" CHECK (("estimated_cost" >= (0)::numeric)),
    CONSTRAINT "usage_events_latency_check" CHECK ((("latency_ms" IS NULL) OR ("latency_ms" >= 0))),
    CONSTRAINT "usage_events_operation_check" CHECK (("operation" = ANY (ARRAY['chat'::"text", 'embedding_query'::"text", 'embedding_index'::"text", 'moderation'::"text", 'analysis'::"text", 'answer_cache_hit'::"text"]))),
    CONSTRAINT "usage_events_state_check" CHECK (("state" = ANY (ARRAY['pending'::"text", 'final'::"text"]))),
    CONSTRAINT "usage_events_tokens_check" CHECK ((("input_tokens" >= 0) AND ("output_tokens" >= 0))),
    CONSTRAINT "usage_events_warm_purpose_check" CHECK ((NOT (("budget_reservation_id" IS NOT NULL) AND ("warm_reservation_id" IS NOT NULL))))
);


ALTER TABLE "public"."usage_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."visitor_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "bot_id" "uuid" NOT NULL,
    "token_version" integer DEFAULT 1 NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "revoked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "visitor_sessions_token_version_check" CHECK (("token_version" >= 1))
);


ALTER TABLE "public"."visitor_sessions" OWNER TO "postgres";


ALTER TABLE ONLY "public"."admin_memberships"
    ADD CONSTRAINT "admin_memberships_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."answer_cache"
    ADD CONSTRAINT "answer_cache_cache_key_hash_key" UNIQUE ("cache_key_hash");



ALTER TABLE ONLY "public"."answer_cache"
    ADD CONSTRAINT "answer_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bot_profiles"
    ADD CONSTRAINT "bot_profiles_id_slug_key" UNIQUE ("id", "slug");



ALTER TABLE ONLY "public"."bot_profiles"
    ADD CONSTRAINT "bot_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bot_profiles"
    ADD CONSTRAINT "bot_profiles_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."budget_reservations"
    ADD CONSTRAINT "budget_reservations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_settings"
    ADD CONSTRAINT "client_settings_pkey" PRIMARY KEY ("bot_id");



ALTER TABLE ONLY "public"."conversation_analysis"
    ADD CONSTRAINT "conversation_analysis_pkey" PRIMARY KEY ("conversation_id");



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_id_bot_key" UNIQUE ("id", "bot_id");



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."data_entries"
    ADD CONSTRAINT "data_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."document_chunks"
    ADD CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."document_chunks"
    ADD CONSTRAINT "document_chunks_version_index_key" UNIQUE ("document_version_id", "chunk_index");



ALTER TABLE ONLY "public"."document_versions"
    ADD CONSTRAINT "document_versions_doc_version_key" UNIQUE ("document_id", "version_number");



ALTER TABLE ONLY "public"."document_versions"
    ADD CONSTRAINT "document_versions_id_doc_key" UNIQUE ("id", "document_id");



ALTER TABLE ONLY "public"."document_versions"
    ADD CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_sources"
    ADD CONSTRAINT "message_sources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."moderation_cache"
    ADD CONSTRAINT "moderation_cache_pkey" PRIMARY KEY ("key_hash");



ALTER TABLE ONLY "public"."public_bot_config"
    ADD CONSTRAINT "public_bot_config_bot_id_slug_key" UNIQUE ("bot_id", "bot_slug");



ALTER TABLE ONLY "public"."public_bot_config"
    ADD CONSTRAINT "public_bot_config_bot_slug_key" UNIQUE ("bot_slug");



ALTER TABLE ONLY "public"."public_bot_config"
    ADD CONSTRAINT "public_bot_config_pkey" PRIMARY KEY ("bot_id");



ALTER TABLE ONLY "public"."query_embedding_cache"
    ADD CONSTRAINT "query_embedding_cache_pkey" PRIMARY KEY ("key_hash");



ALTER TABLE ONLY "public"."rate_limit_buckets"
    ADD CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key_hash", "window_start", "window_seconds");



ALTER TABLE ONLY "public"."request_runs"
    ADD CONSTRAINT "request_runs_idempotency_key" UNIQUE ("bot_id", "visitor_session_id", "idempotency_key");



ALTER TABLE ONLY "public"."request_runs"
    ADD CONSTRAINT "request_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."retrieval_cache"
    ADD CONSTRAINT "retrieval_cache_pkey" PRIMARY KEY ("key_hash");



ALTER TABLE ONLY "public"."usage_events"
    ADD CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."visitor_sessions"
    ADD CONSTRAINT "visitor_sessions_id_bot_key" UNIQUE ("id", "bot_id");



ALTER TABLE ONLY "public"."visitor_sessions"
    ADD CONSTRAINT "visitor_sessions_pkey" PRIMARY KEY ("id");



CREATE INDEX "answer_cache_bot_id_idx" ON "public"."answer_cache" USING "btree" ("bot_id");



CREATE INDEX "answer_cache_expires_at_idx" ON "public"."answer_cache" USING "btree" ("expires_at");



CREATE INDEX "audit_logs_actor_idx" ON "public"."audit_logs" USING "btree" ("actor_user_id") WHERE ("actor_user_id" IS NOT NULL);



CREATE INDEX "audit_logs_created_at_idx" ON "public"."audit_logs" USING "btree" ("created_at");



CREATE UNIQUE INDEX "budget_reservations_analysis_generation_key" ON "public"."budget_reservations" USING "btree" ("job_id", "analysis_generation") WHERE ("analysis_generation" IS NOT NULL);



CREATE INDEX "budget_reservations_bot_time_idx" ON "public"."budget_reservations" USING "btree" ("bot_id", "created_at");



CREATE INDEX "budget_reservations_expiry_idx" ON "public"."budget_reservations" USING "btree" ("expires_at") WHERE ("state" = 'reserved'::"text");



CREATE INDEX "budget_reservations_job_created_idx" ON "public"."budget_reservations" USING "btree" ("job_id", "created_at") WHERE ("job_id" IS NOT NULL);



CREATE UNIQUE INDEX "budget_reservations_job_id_key" ON "public"."budget_reservations" USING "btree" ("job_id") WHERE (("job_id" IS NOT NULL) AND ("state" = 'reserved'::"text") AND ("warm_generation" IS NULL));



CREATE UNIQUE INDEX "budget_reservations_request_id_key" ON "public"."budget_reservations" USING "btree" ("request_id") WHERE ("request_id" IS NOT NULL);



CREATE UNIQUE INDEX "budget_reservations_warm_key" ON "public"."budget_reservations" USING "btree" ("job_id", "warm_generation", "question_hash") WHERE ("warm_generation" IS NOT NULL);



CREATE INDEX "conversations_bot_time_idx" ON "public"."conversations" USING "btree" ("bot_id", "last_message_at" DESC);



CREATE INDEX "conversations_created_at_idx" ON "public"."conversations" USING "btree" ("created_at");



CREATE INDEX "conversations_session_idx" ON "public"."conversations" USING "btree" ("visitor_session_id", "bot_id") WHERE ("visitor_session_id" IS NOT NULL);



CREATE INDEX "data_entries_bot_id_idx" ON "public"."data_entries" USING "btree" ("bot_id");



CREATE INDEX "data_entries_conversation_idx" ON "public"."data_entries" USING "btree" ("conversation_id", "bot_id") WHERE ("conversation_id" IS NOT NULL);



CREATE INDEX "document_chunks_embedding_hnsw_idx" ON "public"."document_chunks" USING "hnsw" ("embedding" "extensions"."vector_cosine_ops");



CREATE INDEX "document_versions_pending_upload_idx" ON "public"."document_versions" USING "btree" ("created_at") WHERE ("status" = 'pending_upload'::"text");



CREATE INDEX "document_versions_storage_path_idx" ON "public"."document_versions" USING "btree" ("storage_path");



CREATE INDEX "documents_active_version_idx" ON "public"."documents" USING "btree" ("active_version_id", "id") WHERE ("active_version_id" IS NOT NULL);



CREATE INDEX "documents_bot_id_idx" ON "public"."documents" USING "btree" ("bot_id");



CREATE INDEX "documents_created_by_idx" ON "public"."documents" USING "btree" ("created_by") WHERE ("created_by" IS NOT NULL);



CREATE UNIQUE INDEX "jobs_dedupe_key_live_key" ON "public"."jobs" USING "btree" ("dedupe_key") WHERE ("state" = ANY (ARRAY['queued'::"text", 'running'::"text"]));



CREATE INDEX "jobs_queued_available_idx" ON "public"."jobs" USING "btree" ("available_at") WHERE ("state" = 'queued'::"text");



CREATE INDEX "jobs_running_lease_idx" ON "public"."jobs" USING "btree" ("locked_until") WHERE ("state" = 'running'::"text");



CREATE INDEX "jobs_terminal_age_idx" ON "public"."jobs" USING "btree" (COALESCE("completed_at", "created_at")) WHERE ("state" = ANY (ARRAY['succeeded'::"text", 'failed'::"text", 'cancelled'::"text"]));



CREATE INDEX "jobs_type_state_idx" ON "public"."jobs" USING "btree" ("type", "state");



CREATE UNIQUE INDEX "jobs_warm_versions_key" ON "public"."jobs" USING "btree" ((("payload" ->> 'bot_id'::"text")), (("payload" ->> 'corpus_version'::"text")), (("payload" ->> 'settings_version'::"text"))) WHERE ("type" = 'warm_answer_cache'::"text");



CREATE INDEX "message_sources_chunk_id_idx" ON "public"."message_sources" USING "btree" ("chunk_id") WHERE ("chunk_id" IS NOT NULL);



CREATE INDEX "message_sources_message_id_idx" ON "public"."message_sources" USING "btree" ("message_id");



CREATE INDEX "message_sources_version_id_idx" ON "public"."message_sources" USING "btree" ("document_version_id") WHERE ("document_version_id" IS NOT NULL);



CREATE INDEX "messages_conversation_time_idx" ON "public"."messages" USING "btree" ("conversation_id", "created_at");



CREATE INDEX "messages_handoff_reason_idx" ON "public"."messages" USING "btree" ("handoff_reason", "created_at") WHERE ("handoff_reason" IS NOT NULL);



CREATE INDEX "messages_reply_to_idx" ON "public"."messages" USING "btree" ("reply_to_message_id") WHERE ("reply_to_message_id" IS NOT NULL);



CREATE INDEX "messages_request_id_idx" ON "public"."messages" USING "btree" ("request_id") WHERE ("request_id" IS NOT NULL);



CREATE INDEX "moderation_cache_expires_at_idx" ON "public"."moderation_cache" USING "btree" ("expires_at");



CREATE INDEX "query_embedding_cache_expires_at_idx" ON "public"."query_embedding_cache" USING "btree" ("expires_at");



CREATE INDEX "rate_limit_buckets_expires_at_idx" ON "public"."rate_limit_buckets" USING "btree" ("expires_at");



CREATE INDEX "retrieval_cache_bot_id_idx" ON "public"."retrieval_cache" USING "btree" ("bot_id");



CREATE INDEX "retrieval_cache_corpus_version_idx" ON "public"."retrieval_cache" USING "btree" ("corpus_version");



CREATE INDEX "retrieval_cache_expires_at_idx" ON "public"."retrieval_cache" USING "btree" ("expires_at");



CREATE UNIQUE INDEX "usage_events_analysis_reservation_key" ON "public"."usage_events" USING "btree" ("budget_reservation_id") WHERE ("budget_reservation_id" IS NOT NULL);



CREATE INDEX "usage_events_bot_time_idx" ON "public"."usage_events" USING "btree" ("bot_id", "created_at");



CREATE INDEX "usage_events_created_at_idx" ON "public"."usage_events" USING "btree" ("created_at");



CREATE INDEX "usage_events_job_id_idx" ON "public"."usage_events" USING "btree" ("job_id") WHERE ("job_id" IS NOT NULL);



CREATE INDEX "usage_events_request_id_idx" ON "public"."usage_events" USING "btree" ("request_id") WHERE ("request_id" IS NOT NULL);



CREATE UNIQUE INDEX "usage_events_warm_invocation_key" ON "public"."usage_events" USING "btree" ("warm_reservation_id", "warm_invocation_id") WHERE ("warm_reservation_id" IS NOT NULL);



CREATE INDEX "visitor_sessions_bot_id_idx" ON "public"."visitor_sessions" USING "btree" ("bot_id");



CREATE INDEX "visitor_sessions_expires_at_idx" ON "public"."visitor_sessions" USING "btree" ("expires_at");



CREATE OR REPLACE TRIGGER "audit_logs_append_only" BEFORE DELETE OR UPDATE ON "public"."audit_logs" FOR EACH ROW EXECUTE FUNCTION "public"."audit_logs_append_only"();



CREATE OR REPLACE TRIGGER "audit_logs_no_truncate" BEFORE TRUNCATE ON "public"."audit_logs" FOR EACH STATEMENT EXECUTE FUNCTION "public"."audit_logs_no_truncate"();



CREATE OR REPLACE TRIGGER "bot_profiles_bump_settings_version" BEFORE UPDATE OF "identity_prompt", "tone", "scope", "allowed_languages", "enabled" ON "public"."bot_profiles" FOR EACH ROW WHEN ((("old"."identity_prompt" IS DISTINCT FROM "new"."identity_prompt") OR ("old"."tone" IS DISTINCT FROM "new"."tone") OR ("old"."scope" IS DISTINCT FROM "new"."scope") OR ("old"."allowed_languages" IS DISTINCT FROM "new"."allowed_languages") OR ("old"."enabled" IS DISTINCT FROM "new"."enabled"))) EXECUTE FUNCTION "public"."bot_profiles_bump_settings_version"();



CREATE OR REPLACE TRIGGER "bot_profiles_guard_embedding_change" BEFORE UPDATE OF "embedding_model", "embedding_dimensions" ON "public"."bot_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."bot_profiles_guard_embedding_change"();



CREATE OR REPLACE TRIGGER "bot_profiles_set_updated_at" BEFORE UPDATE ON "public"."bot_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "bot_profiles_sync_published" AFTER UPDATE OF "enabled" ON "public"."bot_profiles" FOR EACH ROW WHEN (("old"."enabled" IS DISTINCT FROM "new"."enabled")) EXECUTE FUNCTION "public"."bot_profiles_sync_published"();



CREATE OR REPLACE TRIGGER "bot_profiles_warm_version" AFTER UPDATE ON "public"."bot_profiles" FOR EACH ROW WHEN ((("old"."corpus_version" IS DISTINCT FROM "new"."corpus_version") OR ("old"."settings_version" IS DISTINCT FROM "new"."settings_version"))) EXECUTE FUNCTION "public"."enqueue_warm_after_version_change"();



CREATE OR REPLACE TRIGGER "client_settings_bump_settings_version" AFTER UPDATE ON "public"."client_settings" FOR EACH ROW WHEN (("old".* IS DISTINCT FROM "new".*)) EXECUTE FUNCTION "public"."bump_bot_settings_version"();



CREATE OR REPLACE TRIGGER "client_settings_set_updated_at" BEFORE UPDATE ON "public"."client_settings" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "conversation_analysis_set_updated_at" BEFORE UPDATE ON "public"."conversation_analysis" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "jobs_analysis_generation" BEFORE UPDATE ON "public"."jobs" FOR EACH ROW EXECUTE FUNCTION "public"."bump_analysis_generation"();



CREATE OR REPLACE TRIGGER "jobs_analysis_successor" BEFORE UPDATE ON "public"."jobs" FOR EACH ROW EXECUTE FUNCTION "public"."schedule_analysis_successor"();



CREATE OR REPLACE TRIGGER "jobs_warm_generation" BEFORE UPDATE ON "public"."jobs" FOR EACH ROW EXECUTE FUNCTION "public"."bump_warm_generation"();



CREATE OR REPLACE TRIGGER "message_sources_check_ownership" BEFORE INSERT OR UPDATE ON "public"."message_sources" FOR EACH ROW EXECUTE FUNCTION "public"."message_sources_check_ownership"();



CREATE OR REPLACE TRIGGER "messages_check_reply_to" BEFORE INSERT OR UPDATE OF "reply_to_message_id", "conversation_id", "role" ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."messages_check_reply_to"();



CREATE OR REPLACE TRIGGER "public_bot_config_bump_settings_version" AFTER UPDATE ON "public"."public_bot_config" FOR EACH ROW WHEN (("old".* IS DISTINCT FROM "new".*)) EXECUTE FUNCTION "public"."bump_bot_settings_version"();



CREATE OR REPLACE TRIGGER "public_bot_config_set_updated_at" BEFORE UPDATE ON "public"."public_bot_config" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "public_bot_config_sync_published" BEFORE INSERT OR UPDATE ON "public"."public_bot_config" FOR EACH ROW EXECUTE FUNCTION "public"."public_bot_config_sync_published"();



CREATE OR REPLACE TRIGGER "request_runs_check_state_transition" BEFORE UPDATE OF "state" ON "public"."request_runs" FOR EACH ROW EXECUTE FUNCTION "public"."request_runs_check_state_transition"();



ALTER TABLE ONLY "public"."admin_memberships"
    ADD CONSTRAINT "admin_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."answer_cache"
    ADD CONSTRAINT "answer_cache_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "public"."bot_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."budget_reservations"
    ADD CONSTRAINT "budget_reservations_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "public"."bot_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."budget_reservations"
    ADD CONSTRAINT "budget_reservations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."budget_reservations"
    ADD CONSTRAINT "budget_reservations_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."request_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."client_settings"
    ADD CONSTRAINT "client_settings_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "public"."bot_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversation_analysis"
    ADD CONSTRAINT "conversation_analysis_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "public"."bot_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_session_fk" FOREIGN KEY ("visitor_session_id", "bot_id") REFERENCES "public"."visitor_sessions"("id", "bot_id") ON DELETE SET NULL ("visitor_session_id");



ALTER TABLE ONLY "public"."data_entries"
    ADD CONSTRAINT "data_entries_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "public"."bot_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."data_entries"
    ADD CONSTRAINT "data_entries_conversation_fk" FOREIGN KEY ("conversation_id", "bot_id") REFERENCES "public"."conversations"("id", "bot_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_chunks"
    ADD CONSTRAINT "document_chunks_document_version_id_fkey" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_versions"
    ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_active_version_fk" FOREIGN KEY ("active_version_id", "id") REFERENCES "public"."document_versions"("id", "document_id") ON DELETE SET NULL ("active_version_id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "public"."bot_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."message_sources"
    ADD CONSTRAINT "message_sources_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "public"."document_chunks"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."message_sources"
    ADD CONSTRAINT "message_sources_document_version_id_fkey" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."message_sources"
    ADD CONSTRAINT "message_sources_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_reply_to_message_id_fkey" FOREIGN KEY ("reply_to_message_id") REFERENCES "public"."messages"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."request_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."public_bot_config"
    ADD CONSTRAINT "public_bot_config_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "public"."bot_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."public_bot_config"
    ADD CONSTRAINT "public_bot_config_profile_fk" FOREIGN KEY ("bot_id", "bot_slug") REFERENCES "public"."bot_profiles"("id", "slug") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."request_runs"
    ADD CONSTRAINT "request_runs_session_fk" FOREIGN KEY ("visitor_session_id", "bot_id") REFERENCES "public"."visitor_sessions"("id", "bot_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."retrieval_cache"
    ADD CONSTRAINT "retrieval_cache_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "public"."bot_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."usage_events"
    ADD CONSTRAINT "usage_events_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "public"."bot_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."usage_events"
    ADD CONSTRAINT "usage_events_budget_reservation_id_fkey" FOREIGN KEY ("budget_reservation_id") REFERENCES "public"."budget_reservations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."usage_events"
    ADD CONSTRAINT "usage_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."usage_events"
    ADD CONSTRAINT "usage_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."request_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."usage_events"
    ADD CONSTRAINT "usage_events_warm_reservation_id_fkey" FOREIGN KEY ("warm_reservation_id") REFERENCES "public"."budget_reservations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."visitor_sessions"
    ADD CONSTRAINT "visitor_sessions_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "public"."bot_profiles"("id") ON DELETE CASCADE;



ALTER TABLE "public"."admin_memberships" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."answer_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."audit_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "audit_logs_select_admins" ON "public"."audit_logs" FOR SELECT TO "authenticated" USING (( SELECT "public"."is_active_member_mfa"(ARRAY['owner'::"text", 'admin'::"text"]) AS "is_active_member_mfa"));



ALTER TABLE "public"."bot_profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."budget_reservations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."client_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."conversation_analysis" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "conversation_analysis_select_members" ON "public"."conversation_analysis" FOR SELECT TO "authenticated" USING (( SELECT "public"."is_active_member_mfa"(ARRAY['owner'::"text", 'admin'::"text", 'analyst'::"text"]) AS "is_active_member_mfa"));



ALTER TABLE "public"."conversations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "conversations_select_members" ON "public"."conversations" FOR SELECT TO "authenticated" USING (( SELECT "public"."is_active_member_mfa"(ARRAY['owner'::"text", 'admin'::"text", 'analyst'::"text"]) AS "is_active_member_mfa"));



ALTER TABLE "public"."data_entries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "data_entries_select_admins" ON "public"."data_entries" FOR SELECT TO "authenticated" USING (( SELECT "public"."is_active_member_mfa"(ARRAY['owner'::"text", 'admin'::"text"]) AS "is_active_member_mfa"));



ALTER TABLE "public"."document_chunks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."document_versions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "document_versions_select_members" ON "public"."document_versions" FOR SELECT TO "authenticated" USING (( SELECT "public"."is_active_member_mfa"(ARRAY['owner'::"text", 'admin'::"text", 'analyst'::"text"]) AS "is_active_member_mfa"));



ALTER TABLE "public"."documents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "documents_select_members" ON "public"."documents" FOR SELECT TO "authenticated" USING (( SELECT "public"."is_active_member_mfa"(ARRAY['owner'::"text", 'admin'::"text", 'analyst'::"text"]) AS "is_active_member_mfa"));



ALTER TABLE "public"."jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."message_sources" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "message_sources_select_members" ON "public"."message_sources" FOR SELECT TO "authenticated" USING (( SELECT "public"."is_active_member_mfa"(ARRAY['owner'::"text", 'admin'::"text", 'analyst'::"text"]) AS "is_active_member_mfa"));



ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "messages_select_members" ON "public"."messages" FOR SELECT TO "authenticated" USING ((("role" <> 'system'::"text") AND ( SELECT "public"."is_active_member_mfa"(ARRAY['owner'::"text", 'admin'::"text", 'analyst'::"text"]) AS "is_active_member_mfa")));



ALTER TABLE "public"."moderation_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."public_bot_config" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "public_bot_config_select_public" ON "public"."public_bot_config" FOR SELECT TO "authenticated", "anon" USING ("is_published");



ALTER TABLE "public"."query_embedding_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rate_limit_buckets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."request_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."retrieval_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."usage_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."visitor_sessions" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";












































































































































































































































































































































































































































































































REVOKE ALL ON FUNCTION "public"."activate_document_version"("p_document_id" "uuid", "p_version_id" "uuid", "p_expected_chunks" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."activate_document_version"("p_document_id" "uuid", "p_version_id" "uuid", "p_expected_chunks" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."activate_version_for_job"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_expected_chunks" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."activate_version_for_job"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_expected_chunks" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_add_document_version"("p_document_id" "uuid", "p_media_type" "text", "p_byte_size" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_add_document_version"("p_document_id" "uuid", "p_media_type" "text", "p_byte_size" bigint) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_audit"("p_action" "text", "p_resource_type" "text", "p_resource_id" "uuid", "p_metadata" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."admin_complete_upload"("p_version_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_complete_upload"("p_version_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_consume_quota"("p_bot_id" "uuid", "p_kind" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."admin_delete_conversation"("p_conversation_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_delete_conversation"("p_conversation_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_delete_document"("p_document_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_delete_document"("p_document_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_document_status"("p_bot_id" "uuid", "p_limit" integer, "p_offset" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_document_status"("p_bot_id" "uuid", "p_limit" integer, "p_offset" integer) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_get_settings"("p_bot_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_get_settings"("p_bot_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_js_trim"("p_text" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."admin_list_bots"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_list_bots"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_list_members"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_list_members"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_policy_int"("p_bot_id" "uuid", "p_key" "text", "p_min" bigint, "p_max" bigint) FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."admin_register_document"("p_bot_id" "uuid", "p_title" "text", "p_media_type" "text", "p_byte_size" bigint, "p_disclosure_policy" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_register_document"("p_bot_id" "uuid", "p_title" "text", "p_media_type" "text", "p_byte_size" bigint, "p_disclosure_policy" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_reindex_document"("p_document_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_reindex_document"("p_document_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_request_download"("p_version_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_request_download"("p_version_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_require"("p_roles" "text"[]) FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."admin_retry_version"("p_version_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_retry_version"("p_version_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_set_bot_enabled"("p_bot_id" "uuid", "p_expected_settings_version" integer, "p_enabled" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_set_bot_enabled"("p_bot_id" "uuid", "p_expected_settings_version" integer, "p_enabled" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_settings_gate_error"("p_bot_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."admin_text_ok"("p_val" "jsonb", "p_max" integer, "p_plain" boolean) FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."admin_update_settings"("p_bot_id" "uuid", "p_expected_settings_version" integer, "p_patch" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_update_settings"("p_bot_id" "uuid", "p_expected_settings_version" integer, "p_patch" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_url_ok"("p_val" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."admin_utf16_length"("p_text" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."admin_validate_settings_patch"("p_patch" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."analysis_job_fence"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."analysis_job_fence"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."audit_logs_append_only"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."audit_logs_append_only"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."audit_logs_no_truncate"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."audit_logs_no_truncate"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."begin_request_run"("p_bot_id" "uuid", "p_visitor_session_id" "uuid", "p_token_version" integer, "p_idempotency_key" "text", "p_request_hash" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."begin_request_run"("p_bot_id" "uuid", "p_visitor_session_id" "uuid", "p_token_version" integer, "p_idempotency_key" "text", "p_request_hash" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."bot_profiles_bump_settings_version"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bot_profiles_bump_settings_version"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."bot_profiles_guard_embedding_change"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bot_profiles_guard_embedding_change"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."bot_profiles_sync_published"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bot_profiles_sync_published"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."bump_analysis_generation"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bump_analysis_generation"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."bump_bot_settings_version"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bump_bot_settings_version"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."bump_warm_generation"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bump_warm_generation"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."cache_delete_answer"("p_key_hash" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cache_delete_answer"("p_key_hash" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."cache_delete_retrieval"("p_key_hash" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cache_delete_retrieval"("p_key_hash" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."cache_get_answer"("p_key_hash" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cache_get_answer"("p_key_hash" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."cache_get_moderation"("p_key_hash" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cache_get_moderation"("p_key_hash" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."cache_get_query_embedding"("p_key_hash" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cache_get_query_embedding"("p_key_hash" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."cache_get_retrieval"("p_key_hash" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cache_get_retrieval"("p_key_hash" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."cache_set_answer"("p_bot_id" "uuid", "p_key_hash" "text", "p_language" "text", "p_answer_text" "text", "p_source_refs" "jsonb", "p_handoff_reason" "text", "p_corpus_version" bigint, "p_settings_version" integer, "p_prompt_template_version" "text", "p_chat_model" "text", "p_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cache_set_answer"("p_bot_id" "uuid", "p_key_hash" "text", "p_language" "text", "p_answer_text" "text", "p_source_refs" "jsonb", "p_handoff_reason" "text", "p_corpus_version" bigint, "p_settings_version" integer, "p_prompt_template_version" "text", "p_chat_model" "text", "p_expires_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."cache_set_moderation"("p_key_hash" "text", "p_policy_version" "text", "p_verdict" "text", "p_model" "text", "p_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cache_set_moderation"("p_key_hash" "text", "p_policy_version" "text", "p_verdict" "text", "p_model" "text", "p_expires_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."cache_set_query_embedding"("p_key_hash" "text", "p_model" "text", "p_dimensions" integer, "p_embedding_text" "text", "p_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cache_set_query_embedding"("p_key_hash" "text", "p_model" "text", "p_dimensions" integer, "p_embedding_text" "text", "p_expires_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."cache_set_retrieval"("p_key_hash" "text", "p_bot_id" "uuid", "p_corpus_version" bigint, "p_embedding_hash" "text", "p_k" integer, "p_threshold" double precision, "p_language" "text", "p_chunk_refs" "jsonb", "p_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cache_set_retrieval"("p_key_hash" "text", "p_bot_id" "uuid", "p_corpus_version" bigint, "p_embedding_hash" "text", "p_k" integer, "p_threshold" double precision, "p_language" "text", "p_chunk_refs" "jsonb", "p_expires_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."cache_touch_answer"("p_key_hash" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cache_touch_answer"("p_key_hash" "text") TO "service_role";



GRANT ALL ON TABLE "public"."jobs" TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_jobs"("p_worker" "text", "p_limit" integer, "p_lease_seconds" integer, "p_types" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_jobs"("p_worker" "text", "p_limit" integer, "p_lease_seconds" integer, "p_types" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."cleanup_document"("p_document_id" "uuid", "p_batch" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_document"("p_document_id" "uuid", "p_batch" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."cleanup_storage_targets"("p_document_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_storage_targets"("p_document_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."complete_job"("p_job_id" "uuid", "p_worker" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_job"("p_job_id" "uuid", "p_worker" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_data_entry"("p_bot_id" "uuid", "p_conversation_id" "uuid", "p_schema_key" "text", "p_payload" "jsonb", "p_consent_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_data_entry"("p_bot_id" "uuid", "p_conversation_id" "uuid", "p_schema_key" "text", "p_payload" "jsonb", "p_consent_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_visitor_session"("p_bot_id" "uuid", "p_ttl_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_visitor_session"("p_bot_id" "uuid", "p_ttl_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."enqueue_warm_after_version_change"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enqueue_warm_after_version_change"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."expire_abandoned_uploads"("p_older_than_hours" integer, "p_batch" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."expire_abandoned_uploads"("p_older_than_hours" integer, "p_batch" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."expire_stale_budget_reservations"("p_batch" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."expire_stale_budget_reservations"("p_batch" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."expire_stuck_request_runs"("p_older_than_seconds" integer, "p_batch" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."expire_stuck_request_runs"("p_older_than_seconds" integer, "p_batch" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."expire_visitor_sessions"("p_batch" integer, "p_grace_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."expire_visitor_sessions"("p_batch" integer, "p_grace_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."fail_analysis_job"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fail_analysis_job"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."fail_conversation_analysis"("p_conversation_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fail_conversation_analysis"("p_conversation_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."fail_document_version"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_failure_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fail_document_version"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_failure_code" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."fail_job"("p_job_id" "uuid", "p_worker" "text", "p_error" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fail_job"("p_job_id" "uuid", "p_worker" "text", "p_error" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."fail_orphaned_index_versions"("p_batch" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fail_orphaned_index_versions"("p_batch" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."finish_chat_turn"("p_bot_id" "uuid", "p_visitor_session_id" "uuid", "p_run_id" "uuid", "p_message_id" "uuid", "p_conversation_id" "uuid", "p_user_message_id" "uuid", "p_content" "text", "p_status" "text", "p_provider" "text", "p_model" "text", "p_handoff_reason" "text", "p_sources" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finish_chat_turn"("p_bot_id" "uuid", "p_visitor_session_id" "uuid", "p_run_id" "uuid", "p_message_id" "uuid", "p_conversation_id" "uuid", "p_user_message_id" "uuid", "p_content" "text", "p_status" "text", "p_provider" "text", "p_model" "text", "p_handoff_reason" "text", "p_sources" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_analysis_context"("p_conversation_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_analysis_context"("p_conversation_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_analysis_job_context"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_analysis_job_context"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_chat_context"("p_bot_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_chat_context"("p_bot_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_chunks_by_ids"("p_chunk_ids" "uuid"[], "p_bot_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_chunks_by_ids"("p_chunk_ids" "uuid"[], "p_bot_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_conversation_history"("p_bot_id" "uuid", "p_visitor_session_id" "uuid", "p_conversation_id" "uuid", "p_before" "uuid", "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_conversation_history"("p_bot_id" "uuid", "p_visitor_session_id" "uuid", "p_conversation_id" "uuid", "p_before" "uuid", "p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_index_job_context"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_index_job_context"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_rate_policy"("p_bot_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_rate_policy"("p_bot_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_request_run"("p_bot_id" "uuid", "p_run_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_request_run"("p_bot_id" "uuid", "p_run_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_session_policy"("p_bot_slug" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_session_policy"("p_bot_slug" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_warm_job_context"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_warm_job_context"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."heartbeat_job"("p_job_id" "uuid", "p_worker" "text", "p_lease_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."heartbeat_job"("p_job_id" "uuid", "p_worker" "text", "p_lease_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."index_job_fence"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."index_job_fence"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_active_member"("p_roles" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_active_member"("p_roles" "text"[]) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."is_active_member_mfa"("p_roles" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_active_member_mfa"("p_roles" "text"[]) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."job_status_summary"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."job_status_summary"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."knowledge_gaps"("p_from" "date", "p_to" "date", "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."knowledge_gaps"("p_from" "date", "p_to" "date", "p_limit" integer) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."mark_document_deleted"("p_document_id" "uuid", "p_cleanup_max_attempts" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mark_document_deleted"("p_document_id" "uuid", "p_cleanup_max_attempts" integer) TO "service_role";






REVOKE ALL ON FUNCTION "public"."message_sources_check_ownership"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."message_sources_check_ownership"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."messages_check_reply_to"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."messages_check_reply_to"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."prune_superseded_chunks"("p_batch" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prune_superseded_chunks"("p_batch" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."public_bot_config_sync_published"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."public_bot_config_sync_published"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."publish_warm_answer"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_key_hash" "text", "p_bot_id" "uuid", "p_language" "text", "p_raw_question" "text", "p_answer_text" "text", "p_source_refs" "jsonb", "p_handoff_reason" "text", "p_status" "text", "p_moderated" boolean, "p_truncated" boolean, "p_prompt_template_version" "text", "p_chat_model" "text", "p_corpus_version" bigint, "p_settings_version" integer, "p_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."publish_warm_answer"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_key_hash" "text", "p_bot_id" "uuid", "p_language" "text", "p_raw_question" "text", "p_answer_text" "text", "p_source_refs" "jsonb", "p_handoff_reason" "text", "p_status" "text", "p_moderated" boolean, "p_truncated" boolean, "p_prompt_template_version" "text", "p_chat_model" "text", "p_corpus_version" bigint, "p_settings_version" integer, "p_expires_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."publish_warm_embedding"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_key_hash" "text", "p_model" "text", "p_dimensions" integer, "p_embedding_text" "text", "p_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."publish_warm_embedding"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_key_hash" "text", "p_model" "text", "p_dimensions" integer, "p_embedding_text" "text", "p_expires_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."publish_warm_moderation"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_key_hash" "text", "p_policy_version" "text", "p_verdict" "text", "p_model" "text", "p_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."publish_warm_moderation"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_key_hash" "text", "p_policy_version" "text", "p_verdict" "text", "p_model" "text", "p_expires_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."publish_warm_retrieval"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_key_hash" "text", "p_bot_id" "uuid", "p_corpus_version" bigint, "p_embedding_hash" "text", "p_k" integer, "p_threshold" double precision, "p_language" "text", "p_chunk_refs" "jsonb", "p_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."publish_warm_retrieval"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_key_hash" "text", "p_bot_id" "uuid", "p_corpus_version" bigint, "p_embedding_hash" "text", "p_k" integer, "p_threshold" double precision, "p_language" "text", "p_chunk_refs" "jsonb", "p_expires_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."purge_expired_caches"("p_batch" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."purge_expired_caches"("p_batch" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."purge_expired_conversations"("p_batch" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."purge_expired_conversations"("p_batch" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."purge_expired_data_entries"("p_batch" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."purge_expired_data_entries"("p_batch" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."purge_expired_rate_limit_buckets"("p_batch" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."purge_expired_rate_limit_buckets"("p_batch" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."purge_expired_usage_records"("p_batch" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."purge_expired_usage_records"("p_batch" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."purge_terminal_jobs"("p_older_than_days" integer, "p_batch" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."purge_terminal_jobs"("p_older_than_days" integer, "p_batch" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."queue_analysis_job"("p_bot_id" "uuid", "p_conversation_id" "uuid", "p_debounce_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."queue_analysis_job"("p_bot_id" "uuid", "p_conversation_id" "uuid", "p_debounce_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."queue_warm_job"("p_bot_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."queue_warm_job"("p_bot_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_analysis_usage"("p_job_id" "uuid", "p_generation" integer, "p_reservation_id" "uuid", "p_provider" "text", "p_model" "text", "p_input_tokens" integer, "p_output_tokens" integer, "p_estimated_cost" numeric, "p_latency_ms" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_analysis_usage"("p_job_id" "uuid", "p_generation" integer, "p_reservation_id" "uuid", "p_provider" "text", "p_model" "text", "p_input_tokens" integer, "p_output_tokens" integer, "p_estimated_cost" numeric, "p_latency_ms" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_rate_limit_attempt"("p_key_hash" "text", "p_window_seconds" integer, "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_rate_limit_attempt"("p_key_hash" "text", "p_window_seconds" integer, "p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_request_usage"("p_bot_id" "uuid", "p_run_id" "uuid", "p_provider" "text", "p_model" "text", "p_operation" "text", "p_input_tokens" integer, "p_output_tokens" integer, "p_estimated_cost" numeric, "p_latency_ms" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_request_usage"("p_bot_id" "uuid", "p_run_id" "uuid", "p_provider" "text", "p_model" "text", "p_operation" "text", "p_input_tokens" integer, "p_output_tokens" integer, "p_estimated_cost" numeric, "p_latency_ms" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_usage_event"("p_bot_id" "uuid", "p_job_id" "uuid", "p_provider" "text", "p_model" "text", "p_operation" "text", "p_input_tokens" integer, "p_estimated_cost" numeric, "p_latency_ms" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_usage_event"("p_bot_id" "uuid", "p_job_id" "uuid", "p_provider" "text", "p_model" "text", "p_operation" "text", "p_input_tokens" integer, "p_estimated_cost" numeric, "p_latency_ms" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_warm_usage"("p_job_id" "uuid", "p_generation" integer, "p_question_hash" "text", "p_reservation_id" "uuid", "p_invocation_id" "uuid", "p_provider" "text", "p_model" "text", "p_operation" "text", "p_input_tokens" integer, "p_output_tokens" integer, "p_estimated_cost" numeric, "p_latency_ms" integer, "p_final" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_warm_usage"("p_job_id" "uuid", "p_generation" integer, "p_question_hash" "text", "p_reservation_id" "uuid", "p_invocation_id" "uuid", "p_provider" "text", "p_model" "text", "p_operation" "text", "p_input_tokens" integer, "p_output_tokens" integer, "p_estimated_cost" numeric, "p_latency_ms" integer, "p_final" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_budget_reservation"("p_bot_id" "uuid", "p_reservation_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_budget_reservation"("p_bot_id" "uuid", "p_reservation_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_index_budget"("p_job_id" "uuid", "p_worker" "text", "p_reservation_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_index_budget"("p_job_id" "uuid", "p_worker" "text", "p_reservation_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_job_lease"("p_job_id" "uuid", "p_worker" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_job_lease"("p_job_id" "uuid", "p_worker" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."request_runs_check_state_transition"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."request_runs_check_state_transition"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."reserve_analysis_budget"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_amount" numeric, "p_ttl_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reserve_analysis_budget"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_amount" numeric, "p_ttl_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reserve_index_budget"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_amount" numeric, "p_ttl_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reserve_index_budget"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_amount" numeric, "p_ttl_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reserve_request_budget"("p_bot_id" "uuid", "p_request_id" "uuid", "p_amount" numeric, "p_ttl_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reserve_request_budget"("p_bot_id" "uuid", "p_request_id" "uuid", "p_amount" numeric, "p_ttl_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reserve_warm_budget"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_question_hash" "text", "p_amount" numeric, "p_ttl_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reserve_warm_budget"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_question_hash" "text", "p_amount" numeric, "p_ttl_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reset_version_chunks"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reset_version_chunks"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."retry_job_later"("p_job_id" "uuid", "p_worker" "text", "p_error_code" "text", "p_delay_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."retry_job_later"("p_job_id" "uuid", "p_worker" "text", "p_error_code" "text", "p_delay_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."save_analysis_job_result"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_summary" "text", "p_sentiment" "text", "p_intent" "text", "p_analysis_version" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."save_analysis_job_result"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_summary" "text", "p_sentiment" "text", "p_intent" "text", "p_analysis_version" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."save_conversation_analysis"("p_conversation_id" "uuid", "p_summary" "text", "p_sentiment" "text", "p_intent" "text", "p_analysis_version" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."save_conversation_analysis"("p_conversation_id" "uuid", "p_summary" "text", "p_sentiment" "text", "p_intent" "text", "p_analysis_version" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."schedule_analysis_successor"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."schedule_analysis_successor"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."schema_version"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."schema_version"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."set_request_run_state"("p_bot_id" "uuid", "p_run_id" "uuid", "p_state" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_request_run_state"("p_bot_id" "uuid", "p_run_id" "uuid", "p_state" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_updated_at"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."settle_analysis_budget"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_reservation_id" "uuid", "p_actual" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_analysis_budget"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_reservation_id" "uuid", "p_actual" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."settle_budget_reservation"("p_bot_id" "uuid", "p_reservation_id" "uuid", "p_actual_amount" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_budget_reservation"("p_bot_id" "uuid", "p_reservation_id" "uuid", "p_actual_amount" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."settle_index_budget"("p_job_id" "uuid", "p_worker" "text", "p_reservation_id" "uuid", "p_actual" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_index_budget"("p_job_id" "uuid", "p_worker" "text", "p_reservation_id" "uuid", "p_actual" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."settle_orphaned_analysis_reservations"("p_batch" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_orphaned_analysis_reservations"("p_batch" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."settle_orphaned_index_reservations"("p_batch" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_orphaned_index_reservations"("p_batch" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."settle_orphaned_warm_reservations"("p_batch" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_orphaned_warm_reservations"("p_batch" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."settle_warm_budget"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_question_hash" "text", "p_reservation_id" "uuid", "p_actual" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_warm_budget"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer, "p_question_hash" "text", "p_reservation_id" "uuid", "p_actual" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."start_chat_turn"("p_bot_id" "uuid", "p_visitor_session_id" "uuid", "p_run_id" "uuid", "p_conversation_id" "uuid", "p_content" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."start_chat_turn"("p_bot_id" "uuid", "p_visitor_session_id" "uuid", "p_run_id" "uuid", "p_conversation_id" "uuid", "p_content" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."update_version_progress"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_patch" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_version_progress"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_patch" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."usage_daily_summary"("p_from" "date", "p_to" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."usage_daily_summary"("p_from" "date", "p_to" "date") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."warm_job_fence"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."warm_job_fence"("p_job_id" "uuid", "p_worker" "text", "p_generation" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."warm_layer_enabled"("p_policy" "jsonb", "p_layer" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."warm_layer_enabled"("p_policy" "jsonb", "p_layer" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."warm_policy_enabled"("p_policy" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."warm_policy_enabled"("p_policy" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."write_document_chunks"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_chunks" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."write_document_chunks"("p_job_id" "uuid", "p_worker" "text", "p_version_id" "uuid", "p_chunks" "jsonb") TO "service_role";






























GRANT ALL ON TABLE "public"."admin_memberships" TO "service_role";



GRANT ALL ON TABLE "public"."answer_cache" TO "service_role";



GRANT SELECT ON TABLE "public"."audit_logs" TO "authenticated";
GRANT SELECT,INSERT ON TABLE "public"."audit_logs" TO "service_role";



GRANT ALL ON TABLE "public"."bot_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."budget_reservations" TO "service_role";



GRANT ALL ON TABLE "public"."client_settings" TO "service_role";



GRANT ALL ON TABLE "public"."conversation_analysis" TO "service_role";
GRANT SELECT ON TABLE "public"."conversation_analysis" TO "authenticated";



GRANT ALL ON TABLE "public"."conversations" TO "service_role";
GRANT SELECT ON TABLE "public"."conversations" TO "authenticated";



GRANT ALL ON TABLE "public"."data_entries" TO "service_role";
GRANT SELECT ON TABLE "public"."data_entries" TO "authenticated";



GRANT ALL ON TABLE "public"."document_chunks" TO "service_role";



GRANT ALL ON TABLE "public"."document_versions" TO "service_role";
GRANT SELECT ON TABLE "public"."document_versions" TO "authenticated";



GRANT ALL ON TABLE "public"."documents" TO "service_role";
GRANT SELECT ON TABLE "public"."documents" TO "authenticated";



GRANT ALL ON TABLE "public"."message_sources" TO "service_role";
GRANT SELECT ON TABLE "public"."message_sources" TO "authenticated";



GRANT ALL ON TABLE "public"."messages" TO "service_role";
GRANT SELECT ON TABLE "public"."messages" TO "authenticated";



GRANT ALL ON TABLE "public"."moderation_cache" TO "service_role";



GRANT ALL ON TABLE "public"."public_bot_config" TO "service_role";
GRANT SELECT ON TABLE "public"."public_bot_config" TO "anon";
GRANT SELECT ON TABLE "public"."public_bot_config" TO "authenticated";



GRANT ALL ON TABLE "public"."query_embedding_cache" TO "service_role";



GRANT ALL ON TABLE "public"."rate_limit_buckets" TO "service_role";



GRANT ALL ON TABLE "public"."request_runs" TO "service_role";



GRANT ALL ON TABLE "public"."retrieval_cache" TO "service_role";



GRANT ALL ON TABLE "public"."usage_events" TO "service_role";



GRANT ALL ON TABLE "public"."visitor_sessions" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" REVOKE ALL ON FUNCTIONS FROM PUBLIC;




























