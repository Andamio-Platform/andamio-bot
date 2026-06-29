---
title: "Andamio module published-state is `slt_hash` presence, not `is_live`"
date: 2026-06-29
category: conventions
module: src/andamio/content-client.ts, src/commands/preview.ts
problem_type: domain-data-model
component: content_client
severity: high
applies_when:
  - "Deciding whether to surface/list/preview an Andamio course module to users"
  - "Reading the modules endpoint (`/api/v2/course/user/modules/{course_id}`) and mapping entries to a domain type"
  - "A field named `is_live` appears in the payload and looks like the obvious visibility flag"
related_components:
  - api-contract
  - mappers
  - discord-commands
tags:
  - andamio
  - on-chain
  - slt-hash
  - is-live
  - module-visibility
  - api-contract
  - deprecated-field
---

# Andamio module published-state is `slt_hash` presence, not `is_live`

## Context

`/preview` (PR #24) listed a course's modules by filtering on `CourseModule.isLive`, which `mapModules` read from the per-entry `content.is_live` boolean. In a live test against the gated "Andamio Issuer" course, `/preview` returned an **empty module list** even though the course has published, on-chain modules.

The root cause was not a flow defect — it was a wrong-field predicate. `is_live` is **deprecated** (product decision, James 2026-06-29) and reads `false` even for modules that are fully published on-chain. The real "published / show this module" signal is a **non-empty top-level `slt_hash`** on the module entry: its presence means the module's SLTs are on-chain.

The captured live payload for the bug's module (101) makes the mismatch concrete:

```json
{"data":[{
  "slt_hash":"e9b5343186f83ed804a9fd87293a7378e3b237743b76d56da73b111d855631db",
  "course_id":"ae192632…",
  "on_chain_slts":["I can explain…","I can identify…","I can find…"],
  "content":{"course_module_code":"101","title":"About Andamio Issuer","is_live":false},
  "source":"merged"
}]}
```

Module 101 is on-chain (non-empty `slt_hash`, three `on_chain_slts`) yet `content.is_live` is `false`. Filtering on `is_live` drops it; filtering on `slt_hash` presence shows it.

## Guidance

**To decide whether an Andamio module is published/visible, check for a non-empty top-level `slt_hash`. Do not read `is_live`.**

1. **Read `slt_hash` from the entry top level**, a *sibling* of `content` — not from inside `content`. Only `course_module_code`/`title`/`description`/`is_live` are nested under `content`; `slt_hash`, `course_id`, `created_by`, `on_chain_slts`, and `source` sit at the entry level.
2. **Derive a boolean with the same total-mapping discipline** the rest of the client uses: `asString(prop(entry, 'slt_hash')) !== ''`. The `asString(...) !== ''` coercion (not a truthiness check) means non-string junk and empty strings both collapse to "not on-chain", matching how `moduleCode` and `courseId` are guarded in the same file.
3. **Do not keep `is_live` as a dormant fallback.** It was removed from `CourseModule` entirely. Leaving it on the type invites a future reader to re-adopt the wrong predicate. `on_chain_slts` being non-empty corroborates on-chain status, but `slt_hash` is the canonical check.
4. **This predicate is shared, not command-local.** It lives in the content client (`mapModules` → `CourseModule.onChain`) so every consumer — `/preview` today, `/progress` next — inherits one source of truth. Any new module-visibility code reads `onChain`, never `is_live`.

## Why This Matters

- **`is_live` is a false friend.** It is the obvious-looking visibility flag and it is wrong. A reviewer skimming the payload would reach for it; the field name actively misleads. The only defense is knowing the product decision that deprecated it.
- **The failure is silent and user-facing.** Filtering on `is_live` produced an empty embed with no error — green types, passing tests (pinned to a fixture that shared the bug's assumption), blank output in production. The launch-visible symptom ("`/preview` shows nothing") had no stack trace to grep.
- **Visibility predicates propagate.** The same module list backs `/progress`. Encoding the predicate once in the shared client — rather than re-deriving it per command — is what stops the next command from shipping the same empty-list bug.
- **Top-level vs `content` nesting is a recurring trap here.** The #24 reconciliation correctly nested `title`/`is_live` under `content`; the visibility fix then had to reach *back out* to the entry level for `slt_hash`. Keep both levels straight: display fields nested, on-chain signal top-level.

## When to Apply

- Any code that lists, filters, counts, or gates Andamio course modules for display.
- Mapping the modules endpoint into a domain type — expose an `onChain`-style boolean from `slt_hash`, not an `isLive` from `is_live`.
- Reviewing a diff that reads `is_live` / `content.is_live` for a "should we show this?" decision — flag it; the answer is `slt_hash` presence.

Skip only if a future product decision un-deprecates `is_live` and re-establishes it as the visibility signal (and says so explicitly).

## Examples

**The fix, in the mapper:**

```ts
// before: visibility from the deprecated, misleading flag (nested under content)
isLive: asBool(prop(content, 'is_live')),

// after: on-chain = non-empty top-level slt_hash (sibling of content).
// Read from `entry`, not `content`; is_live is deprecated and ignored.
onChain: asString(prop(entry, 'slt_hash')) !== '',
```

**Pinning both halves of the predicate in the fixture** — one module proves inclusion, one proves exclusion, and the `is_live` values are set *against* the outcome so a regression to `is_live` fails loudly:

```jsonc
// 101: on-chain (slt_hash present) but content.is_live:false  → INCLUDED
// 102: no slt_hash but content.is_live:true                   → EXCLUDED
```

A test that asserts module 102 (`is_live:true`, no `slt_hash`) is **excluded** is the load-bearing one: it proves `is_live` is never consulted for visibility. Without it, a mapper that read `is_live` would still pass.

**The anti-pattern this prevents:** trusting the field named `is_live` because it looks like the visibility flag. It type-checks, it reads cleanly, and it hides every on-chain module whose `is_live` happens to be `false` — which, post-deprecation, is most of them.

Related: [[confirm-source-mapped-fixtures-against-live-api]] (the live-capture discipline that surfaced this payload shape), [[discord-autocomplete-dispatch-pattern]] (the `/preview` command this predicate filters), and the auto-memory note [[operator-api-key-location]] for capturing fresh module payloads.
