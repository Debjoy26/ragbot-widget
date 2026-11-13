# P8 — Widget — evidence (in progress, `phase/p8`)

> Base `af3c1c3` (`main` after P7.5). Branch `phase/p8`, uncommitted. Updated 2026-11-13.
> Docs resync from the P7.5 pushed-state update (`status.md`, `handover.md`,
> `docs/evidence/P7.5/SUMMARY.md`) travels in this branch: it could not be
> committed to `main` first because the fast gates are red on this machine for
> pre-existing/environmental reasons (§Gates).

## Scope (plan.md P8)

- `widget/src/widget.ts` — entry: `data-*` attrs from `document.currentScript`, singleton guard (`window.__ragbotWidget` / `customElements.get`), boot sequence (config → session → history restore → UI).
- `widget/src/public-config.ts` — embed-option parsing, server-config validation mirroring `publicBotConfigSchema`, Supabase REST fetch with publishable key, stale-while-revalidate edge cache (ETag + `localStorage`), raw-row caching with revalidation on every read.
- `widget/src/session.ts` — `POST /v1/sessions`, token in tab-scoped `sessionStorage` (ADR 0009), expiry fail-closed, reset.
- `widget/src/api.ts` — SSE frame parser (`event: <name>\ndata: <json>`, order meta/delta*/sources/(handoff)/done per `api/src/lib/sse.ts`), canonical v4 idempotency keys, idempotent `streamChat` (409/400 reconcile, never auto-resends after partial output), same-session history fetch that drops `system` rows even if sent.
- `widget/src/render.ts` — plain text via `textContent` (Markdown off, ADR 0008); `https:`-only URLs, `javascript:`/`data:` rejected; source refs validated (invented IDs/URLs dropped); model-text links stay plain text (W-16).
- `widget/src/contact-card.ts` — card from config + `handoff` only; `mailto:`/`tel:`/`https:` links; business-hours open-now hint; prominent pinning.
- `widget/src/ui.ts` — Shadow-DOM tree, state machine with checked transitions, Escape/focus-restore, batched live-region announcements, `prefers-reduced-motion`, mobile `100dvh` panel.
- `widget/scripts/build.mjs` — P8-D1: `fileURLToPath` instead of `URL.pathname` (Windows `/D:/...` broke esbuild).
- `widget/vercel.json` — JS content type + `max-age=31536000, immutable` for `/:version/widget.js`.
- `widget/public/index.html` — demo page documents the final embed snippet.
- `tests/e2e/widget.spec.ts` — 5 offline specs (boot, hostile CSS, XSS-as-text, handoff card, multi-delta ready). 5 passed here.

## Tests (new, unit)

- `tests/unit/widget/public-config.test.ts` (10), `session.test.ts` (7), `api.test.ts` (9), `contact-render.test.ts` (10), `widget-entry.test.ts` (2), `transitions.test.ts` (4), plus existing `scaffold.test.ts` (3): **45 passed** (`npx vitest run --project unit tests/unit/widget tests/unit/scaffold.test.ts`).
- Bugs the tests caught before commit (all fixed, all green now):
  - P8-D1 build script Windows path bug (build exit 1 → 0).
  - `newIdempotencyKey` TS `as`-precedence trap: `x as number & 0x0f` parses the mask as an intersection *type*, emitting non-4 version nibbles ~25% of the time.
  - SWR cache stored the validated (camelCase) config but revalidated it as a raw (snake_case) row → every 304 fell through to a throw. Now stores the raw row and revalidates on each read.
  - `WidgetHandoff.contact` typed as camelCase while the wire is snake_case → added `WireHandoffContact` + `mergeContact` mapping; unknown handoff reasons now dropped.
  - History fetch kept `system` rows client-side → now filtered to user/assistant.
  - Root `tsc -p tests` failed on the DOM entry: added type-level-only `DOM` lib to `tests/tsconfig.json` (runtime DOM stays out of unit tests; E2E covers boot).

## Gates (this machine: Windows, Node v23.0.0, required is 24.22.2)

- `npm run typecheck` exit 0. `npm run lint` exit 0 (`--max-warnings 0`).
- `npm run build -w widget` exit 0 → `widget/dist/v1.0.0/widget.js` (25,152 bytes, gitignored).
- `npm run format:check` FAILS: 180 files with CRLF warnings (known Windows issue, same as P7/P7.5 evidence).
- Root `npm run build` FAILS for the pre-existing widget path bug only on unpatched trees; fixed here (P8-D1).
- Full `npm test`: unrelated suites fail on this box (e.g. `worker/index-document` child-process `EXIT_9`/`EPERM`, plus fork-pool `kill EPERM` flakes). The same files pass in isolation (`chat-citations` 157/157, `chat-citations-d2` green with scaffold+widget 79/79). No `api/`/`worker/`/`shared/` file was touched by P8, so these are environmental, not regressions. Full suite on Node 24.22.2 Linux is still required before any gate.

