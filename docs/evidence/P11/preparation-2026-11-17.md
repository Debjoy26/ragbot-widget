# P11 preparation and phase-gate evidence review

Review date: 2026-11-17. Basis: existing phase summaries, `status.md`,
`plan.md`, and `TECH_SPECS.md` section 9. This is a documentation review,
not a fresh test run or an independent code/security review. The working
tree is `fix/d2` at `aa6425a` with pre-existing local changes.

## Phase acceptance evidence

| Phase | Evidence reviewed | Outstanding evidence or decision |
| --- | --- | --- |
| P7 | `docs/evidence/P7/SUMMARY.md`, `docs/evidence/P7/post-push.md` | Real-provider wire formats and retrieval quality remain unverified; the evaluation baseline was deferred to P11 by the owner. |
| P7.5 | `docs/evidence/P7.5/SUMMARY.md`, `docs/evidence/P7.5-DEBUG/SUMMARY.md` | Full suite was not rerun on the final P7.5 tree; measured latency improvement remains unproven. C8 warming is not production-wired. Moderation L2 does not independently check the returned model. |
| P8 | `docs/evidence/P8/SUMMARY.md` | Five E2E tests were recorded on Windows; the packet calls for a pinned-toolchain rerun and a healthy full-suite run. |
| P9 | `docs/evidence/P9/SUMMARY.md`, `status.md` | Merged-tree local database evidence is recorded; integration and race coverage have documented Windows limitations. Admin `contracts:sync` is outstanding. |
| P10 | `docs/evidence/P10/SUMMARY.md`, `status.md` | Live smoke and Render proxy-hop measurement remain outstanding; the local full unit and integration runs have documented failures or limitations. |

These records do not establish phase acceptance. Historical summary headers
can describe an earlier branch state; the tracker records the later merges
and hosted application of migrations 014–017.

## P11 work to perform

1. Build evaluation cases for known answers, unanswerable/handoff, multilingual
   and cross-language prompts, and injection attempts. Run against both the
   primary and independent fallback providers; calibrate retrieval thresholds.
   `tests/evaluation/README.md` is currently only a placeholder.
2. Execute and record the security matrix in `TECH_SPECS.md` section 9,
   including forged visitor IDs, cross-session access, injection, XSS, file
   spoofing and budget races.
3. Measure first meaningful event and full-response p95, and test chat-start
   contention and 55P03 under load. Compare results with the plan's targets.
4. Rehearse backup and restore including Storage objects and record results.

Real provider calls require explicit authorization under the repository
instructions. Confirm paid-tier Gemini billing before using client data, and
configure an independent fallback before claiming fallback evaluation.
Do not represent fake-provider results as a real-provider gate.

## Decisions carried forward

- Analysis policy: choose migration 018 or fixed SQL; neither option is
  approved by this review.
- C8: wire activation/settings triggers, question discovery, cache writes and
  budget reservation, or formally defer warming. The existing handler alone
  does not satisfy the planned production behavior.
- Moderation L2: accept the existing model-bound cache key or add a new
  migration and application-side model recheck. Migration 016 is already used
  by P9, so any future schema change needs a new migration number.
