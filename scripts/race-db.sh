#!/usr/bin/env bash
# Two-connection races against the LOCAL Supabase database (P3-D4). Never point this at a remote project.
#
# Each ordering sets up synthetic rows, holds one transaction open (the "first" statement plus a sleep)
# while a second connection runs its statement, then checks the final rows. Both connections are real
# psql sessions in the DB container, running as service_role (the role the API and worker use).
# Based on docs/evidence/P3-D3/race_reply_to.sh, which stays as it was.
#
# Output: one result line per ordering. Exit status:
#   0  every ordering consistent, no unexpected error
#   1  a VIOLATION was found, or a connection failed with an error the ordering does not expect
#   2  the local database container is not available
# A line may carry "WARN no overlap": the second statement returned without waiting although it should
# have, so the race did not happen. That ordering is retried once. A warning that remains fails the run,
# as does a verdict that is not CONSISTENT or a run that does not cover every ordering.
# RACE_DELAY overrides the delay before the second connection; the guard test uses it.
# Orderings that must not block (expect "fast") fail when the second statement waited; orderings that
# prove overlap from row timestamps (verdict "NOOVERLAP ...") are retried once and then warn like the others.
#
# The reaper (expire_stuck_request_runs) is global, so it also reaps other stuck runs in the local DB.
# Rows are created for one synthetic bot and removed on exit.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/supabase/config.toml"
PROJECT_ID="$(sed -n 's/^project_id[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG" | head -n 1)"
if [ -z "$PROJECT_ID" ]; then
  echo "race-db: no project_id in $CONFIG" >&2
  exit 2
fi
C="supabase_db_${PROJECT_ID}"
case "${DOCKER_HOST:-}" in
  "" | unix://*) ;;
  *) echo "race-db: DOCKER_HOST points at a non-local daemon; refusing to run" >&2; exit 2 ;;
esac
# The docker CLI may point at a remote daemon through a context (not only through DOCKER_HOST). Only a local
# unix socket is accepted; an unreadable context fails closed.
DOCKER_ENDPOINT="$(docker context inspect --format '{{(index .Endpoints "docker").Host}}' 2>/dev/null)"
case "$DOCKER_ENDPOINT" in
  unix://*) ;;
  *) echo "race-db: the docker context endpoint is not a local unix socket (scheme '${DOCKER_ENDPOINT%%://*}'); refusing to run" >&2; exit 2 ;;
esac
if [ "$(docker inspect -f '{{.State.Running}}' "$C" 2>/dev/null)" != "true" ]; then
  echo "race-db: container $C is not running (start the local stack: make db-start)" >&2
  exit 2
fi

# Timing: functions from migration 011 (and settle, release, record_rate_limit_attempt) set
# lock_timeout = 2s, so a blocked second statement must finish waiting well before 2 s. Expected wait is
# about HOLD - DELAY + 0.1 s = 1.5 s: 0.5 s below the lock timeout and 0.7 s above BLOCKED_MS.
HOLD=2.0      # seconds the first transaction stays open
DELAY="${RACE_DELAY:-0.6}"     # seconds before the second connection starts
BLOCKED_MS=800  # a second statement that waited is at least this slow

TMP="$(mktemp -d)"
BOT=ac100000-0000-4000-8000-000000000001
SESS=ac200000-0000-4000-8000-000000000001
C1=ac300000-0000-4000-8000-000000000001; C2=ac300000-0000-4000-8000-000000000002
U=ac400000-0000-4000-8000-000000000001;  U2=ac400000-0000-4000-8000-000000000002
A=ac500000-0000-4000-8000-000000000001;  A2=ac500000-0000-4000-8000-000000000002
RUN=ac600000-0000-4000-8000-000000000001
RUN2=ac600000-0000-4000-8000-000000000002
J1=ac700000-0000-4000-8000-000000000001; J2=ac700000-0000-4000-8000-000000000002
BUCKET=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
OWNR=ae100000-0000-4000-8000-000000000001; ADMN=ae100000-0000-4000-8000-000000000002
DOC=ae200000-0000-4000-8000-000000000001;  VER=ae300000-0000-4000-8000-000000000001
IDXD=af200000-0000-4000-8000-000000000001; IDXV=af300000-0000-4000-8000-000000000001; IDXJ=af700000-0000-4000-8000-000000000001
CAPD1=af210000-0000-4000-8000-000000000001; CAPV1=af310000-0000-4000-8000-000000000001
CAPD2=af220000-0000-4000-8000-000000000001; CAPV2=af320000-0000-4000-8000-000000000001

pq() { docker exec -i "$C" psql -U postgres -X -q -At -v ON_ERROR_STOP=1 -v VERBOSITY=verbose "$@"; }

# Rows the P3.5 orderings leave behind besides the bot: users (memberships cascade), Storage objects (the
# Storage delete guard is lifted for this session only), index jobs and the admin quota counters.
# audit_logs is append-only, so audit rows written by those orderings stay in the local database.
CLEAN_P35="delete from auth.users where id in ('$OWNR', '$ADMN');
    delete from public.jobs where payload ->> 'bot_id' = '$BOT';
    delete from public.rate_limit_buckets where key_hash in (
      encode(sha256(convert_to('admin_quota:$BOT:register', 'utf8')), 'hex'),
      encode(sha256(convert_to('admin_quota:$BOT:upload', 'utf8')), 'hex'),
      encode(sha256(convert_to('admin_quota:$BOT:reindex', 'utf8')), 'hex'),
      encode(sha256(convert_to('admin_quota:$BOT:write', 'utf8')), 'hex'));
    set storage.allow_delete_query = 'true';
    delete from storage.objects where bucket_id = 'knowledge' and name like '$BOT/%';"

cleanup() {
  pq -c "delete from public.bot_profiles where id = '$BOT';
    delete from public.jobs where id in ('$J1', '$J2');
    delete from public.rate_limit_buckets where key_hash = '$BUCKET';
    $CLEAN_P35" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

fail=0; warn=0; n=0; retrying=0
EXPECTED=47

# Fresh fixture: one enabled bot (begin_request_run and reserve_request_budget refuse a disabled one, migration 011) with settings and a session, two conversations, two questions in C1.
fixture() { # extra setup SQL
  pq -c "delete from public.bot_profiles where id = '$BOT';
    delete from public.jobs where id in ('$J1', '$J2');
    delete from public.rate_limit_buckets where key_hash = '$BUCKET';
    $CLEAN_P35
    insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions, enabled)
      values ('$BOT', 'race-db', 'x', array['en'], 'm', 1536, true);
    insert into public.client_settings (bot_id, allowed_origins, rate_policy, budget_policy, retention_policy, upload_policy, handoff_policy, cache_policy)
      values ('$BOT', array['https://e.test'], '{}', '{\"daily_cap_usd\": 100}', '{}', '{}', '{}', '{}');
    insert into public.visitor_sessions (id, bot_id, expires_at) values ('$SESS', '$BOT', now() + interval '1 hour');
    insert into public.conversations (id, bot_id) values ('$C1', '$BOT'), ('$C2', '$BOT');
    insert into public.messages (id, conversation_id, role, content) values ('$U', '$C1', 'user', 'q'), ('$U2', '$C1', 'user', 'q2');
    $1" >/dev/null || { echo "race-db: fixture setup failed" >&2; exit 1; }
}

