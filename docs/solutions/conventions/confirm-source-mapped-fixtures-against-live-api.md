---
title: "Confirm source-mapped fixtures against the live service before building on them"
date: 2026-06-29
category: conventions
module: src/andamio, src/andamio/__fixtures__
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - "Building a feature on fixtures/types that were inferred from a handoff, spec, or source-reading rather than captured from the real service"
  - "A prior build shipped 'total/envelope-agnostic' mappers as a hedge against unconfirmed shapes"
  - "A handoff explicitly flags a 'confirm against live' step before implementation"
related_components:
  - tooling
  - documentation
tags:
  - fixtures
  - api-contract
  - mappers
  - live-confirmation
  - test-data
  - handoff
---

# Confirm source-mapped fixtures against the live service before building on them

## Context

The shared `content-client.ts` layer (PR #21) shipped fixtures and mappers whose field names were **source-mapped** — inferred from a handoff capability table, not captured from a live API response. The fixtures' README said as much ("Shape status: UNCONFIRMED"), and #21's own live-capture attempt had 401'd, so the shapes were never verified. The mappers were deliberately written *total and envelope-agnostic* (tolerate a `{ data: … }` wrapper or a bare body, coerce defensively, never throw) precisely as a hedge.

When `/preview` (PR #24) came to render against those shapes, the handoff made Step 0 non-negotiable: capture real responses from the live **mainnet** API first, diff against the fixtures, and reconcile any drift — *before* writing command code. Doing so revealed the shapes had drifted **materially** from the source-mapped guess. Building straight on the fixtures would have rendered against field names that do not exist.

The drift, per endpoint:

| Endpoint | Source-mapped guess | Live (confirmed) |
|---|---|---|
| modules | bare array; flat `title, description, image_url, is_live, course_module_code` | `{data:[…]}`; display fields nested under a per-entry `content` object; **no `image_url`** |
| slts | bare array of `{slt_text, slt_index, has_lesson}` | `{data:{…, slts:[…]}}`; each SLT also embeds a `lesson` object |
| lesson / assignment | `{title, description, image_url, video_url, content_json}` | `{data:{… content:{title, content_json}}}` — **only `title` + `content_json`** |

## Guidance

When a build depends on fixtures/types that were inferred rather than captured, treat **live confirmation as the first implementation unit**, gating everything downstream:

1. **Capture real responses** from the actual service the code will call — the right environment and the right credentials. Write a throwaway script that reads the key from the project's own config so the secret never lands in a transcript; print only status codes and bodies. (For this repo: mainnet `https://api.andamio.io`, operator key from the **main repo** `.env`, not a worktree copy — see [[operator-api-key-location]].)
2. **Diff each captured body against its fixture**, field by field, for every field the mappers actually read — name, type, and the envelope/nesting shape.
3. **Reconcile drift in the fixture *and* the mapper *and* its tests**, pinning the captured response as the new fixture. Update the README to record the live-confirm (date + environment), superseding the "unconfirmed" note.
4. **Only then build** the feature on the confirmed shapes.
5. **Surface material drift as its own concern** — a distinct commit and a callout in the PR body — rather than folding it silently into the feature commit. Reviewers and future readers need to see that the contract moved.

The total/defensive mapper is a safety net against a *future* silent drift (it degrades to empty content, not a crash); it is **not** a substitute for confirming the shape you build against today. A defensive mapper reading the wrong nesting still returns empty for every field — green types, blank output.

## Why This Matters

- **Guessed field names fail silently, not loudly.** A total mapper reading `prop(entry, 'image_url')` when the live shape nests everything under `content` returns `''` for every module — no exception, no test failure (the tests pin the *guessed* fixture), just blank embeds in production.
- **The cost asymmetry is steep.** The live capture + reconcile took one focused pass. Shipping against guessed names would have surfaced as a user-facing "nothing renders" bug with no error to grep for, diagnosed long after the context was cold.
- **Drift is the norm for source-mapped data, not the exception.** All three endpoint families here had drifted — envelope, nesting, and dropped fields. An inferred shape that happens to match live is luck, not the base rate.
- **Reconciliation has downstream reach.** Confirming the lesson/assignment shape exposed only `title` + `content_json` (no description/image/video), which corrected the *feature's* rendering plan — the embed shows title + a Tiptap excerpt, not the image/video the handoff originally imagined. Confirming the contract shapes the feature, not just the fixture.

## When to Apply

- The fixtures or types carry an explicit "unconfirmed / source-mapped / TODO: verify against live" marker.
- A handoff or plan names a "confirm against live" / "validate fixtures" step — treat it as load-bearing, not ceremony.
- The mappers were written unusually defensively (envelope-agnostic, total, "absorbs drift") — that hedge is a tell that the author knew the shape was unverified.
- A previous attempt to capture live data failed (e.g., a 401), leaving the shapes inferred by default.

Skip only when the fixtures were genuinely captured from the same service+environment the code calls (and the README/commit says so).

## Examples

**The Step-0 reconciliation, made durable.** The reconciliation landed as its own commit *before* any command code, and the fixtures README was flipped from UNCONFIRMED to live-confirmed with the drift recorded as a table (so the next reader sees both the old guess and the confirmed shape). The mapper change was minimal because the helpers were already total — drift was absorbed by adjusting which key each mapper digs through, not by restructuring:

```ts
// before (source-mapped guess): read flat, top-level fields
const moduleCode = asString(prop(entry, 'course_module_code'));
return { title: asString(prop(entry, 'title')), imageUrl: asString(prop(entry, 'image_url')), /* … */ };

// after (live-confirmed): fields nest under `content`; no image url exists.
// Fall back to the entry itself so a flatter future shape still maps.
const content = prop(entry, 'content') ?? entry;
const moduleCode = asString(prop(content, 'course_module_code'));
return { title: asString(prop(content, 'title')), /* imageUrl dropped from the type */ };
```

```ts
// slts: the array is nested under `data.slts` (object), not a bare array.
// Tolerate both so the mapper stays total.
const inner = unwrap(raw);
const list = Array.isArray(inner) ? inner : asArray(prop(inner, 'slts'));
```

**The anti-pattern this prevents:** skipping straight to the command, trusting the defensive mapper to "absorb" whatever comes back. It does absorb it — into empty strings. The command type-checks, the unit tests (pinned to the guessed fixture) pass, and the feature renders nothing live, with no error to trace.

Related: [[discord-autocomplete-dispatch-pattern]] (the `/preview` build that triggered this confirmation), and the auto-memory note [[operator-api-key-location]] on where the working operator key lives.
