import {
  loadCourseDisplayNames,
  loadShowAllCourses,
  type DisplayFilter,
} from '../andamio/course-names';
import { loadMappings } from '../gating/mappings';

/**
 * Build the curated-display filter shared by the course-listing commands
 * (`/credentials`, `/preview`, …): the `COURSE_DISPLAY_NAMES` labels map (which
 * doubles as the visibility allow-list), the `SHOW_ALL_COURSES` escape, and the
 * gated course ids from `role-mappings.json` (always shown — the gate catalog
 * never hides itself).
 *
 * `course-names.ts` deliberately does not read the role-mappings file (callers
 * pass the gated ids in), so this composition lives at the command layer where
 * both inputs are available. A config problem must never break a command, so a
 * failed mappings read falls back to an empty gated set.
 */
export function loadDisplayFilter(roleMappingsPath: string): DisplayFilter {
  const names = loadCourseDisplayNames();
  const showAll = loadShowAllCourses();
  let gatedCourseIds: ReadonlySet<string> = new Set();
  try {
    const mappings = loadMappings(roleMappingsPath);
    gatedCourseIds = new Set(mappings.rules.map((r) => r.course_id));
  } catch (err) {
    console.error(
      'Could not load role-mappings for course display curation:',
      err,
    );
  }
  return { names, showAll, gatedCourseIds };
}
