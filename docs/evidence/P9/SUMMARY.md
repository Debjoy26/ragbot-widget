# P9 — Analysis, entries, retention — evidence (`phase/p9`)

> Base `main` @ `8b8da80`. P7 paid-tier eval deferred to P11 per owner 2026-11-14
> (`status.md §3a bt`); P7 gates on fake-provider tests only.
> T1 below is uncommitted except where noted; no hosted change, no push.

## P9-T1 — `POST /v1/entries` + B-10 (W-13)

Contract: strict body (`createEntryRequestSchema`: unknown fields rejected,
`consent` literally `true`) → registry check (unknown key and bad payload
share one `INVALID_REQUEST`, fail closed, empty registry rejects all) →
conversation ownership via `selectOne` on `(id, bot_id, visitor_session_id)`
(404 `INVALID_REQUEST` for foreign/missing, no oracle, same rule as history) →
`create_data_entry` RPC (016, service-role only); RB037 race maps to the same
404. Consent stored as `consent_at` timestamp. Logs carry ids + schema key
only: never payload or consent values. Response validated against new shared
`createEntryResponseSchema` (200, `{entry_id}`).

B-10: `EntrySchemaRegistry.register` takes optional `{labels, piiFields}`;
`describe()` publishes per-form fields/labels/PII with no values. The admin
panel reads it via `contracts:sync` (code, not the database).

Migration `016_p9_entries.sql`: `create_data_entry(uuid,uuid,text,jsonb,timestamptz)`
returns table; 22023 on bad bot/key/non-object payload/missing consent;
RB037 on foreign/unknown conversation or unknown bot (same code, no oracle);
revoke all + grant service-role only; `search_path=''`, `lock_timeout='2s'`,
SECURITY INVOKER; `schema_version` 16. Census updates: 220/250/260 `15→16`.

### Gates (this box, Node 26.13.1, local stack at 016)

- `typecheck`, `lint`, `build`, `format:check` exit 0
- Unit: `entries-route` 8/8, shared registry incl. B-10, `app-wiring`, `server`
  green (96/96 across the 4 files; 47/47 entries+shared after prettier)
- Full `npm test`: 3254/3328; 74 failures are contention flakes (linear-time
  perf tests, timing-sensitive chat/worker suites, PDF child) — every
  suspicious file passes in isolation, `browser-and-enums` passes alone
- pgTAP: 27 files, 3367 passed, incl. new `230_p9_entries` (19 tests)
- `db lint` clean; local advisors no issues
- `race-db`: refused by script guard (npipe, by design) — 016 adds a plain
  SELECT+INSERT RPC with no new lock ordering
- `test:integration`: hung with no output in 10 min (documented Windows
  child-process signal issue) — env-blocked here
- `secret-scan`: red only on the owner-kept demo key
  (`widget/public/index.html:14`, kept per owner 2026-11-14) — not T1

### Open for T1 review

- B-10 shape (`labels` + `piiFields`) is new shared surface; admin panel
  confirms via `contracts:sync` (`status.md §3a bm`).
- No integration coverage for entries on a real DB yet (env-blocked here).
