#!/usr/bin/env bash
# Secret scan over Git-tracked files (P3-D5 G-19c). Plain bash + git grep, no dependencies.
#
# Usage (repository root):
#   bash scripts/secret-scan.sh                    scan tracked files
#   bash scripts/secret-scan.sh --include-untracked  also scan untracked, non-ignored files (pre-commit use)
#   bash scripts/secret-scan.sh --self-test        prove a planted fake key is caught and a placeholder is not
#
# Exit status: 0 no hit, 1 at least one hit, 2 usage/environment error.
# Output on a hit: "file:line  rule" only. The matched value is never printed.
#
# Rules:
#   supabase-secret-key  sb_secret_ followed by 16+ key characters
#   jwt                  the JWT header prefix followed by 10+ base64url characters
#   google-api-key       the Google API key prefix followed by 35 key characters
#   private-key-block    a PEM private key header
#   generic-assignment   an upper-case *_API_KEY, *_SECRET or *_SECRET_KEY name assigned with "=" a value of 12+ characters
#   service-role-key     any name containing service_role (any case) assigned with = or : a value of 12+ characters
#   named-secret         case-insensitive names ending in secret, password, passwd, token or key, with "=" or ":"
#                        (env, JSON, YAML, code), and a key-like value of 12+ characters (see below)
#   openai-style-key     sk- followed by 20+ key characters
#   postgres-url-password a postgres:// or postgresql:// URL with a password
#
# Allow-list, documented placeholders: empty value, <angle-bracket> placeholders (as in the .env.example
# files), an EXACT $NAME or ${NAME} reference (any other value starting with "$" is a hit), values
# shorter than 12 characters, and the public Supabase local-stack JWT secret default. For Postgres
# URLs: <placeholder>, an exact $NAME / ${NAME} reference, %s, or the password "postgres" on a
# loopback host. Nothing else is allowed. Add a path to the pathspec only with an ADR-level reason.
#
# Fail closed: a line that git grep reports but the parser cannot read is a hit ("unparsed-line"),
# never skipped. Limitation: named-secret is a heuristic (see the comment at the rule); it does not
# prove the absence of secrets.
set -u

# Test fixtures are assembled at run time so this file never contains a complete fake key.
SELF="${BASH_SOURCE[0]}"