# Result of one connection: "ok", "err:<SQLSTATE>" (expected), or "err:<SQLSTATE>(unexpected)".
classify() { # rc errfile allowed-sqlstates
  if [ "$1" -eq 0 ]; then echo "ok"; return; fi
  local st
  st="$(grep -m 1 -oE 'ERROR:  [0-9A-Z]{5}' "$2" | awk '{print $2}')"
  [ -n "$st" ] || st="unknown"
  case " $3 " in *" $st "*) echo "err:$st" ;; *) echo "err:$st(unexpected)" ;; esac
}

run_order() { # name, setup SQL, first SQL, second SQL, verdict SQL, first-allowed, second-allowed, expect-block (yes|no|fast) [, exactly-one-error]
  local name="$1" setup="$2" first="$3" second="$4" verdict="$5" fa="$6" sa="$7" eb="$8" one="${9:-}"
  n=$((n + 1))
  fixture "$setup"
  ( pq -c "begin; set local role service_role; $first select pg_sleep($HOLD); commit;" >/dev/null 2>"$TMP/a.err"
    echo $? >"$TMP/a.rc" ) &
  local pid=$!
  sleep "$DELAY"
  local t0 t1 brc
  t0=$(date +%s%N)
  pq -c "begin; set local role service_role; $second commit;" >/dev/null 2>"$TMP/b.err"; brc=$?
  t1=$(date +%s%N)
  wait "$pid"
  local ms=$(( (t1 - t0) / 1000000 ))
  local ares bres bad=0
  ares="$(classify "$(cat "$TMP/a.rc")" "$TMP/a.err" "$fa")"
  bres="$(classify "$brc" "$TMP/b.err" "$sa")"
  case "$ares$bres" in *"(unexpected)"*) bad=1 ;; esac
  local note=""
  # exactly-one-error: one side must have been rolled back (an allowed SQLSTATE) and the other must have
  # succeeded. Neither erroring means the deadlock did not happen; both erroring means nothing won.
  if [ "$one" = "one" ]; then
    local nerr=0
    case "$ares" in err:*) nerr=$((nerr + 1)) ;; esac
    case "$bres" in err:*) nerr=$((nerr + 1)) ;; esac
    if [ "$nerr" -ne 1 ]; then
      note=" EXPECTED EXACTLY ONE ERROR"; bad=1
    fi
  fi
  local v
  v="$(pq -c "$verdict" 2>"$TMP/v.err")" || { v="VIOLATION: verdict query failed"; bad=1; }
  local noov=0
  if [ "$bad" -eq 1 ]; then note="$note UNEXPECTED ERROR"; fail=$((fail + 1)); fi
  case "$v" in
    NOOVERLAP*) noov=1 ;;
    CONSISTENT*) ;;
    *) fail=$((fail + 1)) ;;
  esac
  if [ "$eb" = "yes" ] && [ "$ms" -lt "$BLOCKED_MS" ]; then noov=1; fi
  if [ "$eb" = "fast" ] && [ "$ms" -ge "$BLOCKED_MS" ]; then note="$note UNEXPECTED BLOCK"; fail=$((fail + 1)); fi
  if [ "$noov" -eq 1 ]; then
    if [ "$retrying" -eq 0 ]; then
      printf '%-46s => no overlap, retrying once (%d ms)\n' "$name" "$ms"
      retrying=1; n=$((n - 1)); run_order "$@"; retrying=0
      return
    fi
    note="$note WARN no overlap"; warn=$((warn + 1))
  fi
  printf '%-46s => %s | first=%s second=%s (%d ms)%s\n' "$name" "$v" "$ares" "$bres" "$ms" "$note"
  if [ "$bad" -eq 1 ]; then
    { sed 's/^/    first : /' "$TMP/a.err"; sed 's/^/    second: /' "$TMP/b.err"; } | cut -c1-200 | head -n 6
  fi
}

INS="insert into public.messages (id, conversation_id, reply_to_message_id, role, content) values ('$A', '$C1', '$U', 'assistant', 'a');"
INS2="insert into public.messages (id, conversation_id, reply_to_message_id, role, content) values ('$A2', '$C1', '$U', 'assistant', 'a');"
MOVE_U="update public.messages set conversation_id = '$C2' where id = '$U';"
MOVE_U2="update public.messages set conversation_id = '$C2' where id = '$U2';"
SETROLE_U="update public.messages set role = 'assistant' where id = '$U';"
REPLY_EXISTS="insert into public.messages (id, conversation_id, reply_to_message_id, role, content) values ('$A', '$C1', '$U', 'assistant', 'a');"
RUN_ROW="insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash, state, started_at)
  values ('$RUN', '$BOT', '$SESS', '00000000-0000-4000-8000-0000000ace01', repeat('a', 64), 'running', now() - interval '10 minutes');"
RESERVE="select public.reserve_request_budget('$BOT', '$RUN', 1.0, 3600);"
SETTLE="select public.settle_budget_reservation('$BOT', (select id from public.budget_reservations where request_id = '$RUN'), 0.75);"
RELEASE="select public.release_budget_reservation('$BOT', (select id from public.budget_reservations where request_id = '$RUN'));"
REAP="select public.expire_stuck_request_runs(60, 100);"

# Replies must point at a user message of their own conversation (or be detached); nothing dangles.
V_REPLY="select case
  when exists (select 1 from public.messages a left join public.messages u on u.id = a.reply_to_message_id
                where a.id in ('$A', '$A2') and a.reply_to_message_id is not null
                  and (u.id is null or u.conversation_id <> a.conversation_id or u.role <> 'user'))
  then 'VIOLATION: reply points outside its conversation, at a non-user row, or at nothing'
  else 'CONSISTENT: ' || (select count(*) from public.messages where id in ('$A', '$A2')) || ' reply row(s)' end"
V_TWO="select case
  when (select count(*) from public.messages where id in ('$A', '$A2')) <> 2 then 'VIOLATION: expected both replies to exist'
  when exists (select 1 from public.messages a join public.messages u on u.id = a.reply_to_message_id
                where a.id in ('$A', '$A2') and (u.conversation_id <> a.conversation_id or u.role <> 'user'))
  then 'VIOLATION: reply points outside its conversation or at a non-user row'
  else 'CONSISTENT: 2 reply rows' end"
V_DETACHED="select case
  when (select count(*) from public.messages where id = '$A') <> 1 then 'VIOLATION: the reply was lost'
  when (select reply_to_message_id from public.messages where id = '$A') is not null then 'VIOLATION: reply still points at the deleted question'
  else 'CONSISTENT: reply kept, detached' end"
V_SETTLED="select case
  when r.state = 'failed' and b.state = 'settled' and b.amount = 0.75 then 'CONSISTENT: run failed, reservation settled 0.75'
  else 'VIOLATION: run=' || r.state || ' reservation=' || coalesce(b.state || ' ' || b.amount, 'none') end
  from public.request_runs r left join public.budget_reservations b on b.request_id = r.id where r.id = '$RUN'"
