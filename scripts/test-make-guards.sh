#!/usr/bin/env bash
# Tests for the PROJECT_REF / CONFIRM_REF guards in the Makefile.
# Never reaches the Supabase CLI: it runs the check targets, and remote recipes only with a stubbed CLI.
# Injection payloads try to create a marker file in a temp dir; its existence is a failure.
# Usage (repository root): bash scripts/test-make-guards.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
MARKER="$TMP/marker"

GOOD=abcdefghijklmnopqrst
OTHER=tsrqponmlkjihgfedcba
PASS=0
FAIL=0

ok()  { PASS=$((PASS + 1)); echo "ok   - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL - $1"; }

# mk <args...>: run make from the repo root, quietly. Sets RC and OUT.
mk() {
	OUT="$(cd "$ROOT" && env -u MAKEFLAGS -u MFLAGS -u GNUMAKEFLAGS -u MAKELEVEL make --no-print-directory -f Makefile "$@" 2>&1)"
	RC=$?
}

# mk_env <VAR=value> <args...>: same, with one exported environment variable.
mk_env() {
	local envset="$1"; shift
	OUT="$(cd "$ROOT" && env -u MAKEFLAGS -u MFLAGS -u GNUMAKEFLAGS -u MAKELEVEL "$envset" make --no-print-directory -f Makefile "$@" 2>&1)"
	RC=$?
}

marker_state() { if [ -e "$MARKER" ]; then echo yes; else echo no; fi; }

# check_refused <name>: uses RC, OUT from the last run.
# Non-zero exit, no marker, no accepted-target line.
check_refused() {
	if [ "$RC" -ne 0 ] && [ ! -e "$MARKER" ] && ! grep -qE '^(Target|Confirmed target) project:' <<<"$OUT"; then
		ok "$1"
	else
		bad "$1 (rc=$RC, marker=$(marker_state))"
	fi
}

# expect_refused <name> <args...>
expect_refused() {
	local name="$1"; shift
	rm -f "$MARKER"
	mk "$@"
	check_refused "$name"
}

# expect_refused_env <name> <VAR=value> <args...>
expect_refused_env() {
	local name="$1" envset="$2"; shift 2
	rm -f "$MARKER"
	mk_env "$envset" "$@"
	check_refused "$name"
}

# expect_accepted <name> <expected output line> <args...>
expect_accepted() {
	local name="$1" line="$2"; shift 2
	mk "$@"
	if [ "$RC" -eq 0 ] && grep -qxF "$line" <<<"$OUT"; then
		ok "$name"
	else
		bad "$name (rc=$RC)"
	fi
}

PAYLOADS=(
	'a" ]]; touch '"$MARKER"'; [[ "b'
	"abcdefghijklmnopqrst; touch $MARKER"
	"abcdefghijklmnopqrst\$\$(touch $MARKER)"
	"abcdefghijklmnopqrst\$\$\$\$(touch $MARKER)"
	"abcdefghijklmnopqrst\`touch $MARKER\`"
	"abcdefghijklmnopqrst' ; touch $MARKER ; '"
	"abcdefghijklmnopqrst\" ; touch $MARKER ; \""
	"abcdefghijklmnopqrst && touch $MARKER"
	"abcdefghijklmnopqrst | touch $MARKER"
	'$(touch '"$MARKER"')'
)

# --- injection: PROJECT_REF ---
i=0
for p in "${PAYLOADS[@]}"; do
	i=$((i + 1))
	expect_refused "check-ref injection payload $i refused, no marker" check-ref "PROJECT_REF=$p"
	expect_refused "check-confirm PROJECT_REF injection payload $i refused, no marker" check-confirm "PROJECT_REF=$p" "CONFIRM_REF=$GOOD"
done

# --- injection: CONFIRM_REF ---
i=0
for p in "${PAYLOADS[@]}"; do
	i=$((i + 1))
	expect_refused "check-confirm CONFIRM_REF injection payload $i refused, no marker" check-confirm "PROJECT_REF=$GOOD" "CONFIRM_REF=$p"
