import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getUserState,
  mapUserState,
  ScanError,
} from './scan-client';

/** Build a minimal Response-like stub for the global fetch mock. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const BASE = 'https://preprod.api.andamio.io';

describe('mapUserState', () => {
  it('maps snake_case /state fields to the typed shape', () => {
    const raw = {
      alias: 'alice',
      enrolled_courses: ['course_in_progress'],
      completed_courses: [
        {
          course_id: 'course_done',
          claimed_credentials: ['slt_a', 'slt_b'],
        },
      ],
    };

    const state = mapUserState('alice', raw);
    expect(state.alias).toBe('alice');
    expect(state.enrolledCourses).toEqual(['course_in_progress']);
    expect(state.completedCourses).toEqual([
      { courseId: 'course_done', claimedCredentials: ['slt_a', 'slt_b'] },
    ]);
  });

  it('tolerates unknown/extra fields and missing arrays', () => {
    const raw = {
      alias: 'bob',
      joined_projects: ['p1'],
      completed_projects: [{ project_id: 'x' }],
      something_new: 42,
      // no enrolled_courses, no completed_courses
    };
    const state = mapUserState('bob', raw);
    expect(state.alias).toBe('bob');
    expect(state.enrolledCourses).toEqual([]);
    expect(state.completedCourses).toEqual([]);
  });

  it('falls back to the requested alias when the body omits it', () => {
    const state = mapUserState('carol', { enrolled_courses: [] });
    expect(state.alias).toBe('carol');
  });

  it('drops malformed completed-course entries and non-string credentials', () => {
    const raw = {
      completed_courses: [
        { course_id: 'ok', claimed_credentials: ['a', 7, null, 'b'] },
        { claimed_credentials: ['x'] }, // no course_id → dropped
        'not-an-object',
      ],
    };
    const state = mapUserState('dave', raw);
    expect(state.completedCourses).toEqual([
      { courseId: 'ok', claimedCredentials: ['a', 'b'] },
    ]);
  });
});

describe('getUserState', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches the public endpoint and maps the response — no auth header sent', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse({
          alias: 'alice',
          enrolled_courses: ['c2'],
          completed_courses: [
            { course_id: 'c1', claimed_credentials: ['s1', 's2'] },
          ],
        }),
      );

    const state = await getUserState(BASE, 'alice');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v2/users/alice/state`);

    // AE5: public read — assert NO Authorization header is sent.
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const headerKeys = Object.keys(headers).map((k) => k.toLowerCase());
    expect(headerKeys).not.toContain('authorization');

    expect(state.completedCourses[0]).toEqual({
      courseId: 'c1',
      claimedCredentials: ['s1', 's2'],
    });
    expect(state.enrolledCourses).toEqual(['c2']);
  });

  it('url-encodes the alias path segment', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ alias: 'a b', enrolled_courses: [] }));
    await getUserState(BASE, 'a b');
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/v2/users/a%20b/state`);
  });

  it('throws a not-found ScanError on HTTP 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 404));
    await expect(getUserState(BASE, 'ghost')).rejects.toMatchObject({
      name: 'ScanError',
      kind: 'not-found',
      status: 404,
    });
  });

  it('throws an http ScanError on other non-200 responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 500));
    const err = await getUserState(BASE, 'alice').catch((e) => e);
    expect(err).toBeInstanceOf(ScanError);
    expect(err.kind).toBe('http');
    expect(err.status).toBe(500);
  });

  it('throws a network ScanError when fetch rejects', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const err = await getUserState(BASE, 'alice').catch((e) => e);
    expect(err).toBeInstanceOf(ScanError);
    expect(err.kind).toBe('network');
  });
});
