---
type: plan
status: draft
created: 2026-06-29
origin: orch session "Barca Discord Bot — Launch Features Scope and Build" (live /preview test 2026-06-29 — empty module list; product correction from James)
target_repo: andamio-bot
---

# fix: `/preview` lists modules by on-chain `slt_hash`, not deprecated `is_live`

**Target repo:** andamio-bot · **Stack:** TypeScript, discord.js · **Branch base:** `main` @ #24

## Problem (live-confirmed 2026-06-29)

`/preview` shows no modules for the gated "Andamio Issuer" course (`ae192632…`). Root cause is **not a code defect in the command flow** — it's the wrong field. `mapModules` sets `CourseModule.isLive` from `content.is_live`, and the command filters module choices + the module-list embed on `m.isLive`. But **`is_live` is deprecated** (product decision, James) and reads `false` even for published, on-chain modules.

**The real "published / show this module" signal is a non-empty top-level `slt_hash`** on the module entry — its presence means the module's SLTs are on-chain. The live response for module 101 (the actual captured payload, use as the fixture):

```json
{"data":[{
  "slt_hash":"e9b5343186f83ed804a9fd87293a7378e3b237743b76d56da73b111d855631db",
  "course_id":"ae192632aabe00ed2042eaef596bc15f3887fa32e75e8f9b8fa516df",
  "created_by":"james",
  "on_chain_slts":[
    "I can explain how the Andamio Issuer product differs from the Andamio API.",
    "I can identify the target market for the Andamio Issuer product.",
    "I can find the documentation and resources that support Andamio Issuer."
  ],
  "content":{"course_module_code":"101","title":"About Andamio Issuer","description":"Introducing the new Andamio Issuer product.","is_live":false},
  "source":"merged"
}]}
```

Note the shape: `slt_hash`, `course_id`, `created_by`, `on_chain_slts`, `source` are **top-level on the entry** (siblings of `content`); only `course_module_code`/`title`/`description`/`is_live` are nested under `content`. Module 101 is on-chain (non-empty `slt_hash`) yet `content.is_live` is `false` — that mismatch is the bug.

## Requirements

- **R1 — `content-client.ts`: on-chain predicate replaces `is_live`.** In `mapModules`, read `slt_hash` from the **entry top level** (not from `content`). Expose `CourseModule.onChain: boolean` = `slt_hash` is a non-empty string. **Remove `isLive`** from `CourseModule` (it's deprecated and misleading) — or if any other consumer still references it, keep the field but stop deriving "shown" from it; `onChain` is the new source of truth. Optionally also surface `sltHash: string` and `onChainSlts: string[]` if useful for rendering, but `onChain` is the required addition.
- **R2 — `preview.ts`: filter on `onChain`.** Replace every `m.isLive` filter — in `moduleChoices` (autocomplete) and `execute`'s `liveModules` derivation — with `m.onChain`. Rename `liveModules` → `onChainModules` (or `publishedModules`) and update the user-facing copy: "live modules" → "modules" / "published modules" in `renderModuleListEmbed` and option/description text. Behavior: a module with a non-empty `slt_hash` is listed and previewable even when `content.is_live` is `false`.
- **R3 — Fixture reflects the real shape.** Update the modules fixture under `src/andamio/__fixtures__/content/` to the captured payload above (top-level `slt_hash` + `on_chain_slts`, `content.is_live:false`, `source:"merged"`). This pins the on-chain predicate to reality and prevents regression to `is_live`.
- **R4 — Tests.** Assert: a module with a non-empty `slt_hash` **is included** even though `content.is_live` is `false`; a module with missing/empty `slt_hash` **is excluded**. Update existing `/preview` + `mapModules` tests that asserted on `is_live`. Suite stays green; `tsc` + lint + CodeQL clean.
- **R5 — Compound doc → #23.** If this produces a learnings note (e.g. "Andamio module published-state is `slt_hash` presence, not `is_live`"), commit it onto the long-lived `docs/compound-autocomplete-pattern` branch (PR #23), not this fix branch.

## Key Technical Decisions

- **KTD1 — `slt_hash` presence = published/on-chain = show.** This is the product-truth predicate (James, 2026-06-29). `is_live` is deprecated; do not read it for visibility. `on_chain_slts` non-empty corroborates but `slt_hash` is the canonical check.
- **KTD2 — Top-level vs `content` nesting.** `slt_hash` is a sibling of `content`, not inside it. The #24 reconciliation correctly nested `title`/`is_live` under `content`; this fix adds the **top-level** read. Keep both levels straight in the mapper.
- **KTD3 — Propagate to PR 3.** `/progress` (handoff `2026-06-29-004`) lists the same modules and must use the same `onChain` predicate, not `is_live`. This fix lands the predicate in the shared client so PR 3 inherits it.
- **KTD4 — Don't regress the {data:…} envelope handling** from #24. This is an additive field read on the already-confirmed envelope.

## Build order

1. **`content-client.ts`** — `onChain` from top-level `slt_hash`; drop/deprecate `isLive`; update fixture (R1/R3).
2. **`preview.ts`** — filter + copy (R2).
3. **Tests** (R4).

One small PR. Fixes the launch-visible `/preview` bug; unblocks PR 3's predicate.

## Provenance

orch session "Barca Discord Bot — Launch Features Scope and Build" — 2026-06-29 live `/preview` test (empty module list) + James's correction that `is_live` is deprecated and `slt_hash`/on-chain presence is the show signal. Live payload captured against `api.andamio.io`. Self-contained; carry into a CE run in `andamio-bot`.