done

# --- injection through the environment (a valid-looking value is refused anyway; hostile one must not run) ---
expect_refused_env "exported hostile PROJECT_REF with make -e: refused, no marker" \
	"PROJECT_REF=a\" ]]; touch $MARKER; [[ \"b" -e check-ref

# --- make functions in a value: must be refused before make expands them (R5-2) ---
for f in '$(shell touch '"$MARKER"')' '$(file >'"$MARKER"',x)' '$(eval $(shell touch '"$MARKER"'))' '$(call shell,touch '"$MARKER"')'; do
	expect_refused "check-ref refuses make function: $f" check-ref "PROJECT_REF=$f"
	expect_refused "check-confirm refuses make function in CONFIRM_REF: $f" check-confirm "PROJECT_REF=$GOOD" "CONFIRM_REF=$f"
	expect_refused "help refuses make function: $f" help "PROJECT_REF=$f"
	expect_refused_env "exported make function refused: $f" "PROJECT_REF=$f" check-ref
done

# --- the guards inside the remote recipes, with the CLI stubbed (R5-5) ---
# -i ignores failed prerequisites and makes the exit status 0, so the only proof is whether the stub ran.
STUB='SUPABASE=echo CLI-CALLED'
for t in db-plan db-status db-advisors db-create; do
	mk -i "$t" "$STUB" PROJECT_REF=BAD CONFIRM_REF=BAD
	if grep -q CLI-CALLED <<<"$OUT"; then bad "$t -i with a bad ref reached the CLI"; else ok "$t -i with a bad ref stops before the CLI"; fi
done
mk -i db-create "$STUB" "PROJECT_REF=$GOOD" "CONFIRM_REF=$OTHER"
if grep -q CLI-CALLED <<<"$OUT"; then bad "db-create -i with a mismatched CONFIRM_REF reached the CLI"; else ok "db-create -i with a mismatched CONFIRM_REF stops before the CLI"; fi
mk -i db-create "$STUB" "PROJECT_REF=$GOOD"
if grep -q CLI-CALLED <<<"$OUT"; then bad "db-create -i without CONFIRM_REF reached the CLI"; else ok "db-create -i without CONFIRM_REF stops before the CLI"; fi
mk -i db-plan "$STUB" "PROJECT_REF=$GOOD"
if grep -q CLI-CALLED <<<"$OUT"; then ok "db-plan with a good ref reaches the stub"; else bad "db-plan with a good ref did not reach the stub"; fi
mk -i db-create "$STUB" "PROJECT_REF=$GOOD" "CONFIRM_REF=$GOOD"
if grep -q CLI-CALLED <<<"$OUT"; then ok "db-create with matching refs reaches the stub"; else bad "db-create with matching refs did not reach the stub"; fi

# --- first-admin: the guards run before `node` (C-6) ---
# `node` is replaced by a stub found first on PATH. The stub answers `node -v` with the pinned version
# so check-node passes, and for anything else only prints NODE-CALLED. The real node, the script and
# any Supabase project are never reached; no SUPABASE_* variable is passed on.
STUBDIR="$TMP/stub-bin"
mkdir -p "$STUBDIR"
printf '#!/usr/bin/env bash\nif [ "${1:-}" = "-v" ]; then echo "v%s"; exit 0; fi\necho NODE-CALLED\nexit 0\n' \
	"$(tr -d '[:space:]' <"$ROOT/.nvmrc")" >"$STUBDIR/node"
chmod +x "$STUBDIR/node"
GOODMAIL=owner@client.example.com