V_NOT_HELD="select case
  when r.state = 'failed' and b.state in ('released', 'expired') then 'CONSISTENT: run failed, reservation ' || b.state
  else 'VIOLATION: run=' || r.state || ' reservation=' || coalesce(b.state, 'none') end
  from public.request_runs r left join public.budget_reservations b on b.request_id = r.id where r.id = '$RUN'"
V_SKIPPED="select case
  when r.state = 'running' and b.state = 'reserved' then 'CONSISTENT: reaper skipped the locked run'
  else 'VIOLATION: reaper did not skip the run: run=' || r.state || ' reservation=' || coalesce(b.state, 'none') end
  from public.request_runs r left join public.budget_reservations b on b.request_id = r.id where r.id = '$RUN'"
V_RESERVE="select case
  when r.state in ('failed', 'succeeded', 'partial') and b.state = 'reserved' then 'VIOLATION: finished run holds an active reservation'
  when r.state = 'running' and b.state is distinct from 'reserved' then 'VIOLATION: live run without its reservation'
  else 'CONSISTENT: run ' || r.state || ', reservation ' || coalesce(b.state, 'none') end
  from public.request_runs r left join public.budget_reservations b on b.request_id = r.id where r.id = '$RUN'"

# ---- Two workers, two starts, two counters, two reservations (P3-D5, G-10) ----
# claim_jobs: two queued jobs (type warm_answer_cache, so no other local job is picked); each worker
# claims one. Overlap is read from the leases: both claims take locked_until = transaction start + lease,
# so the second worker started after the first and before the first committed (HOLD seconds later).
JOBS="insert into public.jobs (id, type, payload, max_attempts, available_at, created_at) values
  ('$J1', 'warm_answer_cache', '{}', 3, now() - interval '1 minute', now() - interval '2 minutes'),
  ('$J2', 'warm_answer_cache', '{}', 3, now() - interval '1 minute', now() - interval '1 minute');"
CLAIM1="select * from public.claim_jobs('race-w1', 1, 600, array['warm_answer_cache']);"
CLAIM2="select * from public.claim_jobs('race-w2', 1, 600, array['warm_answer_cache']);"
V_CLAIM="select case
  when (select count(*) from public.jobs where id in ('$J1', '$J2') and state = 'running' and attempts = 1) <> 2
    then 'VIOLATION: expected both jobs claimed exactly once, found ' ||
         (select string_agg(state || '/' || attempts, ',' order by id) from public.jobs where id in ('$J1', '$J2'))
  when (select count(distinct locked_by) from public.jobs where id in ('$J1', '$J2')) <> 2
    then 'VIOLATION: both jobs are held by the same worker'
  when (select count(*) from public.jobs where id in ('$J1', '$J2') and locked_by in ('race-w1', 'race-w2')) <> 2
    then 'VIOLATION: a job is held by an unknown worker'
  when not coalesce((select extract(epoch from (w2.locked_until - w1.locked_until)) between 0 and $HOLD - 0.3
                       from public.jobs w1, public.jobs w2
                      where w1.locked_by = 'race-w1' and w2.locked_by = 'race-w2' and w1.id in ('$J1', '$J2') and w2.id in ('$J1', '$J2')), false)
    then 'NOOVERLAP: the second claim did not start while the first was open'
  else 'CONSISTENT: each job claimed once, by a different worker' end"

# begin_request_run: session cap 1. The second start must wait for the session row lock and then see the
# first run; two runs for the session would mean the cap check raced.
CAP1="update public.client_settings set rate_policy = '{\"concurrent_requests_per_session\": 1}' where bot_id = '$BOT';"
BEGIN1="select * from public.begin_request_run('$BOT', '$SESS', 1, '00000000-0000-4000-8000-0000000b0001', repeat('a', 64));"
BEGIN2="select * from public.begin_request_run('$BOT', '$SESS', 1, '00000000-0000-4000-8000-0000000b0002', repeat('b', 64));"
V_BEGIN="select case
  when (select count(*) from public.request_runs where visitor_session_id = '$SESS') <> 1
    then 'VIOLATION: ' || (select count(*) from public.request_runs where visitor_session_id = '$SESS') || ' runs admitted for a session capped at 1'
  when (select idempotency_key from public.request_runs where visitor_session_id = '$SESS') <> '00000000-0000-4000-8000-0000000b0001'
    then 'VIOLATION: the later start was admitted'
  else 'CONSISTENT: one run admitted, the second start was limited' end"

# record_rate_limit_attempt: both attempts on one key and window are counted (no lost update).
RATE1="select * from public.record_rate_limit_attempt('$BUCKET', 86400, 1);"
V_RATE="select case
  when (select count(*) from public.rate_limit_buckets where key_hash = '$BUCKET') = 0 then 'VIOLATION: no counter row'
  when (select sum(request_count) from public.rate_limit_buckets where key_hash = '$BUCKET') <> 2
    then 'VIOLATION: counted ' || (select sum(request_count) from public.rate_limit_buckets where key_hash = '$BUCKET') || ' of 2 attempts'
  else 'CONSISTENT: both attempts counted' end"

# reserve_request_budget: cap 1.5, two reservations of 1.0 for two runs of one bot. The second reserve
# waits for the settings row lock, then must see the first and fail with RB001 (budget_exceeded).
CAP15="update public.client_settings set budget_policy = '{\"daily_cap_usd\": 1.5}' where bot_id = '$BOT';"
RUN2_ROW="insert into public.request_runs (id, bot_id, visitor_session_id, idempotency_key, request_hash, state, started_at)
  values ('$RUN2', '$BOT', '$SESS', '00000000-0000-4000-8000-0000000ace02', repeat('b', 64), 'running', now() - interval '10 minutes');"
RESERVE2="select public.reserve_request_budget('$BOT', '$RUN2', 1.0, 3600);"
V_CAP="select case
  when (select coalesce(sum(amount), 0) from public.budget_reservations where bot_id = '$BOT' and state = 'reserved') > 1.5
    then 'VIOLATION: reserved ' || (select sum(amount) from public.budget_reservations where bot_id = '$BOT' and state = 'reserved') || ' against a cap of 1.5'
  when (select count(*) from public.budget_reservations where bot_id = '$BOT') <> 1
    then 'VIOLATION: expected exactly one reservation, found ' || (select count(*) from public.budget_reservations where bot_id = '$BOT')
  else 'CONSISTENT: one reservation fits the cap, the other was refused' end"

