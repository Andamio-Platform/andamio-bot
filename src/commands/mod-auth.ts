import {
  ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';

/**
 * Moderator authorization for the deny-list commands (`/deny`, `/allow`,
 * `/denials`).
 *
 * A member is a moderator when they have Discord's native **Manage Roles**
 * permission, OR (when `MOD_ROLE_ID` is configured) they hold that role. The
 * check is enforced server-side inside each command's `execute` — never relying
 * on Discord's command-visibility defaults alone, which an admin can misconfigure.
 */

/** True when the interacting member holds `roleId`, across both member shapes. */
function memberHasRole(
  interaction: ChatInputCommandInteraction,
  roleId: string,
): boolean {
  const roles = interaction.member?.roles;
  if (!roles) return false;
  // Raw API member (uncached): roles is a string[] of ids.
  if (Array.isArray(roles)) return roles.includes(roleId);
  // Cached GuildMember: roles is a GuildMemberRoleManager with a .cache.
  return roles.cache?.has(roleId) ?? false;
}

/**
 * Whether the interacting member may run the moderator commands. `memberPermissions`
 * is null outside a guild context, which correctly resolves to "not a moderator".
 */
export function isModerator(
  interaction: ChatInputCommandInteraction,
  modRoleId?: string,
): boolean {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
    return true;
  }
  if (modRoleId && memberHasRole(interaction, modRoleId)) {
    return true;
  }
  return false;
}

/**
 * Guard for the top of a moderator command's `execute`: returns true for a
 * moderator, otherwise replies with an ephemeral refusal and returns false so
 * the caller can `return` immediately. No mutation happens on the false path.
 */
export async function requireModerator(
  interaction: ChatInputCommandInteraction,
  modRoleId?: string,
): Promise<boolean> {
  if (isModerator(interaction, modRoleId)) return true;
  await interaction.reply({
    content:
      'You need the **Manage Roles** permission (or the server’s configured ' +
      'moderator role) to use this command.',
    flags: MessageFlags.Ephemeral,
  });
  return false;
}