## OS-independence (no OS-specific code paths)

- `.gitattributes` (`* text=auto eol=lf`, new): checkouts are LF on every OS, so `format:check` no longer depends on the platform or `core.autocrlf`.
- `.prettierrc.json`: explicit `"endOfLine": "lf"` (was the default; now documented).
- `widget/scripts/build.mjs` (P8-D1): `fileURLToPath` instead of `URL.pathname` — the `/D:/...` failure was Windows-only.
- Root `clean` script: `rm -rf` (Unix-only) replaced with `node -e ... rmSync(...)` — verified with `npm run clean` (exit 0) + rebuild on Windows, no new dependency.
- All P8-owned files normalized to LF and `prettier --check` green on them; `typecheck`, `lint`, 39 unit tests, widget build re-verified after.
- Full-repo `format:check` is still red on untouched files in *this* working tree (old CRLF checkouts); any fresh checkout after `.gitattributes` is LF and green, including CI (`ubuntu-24.04`).
- Deliberately NOT touched: `tests/unit/worker/extract-confinement.test.ts` (same `.pathname` line exists there, but the test asserts Node `--permission`-model behaviour, which is platform-shaped; reworking its security assertions belongs to a P6 debug cycle with security re-review, not P8).

## Review P8-D2 (read-only, Opus; 2026-11-13)

Confirmed defects (all fixed on `phase/p8`, tests added where node-runnable):

- **R1 (High) state-machine gaps → stuck widget + crash** (`ui.ts`, `widget.ts:200`): terminal states could not retry (`limited/blocked/unavailable → connecting` threw unhandled, wedging the widget after any rate limit); `ready` could not accept late `limited/blocked/unavailable` (hostile-path error event threw); the catch-all re-set the *current* state, which throws for every state except closed/ready (crashed mid-stream network failures). Fix: extended `TRANSITIONS`, exported pure `isTransitionAllowed` (+4 matrix tests), catch only recovers from `connecting`.
- **R2 (Medium) abort misreported as outage** (`widget.ts`): user Stop rejects the fetch, so the post-stream `aborted` check was dead code — every stop showed "service unavailable"/failed. Fix: abort is handled first in `catch` (partial + "Stopped", back to `ready`).
- **R3 (Medium) double boot** (`widget.ts`): `boot()` suspends on the config fetch, then `appendChild` re-enters `connectedCallback` → second `boot()` (double config fetch + doomed second `attachShadow`, silently caught) and a possible unhandled rejection. Also, an author-placed `<ragbot-widget>` plus the script tag booted twice. Fix: per-host boot mark, author-host adoption, rejection catch, global cleared on failure so a later tag can retry.
- **R4 (Low-Medium) history restore dropped assistant turns** (`widget.ts`): UI_SCHEMA §7 restores the transcript; only user messages rendered. Fix: assistant turns render as plain text (no sources available from the history endpoint).
- **R5 (Low) whitespace handoff message** (`contact-card.ts`): blank card line. Fix: trim + fall back to the escalation message (+test).
- **R6 (Low) error event never finished the node** (`widget.ts`): no terminal screen-reader announcement. Fix: `assistant.finish('failed')` on `error` (+1 unknown-reason handoff test in `api.test.ts`).

Gates after P8-D2: 44 unit tests pass (36→44); `typecheck`, `lint`, widget build green; `prettier --check` green on owned files.

## P8-D3: E2E run + storage hardening (2026-11-13)

- `npx playwright install chromium --only-shell` on this box, then `npx playwright test tests/e2e/widget.spec.ts`: first run 2 passed / 2 failed; both failures were real finds, not flakes:
  1. Spec race (mine): assertions ran before async boot/stream finished. Fix: `waitForUi`/`openPanel`/`sendMessage` helpers polling the shadow tree, no sleeps.
  2. Widget bug (R7): on opaque origins (`about:blank` embeds, sandboxed iframes) and with blocked cookies, merely *touching* `window.localStorage`/`sessionStorage` throws — the transcript fell back to bundled branding and sessions died. Fix: `safeWindowStorage` probe with `undefined`/in-memory fallback; storage reads in `loadPublicConfig` hardened; `readSession` already failed closed. New regression test: throwing storage behaves as a cold cache.