if [ "${1:-}" = "--self-test" ]; then
  PASS=0
  FAIL=0
  ok() { PASS=$((PASS + 1)); echo "ok   - $1"; }
  bad() { FAIL=$((FAIL + 1)); echo "FAIL - $1"; }

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  REPO="$TMP/repo"
  mkdir -p "$REPO/api"
  git -C "$REPO" init -q || { echo "secret-scan: git init failed" >&2; exit 2; }

  # scan <args...>: run the scanner against the temp repo. Sets RC and OUT.
  scan() {
    OUT="$(SECRET_SCAN_ROOT="$REPO" bash "$SELF" "$@" 2>&1)"
    RC=$?
  }

  # Clean repo with only documented placeholders and an ordinary line.
  {
    echo 'GEMINI_API_KEY=<gemini-key>'
    echo 'SUPABASE_SECRET_KEY=<server-only-secret-key>'
    echo 'TOKEN_SECRET=${TOKEN_SECRET_FROM_CI}'
    echo 'PORT=8080'
  } >"$REPO/api/.env.example"
  echo 'const x = 1;' >"$REPO/a.ts"
  git -C "$REPO" add -A
  scan
  if [ "$RC" -eq 0 ]; then ok "placeholders only: exit 0"; else bad "placeholders only: expected exit 0, got $RC"; fi

  # One planted fake per rule. Parts are concatenated so no fixture is a literal match here.
  FAKE_BODY="Zq9Xw3Lk7Vn2Rt5Yb8Hc4Jd6"
  plant() { # plant <file> <content> <rule-name>
    local file="$1" content="$2" rule="$3"
    printf '%s\n' "$content" >"$REPO/$file"
    git -C "$REPO" add -A
    scan
    if [ "$RC" -ne 1 ]; then
      bad "$rule: expected exit 1, got $RC"
    elif ! printf '%s' "$OUT" | grep -q "^$file:1  $rule"; then
      bad "$rule: output lacks file:line for $file"
    elif printf '%s' "$OUT" | grep -qF "$FAKE_BODY"; then
      bad "$rule: scanner printed the secret value"
    else
      ok "$rule: planted fake caught, location only"
    fi
    git -C "$REPO" rm -q -f --cached "$file"
    rm -f "$REPO/$file"
  }
  plant fake1.txt "key = sb_secret_${FAKE_BODY}" supabase-secret-key
  plant fake2.txt "token: eyJh""bGci${FAKE_BODY}.${FAKE_BODY}.sig" jwt
  plant fake3.txt "k = AI""za${FAKE_BODY}${FAKE_BODY:0:11}" google-api-key
  plant fake4.txt "-----BEGIN RSA ""PRIVATE KEY-----" private-key-block
  plant fake5.env "STRIPE_API""_KEY=${FAKE_BODY}" generic-assignment
  plant fake6.env "export APP_SECR""ET='${FAKE_BODY}'" generic-assignment

  # New rules (P35-D1). Names are split so this file never contains a complete assignment.
  plant fake7.env "SUPABASE_SERVICE_ROLE""_KEY=${FAKE_BODY}" service-role-key
  plant fake8.json '{"service_role''_key": "'"${FAKE_BODY}"'"}' service-role-key
  plant fake9.json '{"access_tok''en": "'"${FAKE_BODY}"'"}' named-secret
  plant fake10.yml "db_pass""word: ${FAKE_BODY}" named-secret
  plant fake11.yml "client_sec""ret: '${FAKE_BODY}'" named-secret
  plant fake12.ts "const api""Key = '${FAKE_BODY}';" named-secret
  plant fake13.env 'APP_SECR''ET=$(cat x)' generic-assignment
  plant fake14.env 'OTHER_SECR''ET=$x/y' generic-assignment
  plant fake15.txt "sk""-proj-${FAKE_BODY}${FAKE_BODY}" openai-style-key
  plant fake16.txt "DATABASE_URL=postgres""ql://app:${FAKE_BODY}@db.example.com:5432/app" postgres-url-password
  plant fake17.txt "postgres""://app:hunter2@127.0.0.1:5432/app" postgres-url-password
  plant fake18.ts "const u = \`/t?tok""en=${FAKE_BODY}\`;" named-secret
  plant fake19.ts "const STRIPE_API""_KEY = \`${FAKE_BODY}\`;" generic-assignment
  plant fake20.ts "const u = \`/t?tok""en=\${x}${FAKE_BODY}\`;" named-secret

  # Allowed forms stay clean: exact references, placeholders, short values, local-stack default.
  {
    printf '%s\n' 'SUPABASE_SERVICE_ROLE''_KEY=${SERVICE_KEY_FROM_ENV}'
    printf '%s\n' 'client_sec''ret: $CLIENT_SECRET_VAR'
    printf '%s\n' '{"access_tok''en": "<token>"}'
    printf '%s\n' "db_pass""word: changeme"
    printf '%s\n' "const cache""Key = 'doc:chunks:v1';"
    printf '%s\n' "if (token ==""= expectedToken) {}"
    printf '%s\n' 'const u = `/t?tok''en=${tok''en}`;'
    printf '%s\n' 'const m = `x apik''ey=${KEY}`;'
    printf '%s\n' "DATABASE_URL=postgres""ql://postgres:postgres@127.0.0.1:54322/postgres"
    printf '%s\n' "DATABASE_URL=postgres""ql://app:<password>@db.example.com/app"
    printf '%s\n' 'DATABASE_URL=postgres''ql://app:${DB_PASSWORD}@db.example.com/app'
  } >"$REPO/allowed.txt"
  git -C "$REPO" add -A
  scan
  if [ "$RC" -eq 0 ]; then ok "allowed placeholders and references: exit 0"; else bad "allowed forms: expected exit 0, got $RC"; fi
  git -C "$REPO" rm -q -f --cached allowed.txt
  : >"$REPO/allowed.txt"

  # Fail closed: a hit line whose location cannot be parsed counts as a hit, even if it looks harmless.
  printf '%s\n' "API_TOK""EN=<placeholder>" >"$REPO/:odd.env"
  git -C "$REPO" add -A
  scan
  if [ "$RC" -eq 1 ] && printf '%s' "$OUT" | grep -q "^unparsed-line  named-secret" \
    && ! printf '%s' "$OUT" | grep -qF "placeholder"; then
    ok "unparseable hit line counts as a hit, content not printed"
  else
    bad "unparseable hit line: expected exit 1 with unparsed-line (got $RC)"
  fi
  git -C "$REPO" rm -q -f --cached -- './:odd.env'
  printf '' >"$REPO/:odd.env"

  # Same generic rule must also catch a real-looking value inside an .env.example.
  printf '%s\n' "GEMINI_API""_KEY=${FAKE_BODY}" >"$REPO/api/.env.example"
  git -C "$REPO" add -A
  scan
  if [ "$RC" -eq 1 ] && ! printf '%s' "$OUT" | grep -qF "$FAKE_BODY"; then
    ok ".env.example with a real-looking value: caught, location only"
  else
    bad ".env.example with a real-looking value: expected exit 1 without the value (got $RC)"
  fi
  printf 'GEMINI_API_KEY=<gemini-key>\n' >"$REPO/api/.env.example"
  git -C "$REPO" add -A

  # Untracked files are invisible by default and found with --include-untracked.
  printf 'k = sb_secret_%s\n' "$FAKE_BODY" >"$REPO/untracked.txt"
  scan
  if [ "$RC" -eq 0 ]; then ok "untracked file ignored by default"; else bad "untracked file ignored by default (got $RC)"; fi
  scan --include-untracked
  if [ "$RC" -eq 1 ]; then ok "--include-untracked catches untracked file"; else bad "--include-untracked (got $RC)"; fi
  rm -f "$REPO/untracked.txt"

  # Final state is clean again.
  scan
  if [ "$RC" -eq 0 ]; then ok "clean again: exit 0"; else bad "clean again: expected exit 0, got $RC"; fi

  echo "secret-scan self-test: $PASS passed, $FAIL failed"
  [ "$FAIL" -eq 0 ] && exit 0
  exit 1
