---
type: plan
status: draft
created: 2026-06-28
origin: orch session "Barca Discord Bot — Launch Features Scope and Build" (API-capability check + product decisions, 2026-06-28)
target_repo: andamio-bot
---

# feat: Lesson previews, per-module progress, open-assignment opportunities, and channel-level deny

**Target repo:** andamio-bot · **Stack:** TypeScript, discord.js, better-sqlite3 · **Branch base:** `main` @ the merge of #19

## Summary

Three of the four launch features (`/faq` + the deny-list shipped in #14–#17) build on **course content the API already exposes** — no new API work is required. An API-capability scan of `andamio-api` (gateway) + `andamio-db-api-go` (2026-06-28) confirmed the endpoints exist and are reachable with the credentials the bot already holds. This plan also adds the **channel-level deny** enhancement chosen during scoping.

The unifying insight: **Lesson Previews, Progress, and Opportunities all read the same two data sources** — the course module list and the member's assignment commitments. Build one shared client layer, then three thin command views on top. Course Modules and Assignments are **1:1** (product fact from James), so per-assignment commitment status *is* per-module progress, and a module with no (or a refused) commitment *is* an open opportunity.

The fourth build, `/deny #channel`, extends the shipped role-based deny-list with a channel-addressed form that resolves the channel's gating role(s) automatically.

---

## Problem Frame

**Who:** Barça learners + moderators. PS21 testing starts 2026-07-01; these features are *not* gating that date (testers exercise `/faq` + the deny-list, both already merged). This is the next slice.

**Needs (from the owning task's four features):**
1. **Lesson Previews** — surface lesson/module previews in Discord.
2. **Progress** — "my progress report on course X."
3. **Opportunities** — "are there new opportunities open?"
4. **Channel moderation** — block a member from a *channel* (decided: a channel-addressed form on top of the shipped role deny-list).

**Product decisions locked (James, 2026-06-28):**
- **"Opportunity" = an open course assignment** the member hasn't completed. Project tasks/bounties and commemorative-NFT discovery are **future scope — do not build now.**
- **Progress = per-module**, serviceable today via the 1:1 Module↔Assignment mapping. No per-SLT sub-module % (not available, not needed).
- **Mod UX = add a channel-level block** (`/deny #channel`) alongside the existing `/deny <role>`.

---

## API capability (verified 2026-06-28, confirm shapes live during build)

All paths are under the existing client base `${apiBaseUrl}/api/v2`. Source-mapped from `andamio-api`/`andamio-db-api-go`; **CE must confirm exact response field names against `preprod.api.andamio.io` before relying on them** (the bot's existing integration-test style applies).

**Public (operator `X-API-Key` only — no member Bearer):**
| Endpoint | Returns |
|---|---|
| `GET /course/user/modules/{course_id}` | Array: `title`, `description`, `image_url`, `is_live`, `course_module_code` |
| `GET /course/user/slts/{course_id}/{course_module_code}` | Array: `slt_text`, `slt_index`, `has_lesson` (+ optional nested lesson) |
| `GET /course/user/lesson/{course_id}/{course_module_code}/{slt_index}` | `title`, `description`, `image_url`, `video_url`, `content_json` (Tiptap) |
| `GET /course/user/assignment/{course_id}/{course_module_code}` | `title`, `description`, `image_url`, `video_url`, `content_json` |

**Authenticated (operator `X-API-Key` + member `Authorization: Bearer <JWT>`):**
| Endpoint | Returns |
|---|---|
| `POST /course/student/assignment-commitments/list` | Array of the member's commitments with `status` ∈ {DRAFT, SUBMITTED, APPROVED, REFUSED, …}, keyed by course + module |

**What does NOT exist** (so don't design around it): per-SLT/sub-module completion %, a per-user "opportunities" feed (the member's enrolled courses + the module/commitment join *is* the opportunity surface), bulk multi-lesson fetch.

---

## Requirements

- **R1** — A new `content-client.ts` (sibling to `dashboard-client.ts`) exposes `getCourseModules`, `getLesson`, `getModuleSlts`, `getAssignment` (public calls, `X-API-Key` only) and `getAssignmentCommitments` (member Bearer). Same `ApiError` taxonomy and timeout discipline as `dashboard-client.ts`. Pure mappers (`mapModules`, etc.) are unit-tested off captured fixtures.
- **R2 (Feature 1 — `/preview`)** — A command lists a course's live modules (`is_live` only) and, for a chosen module, renders its lesson/assignment content as an embed (title, description, image/video links). Public data: renders for connected *and* unconnected members. Course set = the server's curated/gated courses (`role-mappings.json` course_ids ∪ `COURSE_DISPLAY_NAMES`), reusing the `course-names` display filter.
- **R3 (Feature 3 — `/progress`)** — For a member's enrolled course (from the existing dashboard read), show every module with the member's commitment status (✅ approved · 📝 submitted · ✍️ draft · ⬜ not started · ❌ refused), derived by joining `getCourseModules` × `getAssignmentCommitments`. Requires a connected member; reuse the `isExpired`/`buildReloginPrompt` reconnect path from `credentials.ts`.
- **R4 (Feature 3 — opportunities)** — "Open opportunities" = modules whose assignment has **no commitment or a refused one** for this member. Surface them in `/progress` (the ⬜/❌ rows are the opportunities) and/or a dedicated `/opportunities` view — same join, filtered. Each row links to the assignment.
- **R5 (Feature 4b — `/deny #channel`)** — A channel option on the deny flow: resolve the channel's gating role(s) = roles with a View-allow permission overwrite on that channel **∩ the managed set** (`loadMappings(...).managedRoleIds`), then write a denial per resolved role (reusing `upsertDenial` + `reevaluateMember`). If the channel maps to zero managed roles, reply that it isn't gated. Multiple gating roles → deny all of them.
- **R6** — All new commands reuse the reflective loader (drop file in `src/commands/`), reply **ephemeral**, and degrade gracefully on `ApiError` (network/HTTP → "try again shortly"; 401 on authed reads → reconnect prompt). No command throws to the user.
- **R7** — Moderator commands keep the `requireModerator` guard. `/deny #channel` is the same authorization surface as `/deny <role>`.
- **R8** — Tests: pure mappers + the module×commitment join + the channel→roles resolver are unit-tested; the existing 268-test suite stays green.

---

## Key Technical Decisions

- **KTD1 — New `content-client.ts`, do not overload `dashboard-client.ts`.** The dashboard client is load-bearing for gating (partial-read safety, the `isDegraded` contract). Content reads are display-only and must never feed role removal. Keep them in a separate module with their own mappers so a content-endpoint contract drift can never destabilize the gate.
- **KTD2 — One join function, three views.** `joinModuleProgress(modules, commitments) → ModuleStatus[]` is the single source for `/progress` (all rows), opportunities (⬜/❌ rows), and any future surface. Pure, unit-tested, no I/O.
- **KTD3 — Public vs authed split mirrors the header pattern.** Public course-content calls send only `X-API-Key`; the commitments call adds `Authorization: Bearer`. Factor a small `andamioGet`/`andamioPost` helper carrying the operator key, timeout, and `ApiError` mapping, so each method is a thin typed wrapper.
- **KTD4 — Channel→role resolution reads Discord, not new config.** The channel's gating roles come from its `permissionOverwrites` ∩ `managedRoleIds` — no new channel-to-role config file. This matches how the role-based deny already maps "channel" to "the role that gates it," just automating the lookup. Document the assumption (a gated channel grants View to its gating role via overwrite) in the command help.
- **KTD5 — Confirm response shapes before mapping.** Field names above are source-mapped, not contract-guaranteed. First build step: capture a real preprod response per endpoint into a fixture, pin the mappers to it, and treat any drift as a fixture update. (Mirrors `dashboard-client`'s defensive mapping.)
- **KTD6 — Curated-course reuse.** `/preview` and `/progress` route course selection through the existing `course-names` display filter (`COURSE_DISPLAY_NAMES` / `SHOW_ALL_COURSES`) so a focused server isn't cluttered — consistent with `/credentials`, `/available`, `/check`.

---

## Build order (independent, shippable as separate PRs)

1. **Shared layer** — `content-client.ts` + mappers + fixtures (R1). Foundation; no user-visible change.
2. **`/preview`** (Feature 1, R2) — lowest risk, public data, renders unconnected. Ship first for a quick launch win.
3. **`/progress` + opportunities** (Feature 3, R3/R4) — the module×commitment join; biggest user value.
4. **`/deny #channel`** (Feature 4b, R5) — moderator enhancement; smallest surface, depends only on existing deny-list + mappings.

Each is its own feature branch + PR, CE-reviewed, suite green. None blocks 2026-07-01.

## Out of scope (future)

- Project tasks/bounties as opportunities (`/v2/project/user/tasks/list` exists but deferred).
- Commemorative-NFT discovery by earned credentials.
- Per-SLT sub-module progress % (no API support).
- Richer FAQ authoring workflow (already deferred in the `/faq` build).

## Provenance

Endpoint inventory + the unblock analysis live in the orch session note "Barca Discord Bot — Launch Features Scope and Build" (Feature scope table + final build order, 2026-06-28). This file is the self-contained build handoff; carry it into a CE run in `andamio-bot`.
