---
type: plan
status: active
created: 2026-06-29
origin: docs/plans/2026-06-28-001-feat-content-progress-opportunities-channel-block-handoff.md
target_repo: andamio-bot
---

# feat: Shared `content-client.ts` API layer (PR 1)

**Target repo:** andamio-bot · **Stack:** TypeScript, discord.js, better-sqlite3, vitest · **Branch:** `feat/content-client` off `main` @ #20

## Summary

PR 1 of the four-part launch-features handoff (see origin: `docs/plans/2026-06-28-001-feat-content-progress-opportunities-channel-block-handoff.md`). It builds **only the shared read layer** — a new `src/andamio/content-client.ts` sibling to `dashboard-client.ts` — plus its pure mappers and fixture-backed unit tests. **No user-visible commands ship in this PR** (`/preview`, `/progress`, `/opportunities`, `/deny #channel` are PRs 2–4).

The module exposes five read functions:

- **Public (operator `X-API-Key` only):** `getCourseModules`, `getModuleSlts`, `getLesson`, `getAssignment`
- **Authenticated (operator `X-API-Key` + member `Authorization: Bearer <JWT>`):** `getAssignmentCommitments`

These mirror the existing `dashboard-client.ts` discipline exactly: a typed `ApiError` taxonomy (`unauthorized` / `not-found` / `http` / `network`), a 10s `AbortSignal.timeout`, defensive mappers that tolerate unknown/extra fields, and 200/206-as-success handling. Field names are **source-mapped from the API, not contract-guaranteed** — so the first execution step is to capture a real preprod response per endpoint into a fixture and pin the mappers to it (KTD5).

This PR satisfies origin requirement **R1** and locks origin decisions **KTD1** (separate module, never destabilizes the gate), **KTD3** (public-vs-authed header split via a shared request helper), and **KTD5** (confirm shapes against preprod before pinning mappers).

---

## Problem Frame

**Who:** Downstream PRs 2–4 (the command views) — not end users in this PR. The launch features (Lesson Previews, Progress, Opportunities) all read the same two data sources: a course's module list and a member's assignment commitments. Building one shared, well-tested client layer first means the three command views become thin presentation code on top of a proven, contract-pinned foundation.

**Why a separate module (KTD1):** `dashboard-client.ts` is load-bearing for **role gating** — its `partial`/`isDegraded` contract decides whether the gating sweep is allowed to strip roles. Content reads are **display-only** and must never feed role removal. Keeping them in a separate module with their own mappers means a content-endpoint contract drift can never destabilize the gate.

**Scope of this PR:** the client module + mappers + fixtures + unit tests. It wires nothing into commands, the loader, or the gating evaluator. Success = the module compiles, exports the five functions with stable typed return shapes, mappers are unit-tested off captured preprod fixtures, and the existing 268-test suite stays green (new tests add to that count).

---

## API capability (source-mapped 2026-06-28 — confirm live before pinning mappers)

All paths are under the existing client base `${apiBaseUrl}/api/v2` (`apiBaseUrl` = `config.andamioApiBaseUrl`, key = `config.andamioApiKey`). Field names below are from the origin's source-map of `andamio-api` / `andamio-db-api-go` and **must be confirmed against `preprod.api.andamio.io` during U1 before the mappers are pinned** (KTD5).

**Public (operator `X-API-Key` only — no member Bearer):**

| Function | Method + path | Returns (raw fields, to confirm) |
|---|---|---|
| `getCourseModules(courseId)` | `GET /course/user/modules/{course_id}` | Array of `{ title, description, image_url, is_live, course_module_code }` |
| `getModuleSlts(courseId, moduleCode)` | `GET /course/user/slts/{course_id}/{course_module_code}` | Array of `{ slt_text, slt_index, has_lesson }` (+ optional nested lesson) |
| `getLesson(courseId, moduleCode, sltIndex)` | `GET /course/user/lesson/{course_id}/{course_module_code}/{slt_index}` | `{ title, description, image_url, video_url, content_json }` (Tiptap) |
| `getAssignment(courseId, moduleCode)` | `GET /course/user/assignment/{course_id}/{course_module_code}` | `{ title, description, image_url, video_url, content_json }` |

**Authenticated (operator `X-API-Key` + member `Authorization: Bearer <JWT>`):**

