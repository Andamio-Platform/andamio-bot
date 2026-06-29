---
type: plan
status: completed
created: 2026-06-29
origin: docs/plans/2026-06-29-005-fix-preview-onchain-module-predicate-handoff.md
target_repo: andamio-bot
---

# fix: `/preview` lists modules by on-chain `slt_hash`, not deprecated `is_live`

**Target repo:** andamio-bot · **Stack:** TypeScript, discord.js, vitest · **Branch:** `fix/preview-onchain-modules`

## Summary

`/preview` shows an empty module list for live, on-chain courses. The command derives "show this module" from `CourseModule.isLive`, which `mapModules` reads from `content.is_live` — but `is_live` is **deprecated** (product decision, James 2026-06-29) and reads `false` even for published, on-chain modules. The real published signal is a **non-empty top-level `slt_hash`** on the module entry (sibling of `content`), meaning the module's SLTs are on-chain.

This fix swaps the predicate: `content-client.ts` exposes `CourseModule.onChain` (derived from the top-level `slt_hash`) and drops `isLive`; `preview.ts` filters and renders on `onChain` with "modules" copy instead of "live modules". The shared client change also lands the predicate that `/progress` (PR 3) will inherit.

## Problem Frame

The live module 101 response (the captured fixture payload) is on-chain — non-empty `slt_hash`, three `on_chain_slts` — yet `content.is_live` is `false`. The current mapper reads `is_live` and the command filters on it, so 101 is silently dropped and the embed renders empty. The bug is a **wrong-field predicate**, not a flow defect: the envelope handling and command wiring from #24 are correct.

Shape (live-confirmed against `api.andamio.io`, 2026-06-29): `slt_hash`, `course_id`, `created_by`, `on_chain_slts`, `source` are **top-level on the entry** (siblings of `content`); only `course_module_code`/`title`/`description`/`is_live` are nested under `content`. The current `mapModules` reads everything from `content` — it never reaches the top-level `slt_hash`.

---

## Requirements

Traced from the origin handoff (R1–R5):

