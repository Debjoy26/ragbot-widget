-- 016_p9_entries.sql — P9-T1: service-role RPC for visitor data entries (W-13) + schema_version 16.
--
-- POST /v1/entries stores validated form payloads in public.data_entries. Browsers never write
-- the table directly (grants matrix: anon/authenticated have no INSERT); only service_role
-- executes this function, after the API has authenticated the visitor, validated the form
-- against the approved registry, and checked conversation ownership.
--
-- Fail-closed: unknown bot, bad key, non-object payload or missing consent timestamp raise
-- 22023; a conversation that does not belong to the bot raises RB037 (the API answers the
-- same 404 for "no such conversation" and "someone else's conversation", so it is no oracle).

-- ---------------------------------------------------------------------------
-- create_data_entry: insert one entry row and return its id.
-- ---------------------------------------------------------------------------
create function public.create_data_entry(
  p_bot_id uuid,
  p_conversation_id uuid,
  p_schema_key text,
  p_payload jsonb,
  p_consent_at timestamptz
)
returns table (entry_id uuid)
language plpgsql
set search_path = ''
set lock_timeout = '2s'
as $$
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
$$;
revoke all on function public.create_data_entry(uuid, uuid, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.create_data_entry(uuid, uuid, text, jsonb, timestamptz) to service_role;

-- schema_version: bump to 16.
create or replace function public.schema_version()
returns integer
language sql
stable
set search_path = ''
set lock_timeout = '2s'
as $$
  select 16;
$$;
revoke all on function public.schema_version() from public, anon, authenticated, service_role;
grant execute on function public.schema_version() to authenticated;
