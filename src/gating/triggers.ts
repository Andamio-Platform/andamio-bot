/**
 * Gating re-evaluation triggers.
 *
 * `reevaluateMember(discordId)` is the single entry point fired after any event
 * that may change a member's desired roles:
 *   - a successful `/login` link (U3)
 *   - `/check` (U5)
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

import { RESTJSONErrorCodes, type Client, type GuildMember } from 'discord.js';

import type { Config } from '../config';
import { getDb } from '../db/handle';
import {
  clearExpiredJwts,
  deleteMemberData,
  deleteStalePending,
  getAllLinks,
  getLinkByDiscordId,
} from '../db/links';
import { getDeniedRoleIds } from '../db/denials';
import {
  getUserDashboard,
  ApiError,
  type UserState,
} from '../andamio/dashboard-client';
import { isExpired } from '../andamio/jwt';
import { PENDING_TTL_MS } from '../andamio/login';
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

/** Bound a Discord member fetch so a hung call can't pin the sweep guard. */
const FETCH_MEMBER_TIMEOUT_MS = 10_000;

/** Reject `p` if it has not settled within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Discord error codes that mean the member is definitely not in the guild
 * (Unknown User covers a deleted account).
 */
const MEMBER_GONE_CODES = new Set<number>([
  RESTJSONErrorCodes.UnknownMember,
  RESTJSONErrorCodes.UnknownUser,
]);

/** True when `err` is Discord's authoritative "this member is not here" answer. */
function isMemberGone(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' && MEMBER_GONE_CODES.has(code);
}

/**
 * Result of a guild-member lookup. `gone` is only Discord's explicit
 * unknown-member/user answer; a missing guild, a timeout, or any other error is
 * `unavailable`, because those say nothing about whether the member left.
 */
type MemberLookup =
  | { kind: 'member'; member: GuildMember }
  | { kind: 'gone' }
  | { kind: 'unavailable' };

/**
 * Resolve a guild member by Discord id. The timeout matters for the periodic
 * sweep: a Discord fetch that never settles would otherwise pin the
 * re-entrancy guard and silently stop all gating.
 */
async function fetchMember(
  deps: GatingDeps,
  discordId: string,
): Promise<MemberLookup> {
  const guild = deps.client.guilds.cache.get(deps.config.guildId);
  if (!guild) return { kind: 'unavailable' };
  try {
    const member = await withTimeout(
      guild.members.fetch(discordId),
      FETCH_MEMBER_TIMEOUT_MS,
    );
    return member ? { kind: 'member', member } : { kind: 'unavailable' };
  } catch (err) {
    return isMemberGone(err) ? { kind: 'gone' } : { kind: 'unavailable' };
  }
}

/**
 * Handle a member leaving the server: delete their link and pending logins
 * (deny-list rows stay). Ignores leaves from any guild other than the gated
 * one. Never throws.
 */
export function onMemberLeft(guildId: string, discordId: string): void {
  if (!deps || guildId !== deps.config.guildId) return;
  try {
    deleteMemberData(getDb(), discordId);
  } catch (err) {
    console.error(`Gating: failed to delete data for departed ${discordId}:`, err);
  }
}

/**
 * Apply a managed-role diff to a guild member. Each role op is isolated: a
 * single failing add/remove (e.g. a managed role positioned above the bot's
 * own role, or a transient Discord error) is logged and skipped so it cannot
 * abort the rest of the diff or leave gating wedged on one bad role.
 *
 * Returns the role ids whose op FAILED, so an interactive caller (e.g. `/deny`)
 * can tell a moderator the block did not actually land — a role positioned
 * above the bot can never be removed, and silently reporting success would be a
 * lie. Fire-and-forget callers ignore the return.
 */
