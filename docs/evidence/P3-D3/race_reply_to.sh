#!/usr/bin/env bash
# P3-D3 R3-2: two real connections race on messages.reply_to_message_id. LOCAL stack only.
# Prints the final row state; a reply that points outside its conversation, or at a non-user row, is a violation.
set -u
C=supabase_db_ragbot-widget
q() { docker exec -i "$C" psql -U postgres -q -At -v ON_ERROR_STOP=1 "$@"; }
BOT=00000000-0000-4000-8000-0000000000b1
C1=d0000000-0000-4000-8000-000000000001; C2=d0000000-0000-4000-8000-000000000002
U=d1000000-0000-4000-8000-000000000001; A=d2000000-0000-4000-8000-000000000001

reset() {
  q -c "delete from public.conversations where id in ('$C1','$C2')" >/dev/null
  q -c "insert into public.conversations (id, bot_id) values ('$C1','$BOT'),('$C2','$BOT');
        insert into public.messages (id, conversation_id, role, content) values ('$U','$C1','user','q');" >/dev/null
}
verdict() {
  q -c "select case when a.id is null then 'no reply row'
                    when a.conversation_id = u.conversation_id and u.role = 'user' then 'CONSISTENT'
                    else 'VIOLATION' end
          from (select 1) x
          left join public.messages a on a.id = '$A'
          left join public.messages u on u.id = a.reply_to_message_id"
}
INS="insert into public.messages (id, conversation_id, reply_to_message_id, role, content) values ('$A','$C1','$U','assistant','a');"

run() { # name, first-transaction SQL, second statement
  reset
  ( q -c "begin; $2 select pg_sleep(2); commit;" >/dev/null 2>/tmp/race_a.$$; echo "  first:  exit $?"; ) &
  sleep 0.7
  q -c "$3" >/dev/null 2>/tmp/race_b.$$; echo "  second: exit $? $(grep -m1 -o 'ERROR:.*' /tmp/race_b.$$ | cut -c1-90)"
  wait
  echo "$1 => $(verdict)"
  rm -f /tmp/race_a.$$ /tmp/race_b.$$
}
run "reply in flight, question moved"   "$INS" "update public.messages set conversation_id='$C2' where id='$U';"
run "reply in flight, role changed"     "$INS" "update public.messages set role='assistant' where id='$U';"
run "question move in flight, reply"    "update public.messages set conversation_id='$C2' where id='$U';" "$INS"
q -c "delete from public.conversations where id in ('$C1','$C2')" >/dev/null
