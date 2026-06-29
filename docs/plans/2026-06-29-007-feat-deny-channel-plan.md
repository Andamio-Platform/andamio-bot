---
type: plan
status: completed
created: 2026-06-29
origin: docs/plans/2026-06-29-006-feat-deny-channel-handoff.md
target_repo: andamio-bot
---

# feat: `/deny #channel` — block a member from a channel by resolving its gating roles

**Target repo:** andamio-bot · **Stack:** TypeScript, discord.js ^14.14.1, Vitest · **Branch:** `feat/deny-channel` (base `main` @ #25, `f679037`)

---

## Summary

`/deny` already blocks a member from a **role** (per-role) or **all gated roles** (full block). This PR adds a third *addressing* mode: `/deny @member channel:#x`. The bot reads the channel's permission overwrites, finds the **managed** role(s) that gate it (allow `ViewChannel` ∧ ∈ `managedRoleIds`), and denies each — so a moderator can say "keep them out of *this channel*" without naming the gating role. It rides the existing deny-list write path, sweep, and `outcome.failed` reporting. The only genuinely new code is a **pure resolver** plus option wiring; no new persistence, no new config, no new gating logic.

The crux is the resolver predicate — three conditions ANDed: **role-type overwrite**, **allows `ViewChannel`**, and **∈ `managedRoleIds`**. The failure mode to defend against is *over-broad denial*: dropping the `managedRoleIds` check would let `/deny #channel` deny any role with view access (including ungated ones). R2 and its tests pin this.

---

## Problem Frame

A gated channel grants visibility by giving its **gating role** a View-allow permission overwrite. "Block from this channel even with the credential" therefore means: find the managed role(s) that gate the channel and deny those. The member-facing effect is identical to `/deny @member role:@thatRole` — the channel form just automates the channel→role lookup so mods address the thing they actually see.

Reversal is already covered: `/allow @member` (no role) lifts every block, `/allow @member role:@x` lifts one — so a channel-deny is undone by allowing the resolved role(s) or the member entirely. No new allow path required (see Scope Boundaries for the optional `/allow #channel` nicety).

---

## Requirements

Carried verbatim from the origin handoff (see `origin:`), with R-IDs preserved.

- **R1 — Add a `channel` option to `/deny`.** New optional `addChannelOption`. The three addressing modes are mutually exclusive in intent:
  - `channel` given → resolve gating roles and deny each (this PR's new path).
  - `role` given → existing per-role deny (unchanged).
  - neither → existing FULL_BLOCK (unchanged).
  - **`channel` AND `role` both given → reject** with a friendly "pick one — a channel or a role, not both." Write nothing, re-evaluate nothing.
- **R2 — Pure channel→roles resolver.** `gatingRolesForChannel(overwrites, managedRoleIds) → string[]`: return the ids of overwrites that (a) are **role-type**, (b) **allow `ViewChannel`**, and (c) are in `managedRoleIds`. Pure, no I/O, unit-tested. Member-type overwrites, deny/neutral-View overwrites, and allow-View roles not in `managedRoleIds` are all excluded.
- **R3 — Deny each resolved role.** For each resolved role id: `upsertDenial(db, target.id, roleId, reason, moderatorId)`, then a **single** `reevaluateMember(target.id)` after writing them all. Report which roles were denied (by mention) and surface any the bot couldn't actually remove (role-hierarchy), reusing `/deny`'s existing `outcome.failed` reporting.
- **R4 — Zero managed gating roles → no-op with a clear message.** If the channel resolves to no managed roles, **write nothing**, call `reevaluateMember` **nothing**, and reply: `#channel isn't gated by any role I manage, so there's nothing to block. Use /deny @member role:@role if you mean a specific role.`
- **R5 — Multiple gating roles → deny all of them.** Each is denied; the reply lists them all.
- **R6 — Moderator-gated + ephemeral + graceful.** Keep the `requireModerator(interaction, config.modRoleId)` guard. Ephemeral replies. A broken `loadMappings` read degrades exactly as `/deny` already does ("try again shortly"). No throw to the user.
- **R7 — Tests.** Unit-test `gatingRolesForChannel` (every branch). Test the channel+role both-given guard and the zero-roles no-op. Existing `/deny` + `/allow` tests stay green; `npm run build` (tsc) + `npm run lint` + CodeQL clean.

---

## Key Technical Decisions

- **KTD1 — Resolver is pure; the command does the I/O (origin KTD3).** `gatingRolesForChannel` takes a plain mapped-record array (`ChannelOverwrite[]`), not discord.js types, so it is unit-testable without mocking discord.js. The command pulls `channel.permissionOverwrites.cache` in `execute`, maps each `PermissionOverwrites` to `{ id, type: 'role' | 'member', allowsView: boolean }`, and hands that to the resolver. This mirrors how `triggers.ts` keeps `evaluate()` pure by doing the db read in the trigger.
- **KTD2 — The mapped-record shape isolates the only two discord.js facts the predicate needs.** `type` collapses `OverwriteType.Role`/`.Member` to a string literal; `allowsView` collapses `ow.allow.has(PermissionFlagsBits.ViewChannel)` to a boolean. The resolver never imports discord.js. The command is the single place those enums are touched.
- **KTD3 — Channel→role resolution reads Discord, not new config (origin KTD1).** Gating roles come from `permissionOverwrites ∩ managedRoleIds` — no channel-to-role config. `managedRoleIds` is already loaded by the existing `loadMappings` block in `deny.ts`; the channel path reuses it. Document the assumption (a gated channel grants View to its gating role via an allow overwrite) in the command help text.
- **KTD4 — Reuse the deny-list write path entirely (origin KTD2).** The channel path writes the same `denials` rows via `upsertDenial` and rides the same sweep. No new persistence, no schema change, no new gating logic.
- **KTD5 — Extract the outcome→message logic into a shared helper, then reuse it.** `/deny`'s four-way `lead` message (skipped / failed / removeFailed / live) is replicated for the channel path. To avoid drift and keep the existing role/full-block wording byte-identical (existing tests assert on it), factor the message builder into a small pure helper `denyOutcomeLead(outcome, scope, removeFailed)` and call it from both paths. Strings stay identical, so existing assertions stay green.
- **KTD6 — Don't over-restrict channel type (origin KTD4).** Accept any guild channel/category with overwrites — don't call `addChannelTypes`. Resolution is overwrite-driven, so a category that gates via overwrites works. A channel with no overwrites simply resolves to zero roles (R4). Guard defensively: if the resolved option lacks `permissionOverwrites` (e.g. an uncached/odd channel shape), treat it as zero overwrites rather than throwing.

---

## High-Level Technical Design

Addressing-mode dispatch inside `/deny execute` (after the existing moderator guard and `loadMappings`):

```
requireModerator ──fail──> ephemeral refusal, return
       │ pass
       ▼
 read member, role, reason, channel
       │
 channel && role ? ──yes──> "pick one — a channel or a role, not both"   (R1: write nothing)
       │ no
 load managedRoleIds (existing try/catch; "try again shortly" on failure) (R6)
       │
       ├─ channel given ──> records = map(channel.permissionOverwrites.cache)
       │                    roleIds = gatingRolesForChannel(records, managedRoleIds)   (R2)
       │                       │
       │                       ├─ roleIds.length === 0 ──> "#channel isn't gated…"  (R4: no write, no reeval)
       │                       └─ else ──> for each id: upsertDenial(...)             (R3/R5)
       │                                   one reevaluateMember(target.id)
       │                                   reply: list denied roles + any failed removals
       │
       ├─ role given ──> [existing per-role path, unchanged]
       └─ neither   ──> [existing FULL_BLOCK path, unchanged]
```

The resolver predicate (R2), the one piece that must not drift:

```
gatingRolesForChannel(overwrites, managedRoleIds):
  return overwrites
    .filter(o => o.type === 'role'           // (a) role-type, not member
              && o.allowsView                 // (b) allows ViewChannel
              && managedRoleIds.has(o.id))    // (c) a role the bot manages
    .map(o => o.id)
```

*Directional guidance, not implementation specification.*

---

## Implementation Units

### U1. Pure `gatingRolesForChannel` resolver + exhaustive unit tests

**Goal:** The R2 predicate as a pure, discord.js-free function, fully branch-tested. This is the crux; build and test it first.

**Requirements:** R2, R7.

**Dependencies:** none.

**Files:**
- `src/gating/channel-roles.ts` (new) — exports `interface ChannelOverwrite { id: string; type: 'role' | 'member'; allowsView: boolean }` and `function gatingRolesForChannel(overwrites: readonly ChannelOverwrite[], managedRoleIds: ReadonlySet<string>): string[]`.
- `src/gating/channel-roles.test.ts` (new).

**Approach:** Single `filter`→`map` over the three ANDed conditions (see HTD). No imports beyond the local interface. Return a plain `string[]` (order = overwrite order; de-duplication is unnecessary because a channel cannot hold two overwrites for the same id). Keep the doc comment explicit that dropping the `managedRoleIds.has` check is the over-broad-denial bug this function exists to prevent.

**Patterns to follow:** the pure-module style of `src/gating/evaluator.ts` (pure function, no I/O, colocated test). Doc-comment density matches `mappings.ts`/`denials.ts`.

**Test scenarios** (`channel-roles.test.ts`):
- Managed role, role-type, allows View → **included** (the happy path).
- Allow-View role-type overwrite whose id is **not** in `managedRoleIds` → **excluded** (pins the over-broad-denial guard).
- **Member-type** overwrite whose id *is* in `managedRoleIds` and allows View → **excluded** (type gate).
- Role-type, id in `managedRoleIds`, but `allowsView: false` (deny or neutral View) → **excluded** (View gate).
- No overwrites (empty array) → `[]`.
- Multiple qualifying managed roles → **all** returned (R5), order preserved.
- Mixed bag (one qualifying + one each of the three exclusion reasons) → returns only the one qualifying id.
- Empty `managedRoleIds` set with otherwise-qualifying overwrites → `[]`.

**Verification:** `npx vitest run src/gating/channel-roles.test.ts` green; every branch of the predicate exercised by at least one assertion.

### U2. Extract `denyOutcomeLead` message helper (refactor, behavior-preserving)

**Goal:** Pull `/deny`'s four-way outcome→message logic into a reusable pure helper so the new channel path reports identically without duplicating the wording, and existing wording stays byte-identical.

**Requirements:** R3 (reporting reuse), R7 (existing tests stay green).

**Dependencies:** none (can land before or with U3).

**Files:**
- `src/commands/deny.ts` (modify) — add `denyOutcomeLead(outcome, scope, removeFailed)` returning the `lead` string; rewire the existing role/full-block path to call it.

**Approach:** Lift lines 88–106 of `deny.ts` verbatim into a function taking `(outcome: ReevaluationOutcome, scope: string, removeFailed: boolean)` and returning the `lead` string. `scope` is the caller-supplied phrase (`<@&id>`, `**all gated roles**`, or — for the channel path — the joined role mentions). The existing path computes `removeFailed` exactly as today and passes its existing `scope`. **No string changes.**

**Patterns to follow:** existing private-helper style; keep it in `deny.ts` (not exported) unless U3 needs it cross-file — it does not, both paths live in `deny.ts`.

**Test scenarios:** none new — this is a pure refactor. Verification is that the **existing** `deny.test.ts` suite (live-now, skipped, role-above-bot, etc.) stays green unchanged.

**Execution note:** Run `deny.test.ts` immediately after this unit to confirm zero behavioral drift before U3 builds on it.

### U3. Wire the `channel` option + three-mode dispatch into `/deny`

**Goal:** Add the `channel` option, the both-given guard, the channel-resolution path, the zero-role no-op, and multi-role denial + reporting.

**Requirements:** R1, R3, R4, R5, R6.

**Dependencies:** U1 (resolver), U2 (message helper).

**Files:**
- `src/commands/deny.ts` (modify) — builder option + execute dispatch.
- `src/commands/deny.test.ts` (modify) — new channel-path cases.

**Approach:**
- **Builder:** add `.addChannelOption((o) => o.setName('channel').setDescription("Block them from this channel — I'll find the role(s) that gate it"))`. Do **not** restrict channel types (KTD6).
- **Read:** `const channel = interaction.options.getChannel('channel');` alongside the existing `member`/`role`/`reason` reads.
- **Both-given guard (R1):** if `channel && role` → ephemeral "pick one — a channel or a role, not both." Return before any write or `loadMappings`. (Place it before the mappings load so a config blip can't mask a usage error — but after `requireModerator`.)
- **Mappings:** keep the existing `loadMappings` try/catch (R6); `managedRoleIds` now feeds both the role path and the channel path.
- **Channel path:** map `channel.permissionOverwrites.cache` (guard `channel && 'permissionOverwrites' in channel`, else empty) to `ChannelOverwrite[]` using `ow.type === OverwriteType.Role ? 'role' : 'member'` and `ow.allow.has(PermissionFlagsBits.ViewChannel)`. Call `gatingRolesForChannel(records, managedRoleIds)`.
  - `roleIds.length === 0` → R4 message, no write, no `reevaluateMember`, return.
  - else → `for (const id of roleIds) upsertDenial(db, target.id, id, reason, interaction.user.id);` then one `await reevaluateMember(target.id)`. Build `scope` = roleIds mapped to `<@&id>` joined by `, `. Compute `removeFailed = roleIds.some((id) => outcome.failed.includes(id))`. Reply via `denyOutcomeLead(outcome, scope, removeFailed)` + reason line. When only some roles failed to remove, the helper's removeFailed branch covers it; optionally name the failed subset (nice-to-have, not required by R3).
- **Existing role / FULL_BLOCK paths:** unchanged except they now route through `denyOutcomeLead`.
- **Imports:** add `OverwriteType`, `PermissionFlagsBits` from `discord.js`; `gatingRolesForChannel` (+ its record type) from `../gating/channel-roles`.

**Patterns to follow:** option-callback style and ephemeral-reply style already in `deny.ts`/`allow.ts`; the `loadMappings` try/catch degradation block (deny.ts:44–56); the partial-mock + `FakeInteraction` test style in `deny.test.ts`.

**Test scenarios** (`deny.test.ts` additions — extend `makeInteraction` to accept `channel` and add `getChannel`):
- **channel + role both given** → reply matches `/pick one/i`; `upsertDenial` **not** called; `reevaluateMember` **not** called. (R1)
- **channel resolves to zero managed roles** (overwrites present but none qualify, or no overwrites) → reply matches `/isn't gated by any role I manage/i`; `upsertDenial` **not** called; `reevaluateMember` **not** called. (R4)
- **channel resolves to one managed role** → `upsertDenial` called once with that role id, reason, mod id; `reevaluateMember` called **once** with target; reply mentions the role and matches `/live now/i` (updated outcome). (R3)
- **channel resolves to multiple managed roles** → `upsertDenial` called once **per** role id; `reevaluateMember` called **exactly once**; reply lists all role mentions. (R5)
- **channel path, a denied role above the bot** (`reevaluateMember` resolves `{ status: 'updated', failed: [thatRoleId] }`) → reply matches `/could not remove|above my own role/i` and not `/live now/i`. (R3 honest reporting)
- **channel given but mappings fail to load** → reply matches `/could not load/i`; no write. (R6 — confirms the guard order leaves the existing degradation intact)
- Build the fake channel as `{ permissionOverwrites: { cache: [ /* fake overwrites */ ] } }` where each fake overwrite is `{ id, type: OverwriteType.Role|Member, allow: { has: (flag) => boolean } }`. Import the **real** `OverwriteType` and `PermissionFlagsBits` from discord.js (enums, not a client — no mocking needed). Arrays expose `.map((value) => …)` identically to a discord.js `Collection`.

**Verification:** `npm run test` green (new + all existing); `npm run build` (tsc) clean; `npm run lint` clean.

---

## Scope Boundaries

**In scope:** the pure resolver, the `channel` option, three-mode dispatch with the both-given guard, the zero-role no-op, multi-role denial, honest `outcome.failed` reporting, and the message-helper extraction. Tests for every resolver branch + the both-given guard + the zero-role no-op.

### Deferred to Follow-Up Work
- Naming the *specific* failed-to-remove subset in the channel path's reply (R3 is satisfied by the existing removeFailed phrasing; per-role naming is a nice-to-have).

### Out of scope (origin "future")
- **`/allow #channel`** symmetry — `/allow @member` (and per-role) already reverses a channel-deny. Note in the PR; build only if asked.
- Auto-detecting gating-role changes when a channel's overwrites are later edited — a channel-deny is a snapshot of the roles at deny-time.
- Any new persistence, schema change, or "managed channels" config — explicitly not introduced (KTD3/KTD4).

---

## Risks & Mitigations

- **Over-broad denial (the headline risk).** Dropping condition (c) — `managedRoleIds.has(id)` — would deny any role with View access, including ungated roles. *Mitigation:* the resolver's "unmanaged allow-View → excluded" and "empty managedRoleIds → []" tests (U1) fail loudly if (c) is removed.
- **Both-given guard placement.** If the guard sits *after* `loadMappings`, a config blip would surface "try again shortly" instead of "pick one," masking a usage error. *Mitigation:* guard runs before the mappings load (but after `requireModerator`); U3's mappings-fail test plus the both-given test together pin the ordering.
- **Channel option shape.** `getChannel` can return a channel without `permissionOverwrites` for unusual types. *Mitigation:* `'permissionOverwrites' in channel` guard → empty overwrites → R4 no-op, never a throw (R6).
- **Refactor drift (U2).** Extracting `denyOutcomeLead` must not alter wording. *Mitigation:* existing `deny.test.ts` assertions are the regression gate; run them right after U2.

---

## Verification (whole PR)

- `npm run test` — all suites green, including the new `channel-roles.test.ts` and the new `deny.test.ts` cases, with the existing `/deny` + `/allow` suites unchanged and passing.
- `npm run build` — tsc clean (no new type errors; the resolver is discord.js-free, the command's enum usage type-checks).
- `npm run lint` — eslint clean (`no-explicit-any` is warn; avoid `any` in the new code).
- CodeQL — clean (no new security findings; pure data resolution, no new I/O or input sinks).

---

## Sources & Research

- Origin handoff: `docs/plans/2026-06-29-006-feat-deny-channel-handoff.md` (R1–R7, KTD1–KTD4, provenance).
- Existing command + supporting code (read firsthand): `src/commands/deny.ts`, `src/commands/allow.ts`, `src/commands/mod-auth.ts`, `src/db/denials.ts`, `src/gating/mappings.ts`, `src/gating/triggers.ts`, `src/commands/deny.test.ts`.
- Stack facts: discord.js `^14.14.1`, Vitest `^2.1.8`; `npm run build` is the typecheck (no separate `typecheck` script); commands auto-register via `src/command-loader.ts` (no manifest edit). No pre-existing `permissionOverwrites` / `ViewChannel` / `getChannel` usage — this PR introduces those discord.js touchpoints, all confined to `deny.ts`.