async function applyDiff(member: GuildMember, diff: RoleDiff): Promise<string[]> {
  const failed: string[] = [];
  for (const roleId of diff.add) {
    try {
      await member.roles.add(roleId, 'Andamio gating: credential satisfied');
    } catch (err) {
      console.error(`Gating: failed to add role ${roleId} to ${member.id}:`, err);
      failed.push(roleId);
    }
  }
  for (const roleId of diff.remove) {
    try {
      await member.roles.remove(
        roleId,
        'Andamio gating: credential no longer satisfied',
      );
    } catch (err) {
      console.error(
        `Gating: failed to remove role ${roleId} from ${member.id}:`,
        err,
      );
      failed.push(roleId);
    }
  }
  return failed;
}

/** Coarse status of a re-evaluation. */
export type ReevaluationResult = 'updated' | 'skipped' | 'failed';

/**
 * Full outcome of a re-evaluation. `status` is the coarse result; `failed` lists
 * managed-role ids whose Discord apply op failed (e.g. positioned above the bot)
 * so an interactive caller can report honestly instead of assuming success.
 */
export interface ReevaluationOutcome {
  status: ReevaluationResult;
  failed: string[];
}

const skipped: ReevaluationOutcome = { status: 'skipped', failed: [] };
const failedOutcome: ReevaluationOutcome = { status: 'failed', failed: [] };

/**
 * Re-evaluate one member's managed roles against their Andamio state and apply
 * the diff. Safe to call fire-and-forget — it swallows its own errors (logging
 * them) and never throws, so a single bad member can't break a sweep or a
 * login confirmation.
 *
 * Behaviour:
 *   - Gating not initialised → no-op.
 *   - Discord says the member is not in the guild (unknown member/user) →
 *     delete their link and pending logins (deny-list rows stay). This runs
 *     on every caller (sweep, login callback, `/check`, `/deny`, `/allow`,
 *     rejoin), and catches anyone who left while the bot was offline.
 *   - Member lookup failed otherwise (timeout, other error, guild not cached)
 *     → no-op; that says nothing about whether they left.
 *   - Member UNCONNECTED (no link) → remove any managed roles they hold, add
 *     none. Connecting is required to earn credential roles.
 *   - Member connected but with NO usable JWT (never captured, or expired) →
 *     leave roles unchanged. End-user JWTs cannot be refreshed unattended, so
 *     this member simply re-gates the next time they `/login` or `/check`
 *     (where the Connect button is offered). No role churn on a stale token.
 *   - Member connected with a valid JWT → read the dashboard, diff, apply. Only
 *     an authoritative, complete success (HTTP 200) ever removes roles. A
 *     PARTIAL read (206 — a degraded upstream), a `not-found`, a 401 (operator
 *     key / revoked token), or any transient error leaves roles unchanged, so a
 *     blip in the API never strips the whole guild's gated roles.
 *
 * Returns the {@link ReevaluationOutcome} (status + any roles whose Discord apply
 * failed) so an interactive caller can report honestly. Still never throws —
 * fire-and-forget callers may ignore the result.
 */
export async function reevaluateMember(
  discordId: string,
): Promise<ReevaluationOutcome> {
  if (!deps) return skipped; // Not initialised (e.g. in unit tests).
  const d = deps;

  try {
    const lookup = await fetchMember(d, discordId);
    if (lookup.kind === 'gone') {
      // Left while the bot wasn't watching (e.g. it was offline): the leave
      // event never fired, so drop their data here instead.
      deleteMemberData(getDb(), discordId);
      return skipped;
    }
    if (lookup.kind !== 'member') return skipped;
    const member = lookup.member;

    const currentRoles = member.roles.cache.map((r) => r.id);
    const link = getLinkByDiscordId(getDb(), discordId);

    // Unconnected: ensure NO managed roles (remove any present, add none).
    if (!link) {
      const failed = await applyDiff(member, unconnectedDiff(currentRoles, d.mappings));
      return { status: 'updated', failed };
    }

    // Connected but no usable JWT → cannot read state unattended; leave roles
    // as-is (re-gates on next interactive /login or /check).
    if (!link.user_jwt || isExpired(link.jwt_expires_at)) {
      return skipped;
    }

    let result;
    try {
      result = await getUserDashboard(
        d.config.andamioApiBaseUrl,
        d.config.andamioApiKey,
        link.user_jwt,
      );
    } catch (err) {
      // Never churn roles on a failed read. 401 points at the operator key (or
      // a revoked token), not the member — log it distinctly. A `not-found` is
      // treated as a transient/edge condition, NOT authoritative "no
      // credentials" (that arrives as a successful 200 with an empty state).
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
      return failedOutcome;
    }

    // Degraded (partial) data must not drive role REMOVAL — skip rather than
    // risk stripping roles the member legitimately holds.
    if (result.partial) {
      console.error(
        `Gating: partial (206) dashboard for "${link.alias}" (${discordId}) — ` +
          `skipping to avoid churning roles on incomplete data.`,
      );
      return skipped;
    }

    // Subtract any moderator deny-list entries: the db read lives here (we hold
    // the handle), the evaluator stays pure. Re-read every call so a denial
    // added between sweeps takes effect on the very next tick.
    const denied = getDeniedRoleIds(getDb(), discordId, d.mappings.managedRoleIds);
    const failed = await applyDiff(
      member,
      evaluate(result.state, currentRoles, d.mappings, denied),
    );
    return { status: 'updated', failed };
  } catch (err) {
    console.error(`Gating: reevaluateMember failed for ${discordId}:`, err);
    return failedOutcome;
  }
}