- After fixes: **E2E 5 passed** (4 + multi-delta), unit 45 passed, `typecheck`/`lint`/widget build/`prettier --check` (owned files) green.
- Byte-level check proved the tree is clean UTF-8 throughout (an earlier encoding scare was console rendering, not file damage).

## P8-D4: final review follow-ups (2026-11-13)

- **R8 (High, found in final pass) state transition crashed every multi-delta turn**: `delta`/`meta` handlers called `setState` unconditionally, but `streaming → streaming` is invalid — the E2E suite passed only because it sent single-delta streams. Fix: transition only on actual change. New E2E test (two deltas → accumulated text + Send visible again) fails without the fix by construction.
- **Conversation id was never persisted**: restore read `ragbot.conversation.<slug>` but nothing wrote it, and reset did not clear it. Fix: write on `meta` (best-effort), remove on reset.
- After P8-D4: unit 45 passed, **E2E 5 passed**, `typecheck`/`lint`/widget build/`prettier --check` green.

## Owner-gate packet (STOP — needs owner decisions)

No code, test, hosted, merge, push, install, or real-provider action was taken beyond this branch. To move forward the owner decides, in order:

1. **P7 evaluation baseline** (`status.md §3a bt, n`): approve real provider calls + confirm paid-tier Gemini billing. No client data through free-tier Gemini. Blocks the P11 eval gate and threshold calibration.
2. **Hosted migrations 014–015**: approve `make db-plan` preview then apply to `rbejeqwxyxtklehuzibv` (hosted still at 013). Run advisors after.
3. **Accept or send back P7** (migration 013, `41997a9`) **and P7.5** (`af3c1c3`, 014–015): full suite was not re-run on either final tree on the pinned toolchain.
4. **Accept or send back P8** (`phase/p8`, base `af3c1c3`, uncommitted): 45 unit + 5 E2E green here (Windows/Node23/Chromium shell); `typecheck`/`lint`/widget build/`prettier` green; full-repo `format:check` + full suite still require the pinned Linux toolchain. Then approve merge of `phase/p8` to `main` + push.
5. **Start P9** (analysis, entries, retention) — new phase, needs explicit go-ahead.
6. Standing items (unchanged): public signup off + TOTP check (O-3/O-4), admin `contracts:sync` (bm), ADR 0016 confirmation (ag), production daily cap (a), jurisdiction/DPAs (b), second provider key (o), retrieval check (c).

Evidence links: `docs/evidence/P7/SUMMARY.md`, `docs/evidence/P7/post-push.md`, `docs/evidence/P7.5/SUMMARY.md`, this file, `status.md §2/§7/§8`, `handover.md §2/§10`.

## P8-D5: second pass closeout (2026-11-13)

- `session.ts` re-read clean: fail-closed expiry/parse, opaque challenge token, 401/403 → clear + "session expired" (revocation stays server-side, correct).
- `dir="auto"` was missing on the static greeting + suggested-question buttons (only dynamic bubbles had it) — caught by a new E2E assertion, fixed.
- Conversation-id persistence was write-never/read-only: `meta` now persists it (best-effort) and reset clears it.
- Gates: unit 45 passed, E2E 5/5, `typecheck`/`lint`/widget build/`prettier` green on owned files.

## P8-D6: secret-scan fixtures (2026-11-13)

- `bash scripts/secret-scan.sh` (exit 1, 11 hits, all `named-secret` in P8 test fixtures): the realistic-looking `sb_publishable_0123456789abcdef` literal and a UUID idempotency-key literal next to key-ish names.
- Fix: obviously-fake values that still exercise the length checks (`sb_publishable_TEST_KEY_FOR_TESTS`, `test-idempotency-key`) + the missed assertion updated. No test weakened (same validation paths, same assertions).
- After: `secret-scan` exit 0, `--include-untracked` exit 0 (Git Bash; the Windows `bash.exe` WSL stub cannot run the script on this box), unit 45 + E2E 5 still green.

## Not done / open

- E2E 5 passed on this box (Chromium headless-shell, Windows); rerun on the pinned toolchain before gate.
- Full-repo `format:check` in this working tree (old CRLF checkouts of untouched files); full suite on the pinned toolchain; `make db-*` untouched (no migration in P8 so far).
- No hosted change, no merge, no push, no dependency install, no real provider call.
- Real Turnstile verification stays a P12 step (fake challenge path only); Markdown stays off; feedback stays deferred.
