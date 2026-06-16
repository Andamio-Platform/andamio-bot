---
title: "refactor: read credentials via authenticated api.andamio.io dashboard"
type: refactor
status: completed
date: 2026-06-16
---

# refactor: read credentials via authenticated `api.andamio.io` dashboard

**Target repo:** `andamio-discord-bot-nodejs` (this repo — all paths below are repo-relative).

---

## Summary

Today the bot reads a member's credentials by *alias* from the **public, unauthenticated** andamioscan explorer (`GET /api/v2/users/{alias}/state`). This refactor switches reads to the **authenticated Andamio API** at `api.andamio.io`, using two-layer auth: a single operator `X-API-Key` (a Railway secret) plus the member's own user JWT (`Authorization: Bearer`). The endpoint is `POST /api/v2/user/dashboard`, which returns rich per-user data scoped to the JWT.

The spine is small and lives entirely in this repo: **the bot already receives the member's HS256 user JWT at the `/login` callback and currently discards it.** We stop discarding it, persist it, and use it (with the operator key) to call the dashboard. No app/API-side change is required for the basic read.

Because end-user JWTs expire and **cannot be refreshed unattended** (the only refresh path is developer-scoped and returns the operator's own data), the dashboard is the single read source and we accept staleness: when a member's stored JWT is missing or expired, the bot shows an elegant ephemeral message with a one-click **Connect** button (a freshly minted `/login` link). The background sweep skips members without a valid JWT rather than churning roles.

---

## Problem Frame

- **Current state:** reads are public/by-alias against andamioscan; no API key, no per-user auth. The `refresh_token` column on `links` exists but is always `null`; the callback JWT is explicitly thrown away (`src/web/server.ts`).
- **Goal:** reads go through `api.andamio.io` with an operator API key, positioning the bot to use the authenticated API surface in full. Get the most basic thing working (credential read + gating via the dashboard), then build on it.
- **Constraint (hard):** the end-user HS256 JWT has a finite TTL and no unattended refresh. So unattended reads for absent members are impossible once their JWT expires — the design must degrade gracefully, not break.
- **Out of scope:** new features against the broader dashboard data (projects, teacher, pending reviews); any app/API-repo changes; per-member API keys (one operator key only).

---

## Key Technical Decisions

- **KTD1 — Endpoint + auth.** `POST https://api.andamio.io/api/v2/user/dashboard`, headers `X-API-Key: <operator key>` and `Authorization: Bearer <member HS256 JWT>`. The dashboard is scoped to the Bearer JWT's `accessTokenAlias`, which is exactly the member we want (verified: `andamio-api/internal/middleware/v2_auth_middleware.go` HS256 branch → `c.Locals("alias", claims.AccessTokenAlias)`). The operator key authenticates the bot/tier; the JWT selects the user.
- **KTD2 — Persist the callback JWT (no app change).** The app's `/auth/cli` flow already redirects to the bot callback with `jwt`, `alias`, `user_id` (`cli-auth-flow.tsx`). We persist `jwt` + its decoded `exp` on the `links` row instead of discarding it. This is the entire "make the system work" piece James referenced.
- **KTD3 — Single read source, accept staleness (Option 1).** Retire the andamioscan read. All reads (`/credentials`, gating, sweep) go through the dashboard. A member with a missing/expired JWT is prompted to reconnect via a button; the sweep skips them without changing roles. Auto-revoke for expired-JWT members is deferred (see Deferred).
- **KTD4 — Re-auth as a one-click button.** When a JWT is missing/expired (or a call returns 401 on the user JWT), reply ephemerally with a short message and a **Link-style button** whose URL is a freshly minted single-use login URL (reuse `startLogin`). One click = same as `/login`. No new interaction handler needed (Link buttons carry their URL).
- **KTD5 — New `ApiError` kind `unauthorized` (401), disambiguated from operator failure.** Check the stored `exp` *before* calling: if expired/missing → re-auth button, skip the request. If a call still returns 401 with a not-yet-expired JWT → treat as an **operator/service** problem (the API key is likely misconfigured): log loudly (`console.error`) and show the member a generic "service issue" message, since they can't fix it.
- **KTD6 — Preserve the `UserState` type + evaluator.** Map the dashboard response (`student.credentials_by_course[]`, `student.enrolled_courses[]`, `student.completed_courses[]`) into the existing `UserState` shape so `src/gating/evaluator.ts`, the mappings, and the `/credentials` "earn more" hint are untouched. Only the data-source function and its callers change.
- **KTD7 — Config: replace `SCAN_BASE_URL` with `ANDAMIO_API_BASE_URL` + add `ANDAMIO_API_KEY` (secret).** Breaking env change, intentional: a deploy missing either var crashes on boot with a named error (the repo's fail-fast contract). The API key is a credential — `.env` (gitignored) + Railway service var only; never committed (unlike `role-mappings.json`).

---

## High-Level Technical Design

Token + read sequence (member-present path and expired path):

```mermaid
sequenceDiagram
    participant M as Discord member
    participant B as Bot
    participant App as app.andamio.io (/auth/cli)
    participant API as api.andamio.io (/user/dashboard)

    M->>B: /login
    B->>App: redirect_uri + state
    App-->>B: GET /callback?state&alias&jwt&user_id
    B->>B: persist alias + jwt + exp (links)   %% KTD2

    M->>B: /credentials
    alt stored JWT valid (exp in future)
        B->>API: POST /user/dashboard  X-API-Key + Bearer jwt   %% KTD1
        API-->>B: 200 dashboard (credentials_by_course, ...)
        B->>B: map -> UserState, render embed + gate roles   %% KTD6
        B-->>M: ephemeral embed / roles updated
    else JWT missing or expired
        B->>B: mint single-use login URL (startLogin)
        B-->>M: ephemeral "Connect" message + Link button   %% KTD4
    end

    Note over B: 15-min sweep: for each link, valid JWT -> dashboard + diff;<br/>missing/expired JWT -> skip, no role churn   %% KTD3
```

---

## Implementation Units

### U1. Config — operator API key + API base URL

**Goal:** Introduce `ANDAMIO_API_KEY` (required secret) and `ANDAMIO_API_BASE_URL` (required URL); remove `SCAN_BASE_URL`.
**Requirements:** KTD7.
**Dependencies:** none.
**Files:** `src/config.ts`, `src/config.test.ts`, `.env` (local, gitignored), `.env.example`.
**Approach:** Add `andamioApiKey: string` (non-URL, doc-comment it as a secret) and `andamioApiBaseUrl: string` to the `Config` interface; add both names to `REQUIRED_VARS`; add `ANDAMIO_API_BASE_URL` to `URL_VARS` (run through `stripTrailingSlash`), **not** `ANDAMIO_API_KEY`. Remove `scanBaseUrl` + `SCAN_BASE_URL` from all three lists. Default `ANDAMIO_API_BASE_URL=https://api.andamio.io` in `.env`/`.env.example`; `ANDAMIO_API_KEY` is a placeholder in `.env.example` only.
**Patterns to follow:** mirror `DISCORD_TOKEN` (required non-URL secret) and `APP_LOGIN_BASE_URL` (required URL). The data-driven `requiredVars` loop and URL-rejection tests in `src/config.test.ts` auto-generate coverage when you add the names.
**Test scenarios:**
- Missing `ANDAMIO_API_KEY` → throws naming the var (via `requiredVars` loop).
- Empty `ANDAMIO_API_KEY` → throws.
- `ANDAMIO_API_BASE_URL` non-http scheme → throws (URL-rejection template).
- `ANDAMIO_API_BASE_URL` trailing slash stripped in returned config.
- Valid env → `andamioApiKey` and `andamioApiBaseUrl` present; `scanBaseUrl` gone.
- The key value is not interpolated into any log line (grep guard / review).

### U2. Persist the user JWT at the login callback

**Goal:** Stop discarding the callback `jwt`; store it + its expiry on the member's link, with a non-destructive schema migration.
**Requirements:** KTD2.
**Dependencies:** none (independent of U1).
**Files:** `src/db/index.ts` (schema + migration), `src/db/links.ts` (type + upsert), `src/andamio/login.ts` (`storeLink`), `src/web/server.ts` (`handleCallback`), `src/web/server.test.ts`, `src/db/links.test.ts` (if present).
**Approach:** Add `user_jwt TEXT` and `jwt_expires_at INTEGER` columns to `links`. Existing deployments have a persisted volume, so add an idempotent `ALTER TABLE links ADD COLUMN ...` migration guarded by a column-existence check (`PRAGMA table_info(links)`) — do **not** drop/recreate the table. Update the `Link` interface and `upsertLink` to carry the JWT + expiry. In `handleCallback`, read `query.get('jwt')`, decode its `exp` claim (base64-decode the payload segment; no signature verification needed — the API verifies it), and call `storeLink(db, discordId, alias, jwt, expSeconds)`. Handle a missing/garbage `jwt` defensively (store alias with null JWT → member will be prompted to connect on first read).
**Patterns to follow:** existing `CREATE TABLE IF NOT EXISTS` block and `upsertLink` in `src/db/`. Keep the JWT decode tiny and dependency-free (split on `.`, base64url-decode the middle segment, `JSON.parse`, read `exp`).
**Test scenarios:**
- Valid callback (`state`, `alias`, `jwt`, `user_id`) → link row has `alias`, `user_jwt`, and `jwt_expires_at` = the JWT's `exp`. **Inverts** the existing `server.test.ts` "JWT never persisted" assertion (AE1).
- Migration on a DB that predates the columns → columns added, existing links preserved (no data loss).
- Migration runs twice → idempotent (no error, no duplicate column).
- Callback with malformed/absent `jwt` → alias stored, `user_jwt` null, no throw.
- `exp` decode: a known JWT payload → correct expiry seconds.

### U3. Authenticated dashboard client

**Goal:** New client that calls `POST /api/v2/user/dashboard` with both headers and maps the response into `UserState`; retire the andamioscan client.
**Requirements:** KTD1, KTD5, KTD6.
**Dependencies:** U1 (config fields).
**Files:** create `src/andamio/dashboard-client.ts` + `src/andamio/dashboard-client.test.ts`; remove `src/andamio/scan-client.ts` + `src/andamio/scan-client.test.ts` (move the `UserState`/`CompletedCourse` types into the new client or a shared `types.ts`).
**Approach:** `getUserDashboard(apiBaseUrl: string, apiKey: string, userJwt: string): Promise<UserState>`. POST to `${apiBaseUrl}/api/v2/user/dashboard` with headers `{ 'X-API-Key': apiKey, Authorization: \`Bearer ${userJwt}\`, 'Content-Type': 'application/json', Accept: 'application/json' }` and body `{}`. Define `ApiError` (mirrors the old `ScanError` shape) with `kind: 'unauthorized' | 'not-found' | 'http' | 'network'` + `status?`. Classify: fetch reject → `network`; 401 → `unauthorized`; 404 → `not-found`; other non-2xx (treat 200 and 206 as success) → `http`. Map `body.data.student`: `credentials_by_course[] → completedCourses[]` (`course_id → courseId`, `credentials → claimedCredentials`), `enrolled_courses[].course_id → enrolledCourses`, plus completed course ids; tolerate missing/extra fields (reuse the defensive `toStringArray`-style helpers).
**Patterns to follow:** the structure of the removed `scan-client.ts` (typed error, defensive mapping, `encodeURIComponent` not needed here since no path param). The vitest `fetch`-mock pattern in the old `scan-client.test.ts` (`vi.spyOn(globalThis,'fetch')`, `jsonResponse` helper).
**Test scenarios:**
- 200 with `student.credentials_by_course` → `UserState` with correct `completedCourses[].claimedCredentials` (slt_hashes).
- 200 enrolled/completed courses → correct `enrolledCourses` / `completedCourses` ids.
- 206 partial content → still parsed as success (not an error).
- Both headers present and correct: asserts `X-API-Key` carries the key **and** `Authorization: Bearer <jwt>` is sent (this is the **inverse** of the old "no auth header" invariant test).
- 401 → `ApiError` kind `unauthorized`, status 401.
- 404 → `not-found`. Non-2xx (500) → `http`. fetch reject → `network`.
- Empty/garbage body → tolerated (empty `UserState`).

### U4. Re-auth affordance (Connect button helper)

**Goal:** A reusable helper that builds the elegant "connect / reconnect" ephemeral reply with a one-click Link button to a fresh login URL.
**Requirements:** KTD4.
**Dependencies:** none (uses existing `startLogin`).
**Files:** create `src/discord/relogin-prompt.ts` + `src/discord/relogin-prompt.test.ts`.
**Approach:** Export a function that, given the db + discordId + config, calls `startLogin(...)` to mint a single-use URL, then returns the reply payload: a short message ("Connect your Andamio account to see your credentials" / "Your session expired, reconnect:") plus an `ActionRowBuilder` with a `ButtonBuilder` of `ButtonStyle.Link` and `.setURL(loginUrl)`. Caller sends it ephemerally. Provide two copy variants (first-connect vs expired) via a param.
**Patterns to follow:** `src/commands/login.ts` for `startLogin` usage and ephemeral reply shape; discord.js `ActionRowBuilder`/`ButtonBuilder`.
**Test scenarios:**
- Returns a payload containing a Link button whose URL is the `startLogin` URL (contains `/auth/cli`, `state=`, `redirect_uri=`).
- "expired" variant vs "first-connect" variant produce the intended copy.
- A pending login row is created (state recorded) so the minted link is valid.

### U5. `/credentials` on the dashboard

**Goal:** `/credentials` reads via the dashboard using the stored JWT; missing/expired/401-user → Connect button; operator failure → generic + loud log. Reword user copy off "andamioscan".
**Requirements:** KTD3, KTD4, KTD5, KTD6.
**Dependencies:** U1, U2, U3, U4.
**Files:** `src/commands/credentials.ts`, `src/commands/credentials.test.ts`.
**Approach:** Load link. If no link → existing "run /login" path (or the U4 first-connect prompt). If link has no `user_jwt` or `jwt_expires_at` is in the past → reply with the U4 **expired** prompt (skip the call). Else `getUserDashboard(config.andamioApiBaseUrl, config.andamioApiKey, link.user_jwt)`. On `ApiError`: `not-found` → tailored "no Andamio state" message; `unauthorized` → if our stored exp was already past treat as expired (U4 prompt), otherwise log loudly + generic "service issue, try later" (operator key suspect, KTD5); `network`/`http` → generic "couldn't reach Andamio" (reworded). On success → existing embed + "earn more" rendering (unchanged, operates on `UserState`).
**Patterns to follow:** existing `credentials.ts` catch-block structure (`credentials.ts:116-125`); the `vi.mock` integration-test pattern in `credentials.test.ts` (add `andamioApiKey`/`andamioApiBaseUrl` to the mocked config; mock `getUserDashboard`).
**Test scenarios:**
- Valid JWT + holds credential → embed renders completed/enrolled; gated credential present.
- Valid JWT + missing gated credential → embed shows "earn more" with the earn link.
- No stored JWT → Connect (first-connect) button, no API call made.
- Expired stored JWT (exp past) → Connect (expired) button, no API call made.
- `unauthorized` with a not-yet-expired JWT → generic service message **and** a `console.error` logged (operator-key path).
- `not-found` → tailored "no Andamio state" copy.
- `network` → reworded generic "couldn't reach Andamio" (no "andamioscan").

### U6. Gating on the dashboard (on-demand + sweep)

**Goal:** Role gating reads via the dashboard. On-demand (`/refresh`) prompts reconnect when needed; the unattended sweep skips members without a valid JWT (no role churn).
**Requirements:** KTD3, KTD5, KTD6.
**Dependencies:** U1, U2, U3, U4.
**Files:** `src/gating/triggers.ts`, `src/gating/triggers.test.ts`, `src/commands/refresh.ts`, `src/commands/refresh.test.ts`. (`src/gating/evaluator.ts` unchanged — operates on `UserState`.)
**Approach:** In `reevaluateMember`, replace `getUserState(scanBaseUrl, alias)` with: read the link; if no link → existing unconnected diff (strip managed roles); if link has no/expired JWT → **for the sweep path: return without changing roles** (skip, `console.log` at debug level); **for the on-demand `/refresh` path: surface the U4 expired prompt**. Distinguish the two paths via a parameter or two entry points (e.g. `reevaluateMember(discordId, { interactive })`). When JWT valid → `getUserDashboard(...)` → `evaluate(...)` → `applyDiff`. On `ApiError`: `unauthorized` with past exp → treat as expired (skip/prompt); other 401 → `console.error` (operator) + don't churn; `network`/`http` → existing "don't churn on flaky read" branch. `reevaluateAll` (the sweep) iterates links and calls the non-interactive path.
**Patterns to follow:** existing `triggers.ts:95-133` structure (the `not-found` → strip-roles and the "don't churn on flaky read" branches map cleanly onto the new error kinds); `refresh.ts` deferReply + editReply.
**Test scenarios:**
- Sweep, member with valid JWT holding the credential → role added (diff applied).
- Sweep, member with expired/missing JWT → **roles unchanged**, no API call, no throw (the core Option-1 staleness behavior).
- Sweep, member with valid JWT no longer holding the credential → managed role removed.
- Sweep, `unauthorized` (fresh JWT, operator-key fault) → roles unchanged + `console.error`.
- `/refresh` with expired JWT → Connect (expired) button reply, no role change.
- `/refresh` with valid JWT → roles reconciled, success copy.
- Unconnected member (no link) in sweep → managed roles stripped (unchanged behavior).

### U7. Docs + config surface cleanup

**Goal:** Documentation reflects the authenticated dashboard model and the new env contract; the Railway runbook (in the orch session note) is updated.
**Requirements:** KTD3, KTD7.
**Dependencies:** U1-U6 (document the shipped shape).
**Files:** `README.md`, `.env.example`, `.windsurfrules`. (Orch session note runbook updated separately — see Operational Notes.)
**Approach:** README: rewrite the "how reads work" bullets (authenticated operator-key + per-user JWT dashboard read, not public andamioscan); env table — remove `SCAN_BASE_URL`, add `ANDAMIO_API_BASE_URL` (required, URL) and `ANDAMIO_API_KEY` (required, **secret** — never commit, Railway service var). Rewrite the callout that warned "don't use api.andamio.io" (now inverted). `.env.example`: same. `.windsurfrules`: correct the stale `app.andamio.com/api` line. Add a short note that the SQLite volume now holds user JWTs (sensitive — volume + gitignore already cover it).
**Patterns to follow:** the existing README env table + callout structure.
**Test expectation: none** — docs only.

---

## Risks & Mitigations

- **End-user JWT TTL unknown.** If the HS256 token is short-lived (e.g. 60 min), members will hit the Connect button often and the sweep will skip them quickly, weakening auto-gating. **Mitigation / open question:** confirm the DB-API end-user JWT lifetime during implementation; if too short for a good demo, raise an API-side follow-up (longer-lived end-user token, or an end-user refresh path). Tracked in Open Questions.
- **401 ambiguity (operator key vs user JWT).** A bad operator key and an expired user JWT both surface as 401. **Mitigation:** check stored `exp` before calling (KTD5) so expired-JWT is handled without a request; a 401 on a fresh JWT is then attributable to the operator key and logged loudly.
- **Storing JWTs in SQLite.** User JWTs are now persisted (sensitive). **Mitigation:** already covered by the gitignored `.env` + the persisted volume; document it (U7). JWTs are bearer credentials but short-lived and user-scoped.
- **Breaking env change.** Removing `SCAN_BASE_URL` and adding two required vars means a Railway deploy without them crashes on boot. **Mitigation:** intentional (fail-fast contract); call it out in the runbook so the operator sets `ANDAMIO_API_KEY` + `ANDAMIO_API_BASE_URL` before redeploy.
- **Dashboard `206` partial content.** One data source upstream may be degraded. **Mitigation:** treat 206 as success and map whatever data is present (U3).

---

## Scope Boundaries

### In scope
- Operator API key as a Railway secret consumed by the bot (U1).
- Persisting the member JWT and reading the dashboard with both headers (U2, U3).
- Migrating `/credentials` and gating to the dashboard; Connect-button re-auth; sweep staleness handling (U4-U6).
- Docs + env contract (U7).

### Deferred to Follow-Up Work
- **Auto-revoke for expired-JWT members** (proactive DM with a reconnect prompt, or a short grace period before stripping roles).
- **Using the richer dashboard data** — projects (`contributing`/`managing`), teacher (`pending_reviews`), `pending_assessments`, course titles/images — to build new bot surfaces. The dashboard already returns it; nothing consumes it yet.
- **API-side end-user token refresh / longer TTL**, if the TTL proves too short (depends on the Open Question).

### Out of scope
- Per-member API keys (one operator key only).
- Any change to `andamio-app-v2` or `andamio-api` (the basic read needs none).
- The Barça/BarçaID auth track (separate, parked).

---

## Open Questions

- **End-user HS256 JWT lifetime?** Not pinned in source ("set by DB API"). Verify at implementation; if short, weigh an API-side follow-up (Deferred). Does not block the build — the Connect-button affordance handles expiry regardless of TTL.

---

## Operational / Rollout Notes

- **Railway:** before redeploying, set `ANDAMIO_API_KEY` (the mainnet `ant_mn_…` operator key, as a **secret** service variable) and `ANDAMIO_API_BASE_URL=https://api.andamio.io`; remove `SCAN_BASE_URL`. A missing var crashes on boot by design.
- **Orch session note:** update the Railway runbook + verified-config table in `Andamio Discord Bot — Network Discord demo.md` (orch vault) to the new env contract once this lands.
- **Migration:** the `links` ALTER is additive and idempotent; the existing persisted volume keeps current `discord_id↔alias` links. Members will be prompted to Connect once (to capture a JWT) since pre-migration rows have no `user_jwt`.

---

## Sources & Research

- Auth contract + dashboard shape: `andamio-api/internal/middleware/v2_auth_middleware.go` (HS256 end-user branch sets alias from `accessTokenAlias`; RS256 dev branch sets operator alias), `andamio-api/internal/handlers/v2/merged_handlers/merged_handlers.go` (`GetUserDashboard` reads `c.Locals("alias")`).
- Callback already carries the JWT: `andamio-app-v2/src/components/auth/cli-auth-flow.tsx` (redirects with `jwt`, `alias`, `user_id`).
- Bot discards it today: `src/web/server.ts` (`handleCallback`, "intentionally not persisted"); `src/db/index.ts` schema; `src/gating/triggers.ts` (alias-only reads); `src/commands/refresh.ts` (re-evaluates roles, no token refresh).
- No unattended end-user refresh: refresh endpoint is developer-scoped (`andamio-api .../gateway_handlers.go DeveloperRefreshToken`), returns operator-aliased data.