| Function | Method + path | Returns (raw fields, to confirm) |
|---|---|---|
| `getAssignmentCommitments(jwt)` | `POST /course/student/assignment-commitments/list` | Array of the member's commitments with `status` ∈ {DRAFT, SUBMITTED, APPROVED, REFUSED, …}, keyed by course + module |

**Does NOT exist (do not design around it):** per-SLT/sub-module completion %, a per-user "opportunities" feed, bulk multi-lesson fetch. Each function is a single endpoint call.

**Response envelope:** confirm during U1 whether these endpoints wrap payloads in a `{ data: ... }` envelope like the dashboard does, or return bare arrays/objects. The mappers must read the same shape the fixtures capture — this is the central reason fixtures come first.

---

## Requirements

- **R1 (this PR)** — `src/andamio/content-client.ts` (sibling to `dashboard-client.ts`) exposes `getCourseModules`, `getLesson`, `getModuleSlts`, `getAssignment` (public, `X-API-Key` only) and `getAssignmentCommitments` (member Bearer). Same `ApiError` taxonomy and timeout discipline as `dashboard-client.ts`. Pure mappers (`mapModules`, `mapSlts`, `mapLesson`, `mapAssignment`, `mapCommitments`) are unit-tested off captured fixtures.
- **R8 (partial, this PR)** — The pure mappers are unit-tested; the existing 268-test suite stays green. (The module×commitment join and channel→roles resolver named in origin R8 belong to PRs 3 and 4 respectively — out of scope here.)

Origin requirements **R2–R7** (command views, ephemeral replies, moderator guard, curated-course reuse) are **deferred to PRs 2–4** and out of scope for this PR.

---

## Key Technical Decisions

- **KTD1 — New `content-client.ts`, do not overload `dashboard-client.ts`.** Content reads are display-only and must never feed role removal. Separate module, separate mappers, separate types. The two clients share *conventions* (the `ApiError` class, header pattern, timeout) but not code coupling that could let a content drift reach the gate. **Reuse `ApiError`/`ApiErrorKind` by importing from `dashboard-client.ts`** rather than redefining — one error taxonomy across both clients keeps command-layer `catch` branches uniform, and `ApiError` is gating-neutral (it carries no degraded-read semantics). The gating-specific `isDegraded`/`partial` contract stays in `dashboard-client.ts` and is **not** imported here — content reads have no "decline to churn roles" concept.
- **KTD3 — Public vs authed split mirrors the header pattern.** Public calls send only `X-API-Key`; `getAssignmentCommitments` adds `Authorization: Bearer <jwt>`. Factor two small private helpers — `andamioGet(url, apiKey, jwt?)` and `andamioPost(url, apiKey, body, jwt?)` — that carry the operator key, optional Bearer, `Content-Type`/`Accept`, the 10s timeout, and the full `ApiError` mapping (network → 401 → 404 → other-non-2xx → non-JSON-body). Each public function is then a thin typed wrapper that calls the helper and runs its mapper. This is the same fetch/error choreography `getUserDashboard` already implements, lifted into a shared helper so it isn't copy-pasted five times.
- **KTD5 — Confirm response shapes before mapping (fixtures first).** Field names are source-mapped, not contract-guaranteed. **U1 is fixture capture:** hit each endpoint against `preprod.api.andamio.io` with the operator key (and a member JWT for the commitments call), save the real responses as JSON fixtures under `src/andamio/__fixtures__/content/`, and pin every mapper to the captured shape. Treat any later drift as a fixture update. Mirrors `dashboard-client`'s defensive mapping — mappers tolerate unknown/extra fields and missing/empty bodies, never throw on shape, and coerce types defensively (`toStringArray`-style guards).
- **KTD7 (new, this PR) — Mappers are pure and total.** Every `map*` function takes `unknown` and returns a typed value or `[]`/empty-object default — never throws on a malformed body (only the fetch helper throws, and only `ApiError`). A garbled content response degrades to empty content in the eventual embed, never to a crash. This matches `mapDashboard`'s "tolerates a missing student / empty envelope" behavior.

---

## Output Structure

```text
src/andamio/
  content-client.ts              # new — the five read functions + mappers + helpers
  content-client.test.ts         # new — mapper unit tests + fetch-path tests
  __fixtures__/
    content/
      modules.json               # captured GET /course/user/modules response
      slts.json                  # captured GET /course/user/slts response
      lesson.json                # captured GET /course/user/lesson response
      assignment.json            # captured GET /course/user/assignment response
      commitments.json           # captured POST /course/student/assignment-commitments/list response
```

