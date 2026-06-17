import { MessageFlags } from 'discord.js';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

import { renderCredentialsEmbed } from './credentials';
import type { UserState } from '../andamio/dashboard-client';

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

// execute() loads role-mappings to learn the always-shown gated course ids.
// Default to an empty rule set; tests that care override it.
const loadMappings = vi.fn(() => ({ rules: [], managedRoleIds: new Set<string>() }));
vi.mock('../gating/mappings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gating/mappings')>();
  return { ...actual, loadMappings: () => loadMappings() };
});

// The Connect-button helper is unit-tested separately; here we just assert it
// is invoked (and with which variant), so stub it to a recognizable payload.
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

// Imported after the mocks above are registered.
import { execute } from './credentials';
import { ApiError } from '../andamio/dashboard-client';

/** A link with a valid (far-future) JWT — the happy-path precondition. */
const FUTURE = Date.now() + 60 * 60 * 1000;
const linkedJwt = (alias = 'alice') => ({
  discord_id: 'discord-1',
  alias,
  user_jwt: 'header.payload.sig',
  jwt_expires_at: FUTURE,
  refresh_token: null,
  updated_at: 0,
});

// --- helpers ---------------------------------------------------------------

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

/** Build a DisplayFilter for direct renderCredentialsEmbed tests. */
const filterOf = (
  names: Record<string, string> = {},
  showAll = false,
  gated: string[] = [],
) => ({ names, showAll, gatedCourseIds: new Set(gated) });

beforeEach(() => {
  getLinkByDiscordId.mockReset();
  getUserDashboard.mockReset();
  buildReloginPrompt.mockClear();
  loadMappings.mockClear();
  loadMappings.mockReturnValue({ rules: [], managedRoleIds: new Set<string>() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- execute() -------------------------------------------------------------

describe('/credentials execute', () => {
  it('not-connected user → Connect button, and getUserDashboard is NOT called', async () => {
    getLinkByDiscordId.mockReturnValue(null);
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(getUserDashboard).not.toHaveBeenCalled();
    expect(buildReloginPrompt).toHaveBeenCalledWith(
      expect.anything(),
      'discord-1',
      'https://app.test',
      'https://bot.test',
      'connect',
    );
    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.components).toEqual(['ROW']);
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.embeds).toBeUndefined();
  });

  it('linked but no stored JWT → Connect button, no API call', async () => {
    getLinkByDiscordId.mockReturnValue({ alias: 'alice', user_jwt: null });
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(getUserDashboard).not.toHaveBeenCalled();
    expect(buildReloginPrompt).toHaveBeenCalledWith(
      expect.anything(),
      'discord-1',
      'https://app.test',
      'https://bot.test',
      'connect',
    );
    expect(interaction.reply.mock.calls[0][0].components).toEqual(['ROW']);
  });

  it('expired stored JWT → expired-variant Connect button, no API call', async () => {
    getLinkByDiscordId.mockReturnValue({
      alias: 'alice',
      user_jwt: 'h.p.s',
      jwt_expires_at: Date.now() - 1000,
    });
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(getUserDashboard).not.toHaveBeenCalled();
    expect(buildReloginPrompt).toHaveBeenCalledWith(
      expect.anything(),
      'discord-1',
      'https://app.test',
      'https://bot.test',
      'expired',
    );
    expect(interaction.reply.mock.calls[0][0].content).toBe('relogin:expired');
  });

  it('AE5: connected alias with completed courses renders a grouped ephemeral embed', async () => {
    getLinkByDiscordId.mockReturnValue(linkedJwt('alice'));
    getUserDashboard.mockResolvedValue({
      partial: false,
      state: state({
        completedCourses: [
          { courseId: 'c1', claimedCredentials: ['s1', 's2'] },
          { courseId: 'c2', claimedCredentials: ['s3'] },
        ],
        enrolledCourses: ['c3'],
      }),
    });
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(getUserDashboard).toHaveBeenCalledWith(
      'https://api.test',
      'ant_mn_test-key',
      'header.payload.sig',
    );
    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.embeds).toHaveLength(1);

    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toContain('alice');
    const completed = embed.fields.find((f: { name: string }) => f.name === 'Completed');
    expect(completed.value).toContain('2 credentials');
    expect(completed.value).toContain('1 credential');
    const enrolled = embed.fields.find(
      (f: { name: string }) => f.name === 'Enrolled (in progress)',
    );
    expect(enrolled.value).toContain('c3');
  });

  it('only-enrolled (no completed) → enrolled section, zero credentials', async () => {
    getLinkByDiscordId.mockReturnValue(linkedJwt('bob'));
    getUserDashboard.mockResolvedValue({
      partial: false,
      state: state({ alias: 'bob', enrolledCourses: ['c9'] }),
    });
    const interaction = makeInteraction();

    await execute(interaction as never);

    const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    const completed = embed.fields.find((f: { name: string }) => f.name === 'Completed');
    expect(completed.value).toContain('No completed courses');
    const enrolled = embed.fields.find(
      (f: { name: string }) => f.name === 'Enrolled (in progress)',
    );
    expect(enrolled.value).toContain('c9');
  });

  it('API 404 → graceful ephemeral error naming the alias, no crash', async () => {
    getLinkByDiscordId.mockReturnValue(linkedJwt('ghost'));
    getUserDashboard.mockRejectedValue(new ApiError('not-found', 'nope', 404));
    const interaction = makeInteraction();

    await execute(interaction as never);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.embeds).toBeUndefined();
    expect(payload.content).toContain('ghost');
  });

  it('network error → graceful ephemeral error, no crash', async () => {
    getLinkByDiscordId.mockReturnValue(linkedJwt('alice'));
    getUserDashboard.mockRejectedValue(new ApiError('network', 'down'));
    const interaction = makeInteraction();

    await execute(interaction as never);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.content).toMatch(/try .*again|could not reach/i);
  });

  it('401 on a non-expired JWT → operator-key error logged, neutral message shown', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getLinkByDiscordId.mockReturnValue(linkedJwt('alice'));
    getUserDashboard.mockRejectedValue(new ApiError('unauthorized', '401', 401));
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(errSpy).toHaveBeenCalled();
    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.embeds).toBeUndefined();
    expect(payload.content).toMatch(/trouble verifying|try .*again/i);
    // The member is NOT bounced to reconnect for an operator-side fault.
    expect(buildReloginPrompt).not.toHaveBeenCalled();
  });

});

