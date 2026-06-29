import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getAssignment,
  getAssignmentCommitments,
  getCourseModules,
  getLesson,
  getModuleSlts,
  mapAssignment,
  mapCommitments,
  mapLesson,
  mapModules,
  mapSlts,
  ApiError,
} from './content-client';

import modulesFixture from './__fixtures__/content/modules.json';
import sltsFixture from './__fixtures__/content/slts.json';
import lessonFixture from './__fixtures__/content/lesson.json';
import assignmentFixture from './__fixtures__/content/assignment.json';
import commitmentsFixture from './__fixtures__/content/commitments.json';

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
const CID = 'course_abc';
const MODULE = '101';

// --- mappers (U3/U4): pinned to the captured fixtures + envelope/totality ---

describe('mapModules', () => {
  it('maps the modules fixture, coercing is_live to boolean', () => {
    const modules = mapModules(modulesFixture);
    expect(modules).toEqual([
      {
        title: 'Getting Started',
        description: 'Orientation to the course and how to navigate it.',
        imageUrl: 'https://cdn.andamio.io/courses/intro/module-101.png',
        isLive: true,
        moduleCode: '101',
      },
      {
        title: 'Core Concepts',
        description: 'The foundational ideas you will build on.',
        imageUrl: 'https://cdn.andamio.io/courses/intro/module-102.png',
        isLive: true,
        moduleCode: '102',
      },
      {
        title: 'Draft Module (not yet published)',
        description: 'Work in progress — should be filtered out by is_live.',
        imageUrl: '',
        isLive: false,
        moduleCode: '103',
      },
    ]);
  });

  it('unwraps a { data: [...] } envelope (shape-agnostic)', () => {
    expect(mapModules({ data: modulesFixture })).toEqual(mapModules(modulesFixture));
  });

  it('tolerates an empty array, missing body, and non-array body', () => {
    expect(mapModules([])).toEqual([]);
    expect(mapModules({})).toEqual([]);
    expect(mapModules(undefined)).toEqual([]);
    expect(mapModules('garbage')).toEqual([]);
  });

  it('drops a module entry missing course_module_code', () => {
    const modules = mapModules([
      { title: 'Keep', course_module_code: '201', is_live: true },
      { title: 'Drop — no code', is_live: true },
    ]);
    expect(modules).toHaveLength(1);
    expect(modules[0].moduleCode).toBe('201');
  });

  it('coerces string/number encodings of is_live', () => {
    const modules = mapModules([
      { course_module_code: 'a', is_live: 'true' },
      { course_module_code: 'b', is_live: 'false' },
      { course_module_code: 'c', is_live: 1 },
      { course_module_code: 'd', is_live: 0 },
    ]);
    expect(modules.map((m) => m.isLive)).toEqual([true, false, true, false]);
  });
});

describe('mapSlts', () => {
  it('maps the slts fixture, preserving slt_index 0 and coercing has_lesson', () => {
    const slts = mapSlts(sltsFixture);
    expect(slts).toEqual([
      {
        sltText: 'I can describe what Andamio is and who it is for.',
        sltIndex: 0,
        hasLesson: true,
      },
      {
        sltText: 'I can navigate the course interface.',
        sltIndex: 1,
        hasLesson: true,
      },
      {
        sltText: 'I can explain a concept that has no lesson yet.',
        sltIndex: 2,
        hasLesson: false,
      },
    ]);
  });

  it('drops an entry with a non-numeric slt_index but keeps index 0', () => {
    const slts = mapSlts([
      { slt_text: 'zero', slt_index: 0 },
      { slt_text: 'missing index' },
      { slt_text: 'string index', slt_index: 'nope' },
    ]);
    expect(slts.map((s) => s.sltIndex)).toEqual([0]);
  });

  it('tolerates empty / missing / enveloped bodies', () => {
    expect(mapSlts([])).toEqual([]);
    expect(mapSlts({})).toEqual([]);
    expect(mapSlts({ data: sltsFixture })).toEqual(mapSlts(sltsFixture));
  });
});

