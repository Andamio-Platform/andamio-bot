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
of paragraphs (enough to exercise the excerpt walker).

**Module visibility is keyed on `slt_hash` presence, not `is_live`.** `is_live` is
deprecated and reads `false` even for published, on-chain modules; the real "show this
module" signal is a non-empty top-level `slt_hash` (the module's SLTs are on-chain).
`mapModules` derives `CourseModule.onChain` from it. `modules.json` is built to pin
**both** halves of that predicate: the real `101` is on-chain (non-empty `slt_hash`)
yet `content.is_live: false` → **included**; the representative `102` has **no**
`slt_hash` and an empty `on_chain_slts` yet `content.is_live: true` → **excluded**
(proving `is_live` is never consulted for visibility). No secrets or member PII appear
in any fixture.

**`commitments.json` is now LIVE-CONFIRMED (mainnet, 2026-06-29).** Captured for
`/progress` (PR 3) from `POST …/assignment-commitments/list` using a real member
JWT (alias `james`, enrolled in the gated Issuer course) plus the operator
`X-API-Key`. **The live shape drifted materially from the source-mapped guess** —
the same lesson as the public endpoints:

| Field | Original source-mapped guess | Live (confirmed) |
|---|---|---|
| envelope | bare array | `{ "data": [ … ] }` (handled by `unwrap`) |
| status | top-level `status` ∈ {DRAFT, SUBMITTED, APPROVED, REFUSED} | **no top-level `status`**; the member-facing status is nested at **`content.commitment_status`** |
| status enum | DRAFT/SUBMITTED/APPROVED/REFUSED | observed: **`ACCEPTED`**, **`CREDENTIAL_CLAIMED`** (others pass through verbatim) |
| keys | `course_id`, `course_module_code` | ✓ same |
| extras | — | `slt_hash`, `on_chain_status` ∈ {completed, pending}, `on_chain_content`, `content.evidence` (Tiptap), `content.assignment_evidence_hash`, `source` ∈ {merged, db_only} |

The old `mapCommitments` read a top-level `status` that does not exist, so every
row would have mapped to `status: ''` — silent breakage the live-confirm caught.
`mapCommitments` now reads `content.commitment_status` (falling back to the entry
for a flatter shape) and ignores `on_chain_status`/`evidence`. The endpoint
returns only modules the member has **engaged**; a module absent from the
response is "not started" (an opportunity), derived by the join, not the mapper.

The committed fixture is **representative and PII-free**: real member evidence
text, hashes, and personal course ids from the capture are replaced with neutral
placeholders / synthetic hex; only the public gated Issuer course id and the
confirmed structure + enum are kept.

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
