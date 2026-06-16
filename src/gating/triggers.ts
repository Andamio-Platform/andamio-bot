/**
 * Gating re-evaluation triggers.
 *
 * `reevaluateMember(discordId)` is the single entry point fired after any event
 * that may change a member's desired roles:
 *   - a successful `/login` link (U3)
 *   - `/refresh` (U5)
 *   - `guildMemberAdd` (U5)
 *   - the periodic sweep, via `reevaluateAll()` (U5)
 *
 * The signature `(discordId) => Promise<void>` is fixed — U3's call sites
 * (login command, callback web server) call it fire-and-forget and must keep
 * working unchanged.
 *
 * Dependencies (discord.js client, config, loaded mappings) can't be passed
 * through that signature, so they're injected once at boot via `initGating(...)`
 * — mirroring how `db/handle.ts` shares the db with reflectively-loaded
 * commands. Until `initGating` runs, the triggers are a safe no-op.
 */

import type { Client, GuildMember } from 'discord.js';

import type { Config } from '../config';
import { getDb } from '../db/handle';
import { getAllLinks, getLinkByDiscordId } from '../db/links';
import { getUserDashboard, ApiError } from '../andamio/dashboard-client';
import { isExpired } from '../andamio/jwt';
import { evaluate, unconnectedDiff, type RoleDiff } from './evaluator';
import type { Mappings } from './mappings';

interface GatingDeps {
  client: Client;
  config: Config;
  mappings: Mappings;
}

let deps: GatingDeps | null = null;

/**
 * Wire the gating triggers with their runtime dependencies. Called once from
 * `index.ts` after the client, config, and mappings exist. Idempotent —
 * re-calling just replaces the deps (useful in tests).
 */
export function initGating(next: GatingDeps): void {
  deps = next;
}

/** For tests: drop the wired deps so triggers fall back to the safe no-op. */
export function resetGating(): void {
  deps = null;
}

/**
 * Resolve a guild member by Discord id, or `null` if they aren't in the guild
 * (left, or never joined). Uses the cache then falls back to a fetch.
 */
async function fetchMember(
  deps: GatingDeps,
  discordId: string,
): Promise<GuildMember | null> {
  const guild = deps.client.guilds.cache.get(deps.config.guildId);
  if (!guild) return null;
  try {
    return await guild.members.fetch(discordId);
  } catch {
    // Unknown member (10007) or any fetch failure → treat as not present.
    return null;
  }
}

/** Apply a managed-role diff to a guild member. */
async function applyDiff(member: GuildMember, diff: RoleDiff): Promise<void> {
  for (const roleId of diff.add) {
    await member.roles.add(roleId, 'Andamio gating: credential satisfied');
  }
  for (const roleId of diff.remove) {
    await member.roles.remove(roleId, 'Andamio gating: credential no longer satisfied');
  }
}

/**
 * Re-evaluate one member's managed roles against their Andamio state and apply
 * the diff. Safe to call fire-and-forget — it swallows its own errors (logging
 * them) and never throws, so a single bad member can't break a sweep or a
 * login confirmation.
 *
 * Behaviour:
 *   - Gating not initialised → no-op.
 *   - Member not in the guild → no-op (nothing to apply roles to).
 *   - Member UNCONNECTED (no link) → remove any managed roles they hold, add
 *     none. Connecting is required to earn credential roles.
 *   - Member connected but with NO usable JWT (never captured, or expired) →
 *     leave roles unchanged. End-user JWTs cannot be refreshed unattended, so
 *     this member simply re-gates the next time they `/login` or `/refresh`
 *     (where the Connect button is offered). No role churn on a stale token.
 *   - Member connected with a valid JWT → read the dashboard, diff, apply. A
 *     `not-found` is treated like "no credentials yet" (remove managed roles);
 *     a 401 (operator key / revoked token) or any transient error aborts this
 *     member without changing roles.
 */
export async function reevaluateMember(discordId: string): Promise<void> {
  if (!deps) return; // Not initialised (e.g. in unit tests) — safe no-op.
  const d = deps;

  try {
    const member = await fetchMember(d, discordId);
    if (!member) return;

    const currentRoles = member.roles.cache.map((r) => r.id);
    const link = getLinkByDiscordId(getDb(), discordId);

    // Unconnected: ensure NO managed roles (remove any present, add none).
    if (!link) {
      await applyDiff(member, unconnectedDiff(currentRoles, d.mappings));
      return;
    }

    // Connected but no usable JWT → cannot read state unattended; leave roles
    // as-is (re-gates on next interactive /login or /refresh).
    if (!link.user_jwt || isExpired(link.jwt_expires_at)) {
      return;
    }

    let state;
    try {
      state = await getUserDashboard(
        d.config.andamioApiBaseUrl,
        d.config.andamioApiKey,
        link.user_jwt,
      );
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'not-found') {
        // Connected but no on-chain state yet → no credential roles.
        await applyDiff(member, unconnectedDiff(currentRoles, d.mappings));
        return;
      }
      // 401 points at the operator key (or a revoked token), not the member —
      // log it distinctly. Any other error is transient. Either way, don't
      // churn roles on a failed read.
      if (err instanceof ApiError && err.kind === 'unauthorized') {
        console.error(
          `Gating: Andamio API 401 for "${link.alias}" (${discordId}) — ` +
            `check ANDAMIO_API_KEY:`,
          err.message,
        );
      } else {
        console.error(
          `Gating: dashboard read failed for "${link.alias}" (${discordId}):`,
          err,
        );
      }
      return;
    }

    await applyDiff(member, evaluate(state, currentRoles, d.mappings));
  } catch (err) {
    console.error(`Gating: reevaluateMember failed for ${discordId}:`, err);
  }
}

/**
 * Re-evaluate every connected member (the periodic sweep). Iterates all stored
 * links and re-evaluates each in turn. Errors per member are swallowed inside
 * `reevaluateMember`, so the sweep always completes.
 */
export async function reevaluateAll(): Promise<void> {
  if (!deps) return;
  const links = getAllLinks(getDb());
  for (const link of links) {
    await reevaluateMember(link.discord_id);
  }
}
