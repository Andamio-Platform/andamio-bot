/**
 * Role-mapping config: parse + validate the per-guild rules that translate
 * Andamio credentials into Discord roles.
 *
 * The config is a JSON array of rules read from `ROLE_MAPPINGS_PATH`. Each rule
 * is one of three types:
 *
 *   - `enrolled`        — grant `role_id` when the member is enrolled in (or has
 *                         completed) `course_id`.
 *   - `course-complete` — grant `role_id` when the member has completed
 *                         `course_id`.
 *   - `credential`      — grant `role_id` when the member has completed
 *                         `course_id` AND has claimed the credential `slt_hash`
 *                         within it. `slt_hash` is REQUIRED for this type.
 *
 * Validation is strict and fails fast at load with a message naming the
 * offending rule, so a typo in the config never silently disables gating.
 *
 * The set of `role_id`s referenced across all rules is the bot's MANAGED set:
 * the evaluator only ever adds/removes roles in this set, never touching any
 * other role a member holds.
 */

import * as fs from 'fs';

/** The three supported rule kinds. */
export type RuleType = 'enrolled' | 'credential' | 'course-complete';

const RULE_TYPES: readonly RuleType[] = ['enrolled', 'credential', 'course-complete'];

/** A single validated role-mapping rule. */
export interface MappingRule {
  type: RuleType;
  course_id: string;
  /** Required when `type` is `credential`; absent otherwise. */
  slt_hash?: string;
  role_id: string;
}

/** A loaded, validated set of rules plus the derived managed-role set. */
export interface Mappings {
  rules: MappingRule[];
  /** Every `role_id` referenced by a rule — the roles the bot manages. */
  managedRoleIds: Set<string>;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Validate a parsed JSON value into {@link Mappings}. Throws an `Error` with a
 * clear, rule-indexed message on any of: not an array, unknown/missing type,
 * missing `course_id`, missing `slt_hash` on a `credential` rule, or missing
 * `role_id`.
 */
export function parseMappings(parsed: unknown): Mappings {
  if (!Array.isArray(parsed)) {
    throw new Error(
      'Invalid role-mappings config: expected a JSON array of rules.',
    );
  }

  const rules: MappingRule[] = [];
  const managedRoleIds = new Set<string>();

  parsed.forEach((raw, i) => {
    const where = `rule #${i}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`Invalid role-mappings config: ${where} is not an object.`);
    }
    const r = raw as Record<string, unknown>;

    if (!isNonEmptyString(r.type) || !RULE_TYPES.includes(r.type as RuleType)) {
      throw new Error(
        `Invalid role-mappings config: ${where} has an unknown or missing ` +
          `"type" (got ${JSON.stringify(r.type)}); ` +
          `must be one of ${RULE_TYPES.join(', ')}.`,
      );
    }
    const type = r.type as RuleType;

    if (!isNonEmptyString(r.course_id)) {
      throw new Error(
        `Invalid role-mappings config: ${where} (type "${type}") is missing a ` +
          `non-empty "course_id".`,
      );
    }

    if (!isNonEmptyString(r.role_id)) {
      throw new Error(
        `Invalid role-mappings config: ${where} (type "${type}") is missing a ` +
          `non-empty "role_id".`,
      );
    }

    if (type === 'credential' && !isNonEmptyString(r.slt_hash)) {
      throw new Error(
        `Invalid role-mappings config: ${where} (type "credential") is missing ` +
          `a non-empty "slt_hash" — credential rules must name the specific ` +
          `credential to require.`,
      );
    }

    const rule: MappingRule = {
      type,
      course_id: r.course_id,
      role_id: r.role_id,
    };
    if (type === 'credential') rule.slt_hash = r.slt_hash as string;

    rules.push(rule);
    managedRoleIds.add(r.role_id);
  });

  return { rules, managedRoleIds };
}

/**
 * Read + validate the role-mappings file at `filePath`. Throws (fail-fast) on a
 * missing file, malformed JSON, or any validation error, so `index.ts` can
 * surface a clear startup error before the bot connects.
 */
export function loadMappings(filePath: string): Mappings {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(
      `Could not read role-mappings file at "${filePath}": ` +
        `${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Role-mappings file at "${filePath}" is not valid JSON: ` +
        `${(err as Error).message}`,
    );
  }

  return parseMappings(parsed);
}
