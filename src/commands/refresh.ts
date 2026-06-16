import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import { loadConfig } from '../config';
import { getDb } from '../db/handle';
import { getLinkByDiscordId } from '../db/links';
import { isExpired } from '../andamio/jwt';
import { buildReloginPrompt } from '../discord/relogin-prompt';
import { reevaluateMember } from '../gating/triggers';

export const data = new SlashCommandBuilder()
  .setName('refresh')
  .setDescription('Re-check your Andamio credentials and update your roles.');

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  // Re-evaluation hits the Andamio API + the Discord API, so defer to stay
  // within the 3s interaction window. Ephemeral — only the invoker sees it.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const db = getDb();
  const config = loadConfig();
  const link = getLinkByDiscordId(db, interaction.user.id);

  // No usable JWT → offer the Connect button instead of a silent no-op (the
  // unattended sweep skips these members; an interactive /refresh prompts).
  if (!link || !link.user_jwt) {
    const prompt = buildReloginPrompt(
      db,
      interaction.user.id,
      config.appLoginBaseUrl,
      config.botCallbackBaseUrl,
      'connect',
    );
    await interaction.editReply(prompt);
    return;
  }
  if (isExpired(link.jwt_expires_at)) {
    const prompt = buildReloginPrompt(
      db,
      interaction.user.id,
      config.appLoginBaseUrl,
      config.botCallbackBaseUrl,
      'expired',
    );
    await interaction.editReply(prompt);
    return;
  }

  try {
    await reevaluateMember(interaction.user.id);
    await interaction.editReply({
      content:
        'Refreshed. Your roles now reflect your current Andamio credentials.',
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
