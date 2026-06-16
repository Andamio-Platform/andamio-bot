/**
 * Optional course display-name lookup.
 *
 * The dashboard read returns course IDs, not human titles. This module provides an
 * OPTIONAL `course_id → display name` map so `/credentials` can show friendly
 * names, DEFAULTING to the raw `course_id` when no mapping exists.
 *
 * Deliberately decoupled from U5's role-mapping config — it does NOT read the
 * role-mappings file. The map comes from an optional `COURSE_DISPLAY_NAMES`
 * env var holding a JSON object (e.g. `{"course_abc":"Cardano 101"}`). A
 * missing or malformed value falls back to raw IDs, never throwing.
 *
 * TODO(U6 docs): document `COURSE_DISPLAY_NAMES` in `.env.example` / README and
 * note that it is independent of `role-mappings.json`.
 */

export type CourseDisplayNames = Record<string, string>;

/**
 * Parse the optional `COURSE_DISPLAY_NAMES` JSON env var into a flat
 * `id → name` map. Returns `{}` for an unset, empty, malformed, or non-object
 * value, and silently drops non-string entries — display names must never
 * break the command.
 */
export function loadCourseDisplayNames(
  env: NodeJS.ProcessEnv = process.env,
): CourseDisplayNames {
  const raw = env.COURSE_DISPLAY_NAMES;
  if (!raw || raw.trim() === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const out: CourseDisplayNames = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** Resolve a course id to its display name, falling back to the raw id. */
export function displayNameFor(
  courseId: string,
  names: CourseDisplayNames,
): string {
  return names[courseId] ?? courseId;
}
