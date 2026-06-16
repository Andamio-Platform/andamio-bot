---
title: Reading Andamio credentials — andamioscan vs the authenticated dashboard
date: 2026-06-16
category: architecture-patterns
module: andamio
problem_type: architecture_pattern
component: authentication
severity: high
applies_when:
  - Reading a user's on-chain credentials/courses from Andamio
  - Choosing between a public andamioscan read and an authenticated api.andamio.io call
  - Building or changing credential-gated role assignment
  - Capturing or refreshing a user JWT obtained via the hosted CLI login
tags: [andamio, authentication, jwt, credentials, gating, api]
---

# Reading Andamio credentials — andamioscan vs the authenticated dashboard

## Context

The bot's `/credentials` failed in production with "Could not reach andamioscan." The first diagnosis was a wrong host (it pointed at `api.andamio.io`, which 401s). That was a real fix but a stopgap; the durable decision was to authenticate to the full Andamio API with an operator API key so the bot can use the API in its entirety. Getting that right required understanding two things that are easy to conflate: **which host serves which kind of read**, and **how an arbitrary user's credentials are authorized**.

## Guidance

### Two different hosts, two different read models

- **`andamioscan.io` (mainnet) / `preprod.andamioscan.io`** — the public block-explorer indexer. `GET /api/v2/users/{alias}/state` is **public, unauthenticated, by-alias**. Returns `{ alias, enrolled_courses, completed_courses[].claimed_credentials, ... }`. No API key. This is the only by-alias credential read that exists.
- **`api.andamio.io` (mainnet) / `preprod.api.andamio.io`** — the authenticated API gateway. **Every `/api/v2/*` path 401s without auth** (the gateway runs auth middleware before routing, so an unknown `/api/v2/...` path also returns 401, not 404 — a 401 is not proof the route exists). Do **not** point a public by-alias read at this host.

### Reading an arbitrary user's credentials *with* auth: the dashboard, two-header model

`POST https://api.andamio.io/api/v2/user/dashboard` with **two** headers:

- `X-API-Key: <operator key>` — authenticates the **bot/operator** (one mainnet `ant_mn_…` key per deployment; it is a secret).
- `Authorization: Bearer <user JWT>` — selects **whose** dashboard to read.

The dashboard is scoped to the **Bearer JWT's user** (its `accessTokenAlias` claim), not the API key owner. This is why one operator key serves every member and there is no by-alias parameter to abuse.

**There is no authenticated by-alias credential endpoint.** `POST /api/v2/course/student/credentials/list` is identity-scoped to the auth context (`c.Locals("alias")` = the key owner's alias, or the Bearer JWT's user) — it cannot take an arbitrary target alias. So an integration that needs "credentials for user X" must either (a) read andamioscan's public by-alias `/state`, or (b) hold X's own user JWT and call the dashboard.

### The user JWT comes from the hosted login — capture it

The app's CLI device flow (`/auth/cli`) redirects to the caller's callback with `?jwt=&alias=&user_id=`. That `jwt` is an **HS256 end-user JWT** the dashboard accepts as the Bearer. Capture and persist it; don't discard it as "proof only."

### End-user JWTs expire and cannot be refreshed unattended

The HS256 end-user token has a finite TTL and **no refresh path** — the only refresh endpoint is the **developer** RS256 flow (`/auth/dev-cli` → `/api/v2/auth/developer/token/refresh`), and a developer JWT scopes the dashboard to the *operator's* alias, not the member's. So a member's data can only be read while their captured JWT is valid; when it lapses they must re-authenticate (interactive). Design any unattended/background reader to **degrade gracefully** when a user's JWT is missing or expired, not to assume it can always refresh.

### Credential gating must never churn roles on a degraded read

When this dashboard read drives role add/remove, **only an authoritative, complete success (HTTP 200 with a present `student` block) may remove roles.** A 206 (partial content — one upstream degraded), a 404, a 401, a network/timeout error, **or a 200 whose `student` block is missing/malformed** must leave roles unchanged. An empty-but-present `student` block is a legitimate "no credentials" member and still gates correctly. Stripping roles on a degraded read de-gates the whole community on a transient blip.

## Why This Matters

- The 401-on-`api.andamio.io` confusion cost a debugging cycle; knowing the host split makes credential reads a config decision, not a mystery.
- The two-header model is non-obvious: the API key alone returns the *operator's* data, not a member's. Missing the Bearer-scopes-the-user fact leads to building a non-existent by-alias endpoint.
- The "no unattended refresh" fact is the single biggest constraint on any background credential job — it shaped the whole gating sweep design.
- The role-churn-on-degraded-read bug was a P0: a partial/empty response silently stripped every member's gated roles. The safety rule (remove only on authoritative complete 200) is the durable guardrail.

## When to Apply

- Any new Andamio integration that reads a user's credentials, courses, or projects.
- Deciding whether a read needs auth at all (public by-alias scan vs authenticated dashboard).
- Any system that grants/revokes access based on Andamio credentials (Discord roles, app entitlements).

## Examples

Authenticated dashboard read (request shape):

```
POST https://api.andamio.io/api/v2/user/dashboard
X-API-Key: ant_mn_…            # operator secret
Authorization: Bearer <user-jwt>   # selects the user; from /auth/cli callback
Content-Type: application/json
{}
```

Gating safety — surface degraded reads instead of trusting them:

```text
read result        → gating action
200 + student      → evaluate + apply (may remove roles)   ← only authoritative path
206 (partial)      → skip, no churn
200 + no/bad student → treat as partial, skip, no churn
404 / 401 / network → skip, no churn (401 ⇒ log: check operator key)
JWT missing/expired → skip unattended; prompt reconnect interactively
```

## Related

- PR Andamio-Platform/andamio-discord-bot-nodejs#5 (the dashboard-auth refactor)
- `docs/plans/2026-06-16-001-refactor-credentials-via-dashboard-api-plan.md`
- Source of truth for the auth model: `andamio-api/internal/middleware/v2_auth_middleware.go` (HS256 → `accessTokenAlias`; RS256 → operator alias) and `internal/handlers/v2/merged_handlers/merged_handlers.go` (`GetUserDashboard`).