`__fixtures__/content/` is new. Confirm the repo's existing fixture/import convention during U1 — if vitest is configured to import JSON directly, fixtures load via `import`; otherwise read them with `fs` in the test. The per-unit file lists below are authoritative; this tree is the scope declaration.

---

## High-Level Technical Design

The module is two layers: shared fetch helpers (throw `ApiError`, return parsed JSON) and per-endpoint typed wrappers (call helper, run pure mapper). Mappers are independently testable off fixtures with no I/O.

```text
 caller (PRs 2–4)
       │  getCourseModules(base, key, courseId)         ← public, X-API-Key only
       │  getAssignmentCommitments(base, key, jwt)       ← authed, + Bearer
       ▼
 ┌─────────────────────────────────────────────┐
 │ typed wrapper: build URL → call helper → map │
 └───────────────┬─────────────────────────────┘
                 ▼
 ┌──────────────────────────────┐      ┌────────────────────────────┐
 │ andamioGet(url, key, jwt?)   │      │ andamioPost(url, key, body, │
 │ andamioPost(...)             │      │            jwt?)            │
 │  • headers: X-API-Key (+Bearer when jwt) │  • AbortSignal.timeout(10s)        │
 │  • maps non-2xx → ApiError(kind, status) │  • non-JSON body → ApiError('http')│
 │  • network/timeout → ApiError('network') │  • returns parsed JSON (unknown)   │
 └───────────────┬──────────────────────────┘
                 ▼
 ┌──────────────────────────────────────────────────────┐
 │ pure mappers (unknown → typed, total, never throw):   │
 │  mapModules · mapSlts · mapLesson · mapAssignment ·    │
 │  mapCommitments                                        │
 └──────────────────────────────────────────────────────┘
```

Directional guidance, not implementation specification — the exact helper signatures and whether `andamioGet`/`andamioPost` collapse into one variadic helper are an implementation call, as long as the public-vs-authed header split and `ApiError` mapping are preserved.

---

## Implementation Units

### U1. Capture preprod fixtures and confirm response shapes

**Goal:** Before any mapper is written, capture a real response from each of the five endpoints against `preprod.api.andamio.io` and confirm the actual field names and envelope shape. This is KTD5 made concrete — it de-risks every later unit.

**Requirements:** R1 (foundation), KTD5.

**Dependencies:** none (first unit).

**Files:**
- `src/andamio/__fixtures__/content/modules.json` (create)
- `src/andamio/__fixtures__/content/slts.json` (create)
- `src/andamio/__fixtures__/content/lesson.json` (create)
- `src/andamio/__fixtures__/content/assignment.json` (create)
- `src/andamio/__fixtures__/content/commitments.json` (create)

**Approach:**
- Use the operator key (`config.andamioApiKey`) and base URL (`config.andamioApiBaseUrl`, pointing at preprod) from the bot's existing env. **Never echo the key into the plan, logs, commit, or fixture files** — strip any auth headers from captured output; fixtures hold only response bodies.
- For the four public endpoints, a `curl`/`fetch` with `X-API-Key` is enough. Pick a real course id present in preprod (cross-reference `role-mappings.json` / the courses the bot already gates) and a real module code from the modules response, then a real `slt_index` from the slts response.
- For `getAssignmentCommitments`, a member JWT is required. Use a test/dev member's Bearer (do not commit it). If a member JWT is not readily available during this run, **capture the four public fixtures, and hand-author `commitments.json` from the source-mapped shape, marking it `// shape unconfirmed` in the test** so the gap is explicit rather than hidden — then confirm against preprod when a JWT is available.
- Record, per fixture, whether the payload is enveloped (`{ data: ... }`) or bare. This determines the mapper's entry path.
- Redact any PII (member aliases, emails) from `commitments.json` to representative placeholders while preserving the exact shape.

**Patterns to follow:** the dashboard envelope handling in `src/andamio/dashboard-client.ts` (`mapDashboard` reads `body.data.student`) — confirm whether content endpoints use the same `data` envelope or differ.

**Test scenarios:** `Test expectation: none -- fixture capture, no behavioral code. The fixtures themselves are consumed as test inputs in U2–U4.`

**Verification:** five JSON files exist under `src/andamio/__fixtures__/content/`, each a real (or explicitly-marked unconfirmed, for commitments) response body with no secrets; the actual field names and envelope shape for each endpoint are written down (in the fixture or a comment) to pin the mappers against.

