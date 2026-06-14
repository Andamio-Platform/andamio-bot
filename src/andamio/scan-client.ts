/**
 * andamioscan read client.
 *
 * Reads run entirely against andamioscan's PUBLIC endpoint:
 *   GET ${scanBaseUrl}/api/v2/users/{alias}/state
 * No JWT, no API key — credentials are read by alias. This is the single source
 * of truth for both `/credentials` (U4) and gating (U5).
 */

/** A completed course and the credentials (slt_hashes) the user has claimed in it. */
export interface CompletedCourse {
  courseId: string;
  claimedCredentials: string[];
}

/**
 * The subset of a user's andamioscan `/state` that this bot consumes. The scan
 * response carries more (`joined_projects`, `completed_projects`, …); only the
 * course fields matter for U4, and unknown/extra fields are tolerated.
 */
export interface UserState {
  alias: string;
  enrolledCourses: string[];
  completedCourses: CompletedCourse[];
}

/** Why a scan read failed, so the caller can branch (e.g. 404 = alias not found). */
export type ScanErrorKind = 'not-found' | 'http' | 'network';

/** A typed error the command layer can catch and render gracefully. */
export class ScanError extends Error {
  readonly kind: ScanErrorKind;
  /** HTTP status when `kind` is `http` or `not-found`; undefined for network errors. */
  readonly status?: number;

  constructor(kind: ScanErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ScanError';
    this.kind = kind;
    this.status = status;
  }
}

/** Raw shape of a completed-course entry in the scan JSON (snake_case). */
interface RawCompletedCourse {
  course_id?: unknown;
  claimed_credentials?: unknown;
}

/** Raw shape of the scan `/state` JSON (only the fields we read). */
interface RawUserState {
  alias?: unknown;
  enrolled_courses?: unknown;
  completed_courses?: unknown;
}

/** Coerce an unknown value into a string array, dropping non-strings. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** Map one raw completed-course entry to the typed shape. */
function toCompletedCourse(raw: unknown): CompletedCourse | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as RawCompletedCourse;
  if (typeof r.course_id !== 'string') return null;
  return {
    courseId: r.course_id,
    claimedCredentials: toStringArray(r.claimed_credentials),
  };
}

/** Map the raw snake_case scan response to the typed {@link UserState}. */
export function mapUserState(alias: string, raw: unknown): UserState {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as RawUserState;
  const completed = Array.isArray(r.completed_courses) ? r.completed_courses : [];
  return {
    // Prefer the alias the response echoes back, falling back to the requested one.
    alias: typeof r.alias === 'string' && r.alias !== '' ? r.alias : alias,
    enrolledCourses: toStringArray(r.enrolled_courses),
    completedCourses: completed
      .map(toCompletedCourse)
      .filter((c): c is CompletedCourse => c !== null),
  };
}

/**
 * Fetch a user's state from andamioscan by alias.
 *
 * Public read — sends no Authorization header. Throws a {@link ScanError} on a
 * non-200 response (404 → `not-found`) or a network failure so the command can
 * catch it and reply with a graceful ephemeral error.
 */
export async function getUserState(
  scanBaseUrl: string,
  alias: string,
): Promise<UserState> {
  const url = `${scanBaseUrl}/api/v2/users/${encodeURIComponent(alias)}/state`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    throw new ScanError(
      'network',
      `Network error reaching andamioscan: ${(err as Error).message}`,
    );
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new ScanError(
        'not-found',
        `Alias "${alias}" not found on andamioscan`,
        404,
      );
    }
    throw new ScanError(
      'http',
      `andamioscan returned HTTP ${response.status} for alias "${alias}"`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new ScanError(
      'http',
      `andamioscan returned a non-JSON body: ${(err as Error).message}`,
      response.status,
    );
  }

  return mapUserState(alias, body);
}
