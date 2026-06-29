/**
 * Andamio API course-content read client.
 *
 * A display-only sibling to {@link ./dashboard-client}. It reads course modules,
 * SLTs, lessons, assignments (all public — operator `X-API-Key` only) and a
 * member's assignment commitments (authenticated — operator key + member
 * `Authorization: Bearer <JWT>`).
 *
 * Why a separate module: `dashboard-client` is load-bearing for role gating —
 * its `partial`/`isDegraded` contract decides whether the gating sweep may strip
 * roles. Content reads are display-only and must NEVER feed role removal, so they
 * live here with their own mappers. A content-endpoint contract drift can never
 * destabilize the gate. The one thing the two share is the {@link ApiError}
 * taxonomy (re-exported below) so command-layer `catch` branches stay uniform.
 *
 * Shape note: the response field names below are source-mapped from the API, not
 * contract-guaranteed (see the PR plan, KTD5). Every mapper is therefore TOTAL —
 * it tolerates a `{ data: ... }` envelope OR a bare body, coerces types
 * defensively, drops malformed entries, and never throws on shape. Only the fetch
 * layer throws, and only {@link ApiError}. A drift degrades to empty content in
 * the eventual embed, never to a crash. Fixtures backing the mapper tests live in
 * `src/andamio/__fixtures__/content/` (shapes currently UNCONFIRMED — see that
 * directory's README).
 */

import { ApiError, type ApiErrorKind } from './dashboard-client';

// Re-export so content consumers can import the error taxonomy from one place.
export { ApiError };
export type { ApiErrorKind };

/** A course module as surfaced for previews/progress. */
export interface CourseModule {
  title: string;
  description: string;
  imageUrl: string;
  isLive: boolean;
  moduleCode: string;
}

/** A Student Learning Target within a module. */
export interface ModuleSlt {
  sltText: string;
  sltIndex: number;
  hasLesson: boolean;
}

/** Rendered lesson content (Tiptap `contentJson` passed through opaquely). */
export interface LessonContent {
  title: string;
  description: string;
  imageUrl: string;
  videoUrl: string;
  /** Opaque Tiptap document; rendering is a later PR's concern. */
  contentJson: unknown;
}

/** Rendered assignment content (same shape as a lesson). */
export interface AssignmentContent {
  title: string;
  description: string;
  imageUrl: string;
  videoUrl: string;
  /** Opaque Tiptap document; rendering is a later PR's concern. */
  contentJson: unknown;
}

/**
 * A member's commitment status for one module's assignment. Known values are
 * listed for editor hints; the `(string & {})` arm keeps the type total so a
 * new server-side status passes through verbatim instead of being dropped.
 */
export type CommitmentStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'REFUSED'
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

/** One assignment commitment, keyed by course + module. */
export interface AssignmentCommitment {
  courseId: string;
  moduleCode: string;
  status: CommitmentStatus;
}

// --- defensive coercion helpers (mirrors dashboard-client's tolerant mapping) ---

/** A string, or `''` for anything else. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * A boolean from the common JSON encodings: real booleans, the strings
 * `'true'`/`'false'`, or numbers (0 → false, non-zero → true). Anything else is
 * false. Avoids `Boolean('false') === true` foot-guns.
 */
function asBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  if (typeof value === 'number') return value !== 0;
  return false;
}

/** A finite number (including 0), or `null` for anything else. */
function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Coerce to an array, or `[]` for anything else. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Read an object property, or `undefined` if `value` isn't an object. */
function prop(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Unwrap an optional `{ data: ... }` envelope. The dashboard endpoint wraps its
 * payload in `data`; the content endpoints' envelope is source-mapped but
 * unconfirmed, so this tolerates either: if the body is an object carrying a
 * `data` property, use that; otherwise use the body as-is.
 */
function unwrap(body: unknown): unknown {
  if (typeof body === 'object' && body !== null && 'data' in body) {
    return (body as { data: unknown }).data;
  }
  return body;
}

// --- pure mappers (unknown → typed, total, never throw) ---

/** Map a modules response into {@link CourseModule}[]. Drops entries with no module code. */
export function mapModules(raw: unknown): CourseModule[] {
  return asArray(unwrap(raw))
    .map((entry): CourseModule | null => {
      const moduleCode = asString(prop(entry, 'course_module_code'));
      if (moduleCode === '') return null; // a module with no code is unusable
      return {
        title: asString(prop(entry, 'title')),
        description: asString(prop(entry, 'description')),
        imageUrl: asString(prop(entry, 'image_url')),
        isLive: asBool(prop(entry, 'is_live')),
        moduleCode,
      };
    })
    .filter((m): m is CourseModule => m !== null);
}

/** Map an SLTs response into {@link ModuleSlt}[]. Drops entries with no numeric index. */
export function mapSlts(raw: unknown): ModuleSlt[] {
  return asArray(unwrap(raw))
    .map((entry): ModuleSlt | null => {
      const sltIndex = asNumber(prop(entry, 'slt_index'));
      if (sltIndex === null) return null; // index keys the SLT; 0 is valid, null is not
      return {
        sltText: asString(prop(entry, 'slt_text')),
        sltIndex,
        hasLesson: asBool(prop(entry, 'has_lesson')),
      };
    })
    .filter((s): s is ModuleSlt => s !== null);
}

/** Map a lesson response into {@link LessonContent}. Missing fields default to empty. */
export function mapLesson(raw: unknown): LessonContent {
  const data = unwrap(raw);
  return {
    title: asString(prop(data, 'title')),
    description: asString(prop(data, 'description')),
    imageUrl: asString(prop(data, 'image_url')),
    videoUrl: asString(prop(data, 'video_url')),
    contentJson: prop(data, 'content_json') ?? null,
  };
}

/** Map an assignment response into {@link AssignmentContent}. Missing fields default to empty. */
export function mapAssignment(raw: unknown): AssignmentContent {
  const data = unwrap(raw);
  return {
    title: asString(prop(data, 'title')),
    description: asString(prop(data, 'description')),
    imageUrl: asString(prop(data, 'image_url')),
    videoUrl: asString(prop(data, 'video_url')),
    contentJson: prop(data, 'content_json') ?? null,
  };
}

/**
 * Map a commitments response into {@link AssignmentCommitment}[]. Drops entries
 * missing a course id or module code. The `status` string is passed through
 * verbatim so an unrecognized server-side status survives to the display layer.
 */
export function mapCommitments(raw: unknown): AssignmentCommitment[] {
  return asArray(unwrap(raw))
    .map((entry): AssignmentCommitment | null => {
      const courseId = asString(prop(entry, 'course_id'));
      const moduleCode = asString(prop(entry, 'course_module_code'));
      if (courseId === '' || moduleCode === '') return null;
      return {
        courseId,
        moduleCode,
        status: asString(prop(entry, 'status')),
      };
    })
    .filter((c): c is AssignmentCommitment => c !== null);
}

// --- fetch layer ---

/** Abort a content request that has not responded within this many ms. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Build the base headers, adding a Bearer only when a member JWT is supplied. */
function authHeaders(apiKey: string, jwt?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'X-API-Key': apiKey,
    Accept: 'application/json',
  };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return headers;
}

