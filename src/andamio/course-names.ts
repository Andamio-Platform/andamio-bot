/**
 * Course display config: labels AND curation.
 *
 * The dashboard read returns course IDs, not human titles. This module owns the
 * optional `COURSE_DISPLAY_NAMES` env var (a JSON `course_id → display name`
 * object), which serves two purposes:
 *
 *   1. **Labels** — `displayNameFor` resolves a course id to a friendly name,
 *      falling back to the raw id when no mapping exists.
 *   2. **Curation** — when the map is non-empty it also acts as the allow-list of
 *      which courses the bot shows. `isDisplayed` hides any course NOT in the map
 *      so a focused server is not cluttered with a member's unrelated credentials.
 *
 * Two escapes keep this safe and flexible: an unset/empty map shows everything
 * (back-compat), and `SHOW_ALL_COURSES=true` forces all courses even with a map.
 * Gated courses (those named by a `role-mappings.json` rule) are always shown —
 * the server's own gate catalog can never hide itself.
 *
 * Deliberately decoupled from the role-mapping *file*: it does not read
 * role-mappings.json. Callers pass the gated course ids in. A missing or
 * malformed value falls back to "show everything with raw ids", never throwing.
 * (Documented in `.env.example` and the README.)
 */

export type CourseDisplayNames = Record<string, string>;

/**
 * Parse the optional `COURSE_DISPLAY_NAMES` JSON env var into a flat
 * `id → name` map. Returns `{}` for an unset, empty, malformed, or non-object
 * value, and silently drops non-string entries — display config must never
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

/**
 * The `SHOW_ALL_COURSES` escape: when true, curation is bypassed and every course
 * the member has is shown (labels still apply). Accepts `true`/`false`
 * case-insensitively; any other value (including unset) is treated as `false`.
 */
export function loadShowAllCourses(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (env.SHOW_ALL_COURSES ?? '').trim().toLowerCase() === 'true';
}

/** Resolve a course id to its display name, falling back to the raw id. */
export function displayNameFor(
  courseId: string,
  names: CourseDisplayNames,
): string {
  return names[courseId] ?? courseId;
}

/** Inputs that decide whether a given course is shown in the bot's output. */
export interface DisplayFilter {
  /** The curated `course_id → label` map (also the visibility allow-list). */
  names: CourseDisplayNames;
  /** `SHOW_ALL_COURSES` — bypass curation, show everything. */
  showAll: boolean;
  /** Courses named by a role-mapping rule; always shown (gate catalog). */
  gatedCourseIds: ReadonlySet<string>;
}

/**
 * Decide whether a course should appear in the bot's listings. The rule, in
 * order: show all when `SHOW_ALL_COURSES`; show everything when no map is
 * configured (back-compat); always show a gated course (the gate catalog never
 * hides itself); otherwise show only courses present in the curated map.
 */
export function isDisplayed(courseId: string, filter: DisplayFilter): boolean {
  if (filter.showAll) return true;
  if (Object.keys(filter.names).length === 0) return true;
  if (filter.gatedCourseIds.has(courseId)) return true;
  return courseId in filter.names;
}
