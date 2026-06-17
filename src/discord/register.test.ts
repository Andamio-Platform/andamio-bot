import { afterEach, describe, expect, it, vi } from 'vitest';

// Capture the REST instance the helper builds so we can assert on setToken/put.
const put = vi.fn().mockResolvedValue(undefined);
const setToken = vi.fn().mockReturnThis();
vi.mock('discord.js', () => ({
  REST: vi.fn(() => ({ setToken, put })),
  Routes: {
    applicationGuildCommands: (appId: string, guildId: string) =>
      `/applications/${appId}/guilds/${guildId}/commands`,
  },
}));

import { registerGuildCommands } from './register';

afterEach(() => {
  vi.clearAllMocks();
});

describe('registerGuildCommands', () => {
  it('PUTs the bodies to the guild command route with the token', async () => {
    const bodies = [{ name: 'check' }, { name: 'available' }] as never;

    await registerGuildCommands('tok', 'app-1', 'guild-1', bodies);

    expect(setToken).toHaveBeenCalledWith('tok');
    expect(put).toHaveBeenCalledWith(
      '/applications/app-1/guilds/guild-1/commands',
      { body: bodies },
    );
  });

  it('sends an empty array when there are no commands (full replace)', async () => {
    await registerGuildCommands('tok', 'app-1', 'guild-1', []);
    expect(put).toHaveBeenCalledWith(
      '/applications/app-1/guilds/guild-1/commands',
      { body: [] },
    );
  });

  it('propagates a REST failure to the caller', async () => {
    put.mockRejectedValueOnce(new Error('discord down'));
    await expect(
      registerGuildCommands('tok', 'app-1', 'guild-1', [{ name: 'x' }] as never),
    ).rejects.toThrow('discord down');
  });
});
