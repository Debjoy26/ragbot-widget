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
if [ "$(docker inspect -f '{{.State.Running}}' "$C" 2>/dev/null)" != "true" ]; then
  echo "race-db: container $C is not running (start the local stack: make db-start)" >&2
  exit 2
fi

HOLD=2.5      # seconds the first transaction stays open
DELAY="${RACE_DELAY:-0.8}"     # seconds before the second connection starts
BLOCKED_MS=1200  # a second statement that waited is at least this slow

TMP="$(mktemp -d)"
BOT=ac100000-0000-4000-8000-000000000001
SESS=ac200000-0000-4000-8000-000000000001
C1=ac300000-0000-4000-8000-000000000001; C2=ac300000-0000-4000-8000-000000000002
U=ac400000-0000-4000-8000-000000000001;  U2=ac400000-0000-4000-8000-000000000002
A=ac500000-0000-4000-8000-000000000001;  A2=ac500000-0000-4000-8000-000000000002
RUN=ac600000-0000-4000-8000-000000000001

pq() { docker exec -i "$C" psql -U postgres -X -q -At -v ON_ERROR_STOP=1 -v VERBOSITY=verbose "$@"; }

cleanup() {
  pq -c "delete from public.bot_profiles where id = '$BOT'" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

fail=0; warn=0; n=0; retrying=0
EXPECTED=14

# Fresh fixture: one bot with settings and a session, two conversations, two questions in C1.
fixture() { # extra setup SQL
  pq -c "delete from public.bot_profiles where id = '$BOT';
    insert into public.bot_profiles (id, slug, identity_prompt, allowed_languages, embedding_model, embedding_dimensions)
      values ('$BOT', 'race-db', 'x', array['en'], 'm', 1536);
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

run_order() { # name, setup SQL, first SQL, second SQL, verdict SQL, first-allowed, second-allowed, expect-block (yes|no)
  local name="$1" setup="$2" first="$3" second="$4" verdict="$5" fa="$6" sa="$7" eb="$8"
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
  local v
  v="$(pq -c "$verdict" 2>"$TMP/v.err")" || { v="VIOLATION: verdict query failed"; bad=1; }
  local note=""
  if [ "$bad" -eq 1 ]; then note=" UNEXPECTED ERROR"; fail=$((fail + 1)); fi
  case "$v" in CONSISTENT*) ;; *) fail=$((fail + 1)) ;; esac
  if [ "$eb" = "yes" ] && [ "$ms" -lt "$BLOCKED_MS" ]; then
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

echo "race-db: $n orderings, $fail problem(s), $warn warning(s)"
[ "$n" -eq "$EXPECTED" ] || { echo "race-db: expected $EXPECTED orderings, ran $n" >&2; exit 1; }
[ "$fail" -eq 0 ] && [ "$warn" -eq 0 ]
