import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import { loadConfig } from '../config';
import { getDb } from '../db/handle';
import { reevaluateMember } from '../gating/triggers';
import {
  deleteDenial,
  deleteAllDenials,
  listDenials,
  FULL_BLOCK,
} from '../db/denials';
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

  // When a specific role is named, only lift it if a denial for THAT role
  // actually exists. Otherwise report honestly instead of a misleading success:
  // a full block is not a per-role block, and deleting a non-existent row is a
  // silent no-op that would leave the member still blocked.
  if (role) {
    const hasRoleDenial = existing.some((d) => d.role_id === role.id);
    if (!hasRoleDenial) {
      const hasFullBlock = existing.some((d) => d.role_id === FULL_BLOCK);
      const content = hasFullBlock
        ? `<@${target.id}> has a **full block**, not a block on just <@&${role.id}>. ` +
          `Run \`/allow @${target.username}\` with no role to lift it entirely.`
        : `<@${target.id}> has no block on <@&${role.id}> to lift.`;
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      return;
    }
    deleteDenial(db, target.id, role.id);
  } else {
    deleteAllDenials(db, target.id);
  }
  const outcome = await reevaluateMember(target.id);

  const scope = role ? `<@&${role.id}>` : '**all gated roles**';
  const tail =
    outcome.status === 'updated'
      ? 'Any role they’ve earned has been restored.'
      : 'Any role they’ve earned will return the next time they log in.';
  await interaction.reply({
    content: `Lifted the block on <@${target.id}> for ${scope}. ${tail}`,
    flags: MessageFlags.Ephemeral,
  });
}