- **R1 — On-chain predicate replaces `is_live` in the client.** `mapModules` reads `slt_hash` from the **entry top level** (not from `content`). `CourseModule.onChain: boolean` = `slt_hash` is a non-empty string. Remove `isLive` from `CourseModule`.
- **R2 — `preview.ts` filters on `onChain`.** Replace every `m.isLive` filter (`moduleChoices` autocomplete + `execute`'s `liveModules`) with `m.onChain`. Rename `liveModules` → `onChainModules`. Update user-facing copy: "live modules" → "modules".
- **R3 — Fixture reflects the real shape.** The modules fixture already carries the captured top-level `slt_hash` + `on_chain_slts` + `content.is_live:false` + `source:"merged"` shape (verified present). Repurpose the second entry (102) so it has **no `slt_hash`** — making it the on-chain-excluded contrast case.
- **R4 — Tests assert the predicate.** A module with a non-empty `slt_hash` is included even though `content.is_live` is `false`; a module with missing/empty `slt_hash` is excluded. Update existing `/preview` + `mapModules` tests that asserted on `is_live`. Suite green; `tsc` + lint + CodeQL clean.
- **R5 — Compound doc → #23.** If a learnings note emerges (Andamio module published-state is `slt_hash` presence, not `is_live`), commit it onto the `docs/compound-autocomplete-pattern` branch (PR #23), **not** this fix branch.

---

## Key Technical Decisions

- **KTD1 — `slt_hash` presence = published/on-chain = show.** The product-truth predicate. `is_live` is deprecated; do not read it for visibility. `on_chain_slts` non-empty corroborates, but `slt_hash` is the canonical check.
- **KTD2 — Top-level vs `content` nesting.** `slt_hash` is a sibling of `content`. The existing mapper computes `const content = prop(entry, 'content') ?? entry;` and reads displayable fields from `content`. The new read takes `slt_hash` from `entry` directly (with the same `?? entry` fallback already covering the flatter shape, since when there's no nested `content`, `content === entry` and the top-level read still works). Keep both levels straight: title/description from `content`, `slt_hash` from `entry`.
- **KTD3 — Drop `isLive` entirely, don't keep it dormant.** No other consumer references `isLive` (grep-confirmed: only `content-client.ts`, `preview.ts`, and their tests). Removing the field — rather than leaving it deriving from the deprecated source — prevents future code from re-adopting the wrong predicate. This is a clean break, not a deprecation.
- **KTD4 — Don't surface `sltHash`/`onChainSlts` unless needed.** The origin marks these optional. The render path needs only the boolean `onChain`; adding unused fields is scope creep. Expose `onChain` only. (If a later unit genuinely needs the SLT text for rendering, add it then.)
- **KTD5 — Repurpose fixture entry 102 as the excluded case.** Entry 102 currently has a `slt_hash` and `is_live:true` ("included so tests exercise the is_live filter"). Under the new predicate that comment is obsolete and both entries would be shown, leaving no excluded case for R4. Remove 102's `slt_hash` (and update its description) so the fixture pins both halves of the predicate: 101 = on-chain despite `is_live:false` (included); 102 = not on-chain (excluded).
- **KTD6 — Preserve the `{data:…}` envelope handling** from #24. This is an additive top-level field read on the already-confirmed envelope; `unwrap`/`asArray`/`prop` are untouched.

---

## Implementation Units

### U1. Client: `onChain` from top-level `slt_hash`, drop `isLive`

**Goal:** `mapModules` derives `CourseModule.onChain` from the entry-level `slt_hash`; `isLive` removed from the interface and mapper.
**Requirements:** R1 (also unblocks KTD3 propagation to PR 3).
**Dependencies:** none.
**Files:**
- `src/andamio/content-client.ts` (modify)
- `src/andamio/content-client.test.ts` (modify — see U3)

**Approach:**
- In `interface CourseModule`, replace `isLive: boolean;` with `onChain: boolean;`.
- In `mapModules`, keep `const content = prop(entry, 'content') ?? entry;` for title/description/code. Read the on-chain signal from the **entry**: `onChain: asString(prop(entry, 'slt_hash')) !== ''`. Use `asString(...) !== ''` (not a truthiness check) so non-string junk coerces to `''` → `false`, consistent with the module's existing total-mapping discipline.
- Drop the `isLive: asBool(prop(content, 'is_live')),` line.
- Update the doc comment on `CourseModule` (line ~43) and the `getCourseModules` comment (line ~316: "caller filters on `isLive`" → "caller filters on `onChain`").

**Patterns to follow:** the existing `asString(...) !== ''` guard used for `moduleCode` two lines up; the total/never-throw mapper convention documented in the file header.

**Test scenarios:** covered in U3 (mapper tests live in `content-client.test.ts`).
**Verification:** `mapModules(modulesFixture)` returns entries carrying `onChain` (true for 101, false for 102) and no `isLive` key; `tsc` reports no references to the removed `isLive` field.

### U2. Command: filter + copy on `onChain`

**Goal:** `preview.ts` lists/previews modules by `onChain`; user-facing copy says "modules", not "live modules".
**Requirements:** R2.
**Dependencies:** U1 (needs `CourseModule.onChain`).
**Files:**
- `src/commands/preview.ts` (modify)
- `src/commands/preview.test.ts` (modify — see U3)

**Approach:**
- `moduleChoices` (line ~241): `.filter((m) => m.isLive)` → `.filter((m) => m.onChain)`.
- `execute` (line ~349): `const liveModules = modules.filter((m) => m.isLive);` → `const onChainModules = modules.filter((m) => m.onChain);`. Rename every downstream reference (`liveModules.length`, `renderModuleListEmbed(courseLabel, liveModules)`, `liveModules.find(...)`).
- `renderModuleListEmbed` (line ~130): rename the `liveModules` parameter to `onChainModules`; update the embed copy — description "Live modules in this course…" → "Modules in this course…"; empty-state "No live modules to preview…" → "No modules to preview…".
- Update prose/comments referencing "live modules": file header (line ~29, ~36), `moduleChoices` doc (line ~232 "live-module choices…live modules only"), autocomplete doc (line ~284 "lists its live modules"), the `SlashCommandBuilder` description (line ~262 "Preview a course's live modules…" → "Preview a course's modules…"), and the inline comment at line ~364 ("the module must be live to preview" → "the module must be on-chain to preview").

**Patterns to follow:** existing naming/JSDoc style in the file; keep the rename mechanical and total.
**Test scenarios:** covered in U3.
**Verification:** `/preview` for the Issuer course lists module 101; copy reads "Modules"/"No modules"; no `isLive`/"live modules" string survives a grep of `src/`.

### U3. Fixture + tests pin the on-chain predicate

**Goal:** the modules fixture provides one included and one excluded case; all `is_live`-based assertions become `onChain`-based.
**Requirements:** R3, R4.
**Dependencies:** U1, U2.
**Files:**
- `src/andamio/__fixtures__/content/modules.json` (modify)
- `src/andamio/__fixtures__/content/README.md` (modify — keep the fixture description honest)
- `src/andamio/content-client.test.ts` (modify)
- `src/commands/preview.test.ts` (modify)

**Approach — fixture:**
- Entry 101: already correct (top-level `slt_hash`, `on_chain_slts`, `content.is_live:false`, `source:"merged"`). Leave as-is — it is the **included-despite-`is_live:false`** case.
- Entry 102: **remove the `slt_hash` field** (and its `on_chain_slts` → set to `[]` or drop, to stay internally consistent with "not on-chain"). Update `content.description` away from "exercise the is_live filter" to reflect its new role (e.g. "A module with no on-chain SLTs, excluded by the onChain filter."). Keep `content.is_live:true` so the test proves `is_live` is *not* consulted (an `is_live:true` module is still excluded when `slt_hash` is absent).
- README: update the modules-fixture note to describe the on-chain predicate and the two-entry included/excluded design.

**Approach — `content-client.test.ts`:**
- `'maps the live modules fixture…'`: expected array → `onChain: true` for 101, `onChain: false` for 102; drop `isLive`. Rename the test to reflect on-chain mapping.
- `'falls back to entry-level fields when there is no nested content'`: the `{ title: 'Keep', course_module_code: '201', is_live: true }` entry has no `slt_hash`, so expected `onChain: false`; replace `isLive: true` in the expectation with `onChain: false`. Add a sibling entry carrying a top-level `slt_hash` to prove the flat-shape top-level read yields `onChain: true`.
- Replace `'coerces string/number encodings of is_live'` with `'derives onChain from a non-empty top-level slt_hash'`: assert that entries with a non-empty `slt_hash` → `onChain:true`; empty string / missing / non-string `slt_hash` → `onChain:false`. Explicitly include an entry with `content.is_live:true` but no `slt_hash` to prove `is_live` is ignored.

**Approach — `preview.test.ts`:**
- Helper (line ~77-78): `liveModules` → `onChainModules = allModules.filter((m) => m.onChain)`; update the `/* 101 draft, 102 live */` comment to "101 on-chain, 102 not on-chain".
- `'lists only the live modules…'` (line ~182): becomes "lists only the on-chain modules…"; now **101 is shown** (it is on-chain) and **102 is excluded**; flip the assertions (the comment at line ~188 about "draft module 101… not shown" inverts). Assert 101's code/title appear, 102's do not.
- `'renders an empty-state description…no live modules'` (line ~193): copy assertion `/no live modules/i` → `/no modules/i`; pass `[]`.
- Inline literal at line ~305 (`{ …, isLive: true, moduleCode: '900' }`) → `onChain: true`.
- `'returns only live modules…'` (line ~291): rename to "…on-chain modules…"; assert 101 present, 102 absent.
- `'no live modules → "no preview available"'` (line ~394): `allModules.filter((m) => !m.isLive)` → `allModules.filter((m) => !m.onChain)`; this yields module 102, which now correctly maps to the empty/excluded reply.

**Test scenarios:**
- `mapModules`: a fixture entry with non-empty top-level `slt_hash` and `content.is_live:false` → `onChain:true` (the core R4 inclusion case). *Covers R1/R4.*
- `mapModules`: an entry with no `slt_hash` and `content.is_live:true` → `onChain:false` (proves `is_live` is not consulted). *Covers R4 exclusion + KTD1.*
- `mapModules`: empty-string `slt_hash`, non-string `slt_hash` (number/object), and missing `slt_hash` all → `onChain:false` (total-mapping edge cases).
- `mapModules`: flat-shape entry (no nested `content`) with a top-level `slt_hash` → `onChain:true` (KTD2 fallback path).
- `mapModules`: mapped objects have no `isLive` key (regression guard against the dropped field).
- `moduleChoices`: returns 101 (on-chain), excludes 102 (not on-chain), valued by code.
- `renderModuleListEmbed`: with the on-chain module(s), lists 101 and its code; copy says "Modules", not "Live modules". With `[]`, empty-state copy `/no modules/i` and no field.
- `execute` (course only): replies with the module-list embed containing 101 (ephemeral).
- `execute` (no on-chain modules): replies with `EMPTY_REPLY`, not an error.

**Verification:** `npm test` green; the suite contains no `isLive`/`is_live`-predicate assertions for visibility; `tsc`, lint, CodeQL clean.

---

## Build Order

1. **U1** — `content-client.ts`: `onChain` from top-level `slt_hash`; drop `isLive`.
2. **U2** — `preview.ts`: filter + copy.
3. **U3** — fixture + tests.

One small PR off `fix/preview-onchain-modules`. Fixes the launch-visible `/preview` empty-list bug and lands the shared `onChain` predicate that PR 3 (`/progress`) inherits.

---

## Scope Boundaries

**In scope:** the `is_live` → `onChain` predicate swap in the shared content client and `/preview`, the fixture repurposing, and the test updates.

### Deferred to Follow-Up Work
- **PR 3 (`/progress`) predicate adoption.** `/progress` must use the same `onChain` predicate. Per the user's sequencing note, that worktree is stale-based and will be recreated off updated `main` after this fix merges, so it inherits `onChain` cleanly. Do **not** start the `/progress` build against the old predicate.
- **R5 compound doc.** If a learnings note emerges, it lands on `docs/compound-autocomplete-pattern` (#23), not this branch.

**Out of scope:** surfacing `sltHash`/`onChainSlts` on `CourseModule` (KTD4); any change to SLT/lesson/assignment mappers or the envelope handling (KTD6); redeploy (`npm run deploy`) and live re-test — these happen post-merge, outside the code change.

---

## Risks & Dependencies

- **Low risk — mechanical predicate swap.** No envelope or fetch-layer change; `mapModules` stays total. The main hazard is a missed `isLive`/"live" reference; mitigation is a final `grep -rn "isLive\|live module" src/` returning nothing but intentional matches.
- **Test inversion hazard.** Several existing tests assert 101 is *excluded* under the old predicate; under `onChain` 101 is *included*. Each flipped assertion must be re-reasoned, not blindly renamed, or a test could pass while asserting the wrong thing. Mitigation: the U3 scenarios name the expected included/excluded module explicitly.
- **Dependency:** none external. The fixture is already partway to the target shape (101 correct; only 102 needs the `slt_hash` removed).

---

## Sources & Research

- Origin handoff: `docs/plans/2026-06-29-005-fix-preview-onchain-module-predicate-handoff.md` (captured live payload, product correction).
- Live-confirmed module shape: `src/andamio/__fixtures__/content/README.md` + the captured module-101 payload.
- Grep-confirmed `isLive` consumers (2026-06-29): `src/andamio/content-client.ts`, `src/commands/preview.ts`, and their `.test.ts` siblings only — no other consumer, so the field can be dropped cleanly.
