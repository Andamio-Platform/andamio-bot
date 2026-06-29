---
type: plan
status: draft
created: 2026-06-29
origin: orch session "Barca Discord Bot — Launch Features Scope and Build" (live test 2026-06-29 — /faq autocomplete missing; the deferred Q&A system)
target_repo: andamio-bot
---

# feat: `/faq` extensible Q&A with autocomplete

**Target repo:** andamio-bot · **Stack:** TypeScript, discord.js, better-sqlite3 · **Branch base:** `main` @ merge of #21 (`6d87310`)

## Summary

The shipped `/faq` (#14) is a single static "Getting started" embed with **no argument**. The 06-26 reframe (James) set the deliverable as an **extensible Q&A system** (`config/faq.json` + question autocomplete), with the richer authoring workflow deferred — but the autocomplete half was never built. Live test 2026-06-29 confirmed: typing `/faq ` offers no autocomplete because the command takes no option.

This plan adds the deferred piece **without regressing the static guide**:
- `/faq` with **no question** → the existing static get-started embed (unchanged behavior).
- `/faq question:<id>` → renders that Q&A entry's answer, with **autocomplete** over the configured questions.
- Questions live in a config file (`FAQ_PATH`, default `config/faq.json`), so adding/editing a question is a config change + restart — no code change. This is the "placeholder for questions added over time."

## Problem Frame

**Who:** Barça/Andamio Discord members. PS21 testing starts 2026-07-01. The static guide already meets the original pass-bar; this is the searchable-Q&A upgrade James asked to build now.

**Two structural gaps in the current bot (verified 2026-06-29) that this must close:**
1. **The interaction loop drops autocomplete.** `src/index.ts` does `if (!interaction.isChatInputCommand()) return;` — autocomplete interactions are silently ignored. No command's autocomplete could ever fire.
2. **The `Command` interface has no autocomplete slot.** `src/index.ts` `interface Command { data; execute }` — there's nowhere for a per-command autocomplete handler to live, and the loader only checks `'data' in command && 'execute' in command`.

Both are generic command-infra fixes; `/faq` is the first consumer.

## Requirements

- **R1 — Autocomplete dispatch (infra).** In `src/index.ts`, add an autocomplete branch to the `interactionCreate` handler: when `interaction.isAutocomplete()`, look up `client.commands.get(interaction.commandName)`, and if it exposes an `autocomplete` method, call it (wrapped in try/catch — an autocomplete error must never crash the bot; on error `respond([])`). Keep the existing chat-input path unchanged. The `isChatInputCommand()` early-return must no longer swallow autocomplete interactions.
- **R2 — `Command` interface gains optional `autocomplete`.** Add `autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>` to the `Command` interface. The loader keeps requiring `data` + `execute`; `autocomplete` is optional, so existing commands are untouched. (Mirror the same optional shape in `src/command-loader.ts` if it type-guards command modules.)
- **R3 — FAQ config loader.** Add `faqPath` to `Config` from a **new optional** env var `FAQ_PATH` (default `config/faq.json` when unset — do **not** add it to `REQUIRED_VARS`, so existing deploys don't break and an absent file degrades to the static guide). Add a `loadFaq(path)` loader (sibling to `loadMappings`) returning `FaqEntry[]`, validating the JSON shape, with a typed error on malformed content. A missing file → empty list (not a throw): `/faq` then behaves exactly as today.
- **R4 — `config/faq.json` schema + seed.** `FaqEntry = { id: string; question: string; answer: string; aliases?: string[] }`. `id` is the stable autocomplete `value`; `question` is the display label; `answer` is the embed body (Discord markdown ok). Ship a small seed `config/faq.json` (3–5 real entries, e.g. "How do I connect my account?", "Why can't I see a channel?", "How do I check my progress?") + a `config/faq.example.json` mirroring the `role-mappings.example.json` convention. Document `FAQ_PATH` in `.env.example`, README command table, and CONCEPTS.md.
- **R5 — `/faq` command rework.** Add a string option `question` with `.setAutocomplete(true)` (not required). Export an `autocomplete` handler: filter entries by case-insensitive substring match on `question` + `aliases`, rank prefix-matches first, cap at Discord's **25-choice** limit, `respond` with `{ name: question, value: id }`. `execute`: if `question` (an id) is provided and resolves → render the answer embed; if provided but unknown → friendly "I don't have that one yet" + fall back to the static guide; if absent → the existing static get-started embed verbatim.
- **R6 — Graceful + ephemeral.** All replies ephemeral. Config-read failure in `execute` → static guide (never error to the user), matching the existing `/faq` try/catch around `loadMappings`. Autocomplete never throws to Discord.
- **R7 — Tests.** Unit-test the pure pieces: the matcher/ranker (query → ranked, ≤25, alias hits, empty query), `loadFaq` (valid, malformed, missing-file→[]), answer resolution (known id, unknown id, no id→static). Add a dispatch test for the new autocomplete branch if the existing harness supports it. **The suite (300) stays green**; `tsc` + lint + CodeQL clean.

## Key Technical Decisions

- **KTD1 — Static guide is the floor, never regressed.** No-question `/faq` must render byte-for-byte today's embed. The Q&A is purely additive. The deferred "richer authoring workflow" stays deferred — config-file editing is the authoring surface for now.
- **KTD2 — Autocomplete dispatch is generic infra, not faq-special.** Wire it through the `Command` interface so any future command (`/preview`, `/progress` course pickers) reuses it. Don't special-case `faq` in `index.ts`.
- **KTD3 — `FAQ_PATH` optional with a default; missing file degrades, not throws.** Keeps every existing deploy working with zero new env vars and preserves the "renders when Andamio/down or unconfigured" property that makes `/faq` the safe onboarding command.
- **KTD4 — `id` is the autocomplete `value`, `question` is the `name`.** Stable ids decouple the answer lookup from question-text edits (rewording a question doesn't break anything). 25-choice cap is a hard Discord limit — enforce it in the ranker.
- **KTD5 — Restart registers the new option.** `index.ts` registers guild commands from `data.toJSON()` on boot, so a redeploy/restart picks up the new `question` option automatically — no separate migration. Note this in the PR so the deploy step is explicit.

## Build order (one PR, or split infra/feature)

1. **Infra (R1/R2):** autocomplete dispatch + `Command.autocomplete` slot. No user-visible change; unblocks all future autocomplete.
2. **Config (R3/R4):** `loadFaq` + `FAQ_PATH` + seed `config/faq.json` + docs.
3. **Feature (R5/R6):** `/faq` option + autocomplete handler + answer rendering + fallback.
4. **Tests (R7).**

Shippable as one PR (cohesive) or infra-then-feature. None blocks 2026-07-01; the static guide already covers the launch bar.

## Out of scope (future)

- Rich authoring workflow / in-Discord FAQ editing (still deferred).
- Per-question images/video, multi-embed answers.
- Pulling FAQ content from the Andamio API (config-file is the source for now).

## Provenance

orch session "Barca Discord Bot — Launch Features Scope and Build" — Log 2026-06-26 (the `/faq` reframe) + 2026-06-29 (live test: autocomplete missing; deferred Q&A confirmed unbuilt; decision: build now). Self-contained; carry into a CE run in `andamio-bot`.