# fa <make args...>: run make with the stub node first on PATH. -i makes failed prerequisites non-fatal,
# so a recipe guard has to stop the run by itself. Sets OUT.
fa() {
	OUT="$(cd "$ROOT" && env -u MAKEFLAGS -u MFLAGS -u GNUMAKEFLAGS -u MAKELEVEL -u SUPABASE_URL -u SUPABASE_SECRET_KEY -u EMAIL \
		PATH="$STUBDIR:$PATH" make --no-print-directory -f Makefile "$@" 2>&1)"
}
# fa_env <VAR=value> <make args...>: same, with one exported variable.
fa_env() {
	local envset="$1"; shift
	OUT="$(cd "$ROOT" && env -u MAKEFLAGS -u MFLAGS -u GNUMAKEFLAGS -u MAKELEVEL -u SUPABASE_URL -u SUPABASE_SECRET_KEY -u EMAIL \
		"$envset" PATH="$STUBDIR:$PATH" make --no-print-directory -f Makefile "$@" 2>&1)"
}

# fa_stops <name> <make args...>: with and without -i, node must not be called.
fa_stops() {
	local name="$1"; shift
	rm -f "$MARKER"
	fa first-admin "$@"
	if grep -q NODE-CALLED <<<"$OUT" || [ -e "$MARKER" ]; then bad "first-admin $name reached node"; else ok "first-admin $name stops before node"; fi
	fa -i first-admin "$@"
	if grep -q NODE-CALLED <<<"$OUT" || [ -e "$MARKER" ]; then bad "first-admin -i $name reached node"; else ok "first-admin -i $name stops before node"; fi
}

fa first-admin "PROJECT_REF=$GOOD" "CONFIRM_REF=$GOOD" "EMAIL=$GOODMAIL"
if grep -q NODE-CALLED <<<"$OUT"; then ok "first-admin with valid refs and email reaches the node stub"; else bad "first-admin with valid refs and email did not reach the node stub"; fi

fa_stops "bad ref" PROJECT_REF=BAD CONFIRM_REF=BAD "EMAIL=$GOODMAIL"
fa_stops "uppercase ref" PROJECT_REF=ABCDEFGHIJKLMNOPQRST CONFIRM_REF=ABCDEFGHIJKLMNOPQRST "EMAIL=$GOODMAIL"
fa_stops "missing PROJECT_REF" "CONFIRM_REF=$GOOD" "EMAIL=$GOODMAIL"
fa_stops "mismatched CONFIRM_REF" "PROJECT_REF=$GOOD" "CONFIRM_REF=$OTHER" "EMAIL=$GOODMAIL"
fa_stops "missing CONFIRM_REF" "PROJECT_REF=$GOOD" "EMAIL=$GOODMAIL"
fa_stops "missing EMAIL" "PROJECT_REF=$GOOD" "CONFIRM_REF=$GOOD"
fa_stops "empty EMAIL" "PROJECT_REF=$GOOD" "CONFIRM_REF=$GOOD" "EMAIL="
for bad_mail in 'not-an-email' 'owner@' '@client.example.com' 'owner@client' 'owner @client.example.com' \
	"owner@client.example.com"$'\n' "owner@client.example.com; touch $MARKER" "owner@client.example.com --role admin"; do
	fa_stops "malformed EMAIL [${bad_mail:0:24}]" "PROJECT_REF=$GOOD" "CONFIRM_REF=$GOOD" "EMAIL=$bad_mail"
done
fa_stops 'EMAIL containing $' "PROJECT_REF=$GOOD" "CONFIRM_REF=$GOOD" 'EMAIL=ow$ner@client.example.com'
fa_stops 'EMAIL containing a make function' "PROJECT_REF=$GOOD" "CONFIRM_REF=$GOOD" 'EMAIL=$(shell touch '"$MARKER"')@client.example.com'
rm -f "$MARKER"
fa_env "EMAIL=$GOODMAIL" first-admin "PROJECT_REF=$GOOD" "CONFIRM_REF=$GOOD"
if grep -q NODE-CALLED <<<"$OUT"; then bad "first-admin with an exported EMAIL reached node"; else ok "first-admin with an exported EMAIL stops before node"; fi