run_order "reply in flight, question moved"        ""                       "$INS"        "$MOVE_U"   "$V_REPLY" ""      "23514" yes
run_order "reply in flight, question role changed" ""                       "$INS"        "$SETROLE_U" "$V_REPLY" ""      "23514" yes
run_order "question move in flight, reply"         ""                       "$MOVE_U"     "$INS"      "$V_REPLY" ""      "23514" yes
run_order "pointer update in flight, target moved" "$REPLY_EXISTS"          "update public.messages set reply_to_message_id = '$U2' where id = '$A';" "$MOVE_U2" "$V_REPLY" "" "23514" yes
run_order "target move in flight, pointer update"  "$REPLY_EXISTS"          "$MOVE_U2"    "update public.messages set reply_to_message_id = '$U2' where id = '$A';" "$V_REPLY" "" "23514" yes
run_order "reply in flight, target deleted"        ""                       "$INS"        "delete from public.messages where id = '$U';" "$V_DETACHED" "" "" yes
run_order "target delete in flight, reply"         ""                       "delete from public.messages where id = '$U';" "$INS" "$V_REPLY" "" "23514 23503" yes
run_order "two concurrent replies to one target"   ""                       "$INS"        "$INS2"     "$V_TWO"   ""      ""      no
run_order "settle in flight, reaper"               "$RUN_ROW $RESERVE"      "$SETTLE"     "$REAP"     "$V_SETTLED" ""  ""      yes
run_order "reaper in flight, settle"               "$RUN_ROW $RESERVE"      "$REAP"       "$SETTLE"   "$V_SETTLED" ""  ""      yes
run_order "release in flight, reaper"              "$RUN_ROW $RESERVE"      "$RELEASE"    "$REAP"     "$V_NOT_HELD" "" ""      yes
run_order "reaper in flight, release"              "$RUN_ROW $RESERVE"      "$REAP"       "$RELEASE"  "$V_NOT_HELD" "" "RB003" yes
run_order "reserve in flight, reaper"              "$RUN_ROW"               "$RESERVE"    "$REAP"     "$V_SKIPPED" ""  ""      no
run_order "reaper in flight, reserve"              "$RUN_ROW"               "$REAP"       "$RESERVE"  "$V_RESERVE" ""  "RB004" yes

run_order "claim in flight, second worker claims"  "$JOBS"                  "$CLAIM1"     "$CLAIM2"   "$V_CLAIM" ""    ""      fast
run_order "start in flight, second start (cap 1)"  "$CAP1"                  "$BEGIN1"     "$BEGIN2"   "$V_BEGIN" ""    ""      yes
run_order "attempt in flight, second attempt"      ""                       "$RATE1"      "$RATE1"    "$V_RATE"  ""    ""      yes
run_order "reserve in flight, second reserve (cap)" "$RUN_ROW $RUN2_ROW $CAP15" "$RESERVE" "$RESERVE2" "$V_CAP"  ""    "RB001" yes

# ---- P3.5: the admin document functions under real concurrency (browser role, aal2 claims) ----
# The two callers are an owner and an admin, each a real session as `authenticated` with an aal2 JWT.
# complete_upload: two completes of one version. The second waits for the document lock, then sees the
# version uploaded and queues nothing: one job.
# add_document_version: two adds to one document get distinct numbers (the document row is locked).
# reserve_index_budget (P6-D2, replaces reserve_job_budget): cap 1.5, two reservations of 1.0 for two running jobs held by
# worker w1: the cap is never exceeded.
AS_OWNER="set local role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"$OWNR\",\"aal\":\"aal2\",\"role\":\"authenticated\"}', true);"
AS_ADMIN="set local role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"$ADMN\",\"aal\":\"aal2\",\"role\":\"authenticated\"}', true);"
ADMIN_FIX="insert into auth.users (id, aud, role, email) values
    ('$OWNR', 'authenticated', 'authenticated', 'race-owner@example.test'),
    ('$ADMN', 'authenticated', 'authenticated', 'race-admin@example.test');
  insert into public.admin_memberships (user_id, role) values ('$OWNR', 'owner'), ('$ADMN', 'admin');
  update public.client_settings set upload_policy = '{\"max_bytes\": 1048576, \"index_max_attempts\": 3, \"cleanup_max_attempts\": 3,
    \"quotas\": {\"register\": {\"limit\": 100, \"window_seconds\": 3600}, \"upload\": {\"limit\": 100, \"window_seconds\": 3600},
    \"reindex\": {\"limit\": 100, \"window_seconds\": 3600}, \"write\": {\"limit\": 100, \"window_seconds\": 3600}}}' where bot_id = '$BOT';
  insert into public.documents (id, bot_id, title) values ('$DOC', '$BOT', 'race doc');
  insert into public.document_versions (id, document_id, version_number, storage_path, media_type, byte_size)
    values ('$VER', '$DOC', 1, '$BOT/$DOC/$VER/original.txt', 'text/plain', 100);
  insert into storage.objects (bucket_id, name, metadata)
    values ('knowledge', '$BOT/$DOC/$VER/original.txt', '{\"size\": 100, \"mimetype\": \"text/plain\", \"eTag\": \"race-etag\"}');"
COMPLETE_O="$AS_OWNER select * from public.admin_complete_upload('$VER');"
COMPLETE_A="$AS_ADMIN select * from public.admin_complete_upload('$VER');"
V_COMPLETE="select case
  when (select count(*) from public.jobs where dedupe_key = 'index:version:$VER') <> 1
    then 'VIOLATION: ' || (select count(*) from public.jobs where dedupe_key = 'index:version:$VER') || ' jobs queued for one version'
  when (select status from public.document_versions where id = '$VER') <> 'uploaded' then 'VIOLATION: the version is not uploaded'
  else 'CONSISTENT: one job for the version' end"
ADD_O="$AS_OWNER select * from public.admin_add_document_version('$DOC', 'text/plain', 100);"
ADD_A="$AS_ADMIN select * from public.admin_add_document_version('$DOC', 'text/plain', 100);"
V_ADD="select case
  when (select count(*) from public.document_versions where document_id = '$DOC') <> 3
    then 'VIOLATION: expected 3 versions, found ' || (select count(*) from public.document_versions where document_id = '$DOC')
  when (select count(distinct version_number) from public.document_versions where document_id = '$DOC') <> 3
    or (select max(version_number) from public.document_versions where document_id = '$DOC') <> 3
    then 'VIOLATION: version numbers are not 1, 2, 3'
  else 'CONSISTENT: versions 1, 2 and 3' end"
JOBS_RUN="insert into public.documents (id, bot_id, title, status) values ('$CAPD1', '$BOT', 'cap1', 'indexing'), ('$CAPD2', '$BOT', 'cap2', 'indexing');
  insert into public.document_versions (id, document_id, version_number, storage_path, media_type, byte_size, status) values
    ('$CAPV1', '$CAPD1', 1, '$BOT/$CAPD1/$CAPV1/original.txt', 'text/plain', 100, 'embedding'),
    ('$CAPV2', '$CAPD2', 1, '$BOT/$CAPD2/$CAPV2/original.txt', 'text/plain', 100, 'embedding');
  insert into public.jobs (id, type, payload, state, max_attempts, locked_by, locked_until) values
  ('$J1', 'index_document', jsonb_build_object('bot_id', '$BOT'::uuid, 'document_id', '$CAPD1'::uuid, 'version_id', '$CAPV1'::uuid), 'running', 3, 'w1', now() + interval '1 hour'),
  ('$J2', 'index_document', jsonb_build_object('bot_id', '$BOT'::uuid, 'document_id', '$CAPD2'::uuid, 'version_id', '$CAPV2'::uuid), 'running', 3, 'w1', now() + interval '1 hour');"
