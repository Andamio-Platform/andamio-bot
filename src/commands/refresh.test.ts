import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// --- module mocks ----------------------------------------------------------

vi.mock('../config', () => ({
  loadConfig: () => ({
    appLoginBaseUrl: 'https://app.test',
    botCallbackBaseUrl: 'https://bot.test',
  }),
}));

const getDb = vi.fn(() => ({}) as unknown);
vi.mock('../db/handle', () => ({ getDb: () => getDb() }));

const getLinkByDiscordId = vi.fn();
vi.mock('../db/links', () => ({
  getLinkByDiscordId: (...a: unknown[]) => getLinkByDiscordId(...a),
}));

const reevaluateMember = vi.fn().mockResolvedValue('updated');
vi.mock('../gating/triggers', () => ({
  reevaluateMember: (...a: unknown[]) => reevaluateMember(...a),
}));

const buildReloginPrompt = vi.fn(
  (_db: unknown, _id: string, _app: string, _bot: string, variant = 'connect') => ({
    content: `relogin:${variant}`,
    components: ['ROW'],
  }),
);
vi.mock('../discord/relogin-prompt', () => ({
  buildReloginPrompt: (...a: unknown[]) =>
    buildReloginPrompt(...(a as Parameters<typeof buildReloginPrompt>)),
}));

import { execute } from './refresh';

// --- helpers ---------------------------------------------------------------

interface FakeInteraction {
  user: { id: string };
  deferReply: Mock;
  editReply: Mock;
}

function makeInteraction(id = 'd1'): FakeInteraction {
  return {
    user: { id },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

const FUTURE = Date.now() + 60 * 60 * 1000;
const PAST = Date.now() - 60 * 60 * 1000;

beforeEach(() => {
  getLinkByDiscordId.mockReset();
  reevaluateMember.mockClear().mockResolvedValue('updated');
  buildReloginPrompt.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/refresh execute', () => {
  it('valid JWT → reevaluates roles and confirms', async () => {
    getLinkByDiscordId.mockReturnValue({ user_jwt: 'h.p.s', jwt_expires_at: FUTURE });
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(reevaluateMember).toHaveBeenCalledWith('d1');
    expect(interaction.editReply.mock.calls[0][0].content).toMatch(/Refreshed/);
  });

  it('no link → Connect button, no reevaluation', async () => {
    getLinkByDiscordId.mockReturnValue(null);
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(reevaluateMember).not.toHaveBeenCalled();
    expect(buildReloginPrompt).toHaveBeenCalledWith(
      expect.anything(),
      'd1',
      'https://app.test',
      'https://bot.test',
      'connect',
    );
    expect(interaction.editReply.mock.calls[0][0].components).toEqual(['ROW']);
  });

  it('expired JWT → expired-variant Connect button, no reevaluation', async () => {
    getLinkByDiscordId.mockReturnValue({ user_jwt: 'h.p.s', jwt_expires_at: PAST });
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(reevaluateMember).not.toHaveBeenCalled();
    expect(buildReloginPrompt).toHaveBeenCalledWith(
      expect.anything(),
      'd1',
      'https://app.test',
      'https://bot.test',
      'expired',
    );
    expect(interaction.editReply.mock.calls[0][0].content).toBe('relogin:expired');
  });

  it('reevaluation reports failed (swallowed read error) → honest error message', async () => {
    getLinkByDiscordId.mockReturnValue({ user_jwt: 'h.p.s', jwt_expires_at: FUTURE });
    reevaluateMember.mockResolvedValue('failed');
    const interaction = makeInteraction();

    await execute(interaction as never);

    expect(interaction.editReply.mock.calls[0][0].content).toMatch(
      /Could not refresh/,
    );
  });
});
