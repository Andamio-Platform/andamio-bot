import { afterEach, describe, expect, it, vi } from 'vitest';

import { getUserDashboard, mapDashboard, ApiError } from './dashboard-client';

/** Build a minimal Response-like stub for the global fetch mock. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const BASE = 'https://api.andamio.io';
const KEY = 'ant_mn_operator-key';
const JWT = 'header.payload.sig';

/** A representative dashboard envelope. */
function dashboard(student: Record<string, unknown>, alias = 'alice'): unknown {
  return { data: { user: { alias }, student }, meta: {} };
}

describe('mapDashboard', () => {
  it('maps enrolled + credentials_by_course into UserState', () => {
    const state = mapDashboard(
      dashboard({
        enrolled_courses: [{ course_id: 'c_enrolled' }],
        completed_courses: [{ course_id: 'c_done' }],
        credentials_by_course: [
          { course_id: 'c_done', course_title: 'Done', credentials: ['slt_a', 'slt_b'] },
        ],
      }),
    );

    expect(state.alias).toBe('alice');
    expect(state.enrolledCourses).toEqual(['c_enrolled']);
    expect(state.completedCourses).toEqual([
      { courseId: 'c_done', claimedCredentials: ['slt_a', 'slt_b'] },
    ]);
  });

  it('includes a completed course with no credentials (course-complete rules)', () => {
    const state = mapDashboard(
      dashboard({
        completed_courses: [{ course_id: 'c_done' }],
        credentials_by_course: [],
      }),
    );
    expect(state.completedCourses).toEqual([
      { courseId: 'c_done', claimedCredentials: [] },
    ]);
  });

  it('includes a credentialed course even if absent from completed_courses', () => {
    const state = mapDashboard(
      dashboard({
        completed_courses: [],
        credentials_by_course: [{ course_id: 'c_x', credentials: ['slt_x'] }],
      }),
    );
    expect(state.completedCourses).toEqual([
      { courseId: 'c_x', claimedCredentials: ['slt_x'] },
    ]);
  });

  it('drops non-string credentials and entries without a course_id', () => {
    const state = mapDashboard(
      dashboard({
        credentials_by_course: [
          { course_id: 'c1', credentials: ['a', 7, null, 'b'] },
          { credentials: ['orphan'] }, // no course_id → dropped
        ],
      }),
    );
    expect(state.completedCourses).toEqual([
      { courseId: 'c1', claimedCredentials: ['a', 'b'] },
    ]);
  });

  it('tolerates a missing student / empty envelope', () => {
    expect(mapDashboard({})).toEqual({
      alias: '',
      enrolledCourses: [],
      completedCourses: [],
    });
    expect(mapDashboard({ data: {} })).toEqual({
      alias: '',
      enrolledCourses: [],
      completedCourses: [],
    });
  });
});

describe('getUserDashboard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs with X-API-Key + Authorization Bearer and maps the response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        dashboard({
          enrolled_courses: [{ course_id: 'c2' }],
          credentials_by_course: [{ course_id: 'c1', credentials: ['s1'] }],
        }),
      ),
    );

    const state = await getUserDashboard(BASE, KEY, JWT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v2/user/dashboard`);
    expect(init?.method).toBe('POST');

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['X-API-Key']).toBe(KEY);
    expect(headers['Authorization']).toBe(`Bearer ${JWT}`);

    expect(state.enrolledCourses).toEqual(['c2']);
    expect(state.completedCourses).toEqual([
      { courseId: 'c1', claimedCredentials: ['s1'] },
    ]);
  });

  it('treats 206 partial content as success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(dashboard({ enrolled_courses: [{ course_id: 'c2' }] }), 206),
    );
    const state = await getUserDashboard(BASE, KEY, JWT);
    expect(state.enrolledCourses).toEqual(['c2']);
  });

  it('throws an unauthorized ApiError on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 401));
    await expect(getUserDashboard(BASE, KEY, JWT)).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'unauthorized',
      status: 401,
    });
  });

  it('throws a not-found ApiError on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 404));
    const err = await getUserDashboard(BASE, KEY, JWT).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe('not-found');
  });

  it('throws an http ApiError on other non-2xx responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 500));
    const err = await getUserDashboard(BASE, KEY, JWT).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe('http');
    expect(err.status).toBe(500);
  });

  it('throws a network ApiError when fetch rejects', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const err = await getUserDashboard(BASE, KEY, JWT).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe('network');
  });
});