fi

INCLUDE_UNTRACKED=""
case "${1:-}" in
  "") ;;
  --include-untracked) INCLUDE_UNTRACKED="--untracked" ;;
  *) echo "usage: secret-scan.sh [--include-untracked | --self-test]" >&2; exit 2 ;;
esac

if [ -n "${SECRET_SCAN_ROOT:-}" ]; then
  ROOT="$SECRET_SCAN_ROOT"
else
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
cd "$ROOT" || { echo "secret-scan: cannot enter $ROOT" >&2; exit 2; }
if [ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" != "true" ]; then
  echo "secret-scan: $ROOT is not a Git work tree" >&2
  exit 2
fi

HITS=0

# report <rule> <file:line lines...> on stdin. Prints "file:line  rule" and counts the hits.
report() {
  local rule="$1" loc
  while IFS= read -r loc; do
    [ -n "$loc" ] || continue
    echo "$loc  $rule"
    HITS=$((HITS + 1))
  done
}

# locations: reduce `git grep -n` output (file:line:content) to file:line. Anything that does not
# parse is dropped, never echoed, so a value cannot leak through an odd file name.
locations() {
  sed -n 's/^\([^:][^:]*:[0-9][0-9]*\):.*/\1/p'
}

# fixed_rule <rule> <ERE>: scan all files for one pattern.
fixed_rule() {
  local rule="$1" pattern="$2" raw rc
  # shellcheck disable=SC2086
  raw="$(git grep -nIE $INCLUDE_UNTRACKED -e "$pattern" -- . ':(exclude)package-lock.json' 2>/dev/null)"
  rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "secret-scan: git grep failed for rule $rule" >&2
    HITS=$((HITS + 1))
    return
  fi
  [ "$rc" -eq 0 ] || return 0
  report "$rule" < <(printf '%s\n' "$raw" | locations)
}

fixed_rule supabase-secret-key 'sb_secret_[A-Za-z0-9_-]{16,}'
fixed_rule jwt 'eyJhbGci[A-Za-z0-9_-]{10,}'
fixed_rule google-api-key 'AIza[0-9A-Za-z_-]{35}'
fixed_rule private-key-block '-----BEGIN ([A-Z]+ )*PRIVATE KEY-----'

# Assignments to secret-like names, filtered by the placeholder allow-list. awk sees the value but
# prints only file:line. Fail closed: a line git grep matched that awk cannot parse is a hit
# (printed as "unparsed"), never skipped.
#
# Names: case-insensitive, ending in secret, password, passwd, token or key (so SERVICE_ROLE_KEY,
# GEMINI_API_KEY, apiKey, "access_token", db-password), followed by "=" or ":" in env, JSON
# ("name": "value") or YAML (name: value) form. "==", "=>" and "::" are comparisons or syntax,
# not assignments. Rule labels: service-role-key (name contains service_role), generic-assignment
# (an upper-case *_API_KEY, *_SECRET or *_SECRET_KEY name with "="), named-secret (the rest).
#
# A value ends at the first space, quote, backtick or "#", so an exact reference inside a JS template
# literal (`...token=${token}`) is read as the reference ${token}, not as ${token}`. A value that itself
# starts with a backtick is judged exactly as before (no backtick cut).
#
# Value allow-list: empty; <angle-bracket> placeholder; an exact $NAME or ${NAME} reference;
# anything else beginning with "$" is NOT allowed; values under 12 characters; and the one public,
# documented Supabase local-stack JWT secret default (exact match only).
#
# Strict names (service-role-key and generic-assignment): any value of 12+ characters is a hit.
# Other names (named-secret) are far more common in code (cache keys, SQL "key = ...", object
# keys, type annotations), so there a 12+ character value is a hit only if it is "key-like":
# only letters, digits and + / _ = . ~ -, and at least one digit. Known key formats are caught
# by their own prefix rules above/below regardless of the name. This is a heuristic, not a proof.
# shellcheck disable=SC2086
NAMED_RAW="$(git grep -nIiE $INCLUDE_UNTRACKED -e '(secret|password|passwd|token|key)["'"'"']?[[:space:]]*[=:]' -- . ':(exclude)package-lock.json' 2>/dev/null)"
NAMED_RC=$?
if [ "$NAMED_RC" -gt 1 ]; then
  echo "secret-scan: git grep failed for named secrets" >&2
  HITS=$((HITS + 1))
fi
named_filter() {
  awk -v q="'" '
    function ref_ok(v) { return v ~ /^\$[A-Za-z_][A-Za-z0-9_]*$/ || v ~ /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/ }
    function bad_value(v, strict) {
      if (v == "") return 0                         # empty
      if (v ~ /^</) return 0                        # <placeholder>
      if (v == "super-secret-jwt-token-with-at-least-32-characters-long") return 0  # public Supabase local-stack default
      if (v ~ /^\$/) return !ref_ok(v)              # only an exact reference
      if (length(v) < 12) return 0                  # short values are not keys
      if (strict) return 1
      return v ~ /^[A-Za-z0-9+\/_=.~-]+$/ && v ~ /[0-9]/
    }
    {
      line = $0
      if (line == "") next
      if (!match(line, /^[^:][^:]*:[0-9]+:/)) { print "unparsed"; next }
      loc = substr(line, 1, RLENGTH - 1)
      rest = substr(line, RLENGTH + 1)
      hit = 0
      found = 0
      label = "named-secret"
      while (match(tolower(rest), /[a-z0-9_.-]*(secret|password|passwd|token|key)["'"'"']?[ \t]*[=:]/)) {
        found = 1
        name = substr(rest, RSTART, RLENGTH)
        sep = substr(name, length(name), 1)
        after = substr(rest, RSTART + RLENGTH)
        rest = after
        nxt = substr(after, 1, 1)
        if ((sep == "=" && (nxt == "=" || nxt == ">")) || (sep == ":" && nxt == ":")) continue
        sub(/^[ \t]+/, "", after)
        sub("^[\"" q "]", "", after)                # opening quote
        value = after
        if (substr(value, 1, 1) == "`") sub("[ \t\"" q "#].*$", "", value)   # template-literal value: unchanged
        else sub("[ \t\"" q "`#].*$", "", value)   # first token (drops prose, closing quote or backtick, comment)
        sub(/[,;]+$/, "", value)
        strict = 0
        thisLabel = "named-secret"
        if (tolower(name) ~ /service_role/) { strict = 1; thisLabel = "service-role-key" }
        else if (sep == "=" && name ~ /(_API_KEY|_SECRET|_SECRET_KEY)[ \t]*=$/) { strict = 1; thisLabel = "generic-assignment" }
        if (bad_value(value, strict)) { hit = 1; label = thisLabel }
      }
      if (!found) { print "unparsed"; next }        # git grep matched but awk found no assignment
      if (hit) print loc "\t" label
    }'
}
if [ "$NAMED_RC" -eq 0 ]; then
  while IFS=$'\t' read -r loc label; do
    [ -n "$loc" ] || continue
    if [ "$loc" = "unparsed" ]; then
      echo "unparsed-line  named-secret"
    else
      echo "$loc  $label"
    fi
    HITS=$((HITS + 1))
  done < <(printf '%s\n' "$NAMED_RAW" | named_filter)
fi

fixed_rule openai-style-key 'sk-[A-Za-z0-9_-]{20,}'

# Postgres URLs with a password. Allowed passwords: <placeholder>, an exact $NAME / ${NAME}
# reference, %s, and the documented local-stack default "postgres" on a loopback host.
# shellcheck disable=SC2086
PG_RAW="$(git grep -nIiE $INCLUDE_UNTRACKED -e 'postgres(ql)?://[^[:space:]/@:]*:[^[:space:]/@]+@' -- . ':(exclude)package-lock.json' 2>/dev/null)"
PG_RC=$?
if [ "$PG_RC" -gt 1 ]; then
  echo "secret-scan: git grep failed for postgres-url-password" >&2
  HITS=$((HITS + 1))
fi
if [ "$PG_RC" -eq 0 ]; then
  while IFS= read -r loc; do
    [ -n "$loc" ] || continue
    if [ "$loc" = "unparsed" ]; then echo "unparsed-line  postgres-url-password"; else echo "$loc  postgres-url-password"; fi
    HITS=$((HITS + 1))
  done < <(printf '%s\n' "$PG_RAW" | awk '
    function ref_ok(v) { return v ~ /^\$[A-Za-z_][A-Za-z0-9_]*$/ || v ~ /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/ }
    {
      line = $0
      if (line == "") next
      if (!match(line, /^[^:][^:]*:[0-9]+:/)) { print "unparsed"; next }
      loc = substr(line, 1, RLENGTH - 1)
      rest = substr(line, RLENGTH + 1)
      hit = 0
      found = 0
      while (match(tolower(rest), /postgres(ql)?:\/\/[^ \t\/@:]*:[^ \t\/@]+@[^ \t\/:?"]*/)) {
        found = 1
        url = substr(rest, RSTART, RLENGTH)
        rest = substr(rest, RSTART + RLENGTH)
        sub(/^[^:]*:\/\/[^:]*:/, "", url)         # drop scheme and user
        at = index(url, "@")
        pass = substr(url, 1, at - 1)
        host = substr(url, at + 1)
        if (pass ~ /^</ || ref_ok(pass) || pass == "%s") continue
        if (pass == "postgres" && host ~ /^(127\.0\.0\.1|localhost|\[::1\])$/) continue
        hit = 1
      }
      if (!found) { print "unparsed"; next }
      if (hit) print loc
    }')
fi

if [ "$HITS" -gt 0 ]; then
  echo "secret-scan: $HITS hit(s). Values are not printed; inspect the locations above." >&2
  exit 1
fi
echo "secret-scan: no hits"
exit 0