describe('mapLesson', () => {
  it('maps the lesson fixture and passes content_json through opaquely', () => {
    const lesson = mapLesson(lessonFixture);
    expect(lesson.title).toBe('What is Andamio?');
    expect(lesson.description).toBe('A short orientation to the platform.');
    expect(lesson.imageUrl).toBe('https://cdn.andamio.io/courses/intro/lesson-101-0.png');
    expect(lesson.videoUrl).toBe('https://video.andamio.io/intro/101-0.mp4');
    expect(lesson.contentJson).toEqual((lessonFixture as { content_json: unknown }).content_json);
  });

  it('unwraps a { data: {...} } envelope', () => {
    expect(mapLesson({ data: lessonFixture })).toEqual(mapLesson(lessonFixture));
  });

  it('defaults every field on a missing/empty body and nulls absent content_json', () => {
    expect(mapLesson({})).toEqual({
      title: '',
      description: '',
      imageUrl: '',
      videoUrl: '',
      contentJson: null,
    });
    expect(mapLesson(undefined).contentJson).toBeNull();
  });
});

describe('mapAssignment', () => {
  it('maps every field of the assignment fixture', () => {
    expect(mapAssignment(assignmentFixture)).toEqual({
      title: 'Module 101 Assignment',
      description: 'Demonstrate that you can navigate the course.',
      imageUrl: 'https://cdn.andamio.io/courses/intro/assignment-101.png',
      videoUrl: '',
      contentJson: (assignmentFixture as { content_json: unknown }).content_json,
    });
  });

  it('tolerates missing/enveloped bodies', () => {
    expect(mapAssignment({}).title).toBe('');
    expect(mapAssignment({ data: assignmentFixture })).toEqual(
      mapAssignment(assignmentFixture),
    );
  });

  // mapLesson and mapAssignment are deliberately identical today (the API
  // returns the same shape for both). Pin that identity so a field added to
  // one mapper but not the other fails loudly instead of silently diverging.
  it('produces the same result as mapLesson for an identical body', () => {
    const body = {
      title: 'Same',
      description: 'Same body',
      image_url: 'https://cdn.andamio.io/x.png',
      video_url: 'https://video.andamio.io/x.mp4',
      content_json: { type: 'doc', content: [] },
    };
    expect(mapAssignment(body)).toEqual(mapLesson(body));
  });
});

describe('mapCommitments', () => {
  it('maps the commitments fixture into course/module/status rows', () => {
    const commitments = mapCommitments(commitmentsFixture);
    expect(commitments).toEqual([
      {
        courseId: 'ae192632aabe00ed2042eaef596bc15f3887fa32e75e8f9b8fa516df',
        moduleCode: '101',
        status: 'APPROVED',
      },
      {
        courseId: 'ae192632aabe00ed2042eaef596bc15f3887fa32e75e8f9b8fa516df',
        moduleCode: '102',
        status: 'SUBMITTED',
      },
      {
        courseId: 'ae192632aabe00ed2042eaef596bc15f3887fa32e75e8f9b8fa516df',
        moduleCode: '104',
        status: 'REFUSED',
      },
    ]);
  });

  it('passes an unrecognized status string through verbatim', () => {
    const commitments = mapCommitments([
      { course_id: 'c', course_module_code: '1', status: 'FUTURE_STATUS' },
    ]);
    expect(commitments[0].status).toBe('FUTURE_STATUS');
  });

  it('drops a commitment missing its course id or module code', () => {
    const commitments = mapCommitments([
      { course_id: 'c', course_module_code: '1', status: 'DRAFT' },
      { course_id: 'c', status: 'DRAFT' }, // no module code → dropped
      { course_module_code: '2', status: 'DRAFT' }, // no course id → dropped
    ]);
    expect(commitments).toHaveLength(1);
    expect(commitments[0]).toEqual({
      courseId: 'c',
      moduleCode: '1',
      status: 'DRAFT',
    });
  });

  it('tolerates empty / missing / enveloped bodies', () => {
    expect(mapCommitments([])).toEqual([]);
    expect(mapCommitments({})).toEqual([]);
    expect(mapCommitments({ data: commitmentsFixture })).toEqual(
      mapCommitments(commitmentsFixture),
    );
  });
});

// --- public read functions (U3): URL + header split + mapping ---

