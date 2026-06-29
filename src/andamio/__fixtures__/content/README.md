# Content API fixtures

These JSON files are **representative response bodies** for the five `content-client.ts`
endpoints, used to pin the pure mappers in `content-client.test.ts`.

## Shape status: UNCONFIRMED (source-mapped)

The field names and structure here are **source-mapped from the origin handoff**
(`docs/plans/2026-06-28-001-feat-content-progress-opportunities-channel-block-handoff.md`,
"API capability" table), **not** captured from a live API response. A live capture
against `preprod.api.andamio.io` was attempted during the build but the available
operator key returned HTTP 401 on both preprod and production, and no member JWT was
available for the authenticated commitments endpoint.

**Action when a valid preprod operator key (and a test member JWT) become available:**
capture each endpoint's real body, overwrite the matching fixture, and adjust the
mapper only if the real field names differ. Because the mappers are written to be
**total and envelope-agnostic** (they tolerate a `{ "data": ... }` wrapper OR a bare
body, coerce types defensively, and never throw on shape), a drift surfaces as a
fixture+mapper tweak, never a crash — see KTD5/KTD7 in the PR plan.

## Files

| Fixture | Endpoint | Auth |
|---|---|---|
| `modules.json` | `GET /api/v2/course/user/modules/{course_id}` | X-API-Key |
| `slts.json` | `GET /api/v2/course/user/slts/{course_id}/{course_module_code}` | X-API-Key |
| `lesson.json` | `GET /api/v2/course/user/lesson/{course_id}/{course_module_code}/{slt_index}` | X-API-Key |
| `assignment.json` | `GET /api/v2/course/user/assignment/{course_id}/{course_module_code}` | X-API-Key |
| `commitments.json` | `POST /api/v2/course/student/assignment-commitments/list` | X-API-Key + Bearer |

These bodies are written **bare** (no `data` envelope) to document the source-mapped
shape directly. The mapper tests additionally feed an enveloped variant of each to
prove the `data`-unwrap path, so whichever shape the real API uses is covered.
No secrets or real member PII appear in any fixture.