---

### U2. `ApiError`-sharing + shared fetch helpers (`andamioGet` / `andamioPost`)

**Goal:** Establish the request/error spine the five functions sit on: import the shared `ApiError`/`ApiErrorKind` from `dashboard-client.ts`, and implement `andamioGet`/`andamioPost` private helpers carrying the operator key, optional Bearer, timeout, and full `ApiError` mapping.

**Requirements:** R1, KTD1, KTD3.

**Dependencies:** U1 (envelope shape informs nothing here, but ordering keeps the module coherent; helpers can be written in parallel with U1 in practice).

**Files:**
- `src/andamio/content-client.ts` (create — module skeleton, imports, helpers)
- `src/andamio/content-client.test.ts` (create — helper-path fetch tests)

**Approach:**
- `import { ApiError, type ApiErrorKind } from './dashboard-client';` — one error taxonomy across both clients (KTD1). Do **not** redefine `ApiError` here. Do **not** import `isDegraded`/`partial` — content reads have no degraded-read concept.
- `const REQUEST_TIMEOUT_MS = 10_000;` mirroring the dashboard client.
- `andamioGet(url, apiKey, jwt?)`: `fetch` with `GET`, headers `X-API-Key` always, `Authorization: Bearer <jwt>` only when `jwt` is provided, `Accept: application/json`, `signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)`. Wrap fetch in try/catch → `ApiError('network', ...)`. On `!response.ok`: 401 → `unauthorized`, 404 → `not-found`, else → `http` (with `status`). Parse JSON in try/catch → `ApiError('http', ..., status)` on failure. Return the parsed `unknown` body.
- `andamioPost(url, apiKey, body, jwt?)`: identical, with `POST`, `Content-Type: application/json`, and a JSON-stringified body (`'{}'` when body is empty, matching the dashboard call).
- Factor so the two helpers share their error-mapping logic (a private `mapResponseErrors`/`parseJson` helper is fine) rather than duplicating the non-2xx ladder.

**Patterns to follow:** `getUserDashboard` in `src/andamio/dashboard-client.ts:190-247` — the exact network try/catch, the `!response.ok` status ladder, and the non-JSON-body guard. Test style: `src/andamio/dashboard-client.test.ts` (`jsonResponse` stub, `vi.spyOn(globalThis, 'fetch')`, `afterEach(restoreAllMocks)`).

**Test scenarios:**
- Happy path: `andamioGet` sends `X-API-Key`, no `Authorization` header when `jwt` omitted; returns the parsed body. Assert via `fetchMock.mock.calls[0]` headers.
- Authed path: `andamioGet`/`andamioPost` add `Authorization: Bearer <jwt>` when `jwt` is passed.
- `andamioPost` uses `method: 'POST'` and sends `Content-Type: application/json` with the stringified body.
- Error path: 401 → `ApiError` `kind: 'unauthorized'`, `status: 401`.
- Error path: 404 → `kind: 'not-found'`.
- Error path: 500 → `kind: 'http'`, `status: 500`.
- Error path: fetch rejects (`ECONNREFUSED`) → `kind: 'network'`.
- Error path: 2xx with a body that throws on `.json()` → `kind: 'http'`, status preserved.
- Edge: 206 is treated as success (`response.ok` is true for 200–299), body returned — content reads have no partial-content concept, so 206 is just a normal success here.

**Verification:** `content-client.ts` compiles, imports `ApiError` from the dashboard client, and the helper tests cover every `ApiError` kind plus the public/authed header split. `npx tsc --noEmit` clean.

---

### U3. Public read functions + mappers (`getCourseModules`, `getModuleSlts`, `getLesson`, `getAssignment`)

**Goal:** Implement the four public (X-API-Key-only) functions and their pure mappers, pinned to the U1 fixtures.

**Requirements:** R1, KTD5, KTD7.

**Dependencies:** U1 (fixtures), U2 (helpers).

**Files:**
- `src/andamio/content-client.ts` (modify — add types, mappers, four functions)
- `src/andamio/content-client.test.ts` (modify — add mapper + function tests)
- consumes `src/andamio/__fixtures__/content/{modules,slts,lesson,assignment}.json`