RESERVE_J1="select public.reserve_index_budget('$J1', 'w1', '$CAPV1', 1.0, 3600);"
RESERVE_J2="select public.reserve_index_budget('$J2', 'w1', '$CAPV2', 1.0, 3600);"

run_order "complete in flight, second complete"    "$ADMIN_FIX"             "$COMPLETE_O" "$COMPLETE_A" "$V_COMPLETE" ""  ""      yes
run_order "add version in flight, second add"      "$ADMIN_FIX"             "$ADD_O"      "$ADD_A"    "$V_ADD"   ""    ""      yes
run_order "index reserve in flight, second (cap)"  "$CAP15 $JOBS_RUN"       "$RESERVE_J1" "$RESERVE_J2" "$V_CAP" ""    "RB001" yes

# settings: two admin_update_settings calls with the same expected version. The bot has no public config yet, so
# both patches bring display_name and supported_languages. The second waits for the bot row lock, then sees the
# version the first moved: one wins, the other gets RB030 (a lost update would leave version 2 with the second name).
# The fixture bot is enabled (migration 011), so a settings patch is checked against the publish rules; disable it first,
# as this ordering predates that. The fixture's own updates moved settings_version.
UPD_FIX="update public.bot_profiles set enabled = false where id = '$BOT'; update public.bot_profiles set settings_version = 1 where id = '$BOT';"
UPD_O="$AS_OWNER select public.admin_update_settings('$BOT', 1, '{\"display_name\": \"Owner Name\", \"supported_languages\": [\"en\"]}');"
UPD_A="$AS_ADMIN select public.admin_update_settings('$BOT', 1, '{\"display_name\": \"Admin Name\", \"supported_languages\": [\"en\"]}');"
V_UPD="select case
  when (select count(*) from public.public_bot_config where bot_id = '$BOT') <> 1 then 'VIOLATION: no config row was created'
  when (select display_name from public.public_bot_config where bot_id = '$BOT') <> 'Owner Name'
    then 'VIOLATION: the stale writer won: ' || (select display_name from public.public_bot_config where bot_id = '$BOT')
  when (select settings_version from public.bot_profiles where id = '$BOT') <> 2
    then 'VIOLATION: settings_version is ' || (select settings_version from public.bot_profiles where id = '$BOT') || ', expected 2'
  else 'CONSISTENT: one writer won, the stale one was refused' end"

# quota: register limit 1; two registers in parallel. The second waits for the counter row, then is refused
# (RB034), so exactly one document exists and the counter never goes over the limit.
QUOTA1="update public.client_settings set upload_policy = jsonb_set(upload_policy, '{quotas,register}', '{\"limit\": 1, \"window_seconds\": 86400}') where bot_id = '$BOT';"
REG_O="$AS_OWNER select * from public.admin_register_document('$BOT', 'race quota one', 'text/plain', 10, 'excluded');"
REG_A="$AS_ADMIN select * from public.admin_register_document('$BOT', 'race quota two', 'text/plain', 10, 'excluded');"
QKEY="encode(sha256(convert_to('admin_quota:$BOT:register', 'utf8')), 'hex')"
V_QUOTA="select case
  when (select count(*) from public.documents where bot_id = '$BOT' and title like 'race quota %') <> 1
    then 'VIOLATION: ' || (select count(*) from public.documents where bot_id = '$BOT' and title like 'race quota %') || ' documents registered under a limit of 1'
  when (select coalesce(sum(request_count), 0) from public.rate_limit_buckets where key_hash = $QKEY) <> 1
    then 'VIOLATION: counter is ' || (select coalesce(sum(request_count), 0) from public.rate_limit_buckets where key_hash = $QKEY) || ', expected 1'
  else 'CONSISTENT: one register within the limit, the other refused' end"

# retry: a failed version, two admin_retry_version calls. The second waits for the document lock, then sees the
# version uploaded with a live job (RB030): exactly one job.
FAILED_VER="update public.document_versions set status = 'failed', failure_code = 'INDEXING_FAILED' where id = '$VER';"
RETRY_O="$AS_OWNER select * from public.admin_retry_version('$VER');"
RETRY_A="$AS_ADMIN select * from public.admin_retry_version('$VER');"
V_RETRY="select case
  when (select count(*) from public.jobs where dedupe_key = 'index:version:$VER') <> 1
    then 'VIOLATION: ' || (select count(*) from public.jobs where dedupe_key = 'index:version:$VER') || ' jobs for one retried version'
  when (select status from public.document_versions where id = '$VER') <> 'uploaded' then 'VIOLATION: the version is not uploaded'
  else 'CONSISTENT: one job for the retried version' end"

# delete versus complete, both orders. Whoever goes first, the document ends deleted with no live index job:
# complete first (job queued) is cancelled by the delete; delete first makes the complete find nothing (RB037).
DEL_O="$AS_OWNER select public.admin_delete_document('$DOC');"
DEL_A="$AS_ADMIN select public.admin_delete_document('$DOC');"
V_DELCOMP="select case
  when (select deleted_at from public.documents where id = '$DOC') is null then 'VIOLATION: the document is not deleted'
  when exists (select 1 from public.jobs where type = 'index_document' and state in ('queued', 'running') and payload ->> 'document_id' = '$DOC')
    then 'VIOLATION: a live index job remains for the deleted document'
  when (select count(*) from public.jobs where type = 'cleanup' and state = 'queued' and payload ->> 'resource_id' = '$DOC') <> 1
    then 'VIOLATION: expected one queued cleanup job'
  else 'CONSISTENT: deleted, no live index job, one cleanup job' end"

run_order "update in flight, same-version update"  "$ADMIN_FIX $UPD_FIX"    "$UPD_O"      "$UPD_A"    "$V_UPD"   ""    "RB030" yes
run_order "register in flight, second (quota 1)"   "$ADMIN_FIX $QUOTA1"     "$REG_O"      "$REG_A"    "$V_QUOTA" ""    "RB034" yes
run_order "retry in flight, second retry"          "$ADMIN_FIX $FAILED_VER" "$RETRY_O"    "$RETRY_A"  "$V_RETRY" ""    "RB030" yes
run_order "delete in flight, complete"             "$ADMIN_FIX"             "$DEL_O"      "$COMPLETE_A" "$V_DELCOMP" "" "RB037" yes
run_order "complete in flight, delete"             "$ADMIN_FIX"             "$COMPLETE_O" "$DEL_A"    "$V_DELCOMP" ""    ""      yes

# ---- P5 (migration 011): visitor sessions and run state ----
# create_visitor_session: two sessions for one bot. Both read the bot row FOR SHARE, so neither waits; both rows
# exist with distinct ids.
SESS_NEW="select * from public.create_visitor_session('$BOT', 900);"
V_SESS="select case
  when (select count(*) from public.visitor_sessions where bot_id = '$BOT' and id <> '$SESS') <> 2
    then 'VIOLATION: expected 2 new sessions, found ' || (select count(*) from public.visitor_sessions where bot_id = '$BOT' and id <> '$SESS')
  when (select count(distinct id) from public.visitor_sessions where bot_id = '$BOT' and id <> '$SESS') <> 2
    then 'VIOLATION: the two sessions share an id'
  else 'CONSISTENT: two sessions, distinct ids' end"

