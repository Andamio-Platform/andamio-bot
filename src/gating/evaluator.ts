/**
 * Gating evaluator — a PURE function from (member state, current roles, mappings)
 * to the set of managed-role changes to apply.
 *
 * It computes the DESIRED managed-role set from the member's Andamio state, then
 * diffs it against the member's CURRENT roles RESTRICTED to the managed set:
 *
 *   - `add`    = desired managed roles the member does not yet have.
 *   - `remove` = managed roles the member has but no longer satisfies.
 *
 * Hard guarantee: every id in `add`/`remove` is in `mappings.managedRoleIds`.
 * Roles outside the managed set are never touched — the diff cannot revoke a
 * moderator/booster/etc. role just because it isn't credential-derived.
 */

import type { UserState } from '../andamio/dashboard-client';
import type { Mappings, MappingRule } from './mappings';

/** The managed-role changes to apply to a member. */
export interface RoleDiff {
  add: string[];
  remove: string[];
}

/** True if `state` satisfies a single rule (so its `role_id` is desired). */
export function ruleSatisfied(rule: MappingRule, state: UserState): boolean {
  const completed = state.completedCourses.find(
    (c) => c.courseId === rule.course_id,
  );

  switch (rule.type) {
    case 'enrolled':
      // Enrolled is satisfied by active enrollment OR completion (completing a
      // course implies you were enrolled in it).
      return (
        state.enrolledCourses.includes(rule.course_id) || completed !== undefined
      );
    case 'course-complete':
      return completed !== undefined;
    case 'credential':
      // Must have completed the course AND claimed the specific credential.
      return (
        completed !== undefined &&
        rule.slt_hash !== undefined &&
        completed.claimedCredentials.includes(rule.slt_hash)
      );
    default:
      return false;
  }
}

/**
 * Compute the DESIRED managed-role set for a member's state. A managed role is
 * desired if ANY rule mapping to it is satisfied (rules are OR'd per role).
 */
export function desiredRoles(state: UserState, mappings: Mappings): Set<string> {
  const desired = new Set<string>();
  for (const rule of mappings.rules) {
    if (ruleSatisfied(rule, state)) desired.add(rule.role_id);
  }
  return desired;
}

/**
 * Diff a member's desired managed roles against the roles they currently hold.
 *
 * @param state         the member's Andamio state (from andamioscan).
 * @param currentRoles  every role id the member currently has (managed + not).
 * @param mappings      the loaded role mappings (defines the managed set).
 */
export function evaluate(
  state: UserState,
  currentRoles: Iterable<string>,
  mappings: Mappings,
): RoleDiff {
  const desired = desiredRoles(state, mappings);
  const current = new Set(currentRoles);
  const managed = mappings.managedRoleIds;

  const add: string[] = [];
  for (const roleId of desired) {
    // desired only ever contains managed roles, but stay defensive.
    if (managed.has(roleId) && !current.has(roleId)) add.push(roleId);
  }

  const remove: string[] = [];
  for (const roleId of current) {
    // Only ever consider managed roles for removal — never anything else.
    if (managed.has(roleId) && !desired.has(roleId)) remove.push(roleId);
  }

  return { add, remove };
}

/**
 * The diff for a member with NO Andamio link (unconnected): they get no
 * credential-derived roles, and any managed role they currently hold is removed.
 * Unmanaged roles are untouched.
 */
export function unconnectedDiff(
  currentRoles: Iterable<string>,
  mappings: Mappings,
): RoleDiff {
  const managed = mappings.managedRoleIds;
  const remove: string[] = [];
  for (const roleId of currentRoles) {
    if (managed.has(roleId)) remove.push(roleId);
  }
  return { add: [], remove };
}
