import { MessageFlags } from 'discord.js';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { DisplayFilter } from '../andamio/course-names';
import type { AssignmentCommitment, CourseModule } from '../andamio/content-client';

// --- module mocks ----------------------------------------------------------

vi.mock('../config', () => ({
  loadConfig: () => ({
    andamioApiBaseUrl: 'https://api.test',
    andamioApiKey: 'ant_mn_test-key',
    appLoginBaseUrl: 'https://app.test',
    botCallbackBaseUrl: 'https://bot.test',
    roleMappingsPath: '/tmp/role-mappings.json',
  }),
}));

const getDb = vi.fn(() => ({}) as unknown);
vi.mock('../db/handle', () => ({ getDb: () => getDb() }));

const getLinkByDiscordId = vi.fn();
vi.mock('../db/links', () => ({
  getLinkByDiscordId: (...args: unknown[]) => getLinkByDiscordId(...args),
}));

// Stub the network reads; keep the real mappers + ApiError + join helpers.
const getCourseModules = vi.fn();
const getAssignmentCommitments = vi.fn();
vi.mock('../andamio/content-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../andamio/content-client')>();
  return {
    ...actual,
    getCourseModules: (...a: unknown[]) => getCourseModules(...a),
    getAssignmentCommitments: (...a: unknown[]) => getAssignmentCommitments(...a),
  };
});

const getUserDashboard = vi.fn();
vi.mock('../andamio/dashboard-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../andamio/dashboard-client')>();
  return {
    ...actual,
    getUserDashboard: (...a: unknown[]) => getUserDashboard(...a),
  };
});

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

const loadMappings = vi.fn(() => ({ rules: [], managedRoleIds: new Set<string>() }));
vi.mock('../gating/mappings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gating/mappings')>();
  return { ...actual, loadMappings: () => loadMappings() };
});

const buildReloginPrompt = vi.fn(
  (_db: unknown, _id: string, _app: string, _bot: string, variant = 'connect') => ({
    content: `relogin:${variant}`,
    components: ['ROW'],
  }),
);
vi.mock('../discord/relogin-prompt', () => ({
  buildReloginPrompt: (...args: unknown[]) =>
    buildReloginPrompt(...(args as Parameters<typeof buildReloginPrompt>)),
}));

import {
  autocomplete,
  enrolledCourseChoices,
  execute,
  isCourseSelectable,
  renderOpportunitiesEmbed,
  renderProgressEmbed,
} from './progress';
import { ApiError } from '../andamio/content-client';

// --- helpers ---------------------------------------------------------------

const CID = 'ae192632aabe00ed2042eaef596bc15f3887fa32e75e8f9b8fa516df';
const OTHER = '203e63f457e0b8088073ec20959c4e0cc188cf90425d4f29ff3f817f';

const FUTURE = Date.now() + 60 * 60 * 1000;
const PAST = Date.now() - 60 * 60 * 1000;
const linkedJwt = (over: Record<string, unknown> = {}) => ({
  discord_id: 'discord-1',
  alias: 'alice',
  user_jwt: 'header.payload.sig',
  jwt_expires_at: FUTURE,
  refresh_token: null,
  updated_at: 0,
  ...over,
});

const mod = (moduleCode: string, onChain = true, title = `Module ${moduleCode}`): CourseModule => ({
  title,
  description: '',
  onChain,
  moduleCode,
});

const commit = (moduleCode: string, status: string, courseId = CID): AssignmentCommitment => ({
  courseId,
  moduleCode,
  status,
});

const filterOf = (
  names: Record<string, string> = {},
  gated: string[] = [],
  showAll = false,
): DisplayFilter => ({ names, showAll, gatedCourseIds: new Set(gated) });