# --- origin: exported / make -e ---
expect_refused_env "exported PROJECT_REF refused" "PROJECT_REF=$GOOD" check-ref
expect_refused_env "make -e with exported PROJECT_REF refused" "PROJECT_REF=$GOOD" -e check-ref
expect_refused_env "check-confirm with exported PROJECT_REF refused" "PROJECT_REF=$GOOD" check-confirm "CONFIRM_REF=$GOOD"
expect_refused_env "exported CONFIRM_REF refused" "CONFIRM_REF=$GOOD" check-confirm "PROJECT_REF=$GOOD"
expect_refused_env "make -e with exported CONFIRM_REF refused" "CONFIRM_REF=$GOOD" -e check-confirm "PROJECT_REF=$GOOD"

# --- format ---
expect_refused "check-ref: PROJECT_REF not set refused" check-ref
expect_refused "check-ref: empty PROJECT_REF refused" check-ref "PROJECT_REF="
expect_refused "check-ref: 19 letters refused" check-ref "PROJECT_REF=${GOOD%?}"
expect_refused "check-ref: 21 letters refused" check-ref "PROJECT_REF=${GOOD}u"
expect_refused "check-ref: uppercase refused" check-ref "PROJECT_REF=ABCDEFGHIJKLMNOPQRST"
expect_refused "check-ref: one uppercase letter refused" check-ref "PROJECT_REF=Abcdefghijklmnopqrst"
expect_refused "check-ref: digits refused" check-ref "PROJECT_REF=abcdefghij0123456789"
expect_refused "check-ref: trailing newline refused" check-ref "PROJECT_REF=$GOOD"$'\n'
expect_refused "check-ref: trailing space refused" check-ref "PROJECT_REF=$GOOD "
expect_refused "check-confirm: invalid CONFIRM_REF format refused" check-confirm "PROJECT_REF=$GOOD" "CONFIRM_REF=ABCDEFGHIJKLMNOPQRST"
expect_refused "check-confirm: CONFIRM_REF trailing newline refused" check-confirm "PROJECT_REF=$GOOD" "CONFIRM_REF=$GOOD"$'\n'
expect_refused "check-confirm: invalid PROJECT_REF refused even when CONFIRM_REF equals it" check-confirm "PROJECT_REF=ABCDEFGHIJKLMNOPQRST" "CONFIRM_REF=ABCDEFGHIJKLMNOPQRST"

# --- accepted ---
expect_accepted "check-ref: valid 20-letter ref accepted, prints Target line" "Target project: $GOOD" check-ref "PROJECT_REF=$GOOD"

# --- confirm ---
expect_refused "check-confirm: missing CONFIRM_REF refused" check-confirm "PROJECT_REF=$GOOD"
expect_refused "check-confirm: empty CONFIRM_REF refused" check-confirm "PROJECT_REF=$GOOD" "CONFIRM_REF="
expect_refused "check-confirm: mismatched CONFIRM_REF refused" check-confirm "PROJECT_REF=$GOOD" "CONFIRM_REF=$OTHER"
expect_refused "check-confirm: missing PROJECT_REF refused" check-confirm "CONFIRM_REF=$GOOD"
expect_accepted "check-confirm: matching refs accepted when run alone" "Confirmed target project: $GOOD" check-confirm "PROJECT_REF=$GOOD" "CONFIRM_REF=$GOOD"

# --- structure ---
if grep -qE '\$\((PROJECT_REF|CONFIRM_REF)\)' "$ROOT/Makefile"; then
	bad 'Makefile has no bare $(PROJECT_REF) / $(CONFIRM_REF)'
else
	ok 'Makefile has no bare $(PROJECT_REF) / $(CONFIRM_REF)'
fi
if grep -E -- '--yes|--include-seed' "$ROOT/Makefile" | grep -qvE '^[[:space:]]*#'; then
	bad 'Makefile uses no --yes / --include-seed outside comments'
else
	ok 'Makefile uses no --yes / --include-seed outside comments'
fi

echo ""
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