# begin_request_run against a bot disable. The disable updates bot_profiles.enabled, which conflicts with the
# FOR SHARE lock a start takes on the bot row. Disable first (still open): the start waits, then sees the bot
# disabled (RB039) and no run exists. Start first (still open): the disable waits for the start, which created
# its run before the disable committed; no start can run after the disable.
DISABLE="update public.bot_profiles set enabled = false where id = '$BOT';"
V_DISABLE_FIRST="select case
  when (select enabled from public.bot_profiles where id = '$BOT') then 'VIOLATION: the bot is still enabled'
  when (select count(*) from public.request_runs where bot_id = '$BOT') <> 0
    then 'VIOLATION: ' || (select count(*) from public.request_runs where bot_id = '$BOT') || ' run(s) started after the disable'
  else 'CONSISTENT: disabled, no run started after the disable' end"
V_START_FIRST="select case
  when (select enabled from public.bot_profiles where id = '$BOT') then 'VIOLATION: the bot is still enabled'
  when (select count(*) from public.request_runs where bot_id = '$BOT') <> 1
    then 'VIOLATION: expected the one run that started before the disable, found ' || (select count(*) from public.request_runs where bot_id = '$BOT')
  else 'CONSISTENT: the run started before the disable committed, the bot is disabled' end"

# set_request_run_state: two callers move one live run to the same terminal state. The second waits for the row
# lock, re-reads the run as terminal and returns false: exactly one true. A DO block turns a wrong answer
# into an error the ordering does not expect (XX901 first lost, XX902 second also moved).
SET_FIRST="do \$set\$ begin if not public.set_request_run_state('$BOT', '$RUN', 'succeeded') then raise exception 'first lost' using errcode = 'XX901'; end if; end \$set\$;"
SET_SECOND="do \$set\$ begin if public.set_request_run_state('$BOT', '$RUN', 'succeeded') then raise exception 'second also moved' using errcode = 'XX902'; end if; end \$set\$;"
V_SETSTATE="select case
  when (select state from public.request_runs where id = '$RUN') <> 'succeeded' then 'VIOLATION: run is ' || (select state from public.request_runs where id = '$RUN')
  when (select finished_at from public.request_runs where id = '$RUN') is null then 'VIOLATION: finished_at not set'
  else 'CONSISTENT: run succeeded, one mover' end"

run_order "session create in flight, second create" ""                      "$SESS_NEW"   "$SESS_NEW" "$V_SESS"  ""    ""      fast
run_order "disable in flight, start"               "$CAP1"                  "$DISABLE"    "$BEGIN1"   "$V_DISABLE_FIRST" "" "RB039" yes
run_order "start in flight, disable"               "$CAP1"                  "$BEGIN1"     "$DISABLE"  "$V_START_FIRST" ""  ""      yes
run_order "run state in flight, second move"       "$RUN_ROW"               "$SET_FIRST"  "$SET_SECOND" "$V_SETSTATE" "" ""      yes

# ---- P5-D1: starts against operator edits (lock order in the 011 header: bot, then session/settings, then run) ----
# An operator edits client_settings directly (as the postgres role, not through an admin function). The AFTER UPDATE
# trigger of 008 then updates bot_profiles, so the edit takes the settings lock and then the bot lock, while
# reserve_request_budget takes the bot lock (FOR SHARE) and then the settings lock. Each ordering must end consistent,
# and a start and an edit that do not follow the rule may lose cleanly with a deadlock (40P01) or a lock timeout (55P03); nothing may hang.
OPERATOR="reset role;"
OP_SETTINGS="$OPERATOR update public.client_settings set budget_policy = '{\"daily_cap_usd\": 50}' where bot_id = '$BOT';"
V_OPSET="select case
  when (select budget_policy ->> 'daily_cap_usd' from public.client_settings where bot_id = '$BOT') <> '50'
    then 'VIOLATION: the settings edit was lost'
  when (select count(*) from public.budget_reservations where bot_id = '$BOT' and request_id = '$RUN') > 1
    then 'VIOLATION: more than one reservation for the run'
  when exists (select 1 from public.budget_reservations where bot_id = '$BOT' and request_id = '$RUN' and (state <> 'reserved' or amount <> 1.0))
    then 'VIOLATION: the reservation is not the plain reserved 1.0'
  else 'CONSISTENT: edit applied, ' || (select count(*) from public.budget_reservations where bot_id = '$BOT') || ' reservation(s)' end"
# An operator who does NOT follow the rule: locks the settings row, then touches the bot row. The start holds the bot
# share lock and waits for settings: a true deadlock. One side is rolled back (40P01, found after deadlock_timeout, about 1 s,
# so this ordering is not held to the 1.2 s overlap rule), or the start times out (55P03).
OP_WRONG="$OPERATOR select 1 from public.client_settings where bot_id = '$BOT' for update; select pg_sleep(1.5); update public.bot_profiles set corpus_version = corpus_version + 1 where id = '$BOT';"
V_OPWRONG="select case
  when (select corpus_version from public.bot_profiles where id = '$BOT') = 1
       and (select count(*) from public.budget_reservations where bot_id = '$BOT') = 0
    then 'CONSISTENT: the operator edit won, the start was rolled back'
  when (select corpus_version from public.bot_profiles where id = '$BOT') = 0
       and (select count(*) from public.budget_reservations where bot_id = '$BOT') = 1
    then 'CONSISTENT: the start won, the operator edit was rolled back'
  else 'VIOLATION: corpus_version=' || (select corpus_version from public.bot_profiles where id = '$BOT') || ' reservations=' ||
       (select count(*) from public.budget_reservations where bot_id = '$BOT') end"
OP_RULE="$OPERATOR select 1 from public.bot_profiles where id = '$BOT' for no key update; update public.client_settings set budget_policy = '{\"daily_cap_usd\": 50}' where bot_id = '$BOT';"
# A corpus_version bump (what activate_document_version does last) against begin_request_run. Both need the bot row
# (the start FOR SHARE, the bump FOR NO KEY UPDATE), so they take turns; the bump is never lost and at most one run exists.
BUMP="$OPERATOR update public.bot_profiles set corpus_version = corpus_version + 1 where id = '$BOT';"
V_BUMP="select case
  when (select corpus_version from public.bot_profiles where id = '$BOT') <> 1 then 'VIOLATION: the corpus_version bump was lost'
  when (select count(*) from public.request_runs where visitor_session_id = '$SESS') > 1 then 'VIOLATION: more than one run'
  else 'CONSISTENT: bump applied, ' || (select count(*) from public.request_runs where visitor_session_id = '$SESS') || ' run(s)' end"

