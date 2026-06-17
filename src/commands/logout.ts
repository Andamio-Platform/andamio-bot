import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import { getDb } from '../db/handle';
import { deleteLink, getLinkByDiscordId } from '../db/links';

export const data = new SlashCommandBuilder()
  .setName('logout')
  .setDescription('Unlink your Discord account from your Andamio alias.');

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const db = getDb();
  const existing = getLinkByDiscordId(db, interaction.user.id);

  if (!existing) {
    await interaction.reply({
      content: 'You are not connected, so there is nothing to unlink.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  deleteLink(db, interaction.user.id);

  await interaction.reply({
    content:
      `Unlinked. Your Discord account is no longer connected to alias ` +
      `\`${existing.alias}\`.`,
    flags: MessageFlags.Ephemeral,
  });
}
