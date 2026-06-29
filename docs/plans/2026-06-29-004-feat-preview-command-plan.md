---
type: plan
status: active
created: 2026-06-29
origin: docs/plans/2026-06-29-003-feat-preview-command-handoff.md
target_repo: andamio-bot
---

# feat: `/preview` — lesson/module previews in Discord

**Target repo:** andamio-bot · **Stack:** TypeScript, discord.js, vitest · **Branch:** `feat/preview-command` (base `main` @ `70779df`, with #21 content-client and #22 faq autocomplete both merged)

---

## Summary

`/preview` surfaces a course's **live modules** and renders a chosen module's lesson/assignment content as a Discord embed. It is built entirely on the shared `src/andamio/content-client.ts` layer (#21) — **public, `X-API-Key`-only** reads — so it renders identically for connected *and* unconnected members. Course selection reuses the curated `course-names` display filter; module selection uses the `/faq` autocomplete infra (#22). All replies are ephemeral and degrade gracefully on `ApiError`.

**The build is gated on Step 0 (U1): the #21 fixtures are source-mapped, not live-confirmed.** Before any command code is written, the fixtures must be confirmed against the live **mainnet** API (`https://api.andamio.io`) using the bot's existing `ANDAMIO_API_KEY`, and any field-name/shape drift reconciled in the fixtures + mappers. Building `/preview` on guessed field names is the single largest risk in this plan.

---

## Problem Frame

The launch set needs a low-risk, public-data feature that exercises the #21 content-client end to end. `/preview` is that feature: no member-state join, no new API surface, no new auth. But the data path it depends on (`getCourseModules`, `getModuleSlts`, `getLesson`, `getAssignment`) was mapped from source, and the #21 validation attempt 401'd because it targeted preprod while the bot's key is mainnet. The mappers were deliberately written total and envelope-agnostic to absorb shape drift — but only U1 (live capture + reconcile) can confirm the field names the render logic will read. Everything downstream of U1 assumes the confirmed shapes.

---

## Requirements

Carried from the handoff (`docs/plans/2026-06-29-003-feat-preview-command-handoff.md`), R-IDs preserved:

- **R1 — `/preview` command.** Lists a course's **live** modules (`isLive` only); for a chosen module, renders its lesson/assignment content as an embed (title, description, image/video links). Public data → renders for connected *and* unconnected members.
- **R2 — Course selection reuses the curated filter.** Selectable course set = `role-mappings.json` course_ids ∪ `COURSE_DISPLAY_NAMES`, routed through the existing `DisplayFilter` (`isDisplayed`), consistent with `/credentials`, `/available`, `/check`.
- **R3 — Module selection via autocomplete.** Use the #22 autocomplete infra (`AutocompleteCapable.autocomplete` slot + `handleAutocomplete` dispatch in `index.ts`): `/preview course:<id> module:<code>`, the module option autocompleting live modules for the chosen course. *(Prerequisite satisfied — #22 is merged; no infra needs re-shipping in this PR.)*
- **R4 — Embed rendering.** Live module + lesson → lesson embed (title, description, `imageUrl`, `videoUrl`). Module + assignment → assignment embed. No module chosen → compact list of live modules with titles. Tiptap `contentJson` → short plain-text excerpt or omit (never dump raw JSON).
- **R5 — Graceful + ephemeral.** All replies ephemeral. `ApiError` (network/HTTP) → "try again shortly"; empty/drained content → "no preview available for that yet" rather than an error. No command throws to the user. (Mirror `/faq`/`/credentials` defensive posture.)
- **R6 — Tests.** Pure render/selection logic unit-tested off the confirmed fixtures (module-list render, lesson vs assignment branch, empty/degraded content, curated-course filter). Suite stays green; `tsc` + lint + CodeQL clean.

---

## Key Technical Decisions

- **KTD1 — Validate against mainnet, not preprod.** The bot operates on mainnet; its key is `ant_mn_…` against `https://api.andamio.io`. Use the bot's configured `ANDAMIO_API_BASE_URL` + `ANDAMIO_API_KEY` for fixture capture. This supersedes the #21 handoff's preprod instruction (the cause of the original 401). (see origin)
- **KTD2 — `content-client.ts` is the only data path.** No new fetch logic. Call the #21 client methods (`getCourseModules`, `getModuleSlts`, `getLesson`, `getAssignment`). Content reads stay display-only — never feeding role removal. If U1 reveals drift, fix it in the existing mappers, not in a parallel parser.
- **KTD3 — `module` option is optional, `course` is required.** R4 requires a "no module chosen" module-list view, so the `module` string option must be `setRequired(false)` (mirrors `/faq`'s optional `question`). `course` is `setRequired(true)`. This is the cleanest way to get both the list view and the per-module view from one command.
- **KTD4 — Reuse the `DisplayFilter`, don't reinvent course display.** Build the selectable course set exactly as `/credentials` does: `loadCourseDisplayNames()` + `loadShowAllCourses()` + gated course ids from `loadMappings(...)`, assembled into a `DisplayFilter`, filtered with `isDisplayed`, labelled with `displayNameFor`.
- **KTD5 — Lesson-preferred module rendering.** For a chosen module: fetch its SLTs; if any SLT has `hasLesson === true`, render that SLT's lesson (`getLesson(..., sltIndex)`); otherwise render the module assignment (`getAssignment(...)`). Keeps the branch deterministic and avoids a second user choice (per-SLT selection is out of scope).
- **KTD6 — Tiptap excerpt is a total, best-effort helper.** A small pure function walks `contentJson` text nodes, joins and truncates to a short excerpt; on any unexpected shape it returns empty (→ omit the field). Never throws, never dumps JSON. Rich Tiptap rendering is out of scope.
- **KTD7 — Pure render/selection split from I/O.** All render functions (`renderModuleListEmbed`, `renderModulePreviewEmbed`, `tiptapExcerpt`) and the course-choice/module-choice builders are exported pure functions taking already-fetched data, so they unit-test off the confirmed fixtures without Discord or network. `execute`/`autocomplete` are thin I/O shells (mirrors `/faq`, `/check`).

---

## High-Level Technical Design

Command interaction flow (one command, three render paths):

```
/preview course:<id> [module:<code>]
         │
         ├─ autocomplete(course)  → curated course choices (DisplayFilter)         [no API call]
         ├─ autocomplete(module)  → getCourseModules(course) → live modules only
         │
         └─ execute()
              load config + build DisplayFilter
              │
              ├─ course not displayable ─────────────→ "pick a course from the list" (ephemeral)
              │
              ├─ no module given:
              │     getCourseModules(course) → filter isLive
              │       ├─ ApiError ──────────────────→ "try again shortly"
              │       ├─ [] live modules ───────────→ "no preview available for that yet"
              │       └─ renderModuleListEmbed(liveModules)
              │
              └─ module given:
                    getCourseModules(course) → find live module by code
                      ├─ not live / not found ──────→ "no preview available for that yet"
                      └─ getModuleSlts(course, code)
                            ├─ some slt.hasLesson → getLesson(.., sltIndex)  → lesson embed
                            └─ else               → getAssignment(.., code)  → assignment embed
                                  (any ApiError → "try again shortly";
                                   empty content → "no preview available for that yet")
```

All replies `MessageFlags.Ephemeral`. Every `getX` call is wrapped so `ApiError` and empty/degraded reads map to friendly copy, never a throw.

---

## Implementation Units

### U1. Step 0 — Confirm content-client fixtures against live mainnet & reconcile drift

**Goal:** Replace source-mapped fixtures with live-confirmed ones (or confirm they already match), reconciling any field-name/shape drift in both fixtures and mappers, before any `/preview` code is written. **This unit gates U2–U4.**

**Requirements:** Precondition for R1, R4, R6; KTD1, KTD2.

**Dependencies:** none.

**Files:**
- `src/andamio/__fixtures__/content/modules.json` (update if drift)
- `src/andamio/__fixtures__/content/slts.json` (update if drift)
- `src/andamio/__fixtures__/content/lesson.json` (update if drift)
- `src/andamio/__fixtures__/content/assignment.json` (update if drift)
- `src/andamio/__fixtures__/content/README.md` (update the "source-mapped, not live-confirmed" note to "live-confirmed YYYY-MM-DD against api.andamio.io")
- `src/andamio/content-client.ts` (update mappers only if field names/shape differ)
- `src/andamio/content-client.test.ts` (re-pin mapper assertions to confirmed shapes)
- *(throwaway capture script lives in the scratchpad dir, not committed)*

**Approach:**
1. Pick a real gated `course_id` from the server's `role-mappings.json` (the configured `ROLE_MAPPINGS_PATH`; fall back to any `course_id` present). Read the bot's live `ANDAMIO_API_BASE_URL` (`https://api.andamio.io`) and `ANDAMIO_API_KEY` from its `.env`/environment — **do not echo the key**.
2. Capture a real response (header `X-API-Key: <key>`, `Accept: application/json`) for each public endpoint, writing raw JSON to the scratchpad:
   - `GET /api/v2/course/user/modules/{course_id}`
   - `GET /api/v2/course/user/slts/{course_id}/{course_module_code}` (a live module's code from the modules response)
   - `GET /api/v2/course/user/lesson/{course_id}/{course_module_code}/{slt_index}` (an SLT with `has_lesson`)
   - `GET /api/v2/course/user/assignment/{course_id}/{course_module_code}`
3. Diff each live response against the matching `__fixtures__/content/*.json`. For each field the mappers read (`title`, `description`, `image_url`, `is_live`, `course_module_code`; `slt_text`, `slt_index`, `has_lesson`; `video_url`, `content_json`): confirm name + type, and confirm the envelope (bare array/object vs `{ data: ... }`).
4. **Reconcile drift:** update the pinned fixture JSON to the captured shape, and update the corresponding mapper in `content-client.ts` (and its `*.test.ts` assertions) to the live field names. The mappers are total/envelope-agnostic by design — most drift should be absorbable by adjusting the `prop()` key names, not the structure.
5. If a capture fails (401/network): stop and surface it — confirm the key is the mainnet operator key and the base URL has no trailing slash. A persistent 401 here means the same misconfiguration that broke #21; do not proceed to U2 on unconfirmed shapes.

**Patterns to follow:** existing `content-client.test.ts` mapper tests (bare + `{ data }` enveloped variants); existing fixture file layout.

**Test scenarios:**
- Re-run `src/andamio/content-client.test.ts`; after any fixture/mapper edit, mapper assertions still pass against the (possibly updated) fixtures — bare and `{ data: ... }` envelopes both map identically.
- Covers R6. If a field name changed (e.g. `image_url` → `imageUrl` server-side, or `course_module_code` → `module_code`), a mapper test asserts the new field is read and the camelCase output is unchanged for downstream consumers.

**Verification:** Live JSON captured for all four endpoints; each diffed against its fixture; any drift reconciled in fixture + mapper + test; `npm test` green; README note updated to record the live-confirm date and that capture was against mainnet. If shapes differ materially, the fixture/mapper change is called out in the PR description as a distinct concern (not silently folded in).

---

### U2. Preview render helpers (pure functions)

**Goal:** Pure, Discord-only render functions that turn confirmed content-client data into embeds, plus the Tiptap excerpt helper.

**Requirements:** R1, R4, R5 (degraded copy), R6; KTD6, KTD7.

**Dependencies:** U1 (must render against confirmed shapes).

**Files:**
- `src/commands/preview.ts` (export `renderModuleListEmbed`, `renderModulePreviewEmbed`, `tiptapExcerpt`)
- `src/commands/preview.test.ts` (render-function tests)

**Approach:**
- `renderModuleListEmbed(courseLabel: string, liveModules: CourseModule[]): EmbedBuilder` — compact list: title `Preview — <courseLabel>`, one line per live module (`• **<title>** (\`<moduleCode>\`)`, optional truncated description). Use the existing `fitFieldValue`/`embed-field` helper for length safety (mirror `/credentials`).
- `renderModulePreviewEmbed(module: CourseModule, content: LessonContent | AssignmentContent, kind: 'lesson' | 'assignment'): EmbedBuilder` — title from `content.title` (fallback `module.title`), description from `content.description` + `tiptapExcerpt(content.contentJson)`, `setImage(content.imageUrl)` when non-empty, a "Video" field linking `content.videoUrl` when non-empty, and a footer/label noting lesson vs assignment.
- `tiptapExcerpt(contentJson: unknown, maxLen = ~280): string` — total walk of `{ content: [...] }` collecting `type: 'text'` node `text` values, join with spaces, collapse whitespace, truncate with ellipsis; return `''` on any non-conforming shape (→ caller omits the field). Never throws.
- Empty/degraded inputs return a usable embed (the execute layer decides when to show "no preview available" copy instead).

**Patterns to follow:** `renderCredentialsEmbed`/`renderFaqEmbed` (pure render fn taking data, returning `EmbedBuilder`), `fitFieldValue` from `src/commands/embed-field.ts`.

**Test scenarios (off U1's confirmed fixtures):**
- `renderModuleListEmbed` with `modules.json` filtered to `isLive` → embed lists exactly the two live modules, excludes the draft (`is_live: false`); module codes appear.
- `renderModulePreviewEmbed` with `lesson.json` + `kind: 'lesson'` → title/description present, image set when `imageUrl` non-empty, video field present when `videoUrl` non-empty.
- `renderModulePreviewEmbed` with `assignment.json` + `kind: 'assignment'` → assignment-labelled embed renders.
- `tiptapExcerpt` happy path → extracts plain text from a Tiptap doc, truncated to maxLen with ellipsis. Covers R4.
- `tiptapExcerpt` edge: `null`, `{}`, `{ content: [] }`, a string, a number, deeply nested non-text nodes → returns `''` (never throws, never leaks JSON). Covers R4/R5.
- Empty `imageUrl`/`videoUrl` → those fields omitted, no broken-link/empty field. Covers R5.

**Verification:** `preview.test.ts` covers list view, lesson branch, assignment branch, and excerpt edge cases; `npm test` green.

---

### U3. Course & module selection helpers (pure functions)

**Goal:** Pure helpers that build the curated course autocomplete choices and the live-module autocomplete choices, plus resolve a typed course/module value against the curated/live set.

**Requirements:** R2, R3, R6; KTD3, KTD4.

**Dependencies:** U1 (module choices read confirmed `CourseModule` shape).

**Files:**
- `src/commands/preview.ts` (export `courseChoices`, `moduleChoices`, and a small `isCourseSelectable` guard)
- `src/commands/preview.test.ts` (selection-logic tests)

**Approach:**
- `courseChoices(filter: DisplayFilter, focused: string): { name: string; value: string }[]` — candidate course ids = `Object.keys(filter.names) ∪ filter.gatedCourseIds`; keep those passing `isDisplayed(id, filter)`; map to `{ name: displayNameFor(id, names), value: id }`; case-insensitive substring filter on `focused` over name+id; cap at 25 (Discord limit). When `showAll`/empty names, fall back to gated ids only (avoid an unbounded list — autocomplete has no full course catalog source here; documented limitation).
- `moduleChoices(modules: CourseModule[], focused: string): { name: string; value: string }[]` — filter `isLive`, case-insensitive substring on `focused` over title+code, map to `{ name: '<title> (<moduleCode>)', value: moduleCode }`, cap at 25.
- `isCourseSelectable(courseId: string, filter: DisplayFilter): boolean` — thin wrapper over `isDisplayed`, used by `execute` to reject a hand-typed non-curated course id.

**Patterns to follow:** `/credentials` `DisplayFilter` construction (`loadCourseDisplayNames` + `loadShowAllCourses` + gated ids from `loadMappings`); `/faq` autocomplete `respond` choice shape (`{ name, value }`, ≤25).

**Test scenarios:**
- `courseChoices` with a `names` map of 3 + 1 gated id not in the map → returns all 4 (gated always shown), labelled by display name. Covers R2.
- `courseChoices` with `focused` substring → filters to matching name/id, case-insensitive.
- `courseChoices` caps output at 25 when candidates exceed it.
- `moduleChoices` over `modules.json` → returns only the 2 live modules, excludes the draft; value is the module code, name includes the title. Covers R3.
- `moduleChoices` with `focused` → substring filter on title and code.
- `isCourseSelectable` → true for a curated/gated id, false for an unknown id (drives the execute-layer rejection). Covers R2.

**Verification:** selection tests pass; `npm test` green.

---

### U4. `/preview` command — `data`, `autocomplete`, `execute` (I/O shell)

**Goal:** Wire the slash command: option schema, the two-option autocomplete handler, and the graceful ephemeral execute flow. Auto-discovered by `command-loader` — no manual registration.

**Requirements:** R1, R2, R3, R4, R5, R6; KTD2, KTD3, KTD5, KTD7.

**Dependencies:** U1, U2, U3.

**Files:**
- `src/commands/preview.ts` (`data`, `autocomplete`, `execute`)
- `src/commands/preview.test.ts` (execute-flow + autocomplete-dispatch tests, mocked interactions + content-client)

**Approach:**
- `data`: `SlashCommandBuilder().setName('preview').setDescription(...)` with `course` (`setRequired(true).setAutocomplete(true)`) and `module` (`setRequired(false).setAutocomplete(true)`).
- `autocomplete(interaction)`: branch on `interaction.options.getFocused(true).name`.
  - `course` → build `DisplayFilter` (best-effort, like `/credentials`; config failure → `respond([])`), `respond(courseChoices(filter, focused))`. **No API call** (Discord's 3s budget).
  - `module` → read the already-chosen `course` via `interaction.options.getString('course')`; if absent, `respond([])`; else `getCourseModules(apiBaseUrl, apiKey, course)` and `respond(moduleChoices(modules, focused))`. Wrap in try/catch → `respond([])` on any error (the `handleAutocomplete` dispatcher also guards, but stay graceful).
- `execute(interaction)`:
  1. `loadConfig()`; build `DisplayFilter` (mirror `/credentials` lines 119–128, best-effort gated ids).
  2. `course = getString('course', true)`. If `!isCourseSelectable(course, filter)` → ephemeral "Pick a course from the list" and return.
  3. `module = getString('module')`. `deferReply({ flags: Ephemeral })` before the API call (mirror `/check`).
  4. No module → `getCourseModules` → filter `isLive`; `[]` → "no preview available for that yet"; else `editReply` with `renderModuleListEmbed(displayNameFor(course, names), liveModules)`.
  5. Module given → `getCourseModules`, find live module by `moduleCode === module`; not found/not live → "no preview available for that yet". Else `getModuleSlts`; pick first `hasLesson` SLT → `getLesson(.., sltIndex)` → `renderModulePreviewEmbed(module, lesson, 'lesson')`; else `getAssignment(.., module)` → `renderModulePreviewEmbed(module, assignment, 'assignment')`. Treat an all-empty content object as "no preview available for that yet".
  6. Wrap all API calls: `ApiError` → "Couldn't reach Andamio right now — try `/preview` again shortly." No throw escapes to the user.
- Replies use `editReply` after `deferReply`; the pre-API course-rejection uses `reply` (no defer needed). All ephemeral.

**Patterns to follow:** `/check` (`deferReply` + `ApiError`-kind branching), `/faq` (autocomplete handler + optional option), `/credentials` (DisplayFilter construction).

**Test scenarios (mocked interactions, content-client mocked via `vi.mock`):**
- `execute` with course only → calls `getCourseModules`, replies with a module-list embed of live modules. Covers R1/R4.
- `execute` with course + module having a lesson SLT → calls `getModuleSlts` then `getLesson`, replies lesson embed. Covers R1/R4/R5.
- `execute` with course + module, no lesson SLT → calls `getAssignment`, replies assignment embed. Covers R4.
- `execute` with a non-curated/hand-typed course → ephemeral "pick a course" reply, **no API call**. Covers R2.
- `execute` where `getCourseModules` throws `ApiError` (network) → ephemeral "try again shortly", no throw. Covers R5.
- `execute` where modules read is `[]` (drained) → "no preview available for that yet". Covers R5.
- `execute` module given but module not live / not found → "no preview available for that yet". Covers R4/R5.
- `autocomplete` focused `course` → responds curated choices, makes no API call. Covers R2/R3.
- `autocomplete` focused `module` with a chosen course → responds live-module choices from `getCourseModules`. Covers R3.
- `autocomplete` focused `module` with no course chosen → responds `[]`. Covers R3.
- `autocomplete` content-client throws → responds `[]` (never throws). Covers R3/R5.
- All replies asserted to carry `MessageFlags.Ephemeral`. Covers R5.

**Verification:** `command-loader.isCommandModule('preview.ts')` true (auto-loaded by `index.ts` + `deploy-commands.ts`); `npm test` green; `npm run build` (tsc) clean; `npm run lint` clean. Command appears on next `npm run deploy` (runtime, out of this PR's automated scope).

---

## Scope Boundaries

In scope: the `/preview` command, its pure render/selection helpers, U1 live fixture confirmation, and unit tests, in one PR.

### Deferred to Follow-Up Work
- Re-deploying slash commands to the guild (`npm run deploy`) — runtime/ops step, not code.

### Out of scope (from origin)
- `/progress` + opportunities (PR 3 — the member-commitment join).
- `/deny #channel` (PR 4).
- Multi-lesson/bulk fetch, per-SLT selection or per-SLT %, rich Tiptap rendering.
- A full course catalog source for `course` autocomplete beyond the curated/gated set (documented limitation in U3).

---

## Risks & Dependencies

- **R-A — Live shape drift (highest).** If U1 finds material drift, the fixture+mapper reconciliation is a distinct concern and must be called out in the PR, not papered over (origin Step 0). Mitigation: U1 gates all downstream units; mappers are already total/envelope-agnostic.
- **R-B — Mainnet key access.** U1 needs the bot's real `ANDAMIO_API_KEY`. If unavailable in the build environment, U1 cannot complete and the PR must not proceed on unconfirmed shapes — surface the blocker. The key is known-good (`/check` succeeds with it).
- **R-C — Autocomplete reads sibling option.** The `module` autocomplete depends on `interaction.options.getString('course')` being populated as the user types; if Discord hasn't captured the course yet, fall back to `[]` (handled in U4).
- **Dependency:** #21 (content-client) and #22 (faq autocomplete) — both merged into the branch base; R3's infra-fallback clause is moot.

---

## Sources & Research

- Origin handoff: `docs/plans/2026-06-29-003-feat-preview-command-handoff.md`.
- Codebase: `src/andamio/content-client.ts` (+ `__fixtures__/content/`, `content-client.test.ts`), `src/andamio/course-names.ts`, `src/gating/mappings.ts`, `src/commands/{faq,check,credentials,available}.ts`, `src/discord/autocomplete.ts`, `src/config.ts`, `src/command-loader.ts`.
- Test runner: vitest (`npm test` → `vitest run`); build `npm run build` (tsc); lint `npm run lint`.
