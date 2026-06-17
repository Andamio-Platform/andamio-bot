import { MessageFlags } from 'discord.js';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { renderCheckEmbed } from './check';
import type { UserState } from '../andamio/dashboard-client';
import type { Mappings, MappingRule } from '../gating/mappings';

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

const getUserDashboard = vi.fn();
vi.mock('../andamio/dashboard-client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../andamio/dashboard-client')>();
  return {
    ...actual,
    getUserDashboard: (...args: unknown[]) => getUserDashboard(...args),
  };
});

const loadMappings = vi.fn<[], Mappings>();
vi.mock('../gating/mappings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gating/mappings')>();
  return { ...actual, loadMappings: () => loadMappings() };
});

vi.mock('../andamio/course-names', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../andamio/course-names')>();
  return { ...actual, loadCourseDisplayNames: () => ({}) };
});

const gateMemberFromState = vi.fn().mockResolvedValue('updated');
vi.mock('../gating/triggers', () => ({
  gateMemberFromState: (...args: unknown[]) => gateMemberFromState(...args),
}));

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

import { execute } from './check';
import { ApiError } from '../andamio/dashboard-client';

// --- helpers ---------------------------------------------------------------

const FUTURE = Date.now() + 60 * 60 * 1000;
const linkedJwt = (alias = 'alice') => ({
  discord_id: 'discord-1',
  alias,
  user_jwt: 'header.payload.sig',
  jwt_expires_at: FUTURE,
  refresh_token: null,
  updated_at: 0,
});

interface FakeInteraction {
  user: { id: string };
  deferReply: Mock;
  editReply: Mock;
}
function makeInteraction(discordId = 'discord-1'): FakeInteraction {
  return {
    user: { id: discordId },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

const state = (over: Partial<UserState> = {}): UserState => ({
  alias: 'alice',
  enrolledCourses: [],
  completedCourses: [],
  ...over,
});

const issuerRule: MappingRule = {
  type: 'credential',
  course_id: 'c1',
  slt_hash: 's1',
  role_id: 'r1',
  label: 'Andamio Issuer',
  earn_url: 'https://app.andamio.io/earn',
};
const mappingsOf = (rules: MappingRule[]): Mappings => ({
  rules,
  managedRoleIds: new Set(rules.map((r) => r.role_id)),
});

const field = (embed: { fields?: { name: string; value: string }[] }, name: string) =>
  embed.fields?.find((f) => f.name === name);

beforeEach(() => {
  getLinkByDiscordId.mockReset();
  getUserDashboard.mockReset();
  loadMappings.mockReset();
  loadMappings.mockReturnValue(mappingsOf([issuerRule]));
  gateMemberFromState.mockClear();
  gateMemberFromState.mockResolvedValue('updated');
  buildReloginPrompt.mockClear();
});

// --- renderCheckEmbed ------------------------------------------------------

describe('renderCheckEmbed', () => {
  it('holder → "up to date", a You-have field, no Not-yet field', () => {
    const held = state({ completedCourses: [{ courseId: 'c1', claimedCredentials: ['s1'] }] });
    const embed = renderCheckEmbed(mappingsOf([issuerRule]), {}, held).toJSON();
    expect(embed.description).toMatch(/up to date/i);
    expect(field(embed, 'You have')?.value).toContain('✅ **Andamio Issuer**');
    expect(field(embed, 'Not yet')).toBeUndefined();
  });

  it('non-holder → Not-yet field with the earn link', () => {
    const embed = renderCheckEmbed(mappingsOf([issuerRule]), {}, state()).toJSON();
    expect(embed.description).toMatch(/do not yet hold/i);
    expect(field(embed, 'Not yet')?.value).toContain('earn it: https://app.andamio.io/earn');
    expect(field(embed, 'You have')).toBeUndefined();
  });

  it('partial read → adds an incomplete-data note', () => {
    const embed = renderCheckEmbed(mappingsOf([issuerRule]), {}, state(), true).toJSON();
    expect(field(embed, 'Note')?.value).toMatch(/incomplete data/i);
  });

  it('no rules → "nothing gated yet"', () => {
    const embed = renderCheckEmbed(mappingsOf([]), {}, state()).toJSON();
    expect(embed.description).toMatch(/does not gate/i);
  });
});

// --- execute() -------------------------------------------------------------

describe('/check execute', () => {
  it('not connected → Connect button, no read, no gating', async () => {
    getLinkByDiscordId.mockReturnValue(null);
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(getUserDashboard).not.toHaveBeenCalled();
    expect(gateMemberFromState).not.toHaveBeenCalled();
    expect(buildReloginPrompt).toHaveBeenCalledWith(
      expect.anything(),
      'discord-1',
      'https://app.test',
      'https://bot.test',
      'connect',
    );
    expect(interaction.editReply.mock.calls[0][0].components).toEqual(['ROW']);
  });

  it('expired JWT → expired Connect button, no gating', async () => {
    getLinkByDiscordId.mockReturnValue({
      alias: 'alice',
      user_jwt: 'h.p.s',
      jwt_expires_at: Date.now() - 1000,
    });
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(gateMemberFromState).not.toHaveBeenCalled();
    expect(interaction.editReply.mock.calls[0][0].content).toBe('relogin:expired');
  });

  it('complete read → updates roles, then renders the answer', async () => {
    getLinkByDiscordId.mockReturnValue(linkedJwt());
    const held = state({ completedCourses: [{ courseId: 'c1', claimedCredentials: ['s1'] }] });
    getUserDashboard.mockResolvedValue({ partial: false, state: held });
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(gateMemberFromState).toHaveBeenCalledWith('discord-1', held);
    const embed = interaction.editReply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.description).toMatch(/up to date/i);
  });

  it('partial read → does NOT update roles, still renders with the note', async () => {
    getLinkByDiscordId.mockReturnValue(linkedJwt());
    getUserDashboard.mockResolvedValue({ partial: true, state: state() });
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(gateMemberFromState).not.toHaveBeenCalled();
    const embed = interaction.editReply.mock.calls[0][0].embeds[0].toJSON();
    expect(field(embed, 'Note')?.value).toMatch(/incomplete data/i);
  });

  it('401 → operator-key message, no reconnect bounce, no gating', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getLinkByDiscordId.mockReturnValue(linkedJwt());
    getUserDashboard.mockRejectedValue(new ApiError('unauthorized', '401', 401));
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(gateMemberFromState).not.toHaveBeenCalled();
    expect(buildReloginPrompt).not.toHaveBeenCalled();
    expect(interaction.editReply.mock.calls[0][0].content).toMatch(/trouble verifying/i);
  });

  it('404 → graceful message naming the alias', async () => {
    getLinkByDiscordId.mockReturnValue(linkedJwt('ghost'));
    getUserDashboard.mockRejectedValue(new ApiError('not-found', 'nope', 404));
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(interaction.editReply.mock.calls[0][0].content).toContain('ghost');
  });

  it('network error → graceful retry message', async () => {
    getLinkByDiscordId.mockReturnValue(linkedJwt());
    getUserDashboard.mockRejectedValue(new ApiError('network', 'down'));
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(interaction.editReply.mock.calls[0][0].content).toMatch(/try .*again/i);
  });

  it('mappings fail to load → graceful error, no gating', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getLinkByDiscordId.mockReturnValue(linkedJwt());
    getUserDashboard.mockResolvedValue({ partial: false, state: state() });
    loadMappings.mockImplementation(() => {
      throw new Error('bad json');
    });
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(gateMemberFromState).not.toHaveBeenCalled();
    expect(interaction.editReply.mock.calls[0][0].content).toMatch(/could not load/i);
  });
});