/**
 * Perform a bounded fetch and return the parsed JSON body, mapping every failure
 * to an {@link ApiError}: network/timeout → `network`, 401 → `unauthorized`,
 * 404 → `not-found`, any other non-2xx → `http`, a non-JSON 2xx body → `http`.
 * 2xx (including 206) is success — content reads have no partial-content concept.
 */
async function andamioFetch(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
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
      throw new ApiError('not-found', 'Andamio content not found', 404);
    }
    throw new ApiError(
      'http',
      `Andamio API returned HTTP ${response.status}`,
      response.status,
    );
  }

  try {
    return await response.json();
  } catch (err) {
    throw new ApiError(
      'http',
      `Andamio API returned a non-JSON body: ${(err as Error).message}`,
      response.status,
    );
  }
}

/** GET with the operator key (and an optional member Bearer). */
function andamioGet(url: string, apiKey: string, jwt?: string): Promise<unknown> {
  return andamioFetch(url, { method: 'GET', headers: authHeaders(apiKey, jwt) });
}

/** POST a JSON body with the operator key (and an optional member Bearer). */
function andamioPost(
  url: string,
  apiKey: string,
  body: unknown,
  jwt?: string,
): Promise<unknown> {
  return andamioFetch(url, {
    method: 'POST',
    headers: { ...authHeaders(apiKey, jwt), 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

// --- public read functions (operator X-API-Key only) ---

/** List a course's modules (live + draft; caller filters on `isLive`). */
export async function getCourseModules(
  apiBaseUrl: string,
  apiKey: string,
  courseId: string,
): Promise<CourseModule[]> {
  const url = `${apiBaseUrl}/api/v2/course/user/modules/${encodeURIComponent(courseId)}`;
  return mapModules(await andamioGet(url, apiKey));
}

/** List a module's SLTs. */
export async function getModuleSlts(
  apiBaseUrl: string,
  apiKey: string,
  courseId: string,
  moduleCode: string,
): Promise<ModuleSlt[]> {
  const url = `${apiBaseUrl}/api/v2/course/user/slts/${encodeURIComponent(courseId)}/${encodeURIComponent(moduleCode)}`;
  return mapSlts(await andamioGet(url, apiKey));
}

/** Read a single lesson's content. */
export async function getLesson(
  apiBaseUrl: string,
  apiKey: string,
  courseId: string,
  moduleCode: string,
  sltIndex: number,
): Promise<LessonContent> {
  const url = `${apiBaseUrl}/api/v2/course/user/lesson/${encodeURIComponent(courseId)}/${encodeURIComponent(moduleCode)}/${encodeURIComponent(sltIndex)}`;
  return mapLesson(await andamioGet(url, apiKey));
}

/** Read a module's assignment content. */
export async function getAssignment(
  apiBaseUrl: string,
  apiKey: string,
  courseId: string,
  moduleCode: string,
): Promise<AssignmentContent> {
  const url = `${apiBaseUrl}/api/v2/course/user/assignment/${encodeURIComponent(courseId)}/${encodeURIComponent(moduleCode)}`;
  return mapAssignment(await andamioGet(url, apiKey));
}

// --- authenticated read function (operator key + member Bearer) ---

/**
 * Read the member's assignment commitments. Sends the operator `X-API-Key` and
 * the member's `Authorization: Bearer` (the Bearer selects whose commitments).
 * Throws {@link ApiError} `unauthorized` on 401 — the branch a command catches to
 * trigger the reconnect prompt.
 */
export async function getAssignmentCommitments(
  apiBaseUrl: string,
  apiKey: string,
  jwt: string,
): Promise<AssignmentCommitment[]> {
  const url = `${apiBaseUrl}/api/v2/course/student/assignment-commitments/list`;
  return mapCommitments(await andamioPost(url, apiKey, {}, jwt));
}
