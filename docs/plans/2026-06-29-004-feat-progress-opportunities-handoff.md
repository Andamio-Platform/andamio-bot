---
type: plan
status: draft
created: 2026-06-29
origin: orch session "Barca Discord Bot — Launch Features Scope and Build" (Feature 3, PR 3; builds on #24's confirmed content-client)
target_repo: andamio-bot
---

# feat: `/progress` + opportunities — per-module status and open assignments

**Target repo:** andamio-bot · **Stack:** TypeScript, discord.js · **Branch base:** `main` after #24 merged

## Summary

Feature 3 of the launch set, the biggest user-value slice. For a member's enrolled course, `/progress` shows every module with the member's commitment status; the not-started/refused rows **are** the open "opportunities." Built on the **confirmed** content-client from #24 (`getCourseModules`) joined with the member's assignment commitments (`getAssignmentCommitments`, member Bearer). Course Modules ↔ Assignments are **1:1** (product fact, James), so per-assignment commitment status *is* per-module progress, and a module with no/refused commitment *is* an open opportunity. One pure join, two views.

## ⚠️ Step 0 (do FIRST) — live-confirm the commitments fixture, like #24 did for content

#24 proved the #21 fixtures had **materially drifted** from the live mainnet API (`{data:…}` envelope, nested fields, missing image URLs). The **`commitments.json` fixture is still source-mapped** and equally suspect — do not build the join on it unconfirmed.

1. Get a **member JWT** for a test account enrolled in the server's gated course. **How to capture it:** the bot persists every logged-in member's Bearer token as `user_jwt` in the `links` table at `DB_PATH` (`src/db/links.ts`). So have a test account (or James's own — it holds the Andamio Issuer credential) run `/login` in Discord, then read the token from the bot's SQLite DB:
   ```
   sqlite3 "$DB_PATH" "SELECT alias, user_jwt, jwt_expires_at FROM links WHERE user_jwt IS NOT NULL ORDER BY updated_at DESC LIMIT 5;"
   ```
   Use that `user_jwt` as `Authorization: Bearer <JWT>` **plus** the operator `X-API-Key`. (`jwt_expires_at` is epoch ms — re-`/login` if stale.)
2. Capture a real response from `POST /api/v2/course/student/assignment-commitments/list` against mainnet (`https://api.andamio.io`).
3. Diff against the source-mapped `commitments.json` fixture. **Reconcile shape drift** (expect a `{data:…}` envelope like the content endpoints; confirm the `status` enum values and the course/module keying). Update the fixture + mapper + types as its own commit, mirroring #24's `fix(content)` reconciliation.
4. Only then build `joinModuleProgress` and the command.

If no test member is enrolled in a gated course, surface that as a blocker rather than building against the guess.

## Requirements (Feature 3, from the original content-client handoff R3/R4 + KTD2)

- **R1 — `getAssignmentCommitments` confirmed.** The content-client method (member Bearer) returns the member's commitments with `status` ∈ {DRAFT, SUBMITTED, APPROVED, REFUSED, …}, keyed by course + module, mapped off the **confirmed** fixture (Step 0). Same `ApiError`/timeout discipline as the rest of the client.
- **R2 — `joinModuleProgress(modules, commitments) → ModuleStatus[]` (pure).** The single source of truth for both views. For each module, attach the member's commitment status (or "none"). Pure, total, no I/O, unit-tested off confirmed fixtures. (Original KTD2.)
- **R3 — `/progress` command.** For a member's enrolled course, render every module with status glyphs: ✅ approved · 📝 submitted · ✍️ draft · ⬜ not started · ❌ refused. Requires a connected member — reuse the `isExpired` / `buildReloginPrompt` reconnect path from `credentials.ts`. Course selection via the same curated `loadDisplayFilter` / course-names path #24 extracted (autocomplete the member's enrolled gated courses).
- **R4 — Opportunities.** "Open opportunities" = modules whose assignment has **no commitment or a refused one**. Surface the ⬜/❌ rows as the opportunity set — either highlighted within `/progress` or a dedicated `/opportunities` view off the same join, filtered. Each row links to the assignment where one exists.
- **R5 — Graceful + ephemeral.** All replies ephemeral. `ApiError` → "try again shortly"; 401 on the authed commitments read → the reconnect prompt (not an error). Empty enrolled set → friendly "you're not enrolled in a gated course here yet." No command throws.
- **R6 — Tests.** `joinModuleProgress` (every status branch, none-commitment, refused), the opportunity filter, and the enrolled-course selection, all off confirmed fixtures. Suite stays green; `tsc` + lint + CodeQL clean.
- **R7 — Compound doc → #23.** If this build produces a learnings/compound doc, commit it onto the long-lived `docs/compound-autocomplete-pattern` branch (PR #23, the rolling compound-docs branch) rather than this feature branch — do not open a new docs PR.

## Key Technical Decisions

- **KTD1 — Reuse #24's confirmed content-client + display filter.** `getCourseModules` and `loadDisplayFilter` are live-confirmed and extracted; build on them, don't re-fetch or re-implement. Only the commitments path needs Step-0 confirmation.
- **KTD2 — One join, two views.** `/progress` (all rows) and opportunities (⬜/❌ rows) read the same `ModuleStatus[]`. Don't fork the data path.
- **KTD3 — Member-state read; never feeds gating.** `/progress` is display-only, like `/preview`. It reads commitments but must never influence role add/remove (the gating evaluator stays the sole role authority — the #21 KTD1 separation).
- **KTD4 — Validate against mainnet (`api.andamio.io`), member Bearer + operator key.** Same environment correction as #24's KTD1; the preprod target was the original 401 cause.

## Build order

0. **Live-confirm `commitments.json` (Step 0) + reconcile — its own commit.**
1. **`getAssignmentCommitments` mapper** pinned to the confirmed fixture.
2. **`joinModuleProgress`** pure join + tests.
3. **`/progress` command** + opportunities view + reconnect path.
4. **Tests.**

One PR. Does not block 2026-07-01.

## Out of scope (future)

- `/deny #channel` (PR 4 — the last launch feature; separate handoff).
- Project tasks/bounties as opportunities; commemorative-NFT discovery; per-SLT sub-module %.

## Provenance

orch session "Barca Discord Bot — Launch Features Scope and Build" — original content-client handoff R3/R4/KTD2 (2026-06-28), and the 2026-06-29 #24 finding that source-mapped fixtures drift materially from live (mandating Step 0 here too). Self-contained; carry into a CE run in `andamio-bot`.