/**
 * Apply gating to one member from an ALREADY-FETCHED dashboard state.
 *
 * This is the read-once path for an interactive command (`/check`) that has just
 * read the dashboard for display: instead of making {@link reevaluateMember}
 * fetch it a second time, the command passes the state straight in. It reuses
 * the same guild-member fetch + per-role-isolated apply as the sweep.
 *
 * The caller MUST pass only a COMPLETE (non-partial) state — partial/degraded
 * reads must never drive role removal (the command skips this call when its read
 * was partial). Returns the outcome; never throws.
 */
export async function gateMemberFromState(
  discordId: string,
  state: UserState,
): Promise<ReevaluationOutcome> {
  if (!deps) return skipped;
  const d = deps;
  try {
    const lookup = await fetchMember(d, discordId);
    if (lookup.kind !== 'member') return skipped;
    const member = lookup.member;
    const currentRoles = member.roles.cache.map((r) => r.id);
    // Same deny-list subtraction as the sweep, so a member cannot `/check`
    // their way back into a denied role.
    const denied = getDeniedRoleIds(getDb(), discordId, d.mappings.managedRoleIds);
    const failed = await applyDiff(
      member,
      evaluate(state, currentRoles, d.mappings, denied),
    );
    return { status: 'updated', failed };
  } catch (err) {
    console.error(`Gating: gateMemberFromState failed for ${discordId}:`, err);
    return failedOutcome;
  }
}

/** Guards against overlapping sweeps (a slow sweep outrunning its interval). */
let sweepInProgress = false;

/**
 * Re-evaluate every connected member (the periodic sweep). Iterates all stored
 * links and re-evaluates each in turn. Errors per member are swallowed inside
 * `reevaluateMember`, so the sweep always completes.
 *
 * Re-entrant calls are dropped: if a previous sweep is still running (e.g. a
 * large guild or a slow API made it outlast the interval), a new tick returns
 * immediately rather than running a second concurrent sweep that would double
 * the API load and race on the same members' roles.
 */
export async function reevaluateAll(): Promise<void> {
  if (!deps) return;
  if (sweepInProgress) {
    console.warn('Gating: previous sweep still running — skipping this tick.');
    return;
  }
  sweepInProgress = true;
  try {
    // An expired token can't be used again (the member must reconnect), and an
    // abandoned login can't be completed, so don't keep either. Links stay.
    // A cleanup failure must not cost the member loop its tick.
    try {
      const now = Date.now();
      clearExpiredJwts(getDb(), now);
      deleteStalePending(getDb(), now - PENDING_TTL_MS);
    } catch (err) {
      console.error('Gating: sweep cleanup failed:', err);
    }
    const links = getAllLinks(getDb());
    for (const link of links) {
      await reevaluateMember(link.discord_id);
    }
  } finally {
    sweepInProgress = false;
  }
}