run_order "settings edit in flight, reserve"       "$RUN_ROW"               "$OP_SETTINGS" "$RESERVE"  "$V_OPSET" ""    "55P03 40P01" yes
run_order "reserve in flight, settings edit"       "$RUN_ROW"               "$RESERVE"    "$OP_SETTINGS" "$V_OPSET" ""  "55P03 40P01" yes
run_order "settings locked, reserve, bot edit"     "$RUN_ROW"               "$OP_WRONG"   "$RESERVE"  "$V_OPWRONG" "40P01 55P03" "40P01 55P03" no one
# The operator follows the rule: locks the bot row first, then edits settings, in one transaction. The start waits for the
# bot row (its FOR SHARE conflicts with FOR NO KEY UPDATE) and runs after the edit commits: both succeed, no deadlock.
run_order "settings edit by the rule, reserve"      "$RUN_ROW"               "$OP_RULE"    "$RESERVE"  "$V_OPSET" ""    ""            yes
run_order "corpus bump in flight, start"           "$CAP1"                  "$BUMP"       "$BEGIN1"   "$V_BUMP"  ""    "55P03 40P01" yes
run_order "start in flight, corpus bump"           "$CAP1"                  "$BEGIN1"     "$BUMP"     "$V_BUMP"  ""    "55P03 40P01" yes

# ---- P6 (migration 012): the worker's fenced functions ----
# One running index job held by worker w1, its version in 'embedding'. The fence (lock order: document, job,
# version) makes a second worker, or a call after the job was handed back, wait for the first and then fail with
# RB013 (lease not held); the holder's own repeat is an idempotent upsert. The waits stay below lock_timeout (2 s).
IDX_FIX="insert into public.documents (id, bot_id, title, status) values ('$IDXD', '$BOT', 'race', 'indexing');
  insert into public.document_versions (id, document_id, version_number, storage_path, media_type, byte_size, status, embedding_model)
    values ('$IDXV', '$IDXD', 1, '$BOT/$IDXD/$IDXV/original.txt', 'text/plain', 100, 'embedding', 'm');
  insert into public.jobs (id, type, payload, state, attempts, max_attempts, locked_by, locked_until)
    values ('$IDXJ', 'index_document', jsonb_build_object('bot_id', '$BOT', 'document_id', '$IDXD', 'version_id', '$IDXV'), 'running', 1, 3, 'w1', now() + interval '1 hour');"
IDX_EMB="(select jsonb_agg(0.01) from generate_series(1, 1536))"
WRITE_W1="select public.write_document_chunks('$IDXJ', 'w1', '$IDXV', jsonb_build_array(jsonb_build_object('chunk_index', 0, 'content', 'from-w1', 'embedding', $IDX_EMB)));"
WRITE_W1B="select public.write_document_chunks('$IDXJ', 'w1', '$IDXV', jsonb_build_array(jsonb_build_object('chunk_index', 0, 'content', 'from-w1-again', 'embedding', $IDX_EMB)));"
WRITE_W2="select public.write_document_chunks('$IDXJ', 'w2', '$IDXV', jsonb_build_array(jsonb_build_object('chunk_index', 0, 'content', 'from-w2', 'embedding', $IDX_EMB)));"
RETRY_IDX="select public.retry_job_later('$IDXJ', 'w1', 'race_retry', 30);"
HEART_IDX="select public.heartbeat_job('$IDXJ', 'w1', 60);"
V_WRITE_HOLDER="select case
  when (select count(*) from public.document_chunks where document_version_id = '$IDXV') <> 1
    then 'VIOLATION: ' || (select count(*) from public.document_chunks where document_version_id = '$IDXV') || ' chunk rows'
  when (select content from public.document_chunks where document_version_id = '$IDXV') <> 'from-w1' then 'VIOLATION: the chunk is not the lease holder''s'
  else 'CONSISTENT: only the lease holder wrote its chunk' end"
V_WRITE_TWICE="select case
  when (select count(*) from public.document_chunks where document_version_id = '$IDXV') <> 1
    then 'VIOLATION: ' || (select count(*) from public.document_chunks where document_version_id = '$IDXV') || ' chunk rows'
  when (select content from public.document_chunks where document_version_id = '$IDXV') <> 'from-w1-again' then 'VIOLATION: the second write did not follow the first'
  else 'CONSISTENT: one row, the second write replaced the first' end"
V_RETRY_IDX="select case
  when (select state from public.jobs where id = '$IDXJ') <> 'queued' then 'VIOLATION: the job is ' || (select state from public.jobs where id = '$IDXJ')
  when (select locked_by from public.jobs where id = '$IDXJ') is not null or (select locked_until from public.jobs where id = '$IDXJ') is not null
    then 'VIOLATION: the lease was restored after the job was handed back'
  when (select last_error from public.jobs where id = '$IDXJ') <> 'race_retry' then 'VIOLATION: the error code was lost'
  when (select status from public.document_versions where id = '$IDXV') <> 'embedding' then 'VIOLATION: a requeue changed the version'
  else 'CONSISTENT: job queued, lease cleared, version untouched' end"
V_RETRY_NOWRITE="select case
  when (select count(*) from public.document_chunks where document_version_id = '$IDXV') <> 0
    then 'VIOLATION: a chunk was written after the job was handed back'
  when (select state from public.jobs where id = '$IDXJ') <> 'queued' then 'VIOLATION: the job is ' || (select state from public.jobs where id = '$IDXJ')
  else 'CONSISTENT: no chunk after the retry, job queued' end"

run_order "write in flight (w1), write by w2"      "$IDX_FIX"               "$WRITE_W1"   "$WRITE_W2" "$V_WRITE_HOLDER" "" "RB013" yes
run_order "write in flight (w1), write by w1"      "$IDX_FIX"               "$WRITE_W1"   "$WRITE_W1B" "$V_WRITE_TWICE" "" ""     yes
run_order "retry in flight, heartbeat"             "$IDX_FIX"               "$RETRY_IDX"  "$HEART_IDX" "$V_RETRY_IDX" ""   "RB013" yes
run_order "heartbeat in flight, retry"             "$IDX_FIX"               "$HEART_IDX"  "$RETRY_IDX" "$V_RETRY_IDX" ""   ""      yes
run_order "retry in flight, write by the holder"   "$IDX_FIX"               "$RETRY_IDX"  "$WRITE_W1"  "$V_RETRY_NOWRITE" "" "RB013" yes

# ---- P6-D2 (migration 012 changes): the index budget and release_job_lease ----
# reserve_index_budget by the holder (w1) against a second worker (w2) for the same job: the fence makes w2 wait for w1's
# transaction and then fail with RB013, so only the holder reserves. The budget cap is 100 here; one reservation exists.
RESERVE_IDX_W1="select public.reserve_index_budget('$IDXJ', 'w1', '$IDXV', 1.0, 3600);"
RESERVE_IDX_W2="select public.reserve_index_budget('$IDXJ', 'w2', '$IDXV', 1.0, 3600);"
RELEASE_IDX="select public.release_job_lease('$IDXJ', 'w1');"
V_RESERVE_HOLDER="select case
  when (select count(*) from public.budget_reservations where job_id = '$IDXJ') <> 1
    then 'VIOLATION: ' || (select count(*) from public.budget_reservations where job_id = '$IDXJ') || ' reservations for one job'
  when (select state from public.budget_reservations where job_id = '$IDXJ') <> 'reserved' then 'VIOLATION: the reservation is not reserved'
  else 'CONSISTENT: only the lease holder reserved, one reservation' end"
