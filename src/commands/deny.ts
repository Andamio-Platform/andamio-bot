import {
  ChatInputCommandInteraction,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

import { loadConfig } from '../config';
import { getDb } from '../db/handle';
import { loadMappings } from '../gating/mappings';
import { reevaluateMember, type ReevaluationOutcome } from '../gating/triggers';
import { upsertDenial, FULL_BLOCK } from '../db/denials';
import { gatingRolesForChannel, type ChannelOverwrite } from '../gating/channel-roles';
import { requireModerator } from './mod-auth';

/**
 * Build the moderator-facing lead line for a deny, reporting what actually
 * happened rather than an assumed success. The denial row is always written
 * first; whether the live role(s) dropped depends on the member's state, so the
 * message is keyed on the re-evaluation `outcome` plus `removeFailed` (did a
 * managed-role removal fail, e.g. a role positioned above the bot's own role).
 *
 * `scope` is the caller's phrase for what was denied — a role mention, the
 * joined mentions of a channel's gating roles, or "all gated roles". Shared by
 * every `/deny` addressing mode so their wording cannot drift apart.
 */
function denyOutcomeLead(
  outcome: ReevaluationOutcome,
  scope: string,
  removeFailed: boolean,
  targetId: string,
): string {
  if (outcome.status === 'skipped') {
    return (
      `Recorded a block on <@${targetId}> for ${scope}. They aren’t connected ` +
      'right now, so it will apply automatically the next time they log in.'
    );
  }
  if (outcome.status === 'failed') {
    return (
      `Recorded a block on <@${targetId}> for ${scope}. I couldn’t re-check ` +
      'their roles just now — it will be enforced on the next sweep.'
    );
  }
  if (removeFailed) {
    return (
      `Recorded a block on <@${targetId}> for ${scope}, but I could not remove ` +
      'the role — it likely sits above my own role in Server Settings → Roles. ' +
      'Move my role above it, then run `/check` on the member.'
    );
  }
  return (
    `Denied <@${targetId}> from ${scope}. The block is live now and holds ` +
    'through every sweep until you `/allow` it.'
  );
}

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
  .addChannelOption((o) =>
    o
      .setName('channel')
      .setDescription(
        'Block them from this channel — I’ll find the role(s) that gate it',
      ),
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
  const channel = interaction.options.getChannel('channel');
  const reason = interaction.options.getString('reason');

  // The three addressing modes are mutually exclusive in intent. A channel AND a
  // role together is ambiguous, so reject rather than guess — checked before the
  // config load so a transient config blip can't mask a usage error.
  if (channel && role) {
    await interaction.reply({
      content:
        'Pick one — a channel or a role, not both. Use `channel` to block ' +
        'every role that gates it, or `role` to block a specific role.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // A per-role denial must name a role this server actually gates on, else it
  // would be a no-op the sweep never enforces. Loading mappings also lets a full
  // block fail safe if config is broken, and feeds the channel→roles resolver.
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

  const reasonLine = reason ? `\nReason: ${reason}` : '';

  // Channel mode: resolve the managed role(s) that gate the channel (allow
  // ViewChannel ∧ managed) and deny each. A snapshot of today's gating roles.
  if (channel) {
    const overwrites: ChannelOverwrite[] =
      'permissionOverwrites' in channel
        ? channel.permissionOverwrites.cache.map((ow) => ({
            id: ow.id,
            type: ow.type === OverwriteType.Role ? 'role' : 'member',
            allowsView: ow.allow.has(PermissionFlagsBits.ViewChannel),
          }))
        : [];
    const roleIds = gatingRolesForChannel(overwrites, managedRoleIds);

    if (roleIds.length === 0) {
      await interaction.reply({
        content:
          `<#${channel.id}> isn’t gated by any role I manage, so there’s ` +
          'nothing to block. Use `/deny @member role:@role` if you mean a ' +
          'specific role.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const db = getDb();
    for (const id of roleIds) {
      upsertDenial(db, target.id, id, reason, interaction.user.id);
    }
    // One re-evaluation after writing every row — the sweep applies them together.
    const outcome = await reevaluateMember(target.id);

    const scope = roleIds.map((id) => `<@&${id}>`).join(', ');
    const removeFailed = roleIds.some((id) => outcome.failed.includes(id));
    const lead = denyOutcomeLead(outcome, scope, removeFailed, target.id);

    await interaction.reply({
      content: `${lead}${reasonLine}`,
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

  // The denial row is always written; whether the live role dropped depends on
  // the member's state. `denyOutcomeLead` reports that honestly.
  const removeFailed = role
    ? outcome.failed.includes(role.id)
    : outcome.failed.length > 0;
  const lead = denyOutcomeLead(outcome, scope, removeFailed, target.id);

  await interaction.reply({
    content: `${lead}${reasonLine}`,
    flags: MessageFlags.Ephemeral,
  });
}
