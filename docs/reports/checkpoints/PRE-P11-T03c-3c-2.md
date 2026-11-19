# T03c-3c-2 - local advisors

COMPLETE 2026-11-18. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1, CLI3.0.0. LOCAL only; no hosted flag; no source edits.

Main ran from root: node node_modules/supabase/dist/supabase.js db advisors
--type all --level warn --fail-on warn
Log docs/evidence/P7.5-D4/T03c-3/advisors.log.
Result: "No issues found", exit 0.

Note: PowerShell wraps the CLI's stderr "Target: local stack" line as a
NativeCommandError in the log; the preserved LASTEXITCODE was 0 and the
CLI result is PASS. Same applied to T03c-3c-1.
Next T03c-3c-3 unresolved-gate accounting + continuity updates.
