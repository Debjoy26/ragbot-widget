#!/usr/bin/env bash
# The system test suite from rules.md section 3, run from the repository root on the current tree.
# Stops at the first failing command. Each command's output goes to <evidence dir>/<name>.txt and
# its exit code to <evidence dir>/suite-exit.txt.
# Usage: bash scripts/system-suite.sh docs/evidence/<phase>/<run>
set -u
cd "$(dirname "$0")/.."
E=${1:?usage: system-suite.sh <evidence dir>}
mkdir -p "$E"
SUM=$E/suite-exit.txt
: >"$SUM"
echo "rev $(git rev-parse --short HEAD) + working tree; node $(node -v); $(date -Is)" >>"$SUM"
run() {
  local name=$1
  shift
  "$@" >"$E/$name.txt" 2>&1
  local rc=$?
  echo "$name exit=$rc" | tee -a "$SUM"
  [ "$rc" -eq 0 ] || exit "$rc"
}
run npm_build npm run build
run npm_lint npm run lint
run npm_format_check npm run format:check
run npm_typecheck npm run typecheck
run db-local make db-local
run db-test make db-test
run db-lint make db-lint
run db-race make db-race
run npm_test npm test
run integration npm run test:integration
run api-smoke node scripts/api-smoke.mjs
run worker-dist-check node scripts/worker-dist-check.mjs
run test-make make test-make
run secret-self npm run secret-scan:self-test
run secret-scan bash scripts/secret-scan.sh --include-untracked
run advisors-local npx --no-install supabase db advisors --type all --level warn
echo "ALL PASSED" | tee -a "$SUM"
