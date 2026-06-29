import { MessageFlags } from 'discord.js';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { DisplayFilter } from '../andamio/course-names';
import type { ModuleSlt } from '../andamio/content-client';

// --- module mocks ----------------------------------------------------------

vi.mock('../config', () => ({
  loadConfig: () => ({
    andamioApiBaseUrl: 'https://api.test',
    andamioApiKey: 'ant_mn_test-key',
    roleMappingsPath: '/tmp/role-mappings.json',
  }),
}));

// Stub only the network reads; keep the real mappers + ApiError.
const getCourseModules = vi.fn();
const getModuleSlts = vi.fn();
const getLesson = vi.fn();
const getAssignment = vi.fn();
vi.mock('../andamio/content-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../andamio/content-client')>();
  return {
    ...actual,
    getCourseModules: (...a: unknown[]) => getCourseModules(...a),
    getModuleSlts: (...a: unknown[]) => getModuleSlts(...a),
    getLesson: (...a: unknown[]) => getLesson(...a),
    getAssignment: (...a: unknown[]) => getAssignment(...a),
  };
});

// Control the curated-display inputs; keep the real isDisplayed/displayNameFor.
const loadCourseDisplayNames = vi.fn();
const loadShowAllCourses = vi.fn();
vi.mock('../andamio/course-names', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../andamio/course-names')>();
  return {
    ...actual,
    loadCourseDisplayNames: () => loadCourseDisplayNames(),
    loadShowAllCourses: () => loadShowAllCourses(),
  };
});

const loadMappings = vi.fn();
vi.mock('../gating/mappings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gating/mappings')>();
  return { ...actual, loadMappings: () => loadMappings() };
});

import {
  autocomplete,
  courseChoices,
  execute,
  isCourseSelectable,
  moduleChoices,
  renderModuleListEmbed,
  renderModulePreviewEmbed,
  tiptapExcerpt,
} from './preview';
import {
  mapAssignment,
  mapLesson,
  mapModules,
  ApiError,
} from '../andamio/content-client';

import modulesFixture from '../andamio/__fixtures__/content/modules.json';
import lessonFixture from '../andamio/__fixtures__/content/lesson.json';
import assignmentFixture from '../andamio/__fixtures__/content/assignment.json';

// --- helpers ---------------------------------------------------------------

const CID = 'ae192632aabe00ed2042eaef596bc15f3887fa32e75e8f9b8fa516df';

/** Modules from the confirmed fixture (101 draft, 102 live). */
const allModules = mapModules(modulesFixture);
const liveModules = allModules.filter((m) => m.isLive);

const filterOf = (
  names: Record<string, string> = {},
  gated: string[] = [],
  showAll = false,
): DisplayFilter => ({ names, showAll, gatedCourseIds: new Set(gated) });