// --- renderCredentialsEmbed (display names) --------------------------------

describe('renderCredentialsEmbed', () => {
  it('defaults to the raw course_id when no display-name map is given', () => {
    const embed = renderCredentialsEmbed(
      state({ completedCourses: [{ courseId: 'course_abc', claimedCredentials: [] }] }),
      filterOf(),
    ).toJSON();
    const completed = embed.fields.find((f: { name: string }) => f.name === 'Completed');
    expect(completed.value).toContain('course_abc');
  });

  it('uses a display name when one is provided for the course_id', () => {
    const embed = renderCredentialsEmbed(
      state({ completedCourses: [{ courseId: 'course_abc', claimedCredentials: ['x'] }] }),
      filterOf({ course_abc: 'Cardano 101' }),
    ).toJSON();
    const completed = embed.fields.find((f: { name: string }) => f.name === 'Completed');
    expect(completed.value).toContain('Cardano 101');
    expect(completed.value).not.toContain('course_abc');
  });

  it('no longer renders an Earn more field (moved to /available + /check)', () => {
    const embed = renderCredentialsEmbed(
      state({ completedCourses: [{ courseId: 'c1', claimedCredentials: [] }] }),
      filterOf(),
    ).toJSON();
    expect(
      embed.fields.find((f: { name: string }) => f.name === 'Earn more'),
    ).toBeUndefined();
  });
});

// --- renderCredentialsEmbed (curated display, U9) --------------------------

describe('renderCredentialsEmbed — curation', () => {
  const twoCompleted = state({
    completedCourses: [
      { courseId: 'shown', claimedCredentials: ['s1'] },
      { courseId: 'hidden', claimedCredentials: ['s2'] },
    ],
  });
  const completedValue = (filter: ReturnType<typeof filterOf>) =>
    renderCredentialsEmbed(twoCompleted, filter)
      .toJSON()
      .fields.find((f: { name: string }) => f.name === 'Completed')!.value;

  it('a non-empty map hides courses not in it', () => {
    const v = completedValue(filterOf({ shown: 'Shown Course' }));
    expect(v).toContain('Shown Course');
    expect(v).not.toContain('hidden');
  });

  it('SHOW_ALL_COURSES shows courses absent from the map', () => {
    const v = completedValue(filterOf({ shown: 'Shown Course' }, true));
    expect(v).toContain('Shown Course');
    expect(v).toContain('hidden');
  });

  it('an unmapped but gated course is always shown', () => {
    const v = completedValue(filterOf({ shown: 'Shown Course' }, false, ['hidden']));
    expect(v).toContain('Shown Course');
    expect(v).toContain('hidden');
  });

  it('an empty map shows everything (back-compat)', () => {
    const v = completedValue(filterOf());
    expect(v).toContain('shown');
    expect(v).toContain('hidden');
  });

  it('filters enrolled (in-progress) courses too', () => {
    const embed = renderCredentialsEmbed(
      state({ enrolledCourses: ['shown', 'hidden'] }),
      filterOf({ shown: 'Shown Course' }),
    ).toJSON();
    const enrolled = embed.fields.find(
      (f: { name: string }) => f.name === 'Enrolled (in progress)',
    );
    expect(enrolled.value).toContain('Shown Course');
    expect(enrolled.value).not.toContain('hidden');
  });
});
