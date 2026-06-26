/**
 * Shared view model for the credential-gating commands.
 *
 * `/available` (the catalog) and `/check` (the focused gate check) both need the
 * same thing: the distinct credentials this server gates on, each tagged with
 * whether the member holds it. This module reduces the raw role-mapping rules to
 * that list once, so both commands render from a consistent source.
 */

import { displayNameFor, type CourseDisplayNames } from '../andamio/course-names';
import { ruleSatisfied } from '../gating/evaluator';
import type { Mappings, MappingRule } from '../gating/mappings';
import type { UserState } from '../andamio/dashboard-client';

/**
 * The trailing " — earn it: <url>" suffix shown after a credential the member
 * lacks. Returns `''` when there is no earn link. Centralized here (the module
 * that owns `GatedCredential`) so `/available`, `/check`, and `/faq` render the
 * earn link identically and cannot drift. The caller still decides *whether* to
 * show it (e.g. only for unheld credentials).
 */
export function earnSuffix(earnUrl?: string): string {
  return earnUrl ? ` — earn it: ${earnUrl}` : '';
}

/** One gated credential, resolved for display. */
export interface GatedCredential {
  /** Human label: the rule's `label`, else the course display name, else the id. */
  label: string;
  /** True only when a member state was supplied AND it satisfies the rule. */
  satisfied: boolean;
  /** Optional earn link (the rule's `earn_url`), shown when the member lacks it. */
  earnUrl?: string;
}

/**
 * The de-dupe key for a rule: the credential it requires. Several rules may grant
 * different roles from the same credential — we list the credential once.
 */
function credentialKey(rule: MappingRule): string {
  return `${rule.course_id}::${rule.slt_hash ?? rule.type}`;
}

/**
 * Reduce the role-mapping rules to the distinct credentials this server gates on.
 *
 * Pass `state` to tag each with whether the member holds it; omit it (an
 * unconnected member) and every `satisfied` is `false` — callers should then
 * present the catalog without a ✓/✗ claim rather than implying "not held".
 */
export function gatedCredentials(
  mappings: Mappings,
  names: CourseDisplayNames,
  state?: UserState,
): GatedCredential[] {
  const seen = new Set<string>();
  const out: GatedCredential[] = [];
  for (const rule of mappings.rules) {
    const key = credentialKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label: rule.label ?? displayNameFor(rule.course_id, names),
      satisfied: state !== undefined && ruleSatisfied(rule, state),
      earnUrl: rule.earn_url,
    });
  }
  return out;
}
