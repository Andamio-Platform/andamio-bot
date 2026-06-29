/**
 * Generic autocomplete dispatch.
 *
 * Discord delivers autocomplete as its own interaction type (separate from the
 * chat-input invocation). This helper routes one such interaction to the named
 * command's optional `autocomplete` handler — by capability, never by command
 * name — so any command that opts in (the first is `/faq`, future ones include
 * `/preview` and `/progress` course-pickers) gets autocomplete for free.
 *
 * It is deliberately defensive: a command without an `autocomplete` method is a
 * no-op, and a handler that throws is caught and answered with an empty choice
 * list. An autocomplete error must never crash the bot, and Discord must always
 * get a response (or the user sees a hung input). Even `respond([])` is guarded,
 * since the interaction may already have expired by the time we recover.
 */

import { type AutocompleteInteraction } from 'discord.js';

/** The slice of a command this dispatcher needs: an optional autocomplete handler. */
export interface AutocompleteCapable {
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

/**
 * Dispatch `interaction` to `command.autocomplete` when present. Returns without
 * acting when `command` is undefined or exposes no `autocomplete` method. On a
 * handler error, logs and responds with an empty list so Discord is never left
 * hanging and the bot never crashes.
 */
export async function handleAutocomplete(
  command: AutocompleteCapable | undefined,
  interaction: AutocompleteInteraction,
): Promise<void> {
  if (!command || typeof command.autocomplete !== 'function') return;

  try {
    await command.autocomplete(interaction);
  } catch (err) {
    console.error(
      `Autocomplete failed for /${interaction.commandName}:`,
      err,
    );
    try {
      await interaction.respond([]);
    } catch {
      // The interaction may have expired (3s budget); nothing more to do.
    }
  }
}