describe('public read functions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Assert a public call sent X-API-Key but no member Bearer. */
  function expectPublicHeaders(init: RequestInit | undefined): void {
    expect(init?.method).toBe('GET');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['X-API-Key']).toBe(KEY);
    expect(headers['Authorization']).toBeUndefined();
  }

  it('getCourseModules GETs the modules path with X-API-Key only', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(modulesFixture));

    const modules = await getCourseModules(BASE, KEY, CID);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v2/course/user/modules/${CID}`);
    expectPublicHeaders(init);
    expect(modules).toHaveLength(3);
  });

  it('getModuleSlts builds the slts path, sends X-API-Key only, and maps the body', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(sltsFixture));
    const slts = await getModuleSlts(BASE, KEY, CID, MODULE);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v2/course/user/slts/${CID}/${MODULE}`);
    expectPublicHeaders(init);
    expect(slts).toEqual(mapSlts(sltsFixture));
  });

  it('getLesson builds the lesson path, sends X-API-Key only, and maps the body', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(lessonFixture));
    const lesson = await getLesson(BASE, KEY, CID, MODULE, 0);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v2/course/user/lesson/${CID}/${MODULE}/0`);
    expectPublicHeaders(init);
    expect(lesson.title).toBe('What is Andamio?');
  });

  it('getAssignment builds the assignment path, sends X-API-Key only, and maps the body', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(assignmentFixture));
    const assignment = await getAssignment(BASE, KEY, CID, MODULE);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v2/course/user/assignment/${CID}/${MODULE}`);
    expectPublicHeaders(init);
    expect(assignment).toEqual(mapAssignment(assignmentFixture));
  });

  it('percent-encodes path params so a stray segment cannot re-target the request', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(sltsFixture));
    await getModuleSlts(BASE, KEY, 'a/b', '1 2');
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE}/api/v2/course/user/slts/a%2Fb/1%202`,
    );
  });

  it('propagates an http ApiError on a 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 500));
    const err = await getCourseModules(BASE, KEY, CID).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe('http');
    expect(err.status).toBe(500);
  });
});

// --- authenticated read function (U4) ---

describe('getAssignmentCommitments', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs the commitments path with X-API-Key AND a member Bearer', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(commitmentsFixture));

    const commitments = await getAssignmentCommitments(BASE, KEY, JWT);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v2/course/student/assignment-commitments/list`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['X-API-Key']).toBe(KEY);
    expect(headers['Authorization']).toBe(`Bearer ${JWT}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(commitments).toEqual(mapCommitments(commitmentsFixture));
  });

  it('surfaces a 401 as an unauthorized ApiError (reconnect-prompt branch)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 401));
    const err = await getAssignmentCommitments(BASE, KEY, JWT).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe('unauthorized');
    expect(err.status).toBe(401);
  });

  it('maps non-401 errors on the POST path too (500 -> http)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 500));
    const err = await getAssignmentCommitments(BASE, KEY, JWT).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe('http');
    expect(err.status).toBe(500);
  });
});

// --- fetch layer error taxonomy (U2), exercised through getCourseModules ---

describe('fetch layer error taxonomy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps a network/fetch rejection to a network ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const err = await getCourseModules(BASE, KEY, CID).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe('network');
  });

  it('maps a 404 to a not-found ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 404));
    const err = await getCourseModules(BASE, KEY, CID).catch((e) => e);
    expect(err.kind).toBe('not-found');
  });

  it('maps a 401 to an unauthorized ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 401));
    const err = await getCourseModules(BASE, KEY, CID).catch((e) => e);
    expect(err.kind).toBe('unauthorized');
    expect(err.status).toBe(401);
  });

  it('maps a non-JSON 2xx body to an http ApiError (status preserved)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 206,
      json: async () => {
        throw new Error('Unexpected end of JSON input');
      },
    } as unknown as Response);
    const err = await getCourseModules(BASE, KEY, CID).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe('http');
    expect(err.status).toBe(206);
  });

  it('treats 206 as success (content reads have no partial concept)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(modulesFixture, 206),
    );
    const modules = await getCourseModules(BASE, KEY, CID);
    expect(modules).toHaveLength(3);
  });
});
