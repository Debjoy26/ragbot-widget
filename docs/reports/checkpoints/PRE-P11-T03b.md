# T03b checkpoint - local migration and queue API verification

Date: 2026-11-18. State: COMPLETE for local replay and queue/context/fences.
The parent T03 remains open until T03c passes. Next: T03c advisor diagnosis,
service-only grants/actual claim RPC, and full local database gates.

## Exact state

Root D:/Projects1/Text_AI/ragbot-widget; branch p7.5/d4-integration;
HEAD aa6425a plus preserved uncommitted overlay. Node 26.13.1.
Actual LOCAL schema/history: 020. Hosted last verified: 017, unchanged/not queried.
Migrations 018,019,020 are LOCAL ONLY. Helper/census expected20 now matches local.
No commit, push, hosted write, deployment, dependency install or provider call.
Owner monitors five-hour account usage and authorized continuation; stop when
owner says stop/5% or an authoritative reading is <=5%. No agent counter claimed.

## Commands and evidence (main, repository root)

Evidence: docs/evidence/P7.5-D4/T03b/.
- Pinned CLI migration up --help: exit0; confirms local default, remote requires
  explicit --remote. migration-up-help.log.
- Docker psql schema/history before: exit0, schema19/history001-019. schema-before.log.
- node node_modules/supabase/dist/supabase.js migration up --yes: exit0;
  explicitly targeted LOCAL 127.0.0.1:54322, applied only020. migration-up.log.
  CLI stderr progress is wrapped by PowerShell; exit0/target JSON is authoritative.
- Docker psql schema/history after: exit0,20|t and history001-020. schema-after.log.
- Pinned db advisors --help: exit0. db advisors --type all --level warn
  --fail-on warn: EXIT1, DbConnectError/timeout at127.0.0.1:54322. advisors.log.
  This is NOT a clean advisor result. No blind retry performed.
- Network diagnostic: Node TCP connects to54321 and54322; Docker port maps54322;
  in-container psql returned schema20 and35 connections. Diagnostic exit0;
  connectivity-note.md summarizes observations. Root cause still unknown.
- Isolated original fence test: exit1,1FAIL/2filtered (131.71s), undefined job id
  due to dependence on an earlier test. red-isolated-fence.log.
- Fix: eight distinct per-case bot fixtures, cases explicitly enqueue own jobs;
  beforeAll prepares fixtures, afterAll removes only those generated bot/job IDs.
  Original three cases/assertions retained. Added terminal dedupe, derived
  settings version, supersession, expired lease, FAQ/default language cases.
- Targeted formatter + ESLint file --max-warnings0: exit0,format.log/lint.log.
- Isolated fixed fence case: exit0,1PASS/7filtered (49.74s).
  isolated-fence-final.log.
- Combined Vitest integration queue+policy+version files --maxWorkers=1:
  EXIT0,34PASS/3files (60.44s). integration-final.log. Actual schema020 functions
  exercised; SQL-only fixtures are rolled back, API fixtures cleaned in afterAll.

No assertion removed/weakened; no performance bound changed. New T03b tests
have not had another full-root typecheck; last root typecheck passed in T03a.
Full system verification remains open. The final one-line header clarification
states that accounting is not covered by this queue test.

## Review and limitations

Independent read-only correctness review found no isolation blocker. Main
inspected the fix and ran both isolated and combined checks. Report is static/
self-reported. Claims in these API cases are simulated via service-role PATCH;
this proves real SQL ownership/generation/expiry fences, not actual claim_jobs
acquisition. Add actual claim RPC coverage in T03c/T05.

Budget/invocation accounting, cache publication, validated provider config,
payload/runtime contracts and H1 handler integration remain unfinished. No
actual warming/provider call is proved. H1 draft+14UNRUN tests remain ONLY in
C:/Users/DEBJOY/AppData/Local/Temp/ragbot-p75-d4. No copied worker changes here.

## Next exact task

T03c: diagnose local advisor protocol/connection failure before retrying; TCP
acceptance alone does not prove PostgreSQL authentication/SSL works. Do not
assume network root cause or restart Docker without evidence. Then service-only
role/grant negatives, actual claim RPC, clean replay/full pgTAP/lint/advisors.
T03 parent is not accepted until all children pass. No T03b checks/workers remain
running. Preserve all dirty work, stale restore worktree must not overwrite root.
STOP BEFORE P11.
