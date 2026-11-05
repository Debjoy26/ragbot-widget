# ragbot_widget: setup and database commands. Run `make help`.

# Keep this first. Make expands variables when it exports them or runs $(shell), so a value containing
# $ could run code before any recipe. $(value ...) reads the text without expanding it.
ifneq (,$(findstring $$,$(value PROJECT_REF)$(value CONFIRM_REF)))
$(error PROJECT_REF and CONFIRM_REF must not contain $$)
endif

# Remote targets always need an explicit PROJECT_REF and never use the CLI's linked project.
# Migrations live in supabase/migrations (see database/README.md).

.DEFAULT_GOAL := help
SHELL := /bin/bash

# --no-install: use the CLI pinned in package-lock.json, never fetch an unpinned one.
SUPABASE := npx --no-install supabase
NODE_VERSION := $(shell cat .nvmrc)

# Refs are validated by the shell from its environment ("$$PROJECT_REF"), never from make-expanded
# text, so a hostile value cannot become shell syntax. Make exports command-line variables to
# recipes. The origin test refuses values that came from the environment or from `make -e`.
# Every remote recipe re-runs these tests itself, so nothing depends on check-ref having stopped
# the build (for example `make -i`). $(origin ...) only ever expands to a fixed word.
export PROJECT_REF CONFIRM_REF
# Fixed collation, so [a-z] means the 26 ASCII letters in every locale.
export LC_ALL := C
# Known limit: a valid ref set through MAKEFLAGS in the environment counts as "command line" and make
# cannot tell them apart. It still has to pass the format check, and the Target line shows it.
REF_TEST = [[ "$(origin PROJECT_REF)" == "command line" && "$$PROJECT_REF" =~ ^[a-z]{20}$$ ]]
REF_FAIL = { echo "PROJECT_REF must be given on the make command line (an exported value is refused) and be the 20-letter lowercase project ref, e.g. make db-plan PROJECT_REF=abcdefghijklmnopqrst"; exit 1; }
CONFIRM_TEST = $(REF_TEST) && [[ "$(origin CONFIRM_REF)" == "command line" && "$$CONFIRM_REF" =~ ^[a-z]{20}$$ && "$$CONFIRM_REF" == "$$PROJECT_REF" ]]
CONFIRM_FAIL = { echo "Not confirmed. Type the same ref again on the command line, e.g. make db-create PROJECT_REF=<ref> CONFIRM_REF=<ref> (an exported CONFIRM_REF is refused)"; exit 1; }

.PHONY: help check-node check-docker check-cli check-ref check-confirm install \
	db-start db-stop db-local db-test db-race db-lint test-make \
	db-plan db-create db-status db-advisors

help:
	@echo "Setup"
	@echo "  make install                          Install pinned dependencies (npm ci)"
	@echo ""
	@echo "Local database (Docker)"
	@echo "  make db-start                         Start the local Supabase stack"
	@echo "  make db-local                         Recreate the local DB: migrations + DEV seed (wipes local data)"
	@echo "  make db-test                          Run the pgTAP database tests"
	@echo "  make db-race                          Run the two-connection race checks (local only)"
	@echo "  make db-lint                          Lint the local schema"
	@echo "  make test-make                        Test the PROJECT_REF and CONFIRM_REF guards"
	@echo "  make db-stop                          Stop the local stack"
	@echo ""
	@echo "Remote database (needs: npx supabase login)"
	@echo "  PROJECT_REF must be on the command line; an exported value is refused."
	@echo "  make db-plan PROJECT_REF=<ref>        Show what would be applied; changes nothing"
	@echo "  make db-create PROJECT_REF=<ref> CONFIRM_REF=<ref>"
	@echo "                                        Apply all migrations, no seed. Type the ref twice;"
	@echo "                                        the CLI then asks again"
	@echo "  make db-status PROJECT_REF=<ref>      Compare local and remote migration history"
	@echo "  make db-advisors PROJECT_REF=<ref>    Run security and performance advisors"

check-node:
	@test "$$(node -v 2>/dev/null)" = "v$(NODE_VERSION)" || \
		{ echo "Need Node $(NODE_VERSION), found $$(node -v 2>/dev/null || echo none). Run: nvm use"; exit 1; }

check-docker:
	@docker info >/dev/null 2>&1 || { echo "Docker is not running. Start it and try again."; exit 1; }

check-cli: check-node
	@test -x node_modules/.bin/supabase || { echo "Supabase CLI not installed. Run: make install"; exit 1; }

# Project refs are exactly 20 lowercase letters, given on the command line.
check-ref:
	@$(REF_TEST) || $(REF_FAIL); \
	printf 'Target project: %s\n' "$$PROJECT_REF"

# db-create only. Runnable alone: it checks PROJECT_REF itself.
check-confirm:
	@$(CONFIRM_TEST) || $(CONFIRM_FAIL); \
	printf 'Confirmed target project: %s\n' "$$CONFIRM_REF"

install: check-node
	npm ci

db-start: check-cli check-docker
	$(SUPABASE) start

db-stop: check-cli
	$(SUPABASE) stop

# `db reset` and `test db` default to the local stack (the CLI has no --local flag for them).
db-local: check-cli check-docker
	$(SUPABASE) db reset

db-test: check-cli check-docker
	$(SUPABASE) test db

db-race: check-docker
	bash scripts/race-db.sh

test-make:
	bash scripts/test-make-guards.sh

db-lint: check-cli check-docker
	$(SUPABASE) db lint --local

db-plan: check-cli check-ref
	@$(REF_TEST) || $(REF_FAIL); \
	$(SUPABASE) db push --remote="$$PROJECT_REF" --dry-run

# No --yes, so the CLI asks before applying. No --include-seed: seed.sql is dev-only.
# One shell command: the guard runs first and nothing after it runs if it fails.
db-create: check-cli check-ref check-confirm
	@$(CONFIRM_TEST) || $(CONFIRM_FAIL); \
	$(SUPABASE) db push --remote="$$PROJECT_REF" --dry-run && \
	$(SUPABASE) db push --remote="$$PROJECT_REF" && \
	$(SUPABASE) migration list --remote="$$PROJECT_REF" && \
	echo "" && \
	echo "Schema applied. Next: database/README.md, 'After creating a client database'."

db-status: check-cli check-ref
	@$(REF_TEST) || $(REF_FAIL); \
	$(SUPABASE) migration list --remote="$$PROJECT_REF"

db-advisors: check-cli check-ref
	@$(REF_TEST) || $(REF_FAIL); \
	$(SUPABASE) db advisors --remote="$$PROJECT_REF" --type all
