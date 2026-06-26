import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import { loadConfig } from '../config';
import { getDb } from '../db/handle';
import { listDenials, FULL_BLOCK, type Denial } from '../db/denials';
import { requireModerator } from './mod-auth';
import { fitFieldValue } from './embed-field';

export const data = new SlashCommandBuilder()
  .setName('denials')
  .setDescription('List active moderator blocks (deny-list) for this server.')
  .addUserOption((o) =>
    o.setName('member').setDescription('Only show blocks on this member'),
  );

/**
 * Render the active deny-list. One line per denial: the blocked member, the role
 * (a `<@&id>` mention, or "all gated roles" for a full block), the reason, and
 * who set it. `fitFieldValue` keeps the field within Discord's 1024-char limit
 * so a long list can't make the reply throw. Exported for unit testing.
 */
export function renderDenialsEmbed(denials: Denial[]): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('Active moderator blocks');

  if (denials.length === 0) {
    embed.setDescription('No active denials.');
    return embed;
  }

  const lines = denials.map((d) => {
    const role =
      d.role_id === FULL_BLOCK ? '**all gated roles**' : `<@&${d.role_id}>`;
    const reason = d.reason ? ` — ${d.reason}` : '';
    return `• <@${d.discord_id}> · ${role}${reason} (by <@${d.created_by}>)`;
  });

  embed.setDescription('A member keeps a denied role withheld through every sweep.');
  embed.addFields({ name: 'Denials', value: fitFieldValue(lines) });
  return embed;
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const config = loadConfig();
  if (!(await requireModerator(interaction, config.modRoleId))) return;

  const target = interaction.options.getUser('member');
  const denials = listDenials(getDb(), target?.id);

  await interaction.reply({
    embeds: [renderDenialsEmbed(denials)],
    flags: MessageFlags.Ephemeral,
  });
}
