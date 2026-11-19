# T03c-1 checkpoint - standalone database diagnostics

Date:2026-11-18. Bounded diagnostic task COMPLETE; no project-code fix claimed.
Last prior completed taskT03b; nextT03c-2 (grants and real claim acquisition).
ParentT03 and full phase acceptance remain OPEN. Root p7.5/d4-integration,
HEADaa6425a+preserved dirtyoverlay, Node26.13.1. Actual LOCAL020; hosted-last017.

## Results after owner resumed

All commands by main from repository root, pinned CLI3.0.0, LOCAL target.
- db lint --schema public,storage --level warning --fail-on warning: EXIT1,
  but connected and linted both schemas. No public findings. Managed Storage
  functions list_objects_with_delimiter/search/search_by_timestamp produced
  dynamic-record/static-analysis warnings/errors (lint-comparison.log).
  No runtime Storage defect was established, and no managed function was edited.
- After that process exited, db advisors --type all --level warn --fail-on warn:
  EXIT0, results[], no warning-or-higher findings. advisors-standalone.log.
- Strict public-only db lint --schema public --level warning --fail-on warning:
  EXIT0, results[], no schema errors. public-lint.log.
- Diagnostic probe artifact formatter/ESLint: EXIT0,format.log/lint-artifact.log.
- Prior protocol/authentication diagnostics and original advisor failure remain
  preserved in earlier checkpoint/evidence. Root cause of the original timeout
  is STILL UNPROVEN. Standalone recovery is not a transport-code fix or proof
  that contention caused it. Do not erase failure or repeatedly retry for green.

Evidence directory: docs/evidence/P7.5-D4/T03c-1/.

## Tooling and reliability follow-ups

Observed Makefile db-lint still invokes db lint --local, while pinned CLI3
advertises local-default target and no --local flag. T19 must validate/fix that
compatibility before claiming exact Make gates pass. Direct CLI passes above
are NOT evidence that the Make command works. Do not weaken assertions or
silently suppress managed-Storage findings to make all-schema lint green.
Storage RLS/grant functional gates are separate and still required.

Keep the original intermittent connection timeout with other timing/reliability
observations for T16. Reassess if it recurs during the normal serial database
checks. No complete root-cause resolution or blanket all-green claim is made.

## Next

T03c-2: service-only matrix, real unauthorized invocations and actual claim_jobs
acquisition/reclaim/refund generation tests (current API cases simulate PATCH
claims). T03c-3: clean local replay/full pgTAP/lint/advisors, all serial.
No tests/migrations/advisors currently running. No install/restart/OS setting,
provider call, commit/push or hosted action. Owner monitors five-hour usage;
checkpoint each task and stop on owner signal. STOP BEFORE P11.
