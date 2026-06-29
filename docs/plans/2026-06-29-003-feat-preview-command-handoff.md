---
type: plan
status: draft
created: 2026-06-29
origin: orch session "Barca Discord Bot — Launch Features Scope and Build" (Feature 1, PR 2; supersedes the preprod validation target in the #21 content-client handoff)
target_repo: andamio-bot
---

# feat: `/preview` — lesson/module previews in Discord

**Target repo:** andamio-bot · **Stack:** TypeScript, discord.js · **Branch base:** `main` after `/faq` Q&A merges (else `main` @ #21 `6d87310`)

## Summary

Feature 1 of the launch set. `/preview` surfaces a course's **live modules** and renders a chosen module's lesson/assignment content as an embed. It is built entirely on the shared `content-client.ts` layer shipped in #21 (`getCourseModules`, `getModuleSlts`, `getLesson`, `getAssignment`) — **public, `X-API-Key`-only** reads, so it renders for connected *and* unconnected members. No new API, no new auth.

## ⚠️ Step 0 (do FIRST) — confirm fixtures against the bot's live environment

The #21 content-client fixtures are **source-mapped, not live-confirmed**: that build 401'd because its handoff said validate against `preprod.api.andamio.io`, but the bot's operator key is **mainnet** (`ant_mn_…`) against **`https://api.andamio.io`**. That mainnet key is known-good (the live bot's `/check` succeeds with it).

**Before building the command:**
1. Using the bot's existing `ANDAMIO_API_KEY` + `ANDAMIO_API_BASE_URL` (`https://api.andamio.io`), capture a **real response** for each content endpoint against a known course (the server's gated course id from `role-mappings.json`):
   - `GET /api/v2/course/user/modules/{course_id}`
   - `GET /api/v2/course/user/slts/{course_id}/{course_module_code}`
   - `GET /api/v2/course/user/lesson/{course_id}/{course_module_code}/{slt_index}`
   - `GET /api/v2/course/user/assignment/{course_id}/{course_module_code}`
2. Diff each against the #21 fixture. **Reconcile any field-name/shape drift** — update the fixture + mapper to the live shape (the mappers were written total/envelope-agnostic precisely to absorb this).
3. Only then build the command on the confirmed shapes. Treat the captured responses as the new pinned fixtures.

If an endpoint shape differs materially from the #21 assumption, that's a fixture/mapper PR in its own right — surface it, don't paper over it.

## Requirements (Feature 1, from the original content-client handoff R2)

- **R1 — `/preview` command.** Lists a course's **live** modules (`is_live` only) and, for a chosen module, renders its lesson/assignment content as an embed: title, description, image/video links. Public data → renders for connected *and* unconnected members.
- **R2 — Course selection reuses the curated filter.** The selectable course set = the server's curated/gated courses (`role-mappings.json` course_ids ∪ `COURSE_DISPLAY_NAMES`), routed through the existing `course-names` display filter (`COURSE_DISPLAY_NAMES` / `SHOW_ALL_COURSES`), consistent with `/credentials`, `/available`, `/check`. A focused server isn't cluttered with every course.
- **R3 — Module selection via autocomplete.** Use the autocomplete infra landed in the `/faq` Q&A build (the `Command.autocomplete` slot + `index.ts` dispatch): `/preview course:<id> module:<code>` with the module option autocompleting live modules for the chosen course. **If the `/faq` Q&A build has not merged yet**, this PR must include the same autocomplete-dispatch infra (R1/R2 of the `2026-06-29-002` handoff) as a prerequisite — do not ship `/preview` with a non-functional autocomplete.
- **R4 — Embed rendering.** A live module with a lesson → render the lesson embed (title, description, `image_url`, `video_url`). Module with an assignment → render the assignment embed. Module list view (no module chosen) → a compact list of live modules with their titles. Tiptap `content_json` → render a short plain-text excerpt or omit (do not dump raw JSON).
- **R5 — Graceful + ephemeral.** All replies ephemeral. `ApiError` (network/HTTP) → "try again shortly"; an empty/duned content read → "no preview available for that yet" rather than an error. No command throws to the user. (Mirror `/faq`'s defensive posture.)
- **R6 — Tests.** Pure render/selection logic unit-tested off the confirmed fixtures (module-list render, lesson vs assignment branch, empty/degraded content, the curated-course filter). Suite stays green; `tsc` + lint + CodeQL clean.

## Key Technical Decisions

- **KTD1 — Validate against mainnet (`api.andamio.io`), not preprod.** The bot operates on mainnet; its key is `ant_mn_…`. This supersedes the #21 handoff's preprod instruction — that mismatch is what caused the original 401. Use the bot's configured env for fixture capture.
- **KTD2 — `content-client.ts` is the only data path.** Do not add new fetch logic; call the #21 client methods. If a method needs a small addition (e.g. a list-all-modules helper), extend the client + its tests, keep content reads display-only (never feeding role removal — the KTD1 separation from #21).
- **KTD3 — Lowest-risk feature first.** `/preview` is public-data, renders unconnected, no member-state join — ship it before `/progress` (which adds the member-commitment join). A quick launch win that also exercises the confirmed fixtures for PR 3.
- **KTD4 — Reuse, don't reinvent, course display.** Route course selection through `course-names` so `/preview` matches the other commands' curated behavior.

## Build order

0. **Confirm fixtures live (Step 0 above).**
1. **`/preview` command** + autocomplete (or + autocomplete infra if `/faq` Q&A hasn't merged) + render logic.
2. **Tests.**

One PR. Does not block 2026-07-01.

## Out of scope (future)

- `/progress` + opportunities (PR 3 — the member-commitment join; separate handoff).
- `/deny #channel` (PR 4).
- Multi-lesson/bulk fetch, per-SLT %, rich Tiptap rendering.

## Provenance

orch session "Barca Discord Bot — Launch Features Scope and Build" — Feature scope table + final build order (2026-06-28), and the 2026-06-29 root-cause finding that the bot runs on mainnet (corrects the #21 handoff's preprod validation target). Self-contained; carry into a CE run in `andamio-bot`.
