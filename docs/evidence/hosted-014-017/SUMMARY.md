# Hosted apply 014–017 — evidence (2026-11-16)

> Owner-approved apply of the four local-only migrations to the hosted dev
> project `rbejeqwxyxtklehuzibv` (Render-adjacent "RagBot" project). No seed.
> Network path: phone hotspot (IPv6) + `SUPABASE_ACCESS_TOKEN` from the user
> environment (never in chat/repo/logs). CLI 3.0.0 pinned; the 3.1.0 notice
> is ignored per the lockfile pin.

## Apply

`supabase db push --remote=rbejeqwxyxtklehuzibv --yes` exit 0. Applied, in order:
014 (`cache_policy` + `retrieval_cache`), 015 (L2 cache RPCs, `schema_version` 15),
016 (`create_data_entry`, `schema_version` 16), 017 (analysis RPCs, `schema_version` 17).

## Verification (Opus runs, this box)

- `migration list --remote`: local == remote 001–017, nothing pending.
- `db advisors --type all --level warn`: 19 WARNs, exactly the documented
  expected set in `database/README.md` (14 admin RPCs + 5 from 003). No new
  finding. Note: the local advisors CLI run reports "No issues found" — it
  does not evaluate rule 0029 locally; the flagged functions were verified
  DEFINER-by-design on the local DB (`admin_get_settings`, `usage_daily_summary`,
  … with `authenticated` EXECUTE and in-function caller checks per ADR 0015/0017).
- Anon REST probes with the publishable key (7/7): `public_bot_config` 200;
  `bot_profiles`, `messages`, `retrieval_cache`, `answer_cache` 401;
  `create_data_entry`, `queue_analysis_job` RPCs 404 (not exposed to anon).
- Not run against hosted (same as all prior post-push checks): pgTAP, race
  suite, API. pgTAP 28 files / 3399 passed on the identical local schema.

## Open

- Owner may now revoke the CLI access token.
- P7/P7.5/P8/P9/P10 acceptance still open; `--live` smoke and proxy-hops
  measurement still need staging/Render.
