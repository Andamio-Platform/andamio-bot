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
  it('maps the live modules fixture, reading fields nested under `content`', () => {
    const modules = mapModules(modulesFixture);
    expect(modules).toEqual([
      {
        title: 'About Andamio Issuer',
        description: 'Introducing the new Andamio Issuer product.',
        isLive: false,
        moduleCode: '101',
      },
      {
        title: 'Getting Started with Issuer',
        description: 'A live module, included so tests exercise the is_live filter.',
        isLive: true,
        moduleCode: '102',
      },
    ]);
  });

  it('maps a bare (un-enveloped) array identically to the enveloped fixture', () => {
    const bare = (modulesFixture as { data: unknown[] }).data;
    expect(mapModules(bare)).toEqual(mapModules(modulesFixture));
  });

  it('tolerates an empty array, missing body, and non-array body', () => {
    expect(mapModules([])).toEqual([]);
    expect(mapModules({})).toEqual([]);
    expect(mapModules(undefined)).toEqual([]);
    expect(mapModules('garbage')).toEqual([]);
  });

  it('falls back to entry-level fields when there is no nested `content`', () => {
    const modules = mapModules([
      { title: 'Keep', course_module_code: '201', is_live: true },
      { title: 'Drop — no code', is_live: true },
    ]);
    expect(modules).toHaveLength(1);
    expect(modules[0]).toEqual({
      title: 'Keep',
      description: '',
      isLive: true,
      moduleCode: '201',
    });
  });

  it('coerces string/number encodings of is_live (nested under content)', () => {
    const modules = mapModules([
      { content: { course_module_code: 'a', is_live: 'true' } },
      { content: { course_module_code: 'b', is_live: 'false' } },
      { content: { course_module_code: 'c', is_live: 1 } },
      { content: { course_module_code: 'd', is_live: 0 } },
    ]);
    expect(modules.map((m) => m.isLive)).toEqual([true, false, true, false]);
  });
});

describe('mapSlts', () => {
  it('maps the live slts fixture, digging into `data.slts` and ignoring embedded lessons', () => {
    const slts = mapSlts(sltsFixture);
    expect(slts).toEqual([
      {
        sltText:
          'I can explain how the Andamio Issuer product differs from the Andamio API.',
        sltIndex: 1,
        hasLesson: true,
      },
      {
        sltText: 'I can identify the target market for the Andamio Issuer product.',
        sltIndex: 2,
        hasLesson: true,
      },
      {
        sltText:
          'I can find the documentation and resources that support Andamio Issuer.',
        sltIndex: 3,
        hasLesson: true,
      },
    ]);
  });

  it('drops an entry with a non-numeric slt_index but keeps index 0 (bare array)', () => {
    const slts = mapSlts([
      { slt_text: 'zero', slt_index: 0 },
      { slt_text: 'missing index' },
      { slt_text: 'string index', slt_index: 'nope' },
    ]);
    expect(slts.map((s) => s.sltIndex)).toEqual([0]);
  });

  it('tolerates empty / missing bodies and maps the bare inner object identically', () => {
    expect(mapSlts([])).toEqual([]);
    expect(mapSlts({})).toEqual([]);
    const bareInner = (sltsFixture as { data: unknown }).data;
    expect(mapSlts(bareInner)).toEqual(mapSlts(sltsFixture));
  });
});

/** Read the nested `data.content.content_json` from a content fixture. */
function fixtureContentJson(fixture: unknown): unknown {
  return (fixture as { data: { content: { content_json: unknown } } }).data.content
    .content_json;
}

describe('mapLesson', () => {
  it('maps the live lesson fixture (title + content_json nested under data.content)', () => {
    const lesson = mapLesson(lessonFixture);
    expect(lesson.title).toBe('Two Products, Two Jobs: Issuer and API');
    expect(lesson.contentJson).toEqual(fixtureContentJson(lessonFixture));
  });

  it('maps the bare inner object identically to the enveloped fixture', () => {
    const bareInner = (lessonFixture as { data: unknown }).data;
    expect(mapLesson(bareInner)).toEqual(mapLesson(lessonFixture));
  });

  it('defaults the title and nulls content_json on a missing/empty body', () => {
    expect(mapLesson({})).toEqual({ title: '', contentJson: null });
    expect(mapLesson(undefined).contentJson).toBeNull();
  });
});

describe('mapAssignment', () => {
  it('maps the live assignment fixture (title + content_json under data.content)', () => {
    expect(mapAssignment(assignmentFixture)).toEqual({
      title: 'Show What You Know',
      contentJson: fixtureContentJson(assignmentFixture),
    });
  });

  it('tolerates a missing body and maps the bare inner object identically', () => {
    expect(mapAssignment({}).title).toBe('');
    const bareInner = (assignmentFixture as { data: unknown }).data;
    expect(mapAssignment(bareInner)).toEqual(mapAssignment(assignmentFixture));
  });

  // mapLesson and mapAssignment are deliberately identical today (the API
  // returns the same { title, content_json } shape for both). Pin that identity
  // so a field added to one mapper but not the other fails loudly.
  it('produces the same result as mapLesson for an identical body', () => {
    const body = {
      content: { title: 'Same', content_json: { type: 'doc', content: [] } },
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
    expect(modules).toHaveLength(2);
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
    expect(lesson.title).toBe('Two Products, Two Jobs: Issuer and API');
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
    expect(modules).toHaveLength(2);
  });
});