**Approach:**
- Define exported types from the **confirmed** U1 shapes, e.g. `CourseModule { title; description; imageUrl; isLive; moduleCode }`, `ModuleSlt { sltText; sltIndex; hasLesson }`, `LessonContent { title; description; imageUrl; videoUrl; contentJson }`, `AssignmentContent { ... }`. Names are illustrative — pin to what U1 actually returns.
- Each mapper (`mapModules`, `mapSlts`, `mapLesson`, `mapAssignment`) is pure, total, `unknown → typed`. Read the envelope path U1 confirmed (`body.data` vs bare). Coerce defensively: arrays default to `[]`, strings via a `toStringArray`/`asString` guard, `is_live`/`has_lesson` coerced to boolean. Drop array entries missing their key field (mirroring `courseIdOf`/`toStringArray` in the dashboard client). Never throw (KTD7).
- Each function: build the URL (`${apiBaseUrl}/api/v2/course/user/...` with path params), call `andamioGet(url, apiKey)`, return the mapper output. Signature mirrors `getUserDashboard(apiBaseUrl, apiKey, ...)`.
- `content_json` (Tiptap) is passed through as an opaque structured value in this PR — no rendering. Type it loosely (`unknown`/a minimal node type); rendering is PR 2's concern.

**Patterns to follow:** `mapDashboard` and its helpers (`toStringArray`, `courseIdOf`) in `src/andamio/dashboard-client.ts:56-175` for defensive coercion; the function shape of `getUserDashboard`.

**Test scenarios:**
- `mapModules` maps the captured `modules.json` fixture into `CourseModule[]` with correct field mapping (snake_case → camelCase) and boolean `isLive`.
- `mapModules` tolerates an empty array / missing-envelope body → `[]` (KTD7).
- `mapModules` drops a module entry missing `course_module_code` (or whichever key field U1 confirms is required).
- `mapSlts` maps `slts.json` into `ModuleSlt[]` with `hasLesson` coerced to boolean; tolerates empty/missing.
- `mapLesson` maps `lesson.json` into `LessonContent`, preserving `contentJson` opaquely; tolerates a missing/empty body → empty-object default with empty strings.
- `mapAssignment` maps `assignment.json` into `AssignmentContent`; tolerates missing/empty.
- `getCourseModules` builds `GET /api/v2/course/user/modules/{courseId}`, sends `X-API-Key` only (no `Authorization`), returns mapped modules. Assert URL + headers via `fetchMock`.
- `getModuleSlts`, `getLesson`, `getAssignment` each build the correct path with their path params and return mapped output.
- Each public function propagates `ApiError` on a 500 (one representative test; the kind ladder itself is covered in U2).

**Verification:** four public functions exported and typed; mappers pinned to real fixtures and total; tests green; `tsc --noEmit` clean.

---

### U4. Authed read function + mapper (`getAssignmentCommitments`)

**Goal:** Implement the one authenticated function (operator key + member Bearer) and its mapper, pinned to the commitments fixture.

**Requirements:** R1, KTD3, KTD5, KTD7.

**Dependencies:** U1 (commitments fixture), U2 (helpers).

**Files:**
- `src/andamio/content-client.ts` (modify — add commitment type, `mapCommitments`, `getAssignmentCommitments`)
- `src/andamio/content-client.test.ts` (modify — add commitment tests)
- consumes `src/andamio/__fixtures__/content/commitments.json`

