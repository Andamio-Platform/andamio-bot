import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleAutocomplete, type AutocompleteCapable } from './autocomplete';

// A minimal AutocompleteInteraction stand-in: only the fields the dispatcher
// touches (commandName + respond).
function makeInteraction(commandName = 'faq') {
  return {
    commandName,
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleAutocomplete', () => {
  it('invokes the command autocomplete handler with the interaction', async () => {
    const interaction = makeInteraction();
    const autocomplete = vi.fn().mockResolvedValue(undefined);
    const command: AutocompleteCapable = { autocomplete };

    await handleAutocomplete(command, interaction as never);

    expect(autocomplete).toHaveBeenCalledTimes(1);
    expect(autocomplete).toHaveBeenCalledWith(interaction);
  });

  it('no-ops when the command is undefined (unknown command name)', async () => {
    const interaction = makeInteraction('nope');
    await expect(
      handleAutocomplete(undefined, interaction as never),
    ).resolves.toBeUndefined();
    expect(interaction.respond).not.toHaveBeenCalled();
  });

  it('no-ops when the command has no autocomplete method', async () => {
    const interaction = makeInteraction();
    await expect(
      handleAutocomplete({}, interaction as never),
    ).resolves.toBeUndefined();
    expect(interaction.respond).not.toHaveBeenCalled();
  });

  it('responds with an empty list when the handler throws (never crashes)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const interaction = makeInteraction();
    const command: AutocompleteCapable = {
      autocomplete: vi.fn().mockRejectedValue(new Error('boom')),
    };

    await expect(
      handleAutocomplete(command, interaction as never),
    ).resolves.toBeUndefined();

    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  it('swallows a respond failure after a handler error (expired interaction)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const interaction = makeInteraction();
    interaction.respond.mockRejectedValue(new Error('Unknown interaction'));
    const command: AutocompleteCapable = {
      autocomplete: vi.fn().mockRejectedValue(new Error('boom')),
    };

    // Both the handler AND the recovery respond throw — must still not reject.
    await expect(
      handleAutocomplete(command, interaction as never),
    ).resolves.toBeUndefined();
  });
});