V_RELEASE_RESERVE="select case
  when (select count(*) from public.budget_reservations where job_id = '$IDXJ') <> 0
    then 'VIOLATION: a reservation was made after the lease was released'
  when (select state from public.jobs where id = '$IDXJ') <> 'queued' or (select locked_by from public.jobs where id = '$IDXJ') is not null
    then 'VIOLATION: the job is not queued with the lease cleared'
  when (select attempts from public.jobs where id = '$IDXJ') <> 0 then 'VIOLATION: attempts were not given back'
  else 'CONSISTENT: lease released, nothing reserved, attempt given back' end"

# release_job_lease against claim_jobs. The job is a warm_answer_cache job held by w1 whose lease already ran out (so the
# claim finds it due), 1 attempt used. Release first (still open): claim_jobs skips the locked row (SKIP LOCKED), does not
# wait, and claims nothing; the job ends queued with 0 attempts. Claim first (still open): the stale holder's release waits
# for the row, then finds another worker on the job and returns false; the job stays with w2 at attempt 2.
LEASE_JOB="insert into public.jobs (id, type, payload, state, attempts, max_attempts, available_at, locked_by, locked_until)
  values ('$J1', 'warm_answer_cache', jsonb_build_object('bot_id', '$BOT'::uuid), 'running', 1, 3, now() - interval '1 day', 'w1', now() - interval '1 minute');"
RELEASE_LEASE="select public.release_job_lease('$J1', 'w1');"
CLAIM_LEASE="select * from public.claim_jobs('w2', 1, 60, array['warm_answer_cache']);"
V_RELEASE_FIRST="select case
  when (select state from public.jobs where id = '$J1') <> 'queued' then 'VIOLATION: the job is ' || (select state from public.jobs where id = '$J1')
  when (select locked_by from public.jobs where id = '$J1') is not null or (select locked_until from public.jobs where id = '$J1') is not null
    then 'VIOLATION: the job was claimed or still holds a lease'
  when (select attempts from public.jobs where id = '$J1') <> 0 then 'VIOLATION: attempts are ' || (select attempts from public.jobs where id = '$J1') || ', expected 0'
  else 'CONSISTENT: released, queued, 0 attempts, not claimed' end"
V_CLAIM_FIRST="select case
  when (select state from public.jobs where id = '$J1') <> 'running' or (select locked_by from public.jobs where id = '$J1') <> 'w2'
    then 'VIOLATION: the job is not held by w2 (the stale release took effect)'
  when (select attempts from public.jobs where id = '$J1') <> 2 then 'VIOLATION: attempts are ' || (select attempts from public.jobs where id = '$J1') || ', expected 2'
  else 'CONSISTENT: w2 holds the job at attempt 2, the stale release did nothing' end"

run_order "reserve in flight (w1), reserve by w2"   "$IDX_FIX"               "$RESERVE_IDX_W1" "$RESERVE_IDX_W2" "$V_RESERVE_HOLDER" "" "RB013" yes
run_order "release lease in flight, reserve by w1"  "$IDX_FIX"               "$RELEASE_IDX" "$RESERVE_IDX_W1" "$V_RELEASE_RESERVE" "" "RB013" yes
run_order "release lease in flight, claim"          "$LEASE_JOB"             "$RELEASE_LEASE" "$CLAIM_LEASE" "$V_RELEASE_FIRST" "" ""       fast
run_order "claim in flight, release lease (stale)"  "$LEASE_JOB"             "$CLAIM_LEASE" "$RELEASE_LEASE" "$V_CLAIM_FIRST"  "" ""       yes

# ---- P6-D5: settle_orphaned_index_reservations against settle_index_budget on the same row ----
# The running job IDXJ (holder w1) has an older 'expired' row (ORPH_OLD, an earlier attempt, so an orphan) and its newest
# 'reserved' row (ORPH_NEW). The sweep settles the old row at the job's usage in its window (none here, so 0); the holder
# settles it at 0.7. Exactly one of them wins; the other must not settle it a second time and must not touch the newest row.
# Sweep first (still open): the holder's settle waits for the row, then finds it settled (RB003). Settle first (still
# open): the sweep skips the locked row (SKIP LOCKED), does not wait, and settles nothing (it returns 0).
ORPH_OLD=af800000-0000-4000-8000-000000000001; ORPH_NEW=af800000-0000-4000-8000-000000000002
ORPH_FIX="$IDX_FIX
  insert into public.budget_reservations (id, bot_id, job_id, amount, state, expires_at, created_at) values
    ('$ORPH_OLD', '$BOT', '$IDXJ', 1.0, 'expired', now() - interval '1 hour', now() - interval '2 hours'),
    ('$ORPH_NEW', '$BOT', '$IDXJ', 1.0, 'reserved', now() + interval '1 hour', now() - interval '1 hour');"
SWEEP_ORPH="select public.settle_orphaned_index_reservations(100);"
SETTLE_ORPH="select public.settle_index_budget('$IDXJ', 'w1', '$ORPH_OLD', 0.7);"
V_ORPH_SWEEP="select case
  when (select state from public.budget_reservations where id = '$ORPH_NEW') <> 'reserved' or (select amount from public.budget_reservations where id = '$ORPH_NEW') <> 1.0
    then 'VIOLATION: the newest row of the running job was touched'
  when (select state from public.budget_reservations where id = '$ORPH_OLD') <> 'settled' then 'VIOLATION: the old row is not settled'
  when (select amount from public.budget_reservations where id = '$ORPH_OLD') <> 0 then 'VIOLATION: the old row was settled twice (amount ' || (select amount from public.budget_reservations where id = '$ORPH_OLD') || ')'
  else 'CONSISTENT: the sweep settled the old row at 0, the holder got RB003, the newest row is untouched' end"
V_ORPH_SETTLE="select case
  when (select state from public.budget_reservations where id = '$ORPH_NEW') <> 'reserved' or (select amount from public.budget_reservations where id = '$ORPH_NEW') <> 1.0
    then 'VIOLATION: the newest row of the running job was touched'
  when (select state from public.budget_reservations where id = '$ORPH_OLD') <> 'settled' then 'VIOLATION: the old row is not settled'
  when (select amount from public.budget_reservations where id = '$ORPH_OLD') <> 0.7 then 'VIOLATION: the old row was settled twice (amount ' || (select amount from public.budget_reservations where id = '$ORPH_OLD') || ')'
  else 'CONSISTENT: the holder settled the old row at 0.7, the sweep skipped it, the newest row is untouched' end"
run_order "orphan sweep in flight, holder settle"   "$ORPH_FIX"              "$SWEEP_ORPH"  "$SETTLE_ORPH" "$V_ORPH_SWEEP"  "" "RB003" yes
run_order "holder settle in flight, orphan sweep"   "$ORPH_FIX"              "$SETTLE_ORPH" "$SWEEP_ORPH"  "$V_ORPH_SETTLE" "" ""      fast

echo "race-db: $n orderings, $fail problem(s), $warn warning(s)"
[ "$n" -eq "$EXPECTED" ] || { echo "race-db: expected $EXPECTED orderings, ran $n" >&2; exit 1; }
[ "$fail" -eq 0 ] && [ "$warn" -eq 0 ]
