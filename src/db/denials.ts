import type { Db } from './index';

/**
 * Moderation deny-list.
 *
 * A denial withholds a *managed* role from a member even when their Andamio
 * credentials would earn it. The gating evaluator subtracts the member's denied
 * roles from the desired set on every re-evaluation (login, `/check`, the
 * periodic sweep), so a block is re-asserted each tick rather than eroded by it.
 *
 * This module mirrors `links.ts`: a plain interface plus prepared-statement
 * functions taking the `Db` handle first. The evaluator never touches this
 * module — `triggers.ts` reads the deny set (it already holds the db handle) and
 * passes it into the pure `evaluate()`.
 */

/**
 * Sentinel `role_id` meaning "all managed roles" — a full block. A real Discord
 * role id is a numeric snowflake string, so `'*'` can never collide with one.
 * `getDeniedRoleIds` expands it to the concrete managed-role set at read time, so
 * the evaluator only ever sees real role ids.
 */
export const FULL_BLOCK = '*';

/** A persisted denial: one withheld role (or a full block) for one member. */
export interface Denial {
  discord_id: string;
  /** A managed role id, or {@link FULL_BLOCK} for "all managed roles". */
  role_id: string;
  reason: string | null;
  /** Discord id of the moderator who set the denial. */
  created_by: string;
  created_at: number;
}

/**
 * Insert or update a denial. Re-denying the same `(discord_id, role_id)`
 * refreshes `reason`, `created_by`, and `created_at` (PK upsert). Pass
 * {@link FULL_BLOCK} as `roleId` for a full block.
 */
export function upsertDenial(
  db: Db,
  discordId: string,
  roleId: string,
  reason: string | null,
  createdBy: string,
): void {
  db.prepare(
    `INSERT INTO denials (discord_id, role_id, reason, created_by, created_at)
     VALUES (@discord_id, @role_id, @reason, @created_by, @created_at)
     ON CONFLICT(discord_id, role_id) DO UPDATE SET
       reason = excluded.reason,
       created_by = excluded.created_by,
       created_at = excluded.created_at`,
  ).run({
    discord_id: discordId,
    role_id: roleId,
    reason,
    created_by: createdBy,
    created_at: Date.now(),
  });
}

/** Delete one member's denial for a specific role. No-op if it does not exist. */
export function deleteDenial(db: Db, discordId: string, roleId: string): void {
  db.prepare(`DELETE FROM denials WHERE discord_id = ? AND role_id = ?`).run(
    discordId,
    roleId,
  );
}

/**
 * Delete every denial for a member (lifts per-role denials AND a full block).
 * Used by `/allow @member` with no role argument. No-op if none exist.
 */
export function deleteAllDenials(db: Db, discordId: string): void {
  db.prepare(`DELETE FROM denials WHERE discord_id = ?`).run(discordId);
}

/**
 * Return the concrete set of role ids to withhold from a member: each per-role
 * denial's `role_id`, plus — when a {@link FULL_BLOCK} row is present — every id
 * in `managedRoleIds`. This is the only function the gating path consumes; it
 * hides the sentinel so the evaluator receives a flat set of real role ids.
 */
export function getDeniedRoleIds(
  db: Db,
  discordId: string,
  managedRoleIds: ReadonlySet<string>,
): Set<string> {
  const rows = db
    .prepare(`SELECT role_id FROM denials WHERE discord_id = ?`)
    .all(discordId) as { role_id: string }[];

  const denied = new Set<string>();
  for (const { role_id } of rows) {
    if (role_id === FULL_BLOCK) {
      for (const id of managedRoleIds) denied.add(id);
    } else {
      denied.add(role_id);
    }
  }
  return denied;
}

/**
 * List active denials, newest first. With `discordId`, scope to one member;
 * without it, return every member's denials. Used by the `/denials` audit view.
 */
export function listDenials(db: Db, discordId?: string): Denial[] {
  if (discordId !== undefined) {
    return db
      .prepare(
        `SELECT * FROM denials WHERE discord_id = ? ORDER BY created_at DESC`,
      )
      .all(discordId) as Denial[];
  }
  return db
    .prepare(`SELECT * FROM denials ORDER BY created_at DESC`)
    .all() as Denial[];
}
