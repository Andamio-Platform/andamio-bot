/**
 * Channel → gating-role resolution for `/deny #channel`.
 *
 * A gated channel grants visibility by giving its **gating role** a View-allow
 * permission overwrite. To "block a member from this channel even with the
 * credential" we therefore deny the managed role(s) that gate it. This module
 * holds the one pure predicate that picks those roles out of a channel's
 * permission overwrites.
 *
 * It is deliberately discord.js-free: the command maps each
 * `PermissionOverwrites` to a flat {@link ChannelOverwrite} record and hands the
 * array here, so the predicate is unit-testable without a Discord client (the
 * same split `triggers.ts` uses to keep `evaluate()` pure).
 */

/**
 * The only three facts about a channel permission overwrite the predicate needs.
 * `type` collapses discord.js's `OverwriteType.Role`/`.Member`; `allowsView`
 * collapses whether the overwrite's *allow* bitfield includes `ViewChannel`.
 */
export interface ChannelOverwrite {
  /** The role or member id this overwrite targets. */
  id: string;
  /** Whether the overwrite targets a role or an individual member. */
  type: 'role' | 'member';
  /** True iff the overwrite's allow bitfield includes `ViewChannel`. */
  allowsView: boolean;
}

/**
 * Return the ids of the overwrites that gate `#channel` with a role the bot
 * manages — i.e. those that are (a) role-type, (b) allow `ViewChannel`, and
 * (c) in `managedRoleIds`. Order follows the input; a channel cannot hold two
 * overwrites for the same id, so no de-duplication is needed.
 *
 * All three conditions are load-bearing. Dropping (c) — the `managedRoleIds`
 * membership check — is the over-broad-denial bug this function exists to
 * prevent: without it, `/deny #channel` would deny *any* role with view access,
 * including roles the bot does not gate on. See `channel-roles.test.ts`.
 */
export function gatingRolesForChannel(
  overwrites: readonly ChannelOverwrite[],
  managedRoleIds: ReadonlySet<string>,
): string[] {
  return overwrites
    .filter(
      (o) => o.type === 'role' && o.allowsView && managedRoleIds.has(o.id),
    )
    .map((o) => o.id);
}
