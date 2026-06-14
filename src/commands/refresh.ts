import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import { reevaluateMember } from '../gating/triggers';

export const data = new SlashCommandBuilder()
  .setName('refresh')
  .setDescription('Re-check your Andamio credentials and update your roles.');

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  // Re-evaluation can hit andamioscan + the Discord API, so defer to stay
  // within the 3s interaction window. Ephemeral — only the invoker sees it.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await reevaluateMember(interaction.user.id);
    await interaction.editReply({
      content:
        'Refreshed. Your roles now reflect your current Andamio credentials. ' +
        'If something looks off, make sure you have run `/login`.',
    });
  } catch (err) {
    console.error('Gating: /refresh failed:', err);
    await interaction.editReply({
      content:
        'Could not refresh your roles right now. Please try `/refresh` again ' +
        'in a moment.',
    });
  }
}
