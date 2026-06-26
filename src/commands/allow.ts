import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import { loadConfig } from '../config';
import { getDb } from '../db/handle';
import { reevaluateMember } from '../gating/triggers';
import { deleteDenial, deleteAllDenials, listDenials } from '../db/denials';
import { requireModerator } from './mod-auth';

export const data = new SlashCommandBuilder()
  .setName('allow')
  .setDescription('Lift a moderator block on a member.')
  .addUserOption((o) =>
    o.setName('member').setDescription('The member to unblock').setRequired(true),
  )
  .addRoleOption((o) =>
    o
      .setName('role')
      .setDescription('The role to unblock (omit to lift all blocks on them)'),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const config = loadConfig();
  if (!(await requireModerator(interaction, config.modRoleId))) return;

  const target = interaction.options.getUser('member', true);
  const role = interaction.options.getRole('role');
  const db = getDb();

  // Friendly no-op when there is nothing to lift, so a mod isn't left wondering
  // whether the command worked.
  const existing = listDenials(db, target.id);
  if (existing.length === 0) {
    await interaction.reply({
      content: `<@${target.id}> has no active moderator blocks.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (role) {
    deleteDenial(db, target.id, role.id);
  } else {
    deleteAllDenials(db, target.id);
  }
  await reevaluateMember(target.id);

  const scope = role ? `<@&${role.id}>` : '**all gated roles**';
  await interaction.reply({
    content:
      `Lifted the block on <@${target.id}> for ${scope}. Any role they’ve ` +
      'earned will return on the next check.',
    flags: MessageFlags.Ephemeral,
  });
}
