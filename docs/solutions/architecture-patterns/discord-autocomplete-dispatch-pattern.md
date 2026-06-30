---
title: "Discord.js autocomplete: dispatch through the Command interface, never per-command"
date: 2026-06-29
category: architecture-patterns
module: src/discord, src/faq, src/commands
problem_type: architecture_pattern
component: service_object
severity: medium
applies_when:
  - "Adding autocomplete to a discord.js slash command"
  - "Building a command that needs a dynamic option picker (course, credential, FAQ, etc.)"
  - "Loading optional JSON config that must degrade gracefully when absent or malformed"
related_components:
  - tooling
  - documentation
tags:
  - discord-js
  - autocomplete
  - slash-commands
  - graceful-degradation
  - config-loader
  - command-interface
---

# Discord.js autocomplete: dispatch through the Command interface, never per-command

## Context

The bot dispatched chat-input commands but silently dropped autocomplete: `interactionCreate` early-returned on anything that wasn't `isChatInputCommand()`, and the `Command` interface had no slot for an autocomplete handler. Adding `/faq question:<…>` (the first command with a dynamic option) surfaced the gap. The temptation was to special-case `faq` inside `index.ts`. The durable choice was to wire autocomplete generically — so the next picker (`/preview`, `/progress` course-selectors) inherits it with zero router changes.

This learning captures the dispatch pattern plus the supporting conventions that keep an autocomplete command safe: a pure ranker, a non-throwing config loader, parse-time length validation, and degradation guards.

## Guidance

**1. Dispatch by capability through the `Command` interface — not by command name.**

Give the shared command type an optional handler, and route autocomplete interactions to it generically. The dispatcher checks for the *method*, never the command's name:

```ts
// src/discord/autocomplete.ts — the generic dispatcher
export interface AutocompleteCapable {
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

export async function handleAutocomplete(
  command: AutocompleteCapable | undefined,
  interaction: AutocompleteInteraction,
): Promise<void> {
  if (!command?.autocomplete) return; // dispatch only if the capability exists
  try {
    await command.autocomplete(interaction);
  } catch (err) {
    console.error(`Autocomplete failed for /${interaction.commandName}:`, err);
    try {
      await interaction.respond([]); // never leave the input hanging
    } catch {
      // interaction may have expired (3s budget) — nothing more to do
    }
  }
}
```

```ts
// src/index.ts — Command extends the capability; the router branches generically
interface Command extends AutocompleteCapable {
  data: SlashCommandBuilder; // the slash-command definition
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(
      client.commands.get(interaction.commandName),
      interaction,
    );
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  // …existing chat-input path unchanged…
});
```

The command loader still only requires `data` + `execute`; `autocomplete` is optional, so existing commands are untouched. A command opts in by exporting an `autocomplete` function and declaring its option with `.setAutocomplete(true)`.

**2. Keep the matcher/ranker a pure module, separate from the command file.**

The ranking logic has no Discord types and is unit-tested in isolation. Enforce Discord's hard 25-choice cap *inside* the ranker, not at the call site:

```ts
// src/faq/match.ts
export const MAX_CHOICES = 25; // Discord's hard limit

export function rankFaqEntries(entries, query, limit = MAX_CHOICES) {
  const q = query.trim().toLowerCase();
  if (q === '') return entries.slice(0, limit).map(toChoice); // empty → all (capped)
  // tier 0: question prefix · tier 1: question substring · tier 2: alias-only
  // stable within a tier (config order), then .slice(0, limit)
}
```

**3. Config loader: borrow the parse/load split, but be non-throwing on absence.**

Mirror the strict validator split of a `parse*`/`load*` pair, but adopt a non-throwing posture for a *missing* file so the feature degrades instead of failing boot:

- `parseX(value)` — validates shape with entry-indexed error messages; **throws** on malformed content (bad JSON, wrong shape, duplicate keys).
- `loadX(path)` — absent/empty path or missing file → `[]` (the "unconfigured" degrade path); a file that *exists but is malformed* → throws (so a caller can catch and fall back, and a seed-validity test catches a broken commit). Log non-ENOENT read errors (e.g. EACCES) before degrading, so a misconfigured deploy isn't silent.

**4. Validate downstream length limits at parse time — degrade, don't crash.**

discord.js throws a synchronous `RangeError` when an embed title exceeds 256 chars or a description exceeds 4096, and rejects autocomplete values over 100. If that throw happens *outside* the loader's try/catch (e.g. inside the embed renderer), it escapes to the global handler and the user sees the generic error — breaking the "never error to the user" guarantee. Enforce the limits where the config is parsed, so an over-long entry throws inside the guarded load and degrades to the fallback:

```ts
const LIMITS = { id: 100, question: 256, answer: 4096 } as const; // Discord caps
if (e.question.length > LIMITS.question) throw new Error(/* indexed message */);
```

**5. Make every degradation path explicit and guarded.**

Both the dispatcher (above) and the per-command handler wrap their work so an error answers `respond([])` rather than hanging the input or crashing the gateway. The command's `execute` falls back to a safe static reply on any config-read failure.

## Why This Matters

- **Reuse, not duplication.** A name-keyed `if (commandName === 'faq')` branch in the router would need editing for every future picker and invites drift. Capability dispatch means the router is written once; new pickers are pure additions.
- **One signature, one source of truth.** `Command extends AutocompleteCapable` keeps the dispatcher and the interface from declaring the handler shape twice and silently drifting.
- **The 3-second budget is unforgiving.** Discord cancels an autocomplete interaction that isn't answered in ~3s and shows a hung dropdown. Every error path must still call `respond` (even `respond([])`), and the guard around `respond` itself matters because the interaction may already have expired.
- **Graceful degradation is a contract, not a nicety.** A missing/malformed config or an over-long entry must downgrade to a safe fallback, never surface a raw error. The length-at-parse-time check is the non-obvious piece: validating required fields isn't enough when the *renderer* enforces a separate, stricter limit.

## When to Apply

- Any discord.js command that needs autocomplete — reach for the generic dispatcher, never a name check in the router.
- Any optional, file-backed config that should make its feature degrade (not crash) when unconfigured: split `parse`/`load`, return `[]` on a missing file, throw on malformed, guard a seed file with a validity test.
- Any user-facing content sourced from config that flows into a provider with hard field limits — validate those limits at parse time.

## Examples

**Anti-pattern — name-keyed dispatch (do not do this):**

```ts
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete() && interaction.commandName === 'faq') {
    await faqAutocomplete(interaction); // every new picker edits the router
  }
});
```

**Pattern — capability dispatch (see code above):** the router asks "does this command expose `autocomplete`?", calls it, and guards it. `/preview` and `/progress` pickers add an `autocomplete` export and nothing in `index.ts` changes.

## Related

- `docs/solutions/architecture-patterns/reading-andamio-credentials-auth-model.md` — the same graceful-degradation principle (act only on a clean, complete load; never let a degraded read trigger destructive or error-surfacing behavior) applied to credential reads.
- Sibling config-loader conventions in the codebase: the strict `parseMappings`/`loadMappings` split (`src/gating/mappings.ts`) and the non-throwing optional-config posture of `src/andamio/course-names.ts` — this pattern combines both.
- Shipped in PR #22 (branch `feat/faq-qa-autocomplete`); plan at `docs/plans/2026-06-29-003-feat-faq-qa-autocomplete-plan.md`.
