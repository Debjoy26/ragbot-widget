# T07 - reservation schema and reserve RPC

COMPLETE 2026-11-18. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1, CLI3.0.0. LOCAL only (reset + pgTAP on 127.0.0.1:54322);
no hosted/provider/release action.

Gap: DB 020 versions every warm claim but nothing could reserve budget for one:
no generation/question-bound reservation, no immutable allowance, no atomic cap
path for warming. T07 mirrors the 018 analysis pattern per question.

Changes (migration + tests + spec; no app/worker behavior yet):
- supabase/migrations/021_reserve_warm_budget.sql: budget_reservations gains
  warm_generation (>0) + 64-hex question_hash (paired CHECK) + warm/analysis
  mutual exclusion; 009 one-active-per-job index narrowed to non-warm rows;
  new partial unique key on (job_id, warm_generation, question_hash);
  reserve_warm_budget (service_role only, empty search_path, 2 s lock timeout):
  22023 on bad inputs, RB004 unknown/wrong-type, RB013 unheld lease (fence
  order), RB002 missing policy, null (no spend) on disabled bot / policy off /
  superseded versions, duplicate returns stored id, RB003 accounted, RB001 cap;
  cap sum identical to reserve_request_budget (warm rows count); amounts ceiled
  to 6 dp like analysis. schema_version 20 -> 21.
- supabase/tests/database/320_warm_reservation.test.sql: 30 tests (catalog 9
  incl. narrowed 009 index still matching its 210 assertion, roles 2, invalid 5,
  lease/type 5, no-settings 1, nulls 3, dup/new/settled 4 incl. generic settle
  for the RB003 path, cap 1).
- Census bumps 20 -> 21: 220 (x7 + label), 250, 260, 290,
  tests/integration/helpers/local-stack.ts EXPECTED_SCHEMA_VERSION.
- DATABASE_SCHEMA.md: warm reservation subsection + budget_reservations row.

Verification (main-run, root):
- db reset --yes exit 0 (001-021 + seed). Logs T07/reset.log + full-pgtap.log.
- Full pgTAP: 32 files, 3526 passed, exit 0.
- Two test-first iterations: (1) lease-fixture jobs collided with the 020
  version-dedup index -> fixtures use distinct corpus versions (lease checks run
  before version recheck); (2) wrong-type job hit the generation check first ->
  RPC reordered to RB004 (type) / 22023 (payload) / RB013 (liveness).

True concurrency (two workers reserving at once) is not covered by pgTAP; the
atomicity rests on the settings-row lock + partial unique indexes, and load
contention stays a P11 item like the other reserve paths.

Next T08 per-invocation usage ledger; T03 stays COMPLETE with carried limits.
