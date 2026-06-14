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
import type { UserState } from '../andamio/scan-client';

// --- module mocks ----------------------------------------------------------

vi.mock('../config', () => ({
  loadConfig: () => ({ scanBaseUrl: 'https://scan.test' }),
}));

const getDb = vi.fn(() => ({}) as unknown);
vi.mock('../db/handle', () => ({ getDb: () => getDb() }));

const getLinkByDiscordId = vi.fn();
vi.mock('../db/links', () => ({
  getLinkByDiscordId: (...args: unknown[]) => getLinkByDiscordId(...args),
}));

const getUserState = vi.fn();
vi.mock('../andamio/scan-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../andamio/scan-client')>();
  return {
    ...actual,
    getUserState: (...args: unknown[]) => getUserState(...args),
  };
});

// Imported after the mocks above are registered.
import { execute } from './credentials';
import { ScanError } from '../andamio/scan-client';

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

beforeEach(() => {
  getLinkByDiscordId.mockReset();
  getUserState.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- execute() -------------------------------------------------------------

describe('/credentials execute', () => {
  it('not-connected user → /login prompt, and getUserState is NOT called', async () => {
    getLinkByDiscordId.mockReturnValue(null);
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(getUserState).not.toHaveBeenCalled();
    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('/login');
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.embeds).toBeUndefined();
  });

  it('AE5: connected alias with completed courses renders a grouped ephemeral embed', async () => {
    getLinkByDiscordId.mockReturnValue({ alias: 'alice' });
    getUserState.mockResolvedValue(
      state({
        completedCourses: [
          { courseId: 'c1', claimedCredentials: ['s1', 's2'] },
          { courseId: 'c2', claimedCredentials: ['s3'] },
        ],
        enrolledCourses: ['c3'],
      }),
    );
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(getUserState).toHaveBeenCalledWith('https://scan.test', 'alice');
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
    getLinkByDiscordId.mockReturnValue({ alias: 'bob' });
    getUserState.mockResolvedValue(
      state({ alias: 'bob', enrolledCourses: ['c9'] }),
    );
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

  it('scan 404 → graceful ephemeral error, no crash', async () => {
    getLinkByDiscordId.mockReturnValue({ alias: 'ghost' });
    getUserState.mockRejectedValue(new ScanError('not-found', 'nope', 404));
    const interaction = makeInteraction();

    await execute(interaction as never);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.embeds).toBeUndefined();
    expect(payload.content).toContain('ghost');
  });

  it('network error → graceful ephemeral error, no crash', async () => {
    getLinkByDiscordId.mockReturnValue({ alias: 'alice' });
    getUserState.mockRejectedValue(new ScanError('network', 'down'));
    const interaction = makeInteraction();

    await execute(interaction as never);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.content).toMatch(/try .*again|could not reach/i);
  });
});

// --- renderCredentialsEmbed (display names) --------------------------------

describe('renderCredentialsEmbed', () => {
  it('defaults to the raw course_id when no display-name map is given', () => {
    const embed = renderCredentialsEmbed(
      state({ completedCourses: [{ courseId: 'course_abc', claimedCredentials: [] }] }),
    ).toJSON();
    const completed = embed.fields.find((f: { name: string }) => f.name === 'Completed');
    expect(completed.value).toContain('course_abc');
  });

  it('uses a display name when one is provided for the course_id', () => {
    const embed = renderCredentialsEmbed(
      state({ completedCourses: [{ courseId: 'course_abc', claimedCredentials: ['x'] }] }),
      { course_abc: 'Cardano 101' },
    ).toJSON();
    const completed = embed.fields.find((f: { name: string }) => f.name === 'Completed');
    expect(completed.value).toContain('Cardano 101');
    expect(completed.value).not.toContain('course_abc');
  });
});