interface FakeChat {
  options: { getString: Mock };
  reply: Mock;
  deferReply: Mock;
  editReply: Mock;
}
function makeChat(course: string | null, module: string | null = null): FakeChat {
  return {
    options: {
      getString: vi.fn((name: string) => (name === 'course' ? course : module)),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

interface FakeAuto {
  options: { getFocused: Mock; getString: Mock };
  respond: Mock;
}
function makeAuto(
  focusedName: string,
  focusedValue = '',
  course: string | null = null,
): FakeAuto {
  return {
    options: {
      getFocused: vi.fn(() => ({ name: focusedName, value: focusedValue })),
      getString: vi.fn((name: string) => (name === 'course' ? course : null)),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

/** Extract the content/embeds passed to the last editReply/reply call. */
const lastReply = (m: Mock) => m.mock.calls[m.mock.calls.length - 1][0];
const embedJson = (payload: { embeds: { toJSON(): Record<string, unknown> }[] }) =>
  payload.embeds[0].toJSON();
const fieldVal = (
  embed: { fields?: { name: string; value: string }[] },
  name: string,
) => embed.fields?.find((f) => f.name === name)?.value ?? '';

beforeEach(() => {
  getCourseModules.mockReset();
  getModuleSlts.mockReset();
  getLesson.mockReset();
  getAssignment.mockReset();
  loadCourseDisplayNames.mockReset().mockReturnValue({});
  loadShowAllCourses.mockReset().mockReturnValue(false);
  loadMappings
    .mockReset()
    .mockReturnValue({ rules: [{ course_id: CID }], managedRoleIds: new Set() });
});

// --- tiptapExcerpt (U2) ----------------------------------------------------

describe('tiptapExcerpt', () => {
  it('extracts plain text from the confirmed lesson fixture, ignoring marks', () => {
    const excerpt = tiptapExcerpt(mapLesson(lessonFixture).contentJson);
    expect(excerpt).toContain('Andamio comes in two products');
    // The bold node text is still collected.
    expect(excerpt).toContain('Who handles the blockchain');
    expect(excerpt).not.toContain('{');
    expect(excerpt).not.toContain('"type"');
  });

  it('truncates a long document to maxLen with an ellipsis', () => {
    const longText = 'word '.repeat(200).trim();
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: longText }] }],
    };
    const excerpt = tiptapExcerpt(doc, 50);
    expect(excerpt.length).toBe(50);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('returns "" for any non-conforming shape, never throwing', () => {
    expect(tiptapExcerpt(null)).toBe('');
    expect(tiptapExcerpt(undefined)).toBe('');
    expect(tiptapExcerpt({})).toBe('');
    expect(tiptapExcerpt({ content: [] })).toBe('');
    expect(tiptapExcerpt('a raw string')).toBe('');
    expect(tiptapExcerpt(42)).toBe('');
    // A text node with no string `text` contributes nothing.
    expect(
      tiptapExcerpt({ content: [{ type: 'paragraph', content: [{ type: 'text' }] }] }),
    ).toBe('');
  });
});

// --- renderModuleListEmbed (U2) --------------------------------------------

describe('renderModuleListEmbed', () => {
  it('lists only the live modules from the confirmed fixture, with codes', () => {
    const embed = renderModuleListEmbed('Andamio Issuer', liveModules).toJSON();
    expect(embed.title).toBe('Preview — Andamio Issuer');
    const modulesField = fieldVal(embed, 'Modules');
    expect(modulesField).toContain('Getting Started with Issuer');
    expect(modulesField).toContain('`102`');
    // The draft module (101, is_live false) is not in liveModules → not shown.
    expect(modulesField).not.toContain('About Andamio Issuer');
    expect(modulesField).not.toContain('`101`');
  });

  it('renders an empty-state description and no field when there are no live modules', () => {
    const embed = renderModuleListEmbed('Andamio Issuer', []).toJSON();
    expect(embed.description).toMatch(/no live modules/i);
    expect(embed.fields ?? []).toHaveLength(0);
  });
});

// --- renderModulePreviewEmbed (U2) -----------------------------------------

describe('renderModulePreviewEmbed', () => {
  const module = liveModules[0];

  it('renders a lesson: labelled title, excerpt, and a module reference', () => {
    const embed = renderModulePreviewEmbed(
      module,
      mapLesson(lessonFixture),
      'lesson',
    ).toJSON();
    expect(embed.title).toBe('Lesson: Two Products, Two Jobs: Issuer and API');
    expect(embed.description).toContain('Andamio comes in two products');
    expect(fieldVal(embed, 'Module')).toContain('`102`');
  });

  it('renders an assignment with the assignment label', () => {
    const embed = renderModulePreviewEmbed(
      module,
      mapAssignment(assignmentFixture),
      'assignment',
    ).toJSON();
    expect(embed.title).toBe('Assignment: Show What You Know');
    expect(embed.description).toContain('Andamio Issuer is a new product');
  });

  it('falls back to a placeholder description when the content has no body', () => {
    const embed = renderModulePreviewEmbed(
      module,
      { title: 'Bare', contentJson: null },
      'lesson',
    ).toJSON();
    expect(embed.title).toBe('Lesson: Bare');
    expect(embed.description).toMatch(/no description available/i);
  });

  it('clamps an over-long content title to Discord 256-char embed-title limit', () => {
    const embed = renderModulePreviewEmbed(
      module,
      { title: 'T'.repeat(400), contentJson: null },
      'lesson',
    ).toJSON();
    expect((embed.title as string).length).toBeLessThanOrEqual(256);
  });
});

// --- courseChoices / moduleChoices / isCourseSelectable (U3) ---------------

describe('courseChoices', () => {
  it('returns curated names plus gated ids (gated always shown), labelled', () => {
    const filter = filterOf({ c1: 'Course One', c2: 'Course Two' }, ['c3']);
    const choices = courseChoices(filter, '');
    expect(choices).toContainEqual({ name: 'Course One', value: 'c1' });
    expect(choices).toContainEqual({ name: 'Course Two', value: 'c2' });
    // c3 is gated but unnamed → shown, labelled by its raw id.
    expect(choices).toContainEqual({ name: 'c3', value: 'c3' });
  });

  it('narrows by the focused query (case-insensitive, name or id)', () => {
    const filter = filterOf({ c1: 'Cardano 101', c2: 'Plutus Deep Dive' });
    expect(courseChoices(filter, 'plut')).toEqual([
      { name: 'Plutus Deep Dive', value: 'c2' },
    ]);
  });

  it('caps the result at 25 choices', () => {
    const names: Record<string, string> = {};
    for (let i = 0; i < 30; i++) names[`c${i}`] = `Course ${i}`;
    expect(courseChoices(filterOf(names), '')).toHaveLength(25);
  });

  it('returns [] when nothing is curated and nothing is gated (focused server)', () => {
    expect(courseChoices(filterOf({}, []), '')).toEqual([]);
  });

  it('falls back to the id when a configured display name is empty (never an empty choice name)', () => {
    // An empty-string name would make Discord reject the entire batch.
    const choices = courseChoices(filterOf({ c1: '', c2: 'Course Two' }), '');
    expect(choices).toContainEqual({ name: 'c1', value: 'c1' });
    expect(choices).toContainEqual({ name: 'Course Two', value: 'c2' });
    expect(choices.every((c) => c.name.length > 0)).toBe(true);
  });

  it('truncates an over-long display name to Discord 100-char choice limit', () => {
    const choices = courseChoices(filterOf({ c1: 'N'.repeat(150) }), '');
    expect(choices[0].name.length).toBeLessThanOrEqual(100);
    expect(choices[0].value).toBe('c1');
  });
});

describe('moduleChoices', () => {
  it('returns only live modules from the confirmed fixture, valued by code', () => {
    const choices = moduleChoices(allModules, '');
    expect(choices).toEqual([
      { name: 'Getting Started with Issuer (102)', value: '102' },
    ]);
  });

  it('narrows by the focused query over title and code', () => {
    expect(moduleChoices(allModules, '102')).toHaveLength(1);
    expect(moduleChoices(allModules, 'nope')).toHaveLength(0);
  });

  it('truncates an over-long module choice name to Discord 100-char limit', () => {
    const choices = moduleChoices(
      [{ title: 'M'.repeat(150), description: '', isLive: true, moduleCode: '900' }],
      '',
    );
    expect(choices).toHaveLength(1);
    expect(choices[0].name.length).toBeLessThanOrEqual(100);
    expect(choices[0].value).toBe('900');
  });
});

describe('isCourseSelectable', () => {
  it('is true for a curated or gated course, false for an unknown one when curated', () => {
    const filter = filterOf({ c1: 'Course One' }, ['c3']);
    expect(isCourseSelectable('c1', filter)).toBe(true);
    expect(isCourseSelectable('c3', filter)).toBe(true);
    expect(isCourseSelectable('unknown', filter)).toBe(false);
    expect(isCourseSelectable('', filter)).toBe(false);
  });
});

// --- execute (U4) ----------------------------------------------------------

describe('/preview execute', () => {
  it('course only → replies with the live module-list embed (ephemeral)', async () => {
    getCourseModules.mockResolvedValue(allModules);
    const interaction = makeChat(CID, null);

    await execute(interaction as never);

    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    const embed = embedJson(lastReply(interaction.editReply));
    expect(embed.title).toMatch(/^Preview —/);
    expect(fieldVal(embed, 'Modules')).toContain('`102`');
  });

  it('course + module with a lesson SLT → renders the lesson embed', async () => {
    getCourseModules.mockResolvedValue(allModules);
    getModuleSlts.mockResolvedValue([
      { sltText: 'x', sltIndex: 1, hasLesson: true } as ModuleSlt,
    ]);
    getLesson.mockResolvedValue(mapLesson(lessonFixture));
    const interaction = makeChat(CID, '102');

    await execute(interaction as never);

    expect(getLesson).toHaveBeenCalled();
    expect(getAssignment).not.toHaveBeenCalled();
    expect(embedJson(lastReply(interaction.editReply)).title).toMatch(/^Lesson:/);
  });

  it('course + module with no lesson SLT → renders the assignment embed', async () => {
    getCourseModules.mockResolvedValue(allModules);
    getModuleSlts.mockResolvedValue([
      { sltText: 'x', sltIndex: 1, hasLesson: false } as ModuleSlt,
    ]);
    getAssignment.mockResolvedValue(mapAssignment(assignmentFixture));
    const interaction = makeChat(CID, '102');

    await execute(interaction as never);

    expect(getAssignment).toHaveBeenCalled();
    expect(getLesson).not.toHaveBeenCalled();
    expect(embedJson(lastReply(interaction.editReply)).title).toMatch(/^Assignment:/);
  });

  it('non-curated, hand-typed course → "pick a course", no API call', async () => {
    loadCourseDisplayNames.mockReturnValue({ [CID]: 'Andamio Issuer' });
    loadMappings.mockReturnValue({ rules: [], managedRoleIds: new Set() });
    const interaction = makeChat('some-other-course', null);

    await execute(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringMatching(/pick a course/i),
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(getCourseModules).not.toHaveBeenCalled();
  });

  it('ApiError from the content read → friendly retry note, never throws', async () => {
    getCourseModules.mockRejectedValue(new ApiError('network', 'down'));
    const interaction = makeChat(CID, null);

    await expect(execute(interaction as never)).resolves.toBeUndefined();
    expect(lastReply(interaction.editReply).content).toMatch(/try .*preview.* again/i);
  });

  it('no live modules → "no preview available", not an error', async () => {
    getCourseModules.mockResolvedValue(
      allModules.filter((m) => !m.isLive), // only the draft
    );
    const interaction = makeChat(CID, null);

    await execute(interaction as never);

    expect(lastReply(interaction.editReply).content).toMatch(/no preview available/i);
  });

  it('module given but not live / not found → "no preview available"', async () => {
    getCourseModules.mockResolvedValue(allModules);
    const interaction = makeChat(CID, '999');

    await execute(interaction as never);

    expect(getModuleSlts).not.toHaveBeenCalled();
    expect(lastReply(interaction.editReply).content).toMatch(/no preview available/i);
  });

  it('empty/degraded lesson content → "no preview available"', async () => {
    getCourseModules.mockResolvedValue(allModules);
    getModuleSlts.mockResolvedValue([
      { sltText: 'x', sltIndex: 1, hasLesson: true } as ModuleSlt,
    ]);
    getLesson.mockResolvedValue({ title: '', contentJson: null });
    const interaction = makeChat(CID, '102');

    await execute(interaction as never);

    expect(lastReply(interaction.editReply).content).toMatch(/no preview available/i);
  });

  it('empty/degraded assignment content → "no preview available"', async () => {
    getCourseModules.mockResolvedValue(allModules);
    getModuleSlts.mockResolvedValue([
      { sltText: 'x', sltIndex: 1, hasLesson: false } as ModuleSlt,
    ]);
    getAssignment.mockResolvedValue({ title: '', contentJson: null });
    const interaction = makeChat(CID, '102');

    await execute(interaction as never);

    expect(lastReply(interaction.editReply).content).toMatch(/no preview available/i);
  });

  it('ApiError from getModuleSlts (mid-flow) → friendly retry note', async () => {
    getCourseModules.mockResolvedValue(allModules);
    getModuleSlts.mockRejectedValue(new ApiError('http', '500', 500));
    const interaction = makeChat(CID, '102');

    await expect(execute(interaction as never)).resolves.toBeUndefined();
    expect(lastReply(interaction.editReply).content).toMatch(/try .*preview.* again/i);
  });

  it('ApiError from getLesson (mid-flow) → friendly retry note', async () => {
    getCourseModules.mockResolvedValue(allModules);
    getModuleSlts.mockResolvedValue([
      { sltText: 'x', sltIndex: 1, hasLesson: true } as ModuleSlt,
    ]);
    getLesson.mockRejectedValue(new ApiError('network', 'down'));
    const interaction = makeChat(CID, '102');

    await execute(interaction as never);
    expect(lastReply(interaction.editReply).content).toMatch(/try .*preview.* again/i);
  });

  it('a non-ApiError thrown mid-render → friendly note AND a logged error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getCourseModules.mockRejectedValue(new Error('unexpected bug'));
    const interaction = makeChat(CID, null);

    await expect(execute(interaction as never)).resolves.toBeUndefined();
    expect(lastReply(interaction.editReply).content).toMatch(/try .*preview.* again/i);
    expect(errSpy).toHaveBeenCalled(); // the real bug stays visible in logs
  });

  it('role-mappings fail to load → command still renders, no crash', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    loadMappings.mockImplementation(() => {
      throw new Error('bad role-mappings.json');
    });
    getCourseModules.mockResolvedValue(allModules);
    const interaction = makeChat(CID, null);

    await execute(interaction as never);
    // No curation configured → course is selectable, module list renders.
    expect(embedJson(lastReply(interaction.editReply)).title).toMatch(/^Preview —/);
  });
});

// --- autocomplete (U4) -----------------------------------------------------

describe('/preview autocomplete', () => {
  it('course focused → curated choices, no API call', async () => {
    loadCourseDisplayNames.mockReturnValue({ [CID]: 'Andamio Issuer' });
    loadMappings.mockReturnValue({ rules: [], managedRoleIds: new Set() });
    const interaction = makeAuto('course', 'iss');

    await autocomplete(interaction as never);

    expect(interaction.respond).toHaveBeenCalledWith([
      { name: 'Andamio Issuer', value: CID },
    ]);
    expect(getCourseModules).not.toHaveBeenCalled();
  });

  it('module focused with a chosen course → live-module choices', async () => {
    getCourseModules.mockResolvedValue(allModules);
    const interaction = makeAuto('module', '', CID);

    await autocomplete(interaction as never);

    expect(interaction.respond).toHaveBeenCalledWith([
      { name: 'Getting Started with Issuer (102)', value: '102' },
    ]);
  });

  it('module focused with no course chosen → empty list, no API call', async () => {
    const interaction = makeAuto('module', '', null);

    await autocomplete(interaction as never);

    expect(interaction.respond).toHaveBeenCalledWith([]);
    expect(getCourseModules).not.toHaveBeenCalled();
  });

  it('content read throws → responds [] and never throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getCourseModules.mockRejectedValue(new ApiError('network', 'down'));
    const interaction = makeAuto('module', '', CID);

    await expect(autocomplete(interaction as never)).resolves.toBeUndefined();
    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  it('module focused with a non-curated course → [] (no enumeration, no API call)', async () => {
    // Curation ON: only CID is surfaced; a hand-typed other id must be ignored.
    loadCourseDisplayNames.mockReturnValue({ [CID]: 'Andamio Issuer' });
    loadMappings.mockReturnValue({ rules: [], managedRoleIds: new Set() });
    const interaction = makeAuto('module', '', 'some-other-course');

    await autocomplete(interaction as never);

    expect(interaction.respond).toHaveBeenCalledWith([]);
    expect(getCourseModules).not.toHaveBeenCalled();
  });

  it('module fetch that overruns the Discord budget → responds [] (never hangs)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      getCourseModules.mockReturnValue(new Promise(() => {})); // never resolves
      const interaction = makeAuto('module', '', CID);

      const pending = autocomplete(interaction as never);
      await vi.advanceTimersByTimeAsync(3_000); // past AUTOCOMPLETE_BUDGET_MS
      await pending;

      expect(interaction.respond).toHaveBeenCalledWith([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
