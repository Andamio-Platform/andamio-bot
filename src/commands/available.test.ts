import { MessageFlags } from 'discord.js';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { renderAvailableEmbed } from './available';
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

import { execute } from './available';

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
  reply: Mock;
}
function makeInteraction(discordId = 'discord-1'): FakeInteraction {
  return { user: { id: discordId }, reply: vi.fn().mockResolvedValue(undefined) };
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

const fieldVal = (embed: { fields?: { name: string; value: string }[] }) =>
  embed.fields?.find((f) => f.name === 'Gated credentials')?.value ?? '';

beforeEach(() => {
  getLinkByDiscordId.mockReset();
  getUserDashboard.mockReset();
  loadMappings.mockReset();
  loadMappings.mockReturnValue(mappingsOf([issuerRule]));
});

// --- renderAvailableEmbed --------------------------------------------------

describe('renderAvailableEmbed', () => {
  it('no rules → a "nothing gated yet" description, no fields', () => {
    const embed = renderAvailableEmbed(mappingsOf([])).toJSON();
    expect(embed.description).toMatch(/does not gate/i);
    expect(embed.fields ?? []).toHaveLength(0);
  });

  it('unconnected (no state) → bullets, earn links, no ✓/✗ claim', () => {
    const embed = renderAvailableEmbed(mappingsOf([issuerRule]), {}).toJSON();
    expect(embed.description).toMatch(/connect with .*login/i);
    const v = fieldVal(embed);
    expect(v).toContain('• **Andamio Issuer**');
    expect(v).toContain('https://app.andamio.io/earn');
    expect(v).not.toContain('✅');
    expect(v).not.toContain('⬜');
  });

  it('connected holder → ✅ and no earn link', () => {
    const held = state({ completedCourses: [{ courseId: 'c1', claimedCredentials: ['s1'] }] });
    const v = fieldVal(renderAvailableEmbed(mappingsOf([issuerRule]), {}, held).toJSON());
    expect(v).toContain('✅ **Andamio Issuer**');
    expect(v).not.toContain('earn it');
  });

  it('connected non-holder → ⬜ with an earn link', () => {
    const v = fieldVal(renderAvailableEmbed(mappingsOf([issuerRule]), {}, state()).toJSON());
    expect(v).toContain('⬜ **Andamio Issuer**');
    expect(v).toContain('earn it: https://app.andamio.io/earn');
  });

  it('couldNotCheck → catalog shown with a soft "try again" note', () => {
    const embed = renderAvailableEmbed(mappingsOf([issuerRule]), {}, undefined, true).toJSON();
    expect(embed.description).toMatch(/could not check/i);
    expect(fieldVal(embed)).toContain('• **Andamio Issuer**');
  });
});

// --- execute() -------------------------------------------------------------

describe('/available execute', () => {
  it('unconnected → catalog without a live read', async () => {
    getLinkByDiscordId.mockReturnValue(null);
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(getUserDashboard).not.toHaveBeenCalled();
    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.embeds[0].toJSON().description).toMatch(/connect with/i);
  });

  it('expired JWT → catalog without a live read', async () => {
    getLinkByDiscordId.mockReturnValue({
      alias: 'alice',
      user_jwt: 'h.p.s',
      jwt_expires_at: Date.now() - 1000,
    });
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(getUserDashboard).not.toHaveBeenCalled();
    expect(interaction.reply.mock.calls[0][0].embeds).toHaveLength(1);
  });

  it('connected → overlays ✓/✗ from a live read', async () => {
    getLinkByDiscordId.mockReturnValue(linkedJwt());
    getUserDashboard.mockResolvedValue({
      partial: false,
      state: state({ completedCourses: [{ courseId: 'c1', claimedCredentials: ['s1'] }] }),
    });
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(getUserDashboard).toHaveBeenCalled();
    expect(fieldVal(interaction.reply.mock.calls[0][0].embeds[0].toJSON())).toContain(
      '✅ **Andamio Issuer**',
    );
  });

  it('connected but read fails → catalog still renders (couldNotCheck note)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getLinkByDiscordId.mockReturnValue(linkedJwt());
    getUserDashboard.mockRejectedValue(new Error('down'));
    const interaction = makeInteraction();

    await execute(interaction as never);

    const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.description).toMatch(/could not check/i);
    expect(fieldVal(embed)).toContain('Andamio Issuer');
  });

  it('mappings fail to load → graceful error, no crash', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    loadMappings.mockImplementation(() => {
      throw new Error('bad json');
    });
    getLinkByDiscordId.mockReturnValue(null);
    const interaction = makeInteraction();

    await execute(interaction as never);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toMatch(/could not load/i);
    expect(payload.embeds).toBeUndefined();
  });
});
