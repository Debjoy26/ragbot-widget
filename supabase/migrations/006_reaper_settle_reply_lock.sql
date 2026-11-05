-- 006: debug cycle P3-D3 (security review P3-R3, findings R3-1 and R3-2).
-- 001-005 are applied to remote projects, so fixes are forward-only. CREATE OR REPLACE keeps the
-- existing grants, revokes and the trigger binding.

-- R3-1: a reaped run may still be in flight. Its reservation becomes 'expired', not 'released':
-- 'expired' stops counting toward the cap like 'released' does, but stays settleable, so a slow
-- request's real spend is still counted when it finishes (see settle_budget_reservation in 004).
create or replace function public.expire_stuck_request_runs(p_older_than_seconds integer, p_batch integer)
returns integer
language plpgsql
set search_path = ''
as $$
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

-- R3-2: FOR SHARE locks the target until commit, so a concurrent move or role change of the question
-- either waits and is then rejected by the first branch, or commits first and is seen here.
-- A target that is missing or not visible to the writer is rejected (fail closed), not skipped.
create or replace function public.messages_check_reply_to()
returns trigger
language plpgsql
set search_path = ''
as $$
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
