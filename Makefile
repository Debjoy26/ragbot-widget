# ragbot_widget: setup and database commands. Run `make help`.
# Remote targets always need an explicit PROJECT_REF and never use the CLI's linked project.
# Migrations live in supabase/migrations (see database/README.md).

.DEFAULT_GOAL := help
SHELL := /bin/bash

# --no-install: use the CLI pinned in package-lock.json, never fetch an unpinned one.
SUPABASE := npx --no-install supabase
NODE_VERSION := $(shell cat .nvmrc)

.PHONY: help check-node check-docker check-cli check-ref install \
	db-start db-stop db-local db-test db-lint \
	db-plan db-create db-status db-advisors

help:
	@echo "Setup"
	@echo "  make install                          Install pinned dependencies (npm ci)"
	@echo ""
	@echo "Local database (Docker)"
	@echo "  make db-start                         Start the local Supabase stack"
	@echo "  make db-local                         Recreate the local DB: migrations + DEV seed (wipes local data)"
	@echo "  make db-test                          Run the pgTAP database tests"
	@echo "  make db-lint                          Lint the local schema"
	@echo "  make db-stop                          Stop the local stack"
	@echo ""
	@echo "Remote database (needs: npx supabase login)"
	@echo "  make db-plan PROJECT_REF=<ref>        Show what would be applied; changes nothing"
	@echo "  make db-create PROJECT_REF=<ref>      Apply all migrations, no seed; asks to confirm"
	@echo "  make db-status PROJECT_REF=<ref>      Compare local and remote migration history"
	@echo "  make db-advisors PROJECT_REF=<ref>    Run security and performance advisors"

check-node:
	@test "$$(node -v 2>/dev/null)" = "v$(NODE_VERSION)" || \
		{ echo "Need Node $(NODE_VERSION), found $$(node -v 2>/dev/null || echo none). Run: nvm use"; exit 1; }

check-docker:
	@docker info >/dev/null 2>&1 || { echo "Docker is not running. Start it and try again."; exit 1; }

check-cli: check-node
	@test -x node_modules/.bin/supabase || { echo "Supabase CLI not installed. Run: make install"; exit 1; }

# Project refs are exactly 20 lowercase letters.
check-ref:
	@[[ "$(PROJECT_REF)" =~ ^[a-z]{20}$$ ]] || \
		{ echo "Set PROJECT_REF to the 20-letter project ref, e.g. make $(firstword $(MAKECMDGOALS)) PROJECT_REF=abcdefghijklmnopqrst"; exit 1; }

install: check-node
	npm ci

db-start: check-cli check-docker
	$(SUPABASE) start

db-stop: check-cli
	$(SUPABASE) stop

db-local: check-cli check-docker
	$(SUPABASE) db reset

db-test: check-cli check-docker
	$(SUPABASE) test db

db-lint: check-cli check-docker
	$(SUPABASE) db lint --local

db-plan: check-cli check-ref
	$(SUPABASE) db push --remote=$(PROJECT_REF) --dry-run

# No --yes, so the CLI asks before applying. No --include-seed: seed.sql is dev-only.
db-create: check-cli check-ref
	$(SUPABASE) db push --remote=$(PROJECT_REF) --dry-run
	$(SUPABASE) db push --remote=$(PROJECT_REF)
	$(SUPABASE) migration list --remote=$(PROJECT_REF)
	@echo ""
	@echo "Schema applied. Next: database/README.md, 'After creating a client database'."

db-status: check-cli check-ref
	$(SUPABASE) migration list --remote=$(PROJECT_REF)

db-advisors: check-cli check-ref
	$(SUPABASE) db advisors --remote=$(PROJECT_REF) --type all
