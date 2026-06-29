# Content API fixtures

These JSON files are **representative response bodies** for the five `content-client.ts`
endpoints, used to pin the pure mappers in `content-client.test.ts` and the `/preview`
render/selection tests in `src/commands/preview.test.ts`.

## Shape status: LIVE-CONFIRMED (mainnet, 2026-06-29)

The four public fixtures (`modules`, `slts`, `lesson`, `assignment`) were captured
from the **live mainnet API** (`https://api.andamio.io`) using the bot's operator
`X-API-Key`, against the server's gated course
`ae192632aabe00ed2042eaef596bc15f3887fa32e75e8f9b8fa516df`, module `101`. The
original `preprod` validation target in the #21 handoff was wrong — the bot runs on
mainnet — which is what caused the earlier 401s.

**The live shapes differ materially from the original source-mapped guess.** The
fixtures and mappers were reconciled to the confirmed shapes:

| Endpoint | Original source-mapped guess | Live (confirmed) |
|---|---|---|
| modules | bare array; flat `title, description, image_url, is_live, course_module_code` | `{ "data": [ … ] }`; displayable fields nested under a per-entry `content` object; **no image url**; entries also carry `slt_hash, course_id, created_by, on_chain_slts, source` |
| slts | bare array of `{ slt_text, slt_index, has_lesson }` | `{ "data": { …, "slts": [ … ] } }`; each SLT additionally embeds a `lesson` object (ignored by `mapSlts`) |
| lesson | `{ title, description, image_url, video_url, content_json }` | `{ "data": { …, "content": { "title", "content_json" } } }` — **only title + content_json** |
| assignment | same as lesson | `{ "data": { …, "content": { "title", "content_json" } } }` — **only title + content_json** |

Because the mappers are **total and envelope-agnostic** (they tolerate a
`{ "data": … }` wrapper, dig through the nesting, coerce types defensively, and never
throw on shape), the drift surfaced as a fixture + mapper reconciliation, not a crash.

The fixtures are trimmed for size: `content_json` documents are shortened to a couple
of paragraphs (enough to exercise the excerpt walker), and `modules.json` adds one
representative `is_live: true` module (`102`) alongside the real `101` (`is_live:
false`) so the live-filter logic has both cases to test against. No secrets or member
PII appear in any fixture.

`commitments.json` remains **source-mapped, not yet live-confirmed** — its endpoint
(`POST …/assignment-commitments/list`) is authenticated and requires a member JWT,
which `/preview` does not use. Confirm it when `/progress` (PR 3) is built.

## Files

| Fixture | Endpoint | Auth |
|---|---|---|
| `modules.json` | `GET /api/v2/course/user/modules/{course_id}` | X-API-Key |
| `slts.json` | `GET /api/v2/course/user/slts/{course_id}/{course_module_code}` | X-API-Key |
| `lesson.json` | `GET /api/v2/course/user/lesson/{course_id}/{course_module_code}/{slt_index}` | X-API-Key |
| `assignment.json` | `GET /api/v2/course/user/assignment/{course_id}/{course_module_code}` | X-API-Key |
| `commitments.json` | `POST /api/v2/course/student/assignment-commitments/list` | X-API-Key + Bearer |

The public fixtures are written **enveloped** (`{ "data": … }`) to match the live
responses. The mapper tests additionally feed a bare (un-enveloped) variant of each
to prove the unwrap path stays tolerant of either.
