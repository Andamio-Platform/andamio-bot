/**
 * Andamio API dashboard read client.
 *
 * Reads a member's credentials/courses from the AUTHENTICATED API:
 *   POST ${apiBaseUrl}/api/v2/user/dashboard
 *   X-API-Key: <operator key>           — authenticates the bot operator
 *   Authorization: Bearer <member JWT>  — selects WHOSE dashboard to read
 *
 * The dashboard is scoped to the Bearer JWT's user (its `accessTokenAlias`),
 * which is exactly the linked member — there is no by-alias parameter. The
 * response is mapped into {@link UserState}, the same shape the gating evaluator
 * and `/credentials` already consume.
 */

/** A completed course and the credentials (slt_hashes) the member has claimed in it. */
export interface CompletedCourse {
  courseId: string;
  claimedCredentials: string[];
}

/** The subset of a member's dashboard this bot consumes for gating + `/credentials`. */
export interface UserState {
  alias: string;
  enrolledCourses: string[];
  completedCourses: CompletedCourse[];
}

/**
 * A dashboard read result. `partial` is true when the API returned HTTP 206 —
 * one upstream source was degraded, so `state` may be incomplete. Destructive
 * consumers (role gating) must NOT remove roles on a partial read; display
 * consumers (`/credentials`) may show it as-is.
 */
export interface DashboardResult {
  state: UserState;
  partial: boolean;
}

/** Why a dashboard read failed, so the caller can branch (401 → reconnect, etc.). */
export type ApiErrorKind = 'unauthorized' | 'not-found' | 'http' | 'network';

/** A typed error the command/gating layer can catch and render gracefully. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** HTTP status when `kind` is `unauthorized`/`not-found`/`http`; undefined for network errors. */
  readonly status?: number;

  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

/** Coerce an unknown value into a string array, dropping non-strings. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** Read `course_id` from a raw `{ course_id, ... }` entry, or null if absent. */
function courseIdOf(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const id = (raw as { course_id?: unknown }).course_id;
  return typeof id === 'string' ? id : null;
}

/**
 * Map the dashboard response envelope (`{ data: { student, user, ... } }`) into
 * {@link UserState}. Credentials live in `student.credentials_by_course`;
 * completed courses without credentials still come through via
 * `student.completed_courses` (so `course-complete` rules fire). Unknown/extra
 * fields are tolerated.
 */
export function mapDashboard(raw: unknown): UserState {
  const data =
    (typeof raw === 'object' && raw !== null
      ? (raw as { data?: unknown }).data
      : undefined) ?? {};
  const student =
    (typeof data === 'object' && data !== null
      ? (data as { student?: unknown }).student
      : undefined) ?? {};
  const s = student as {
    enrolled_courses?: unknown;
    completed_courses?: unknown;
    credentials_by_course?: unknown;
  };
  const user =
    (typeof data === 'object' && data !== null
      ? (data as { user?: unknown }).user
      : undefined) ?? {};
  const alias = (user as { alias?: unknown }).alias;

  const enrolledCourses = (
    Array.isArray(s.enrolled_courses) ? s.enrolled_courses : []
  )
    .map(courseIdOf)
    .filter((id): id is string => id !== null);

  // course_id -> claimed slt_hashes, from credentials_by_course.
  const creds = new Map<string, string[]>();
  const byCourse = Array.isArray(s.credentials_by_course)
    ? s.credentials_by_course
    : [];
  for (const entry of byCourse) {
    const id = courseIdOf(entry);
    if (id === null) continue;
    // `credentials` is an array of bare slt_hash strings; toStringArray drops
    // anything non-string. If the API ever nests them as objects, this would
    // silently empty — pin the element type here if that contract changes.
    const credentials = toStringArray(
      (entry as { credentials?: unknown }).credentials,
    );
    creds.set(id, credentials);
  }

  // completedCourses = every completed course, plus any course that carries
  // credentials, each with its claimed credentials (default []).
  const completedIds = new Set<string>();
  for (const entry of Array.isArray(s.completed_courses)
    ? s.completed_courses
    : []) {
    const id = courseIdOf(entry);
    if (id !== null) completedIds.add(id);
  }
  for (const id of creds.keys()) completedIds.add(id);

  const completedCourses: CompletedCourse[] = [...completedIds].map(
    (courseId) => ({
      courseId,
      claimedCredentials: creds.get(courseId) ?? [],
    }),
  );

  return {
    alias: typeof alias === 'string' ? alias : '',
    enrolledCourses,
    completedCourses,
  };
}

/** Abort a dashboard request that has not responded within this many ms. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Fetch a member's dashboard and map it to {@link UserState}.
 *
 * Sends the operator `X-API-Key` and the member's `Authorization: Bearer`.
 * Throws an {@link ApiError} on 401 (`unauthorized`), 404 (`not-found`), any
 * other non-2xx (`http`), or a network/timeout failure (`network`). 200 and 206
 * are both successes; 206 (partial content — one upstream source degraded) is
 * flagged via {@link DashboardResult.partial} so gating can decline to churn.
 * The request is bounded by a timeout so a hung API can't stall the sweep.
 */
export async function getUserDashboard(
  apiBaseUrl: string,
  apiKey: string,
  userJwt: string,
): Promise<DashboardResult> {
  const url = `${apiBaseUrl}/api/v2/user/dashboard`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        Authorization: `Bearer ${userJwt}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiError(
      'network',
      `Network error reaching the Andamio API: ${(err as Error).message}`,
    );
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new ApiError('unauthorized', 'Andamio API returned 401', 401);
    }
    if (response.status === 404) {
      throw new ApiError('not-found', 'Andamio dashboard not found', 404);
    }
    throw new ApiError(
      'http',
      `Andamio API returned HTTP ${response.status}`,
      response.status,
    );
  }

  const partial = response.status === 206;

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new ApiError(
      'http',
      `Andamio API returned a non-JSON body: ${(err as Error).message}`,
      response.status,
    );
  }

  return { state: mapDashboard(body), partial };
}
