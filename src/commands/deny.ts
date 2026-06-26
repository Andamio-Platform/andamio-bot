import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import { loadConfig } from '../config';
import { getDb } from '../db/handle';
import { loadMappings } from '../gating/mappings';
import { reevaluateMember } from '../gating/triggers';
import { upsertDenial, FULL_BLOCK } from '../db/denials';
import { requireModerator } from './mod-auth';

export const data = new SlashCommandBuilder()
  .setName('deny')
  .setDescription(
    'Block a member from a gated role even if they hold the credential.',
  )
  .addUserOption((o) =>
    o.setName('member').setDescription('The member to block').setRequired(true),
  )
  .addRoleOption((o) =>
    o
      .setName('role')
      .setDescription('The gated role to withhold (omit to block all gated roles)'),
  )
  .addStringOption((o) =>
    o.setName('reason').setDescription('Why (shown in the /denials audit list)'),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const config = loadConfig();
  if (!(await requireModerator(interaction, config.modRoleId))) return;

  const target = interaction.options.getUser('member', true);
  const role = interaction.options.getRole('role');
  const reason = interaction.options.getString('reason');

  // A per-role denial must name a role this server actually gates on, else it
  // would be a no-op the sweep never enforces. Loading mappings also lets a full
  // block fail safe if config is broken.
  let managedRoleIds: ReadonlySet<string>;
  try {
    managedRoleIds = loadMappings(config.roleMappingsPath).managedRoleIds;
  } catch (err) {
    console.error('/deny: could not load role-mappings:', err);
    await interaction.reply({
      content:
        'Could not load this server’s role config right now. Please try ' +
        '`/deny` again shortly.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let roleId: string;
  if (role) {
    if (!managedRoleIds.has(role.id)) {
      await interaction.reply({
        content:
          `**${role.name}** is not a gated role, so denying it would have no ` +
          'effect. Pick a role this server gates on (see `/available`), or omit ' +
          'the role to block all gated roles.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    roleId = role.id;
  } else {
    roleId = FULL_BLOCK;
  }

  const db = getDb();
  upsertDenial(db, target.id, roleId, reason, interaction.user.id);
  const outcome = await reevaluateMember(target.id);

  const scope = role ? `<@&${role.id}>` : '**all gated roles**';
  const reasonLine = reason ? `\nReason: ${reason}` : '';

  // Report what actually happened, not an assumed success. The denial row is
  // always written; whether the live role dropped depends on the member's state.
  const removeFailed = role
    ? outcome.failed.includes(role.id)
    : outcome.failed.length > 0;

  let lead: string;
  if (outcome.status === 'skipped') {
    lead =
      `Recorded a block on <@${target.id}> for ${scope}. They aren’t connected ` +
      'right now, so it will apply automatically the next time they log in.';
  } else if (outcome.status === 'failed') {
    lead =
      `Recorded a block on <@${target.id}> for ${scope}. I couldn’t re-check ` +
      'their roles just now — it will be enforced on the next sweep.';
  } else if (removeFailed) {
    lead =
      `Recorded a block on <@${target.id}> for ${scope}, but I could not remove ` +
      'the role — it likely sits above my own role in Server Settings → Roles. ' +
      'Move my role above it, then run `/check` on the member.';
  } else {
    lead =
      `Denied <@${target.id}> from ${scope}. The block is live now and holds ` +
      'through every sweep until you `/allow` it.';
  }

  await interaction.reply({
    content: `${lead}${reasonLine}`,
    flags: MessageFlags.Ephemeral,
  });
}