interface FakeChat {
  user: { id: string };
  options: { getString: Mock };
  reply: Mock;
  deferReply: Mock;
  editReply: Mock;
}
function makeChat(course: string | null, view: string | null = null): FakeChat {
  return {
    user: { id: 'discord-1' },
    options: {
      getString: vi.fn((name: string) => (name === 'course' ? course : view)),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

interface FakeAuto {
  user: { id: string };
  options: { getFocused: Mock };
  respond: Mock;
}
function makeAuto(focusedValue = '', focusedName = 'course'): FakeAuto {
  return {
    user: { id: 'discord-1' },
    options: { getFocused: vi.fn(() => ({ name: focusedName, value: focusedValue })) },
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

const lastReply = (m: Mock) => m.mock.calls[m.mock.calls.length - 1][0];
const embedJson = (payload: { embeds: { toJSON(): Record<string, unknown> }[] }) =>
  payload.embeds[0].toJSON();
const fieldVal = (
  embed: { fields?: { name: string; value: string }[] },
  name: string,
) => embed.fields?.find((f) => f.name === name)?.value ?? '';

beforeEach(() => {
  getDb.mockReset().mockReturnValue({});
  getLinkByDiscordId.mockReset().mockReturnValue(linkedJwt());
  getCourseModules.mockReset();
  getAssignmentCommitments.mockReset();
  getUserDashboard.mockReset();
  loadCourseDisplayNames.mockReset().mockReturnValue({});
  loadShowAllCourses.mockReset().mockReturnValue(false);
  loadMappings
    .mockReset()
    .mockReturnValue({ rules: [{ course_id: CID }], managedRoleIds: new Set() });
  buildReloginPrompt.mockClear();
});

// --- pure render helpers ----------------------------------------------------

describe('renderProgressEmbed', () => {
  it('lists every module with a status glyph and counts open opportunities', () => {
    const rows = [
      { module: mod('101'), status: 'ACCEPTED' as const },
      { module: mod('102'), status: 'NONE' as const },
      { module: mod('103'), status: 'REFUSED' as const },
    ];
    const embed = renderProgressEmbed('Andamio Issuer', rows).toJSON();
    expect(embed.title).toBe('Progress — Andamio Issuer');
    const field = fieldVal(embed, 'Modules');
    expect(field).toContain('✅ **Module 101** (`101`) — Accepted');
    expect(field).toContain('⬜ **Module 102** (`102`) — Not started');
    expect(field).toContain('❌ **Module 103** (`103`) — Refused');
    expect(embed.description).toMatch(/2 open/);
  });

  it('says all caught up when there are no opportunities', () => {
    const rows = [{ module: mod('101'), status: 'ACCEPTED' as const }];
    const embed = renderProgressEmbed('Issuer', rows).toJSON();
    expect(embed.description).toMatch(/caught up/i);
  });
});

describe('renderOpportunitiesEmbed', () => {
  it('renders only the open (NONE/refused) rows', () => {
    const rows = [
      { module: mod('101'), status: 'ACCEPTED' as const },
      { module: mod('102'), status: 'NONE' as const },
      { module: mod('103'), status: 'REFUSED' as const },
    ];
    const field = fieldVal(renderOpportunitiesEmbed('Issuer', rows).toJSON(), 'Open');
    expect(field).toContain('`102`');
    expect(field).toContain('`103`');
    expect(field).not.toContain('`101`'); // accepted is not an opportunity
  });
});

// --- enrolledCourseChoices / isCourseSelectable -----------------------------

describe('enrolledCourseChoices', () => {
  it('returns enrolled courses the server surfaces, labelled by display name', () => {
    const filter = filterOf({ [CID]: 'Andamio Issuer' }, [CID]);
    const choices = enrolledCourseChoices([CID, OTHER], filter, '');
    // OTHER is enrolled but not surfaced (not in names, not gated) → excluded.
    expect(choices).toEqual([{ name: 'Andamio Issuer', value: CID }]);
  });

  it('narrows by the focused query (case-insensitive)', () => {
    const filter = filterOf({ [CID]: 'Andamio Issuer', [OTHER]: 'Plutus PBL' });
    expect(enrolledCourseChoices([CID, OTHER], filter, 'plutus')).toEqual([
      { name: 'Plutus PBL', value: OTHER },
    ]);
  });
});

describe('isCourseSelectable', () => {
  it('accepts a surfaced course and rejects a blank or non-surfaced one', () => {
    const filter = filterOf({ [CID]: 'Issuer' }, [CID]);
    expect(isCourseSelectable(CID, filter)).toBe(true);
    expect(isCourseSelectable('', filter)).toBe(false);
    expect(isCourseSelectable(OTHER, filter)).toBe(false);
  });
});

// --- autocomplete -----------------------------------------------------------

describe('autocomplete', () => {
  it('offers the member enrolled ∩ surfaced courses for a connected member', async () => {
    loadCourseDisplayNames.mockReturnValue({ [CID]: 'Andamio Issuer' });
    getUserDashboard.mockResolvedValue({
      state: { alias: 'alice', enrolledCourses: [CID, OTHER], completedCourses: [] },
      partial: false,
    });
    const auto = makeAuto('');
    await autocomplete(auto as never);
    expect(auto.respond).toHaveBeenCalledWith([
      { name: 'Andamio Issuer', value: CID },
    ]);
  });

  it('responds with [] for a non-course focused option, no dashboard read', async () => {
    const auto = makeAuto('', 'view');
    await autocomplete(auto as never);
    expect(auto.respond).toHaveBeenCalledWith([]);
    expect(getUserDashboard).not.toHaveBeenCalled();
  });

  it('responds with [] and makes no dashboard read when not connected', async () => {
    getLinkByDiscordId.mockReturnValue(null);
    const auto = makeAuto('');
    await autocomplete(auto as never);
    expect(auto.respond).toHaveBeenCalledWith([]);
    expect(getUserDashboard).not.toHaveBeenCalled();
  });

  it('responds with [] when the JWT is expired', async () => {
    getLinkByDiscordId.mockReturnValue(linkedJwt({ jwt_expires_at: PAST }));
    const auto = makeAuto('');
    await autocomplete(auto as never);
    expect(auto.respond).toHaveBeenCalledWith([]);
    expect(getUserDashboard).not.toHaveBeenCalled();
  });

  it('responds with [] (never throws) when the dashboard read fails', async () => {
    getUserDashboard.mockRejectedValue(new ApiError('network', 'down'));
    const auto = makeAuto('');
    await expect(autocomplete(auto as never)).resolves.toBeUndefined();
    expect(auto.respond).toHaveBeenLastCalledWith([]);
  });
});

// --- execute: reconnect gate ------------------------------------------------

describe('execute — reconnect gate', () => {
  it('shows the connect prompt and makes no API call when unlinked', async () => {
    getLinkByDiscordId.mockReturnValue(null);
    const chat = makeChat(CID);
    await execute(chat as never);
    expect(buildReloginPrompt).toHaveBeenCalledWith(
      expect.anything(), 'discord-1', 'https://app.test', 'https://bot.test', 'connect',
    );
    expect(lastReply(chat.reply).flags).toBe(MessageFlags.Ephemeral);
    expect(getCourseModules).not.toHaveBeenCalled();
    expect(getAssignmentCommitments).not.toHaveBeenCalled();
  });

  it('shows the expired prompt and makes no API call when the JWT is expired', async () => {
    getLinkByDiscordId.mockReturnValue(linkedJwt({ jwt_expires_at: PAST }));
    const chat = makeChat(CID);
    await execute(chat as never);
    expect(buildReloginPrompt).toHaveBeenCalledWith(
      expect.anything(), 'discord-1', 'https://app.test', 'https://bot.test', 'expired',
    );
    expect(lastReply(chat.reply).flags).toBe(MessageFlags.Ephemeral);
    expect(getCourseModules).not.toHaveBeenCalled();
  });

  it('shows the connect prompt when the link exists but has no usable JWT', async () => {
    getLinkByDiscordId.mockReturnValue(linkedJwt({ user_jwt: null }));
    const chat = makeChat(CID);
    await execute(chat as never);
    expect(buildReloginPrompt).toHaveBeenCalledWith(
      expect.anything(), 'discord-1', 'https://app.test', 'https://bot.test', 'connect',
    );
    expect(getCourseModules).not.toHaveBeenCalled();
    expect(getAssignmentCommitments).not.toHaveBeenCalled();
  });
});

// --- execute: course guard --------------------------------------------------

describe('execute — course guard', () => {
  it('rejects a hand-typed, non-surfaced course before any API call', async () => {
    // Non-empty names map → curation is active; OTHER is neither named nor gated.
    loadCourseDisplayNames.mockReturnValue({ [CID]: 'Andamio Issuer' });
    const chat = makeChat(OTHER);
    await execute(chat as never);
    expect(lastReply(chat.reply).content).toMatch(/pick a course/i);
    expect(lastReply(chat.reply).flags).toBe(MessageFlags.Ephemeral);
    expect(getCourseModules).not.toHaveBeenCalled();
  });
});

// --- execute: happy paths ---------------------------------------------------

describe('execute — progress views', () => {
  it('renders the full progress embed with glyphs for on-chain modules', async () => {
    getCourseModules.mockResolvedValue([mod('101'), mod('102'), mod('103', false)]);
    getAssignmentCommitments.mockResolvedValue([
      commit('101', 'ACCEPTED'),
      commit('103', 'ACCEPTED'), // off-chain module → excluded from the join
      // Other course, SAME module code as on-chain 102: without the courseId
      // scope filter this would wrongly mark 102 ACCEPTED. It must stay NONE.
      commit('102', 'ACCEPTED', OTHER),
    ]);
    const chat = makeChat(CID);
    await execute(chat as never);
    expect(chat.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const embed = embedJson(lastReply(chat.editReply));
    const field = fieldVal(embed, 'Modules');
    expect(field).toContain('✅ **Module 101** (`101`) — Accepted');
    expect(field).toContain('⬜ **Module 102** (`102`) — Not started');
    expect(field).not.toContain('`103`'); // not on-chain → not shown
  });

  it('opportunities view shows only the open rows', async () => {
    getCourseModules.mockResolvedValue([mod('101'), mod('102')]);
    getAssignmentCommitments.mockResolvedValue([commit('101', 'ACCEPTED')]);
    const chat = makeChat(CID, 'opportunities');
    await execute(chat as never);
    const embed = embedJson(lastReply(chat.editReply));
    expect(embed.title).toMatch(/Opportunities/);
    const field = fieldVal(embed, 'Open');
    expect(field).toContain('`102`');
    expect(field).not.toContain('`101`');
  });

  it('opportunities view says caught-up when nothing is open', async () => {
    getCourseModules.mockResolvedValue([mod('101')]);
    getAssignmentCommitments.mockResolvedValue([commit('101', 'ACCEPTED')]);
    const chat = makeChat(CID, 'opportunities');
    await execute(chat as never);
    expect(lastReply(chat.editReply).content).toMatch(/caught up/i);
  });

  it('reports an empty course (no on-chain modules) without erroring', async () => {
    getCourseModules.mockResolvedValue([mod('101', false)]);
    getAssignmentCommitments.mockResolvedValue([]);
    const chat = makeChat(CID);
    await execute(chat as never);
    expect(lastReply(chat.editReply).content).toMatch(/no modules to show/i);
  });
});

// --- execute: error handling ------------------------------------------------

describe('execute — graceful errors', () => {
  it('shows a neutral verify message (not the connect prompt) on a 401', async () => {
    const err = new ApiError('unauthorized', '401', 401);
    getCourseModules.mockResolvedValue([mod('101')]);
    getAssignmentCommitments.mockRejectedValue(err);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const chat = makeChat(CID);
    await execute(chat as never);
    expect(lastReply(chat.editReply).content).toMatch(/trouble verifying/i);
    expect(buildReloginPrompt).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('shows a friendly try-again on a non-401 ApiError', async () => {
    getCourseModules.mockRejectedValue(new ApiError('network', 'down'));
    getAssignmentCommitments.mockResolvedValue([]);
    const chat = makeChat(CID);
    await execute(chat as never);
    // Pin ERROR_REPLY distinctively — VERIFY_REPLY shares the "again shortly"
    // tail, so match the unique "could not reach" lead instead.
    expect(lastReply(chat.editReply).content).toMatch(/could not reach andamio/i);
  });

  it('logs and recovers from an unexpected (non-ApiError) throw', async () => {
    getCourseModules.mockRejectedValue(new Error('boom'));
    getAssignmentCommitments.mockResolvedValue([]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const chat = makeChat(CID);
    await execute(chat as never);
    expect(lastReply(chat.editReply).content).toBe(
      'Could not reach Andamio right now. Please try `/progress` again shortly.',
    );
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
