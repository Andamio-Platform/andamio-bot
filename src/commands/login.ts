import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import { loadConfig } from '../config';
import { getDb } from '../db/handle';
import { startLogin } from '../andamio/login';
import { reevaluateMember } from '../gating/triggers';

export const data = new SlashCommandBuilder()
  .setName('login')
  .setDescription('Link your Discord account to your Andamio alias.');

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const config = loadConfig();
  const db = getDb();

  // Re-running /login is fine: a fresh state is minted, and the eventual
  // callback overwrites any existing link for this Discord id.
  const { url } = startLogin(
    db,
    interaction.user.id,
    config.appLoginBaseUrl,
    config.botCallbackBaseUrl,
  );

  await interaction.reply({
    content:
      `**Link your Andamio alias**\n` +
      `Open this link to authenticate, then return here:\n${url}\n\n` +
      `The link is single-use and expires in 10 minutes.`,
    flags: MessageFlags.Ephemeral,
  });

  // Fire the gating hook (no-op until U5) so a re-login refreshes roles.
  await Promise.resolve(reevaluateMember(interaction.user.id)).catch((err) =>
    console.error('Gating re-evaluation failed:', err),
  );
}
