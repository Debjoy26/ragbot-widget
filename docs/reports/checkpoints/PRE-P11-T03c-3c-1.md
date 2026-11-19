# T03c-3c-1 - strict public lint

COMPLETE 2026-11-18. Root p7.5/d4-integration@aa6425a plus preserved dirty
overlay, Node26.13.1, CLI3.0.0. LOCAL only; no hosted flag; no source edits.

Main ran from root: node node_modules/supabase/dist/supabase.js db lint
--schema public --level warning --fail-on warning
Log docs/evidence/P7.5-D4/T03c-3/public-lint.log.
Result: "Linting schema: public" / "No schema errors found", exit 0.

Scope note: public-only lint does not satisfy all-schema/Storage acceptance.
Managed Storage findings and exact Make gates remain explicitly unresolved
(T19). Next T03c-3c-2 local advisors (serial).