**Approach:**
- Define `AssignmentCommitment { courseId; moduleCode; status }` (pin to U1's confirmed keying — the origin says commitments are "keyed by course + module"). `status` typed as a string union of the known values (`'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REFUSED'` + a fallback) — but the mapper must **pass through unknown status strings**, not drop them, so a new server-side status never silently disappears (it would just render as "unknown" in a later view). Type `status` as a branded string or `string` to keep the mapper total.
- `mapCommitments(unknown): AssignmentCommitment[]` — pure, total, reads the U1-confirmed envelope, coerces defensively, drops entries missing the course/module key, never throws (KTD7).
- `getAssignmentCommitments(apiBaseUrl, apiKey, jwt)`: `POST /api/v2/course/student/assignment-commitments/list` via `andamioPost(url, apiKey, {} /* or U1-confirmed body */, jwt)`, returns `mapCommitments(body)`. The Bearer is the member-selector exactly as in `getUserDashboard`.
- Confirm during U1 whether the POST needs a body (course filter) or returns all of the member's commitments for an empty body. Default to the dashboard pattern (`'{}'`) unless U1 shows otherwise.

**Patterns to follow:** `getUserDashboard`'s POST-with-Bearer shape (`src/andamio/dashboard-client.ts:190-247`); the authed-header test (`dashboard-client.test.ts:99-125`).

**Test scenarios:**
- `mapCommitments` maps the captured `commitments.json` into `AssignmentCommitment[]` with course/module/status fields.
- `mapCommitments` passes through an unrecognized `status` string verbatim (does not drop or null it).
- `mapCommitments` tolerates an empty array / missing-envelope body → `[]`.
- `mapCommitments` drops a commitment entry missing its course or module key.
- `getAssignmentCommitments` sends BOTH `X-API-Key` AND `Authorization: Bearer <jwt>`, uses `POST`, and targets `/api/v2/course/student/assignment-commitments/list`. Assert via `fetchMock`.
- `getAssignmentCommitments` throws `ApiError` `kind: 'unauthorized'` on 401 (the member's JWT expired) — this is the branch PR 3 will catch to trigger the reconnect prompt.

**Verification:** `getAssignmentCommitments` exported and typed; the authed-header split is proven (key + Bearer both sent); `mapCommitments` total and pinned to the fixture; 401 surfaces as `unauthorized`; full suite green; `tsc --noEmit` clean.

---

## Scope Boundaries

### Deferred to Follow-Up Work (later PRs in this handoff)
- **`/preview` command** (origin R2) — PR 2.
- **`/progress` + opportunities** (origin R3/R4) including `joinModuleProgress` (origin KTD2) — PR 3.
- **`/deny #channel`** (origin R5, KTD4) and the channel→roles resolver — PR 4.
- **Tiptap `content_json` rendering** — PR 2's embed concern. This PR passes content through opaquely.
- **Curated-course display filtering** (origin KTD6) — PRs 2/3 wire `course-names` at the command layer; the client takes a raw `courseId`.

### Outside this PR's identity
- No command files, no reflective-loader registration, no `deploy-commands` changes.
- No coupling into `dashboard-client.ts`'s gating contract (`isDegraded`/`partial`) — content reads never touch role removal (KTD1).
- No new config/env keys — reuses `config.andamioApiBaseUrl` / `config.andamioApiKey`.

---

## Risks & Dependencies

- **Response-shape drift (primary risk).** Field names are source-mapped, not contract-guaranteed. **Mitigation:** U1 captures real preprod fixtures first and pins every mapper; mappers are total (KTD7) so a drift degrades to empty content, never a crash. Any later drift is a fixture update + mapper tweak.
- **Member JWT availability for the commitments fixture.** If no test member Bearer is available during U1, `commitments.json` is hand-authored from the source-mapped shape and explicitly marked unconfirmed, with a follow-up to confirm against preprod. The other four fixtures are unblocked (X-API-Key only).
- **Envelope assumption.** The mappers assume whatever envelope U1 confirms. If different endpoints use different envelopes, each mapper reads its own — they do not share an envelope-unwrap helper unless U1 shows the shape is uniform.
- **Dependency:** none external — this PR adds a leaf module. It depends only on the existing `config` shape and `ApiError` from `dashboard-client.ts`.

---

## Verification (whole PR)

- `npm test` (vitest run) is green — the existing 268 tests plus the new `content-client.test.ts` cases. New tests **add** to the count; none of the 268 change.
- `npx tsc --noEmit` is clean.
- `src/andamio/content-client.ts` exports exactly `getCourseModules`, `getModuleSlts`, `getLesson`, `getAssignment`, `getAssignmentCommitments` and their result types; it does **not** export or re-implement gating concepts.
- No secrets in fixtures, tests, or commits.
- No command/loader/deploy wiring changed — `git diff --stat` touches only `src/andamio/content-client.ts`, `src/andamio/content-client.test.ts`, and `src/andamio/__fixtures__/content/*`.

---

## Sources & Research

- **Origin handoff:** `docs/plans/2026-06-28-001-feat-content-progress-opportunities-channel-block-handoff.md` (R1, KTD1/KTD3/KTD5, API capability table, build order).
- **Pattern source:** `src/andamio/dashboard-client.ts` (ApiError taxonomy, `AbortSignal.timeout`, defensive mappers, 206 handling) and `src/andamio/dashboard-client.test.ts` (fetch-mock test style).
- **Config:** `src/config.ts:118-119` (`andamioApiBaseUrl`, `andamioApiKey`).
- **Live confirmation target:** `preprod.api.andamio.io` (U1, per KTD5).
