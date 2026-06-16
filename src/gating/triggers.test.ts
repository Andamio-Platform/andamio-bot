import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Mappings } from './mappings';

// --- module mocks ----------------------------------------------------------

const getDb = vi.fn(() => ({}) as unknown);
vi.mock('../db/handle', () => ({ getDb: () => getDb() }));

const getLinkByDiscordId = vi.fn();
const getAllLinks = vi.fn(() => [] as unknown[]);
vi.mock('../db/links', () => ({
  getLinkByDiscordId: (...a: unknown[]) => getLinkByDiscordId(...a),
  getAllLinks: () => getAllLinks(),
}));

const getUserDashboard = vi.fn();
vi.mock('../andamio/dashboard-client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../andamio/dashboard-client')>();
  return {
    ...actual,
    getUserDashboard: (...a: unknown[]) => getUserDashboard(...a),
  };
});

import {
  reevaluateMember,
  reevaluateAll,
  initGating,
  resetGating,
} from './triggers';
import { ApiError, type UserState } from '../andamio/dashboard-client';

// --- helpers ---------------------------------------------------------------

interface FakeMember {
  roles: {
    cache: { map: <T>(fn: (r: { id: string }) => T) => T[] };
    add: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
}

function makeMember(roleIds: string[] = []): FakeMember {
  return {
    roles: {
      cache: { map: (fn) => roleIds.map((id) => fn({ id })) },
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  };
}

const CRED_MAPPINGS: Mappings = {
  rules: [{ type: 'credential', course_id: 'c1', slt_hash: 's1', role_id: 'r1' }],
  managedRoleIds: new Set(['r1']),
};

function wire(member: FakeMember | null, mappings: Mappings = CRED_MAPPINGS) {
  const guild = { members: { fetch: vi.fn().mockResolvedValue(member) } };
  const client = { guilds: { cache: { get: vi.fn(() => guild) } } };
  initGating({
    client,
    config: {
      guildId: 'g1',
      andamioApiBaseUrl: 'https://api.test',
      andamioApiKey: 'ant_mn_k',
    },
    mappings,
  } as never);
  return member;
}

const FUTURE = Date.now() + 60 * 60 * 1000;
const PAST = Date.now() - 60 * 60 * 1000;
const validLink = (over = {}) => ({
  discord_id: 'd1',
  alias: 'alice',
  user_jwt: 'h.p.s',
  jwt_expires_at: FUTURE,
  refresh_token: null,
  updated_at: 0,
  ...over,
});

const state = (over: Partial<UserState> = {}): UserState => ({
  alias: 'alice',
  enrolledCourses: [],
  completedCourses: [],
  ...over,
});

beforeEach(() => {
  getLinkByDiscordId.mockReset();
  getAllLinks.mockReset().mockReturnValue([]);
  getUserDashboard.mockReset();
});

afterEach(() => {
  resetGating();
  vi.restoreAllMocks();
});

// --- reevaluateMember -------------------------------------------------------

describe('reevaluateMember (dashboard model)', () => {
  it('valid JWT holding the credential → role added', async () => {
    const member = wire(makeMember([]));
    getLinkByDiscordId.mockReturnValue(validLink());
    getUserDashboard.mockResolvedValue(
      state({ completedCourses: [{ courseId: 'c1', claimedCredentials: ['s1'] }] }),
    );

    await reevaluateMember('d1');

    expect(getUserDashboard).toHaveBeenCalledWith(
      'https://api.test',
      'ant_mn_k',
      'h.p.s',
    );
    expect(member!.roles.add).toHaveBeenCalledWith('r1', expect.any(String));
    expect(member!.roles.remove).not.toHaveBeenCalled();
  });

  it('valid JWT no longer holding the credential → managed role removed', async () => {
    const member = wire(makeMember(['r1']));
    getLinkByDiscordId.mockReturnValue(validLink());
    getUserDashboard.mockResolvedValue(state()); // empty

    await reevaluateMember('d1');

    expect(member!.roles.remove).toHaveBeenCalledWith('r1', expect.any(String));
  });

  it('expired JWT → no API call, roles unchanged (no churn)', async () => {
    const member = wire(makeMember(['r1']));
    getLinkByDiscordId.mockReturnValue(validLink({ jwt_expires_at: PAST }));

    await reevaluateMember('d1');

    expect(getUserDashboard).not.toHaveBeenCalled();
    expect(member!.roles.add).not.toHaveBeenCalled();
    expect(member!.roles.remove).not.toHaveBeenCalled();
  });

  it('missing JWT → no API call, roles unchanged', async () => {
    const member = wire(makeMember(['r1']));
    getLinkByDiscordId.mockReturnValue(validLink({ user_jwt: null }));

    await reevaluateMember('d1');

    expect(getUserDashboard).not.toHaveBeenCalled();
    expect(member!.roles.add).not.toHaveBeenCalled();
    expect(member!.roles.remove).not.toHaveBeenCalled();
  });

  it('401 (operator-key fault) → logged, roles unchanged', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const member = wire(makeMember(['r1']));
    getLinkByDiscordId.mockReturnValue(validLink());
    getUserDashboard.mockRejectedValue(new ApiError('unauthorized', '401', 401));

    await reevaluateMember('d1');

    expect(errSpy).toHaveBeenCalled();
    expect(member!.roles.add).not.toHaveBeenCalled();
    expect(member!.roles.remove).not.toHaveBeenCalled();
  });

  it('unconnected (no link) → strips managed roles', async () => {
    const member = wire(makeMember(['r1']));
    getLinkByDiscordId.mockReturnValue(null);

    await reevaluateMember('d1');

    expect(getUserDashboard).not.toHaveBeenCalled();
    expect(member!.roles.remove).toHaveBeenCalledWith('r1', expect.any(String));
  });

  it('not-found from the API → strips managed roles (no on-chain state)', async () => {
    const member = wire(makeMember(['r1']));
    getLinkByDiscordId.mockReturnValue(validLink());
    getUserDashboard.mockRejectedValue(new ApiError('not-found', 'none', 404));

    await reevaluateMember('d1');

    expect(member!.roles.remove).toHaveBeenCalledWith('r1', expect.any(String));
  });

  it('network error → roles unchanged (no churn)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const member = wire(makeMember(['r1']));
    getLinkByDiscordId.mockReturnValue(validLink());
    getUserDashboard.mockRejectedValue(new ApiError('network', 'down'));

    await reevaluateMember('d1');

    expect(member!.roles.add).not.toHaveBeenCalled();
    expect(member!.roles.remove).not.toHaveBeenCalled();
  });

  it('not initialised → safe no-op', async () => {
    resetGating();
    await expect(reevaluateMember('d1')).resolves.toBeUndefined();
  });
});

// --- reevaluateAll (sweep) --------------------------------------------------

describe('reevaluateAll (sweep)', () => {
  it('skips a member with an expired JWT without churning roles', async () => {
    const member = wire(makeMember(['r1']));
    getAllLinks.mockReturnValue([{ discord_id: 'd1' }]);
    // Per-member lookup returns the expired link.
    getLinkByDiscordId.mockReturnValue(validLink({ jwt_expires_at: PAST }));

    await reevaluateAll();

    expect(getUserDashboard).not.toHaveBeenCalled();
    expect(member!.roles.add).not.toHaveBeenCalled();
    expect(member!.roles.remove).not.toHaveBeenCalled();
  });

  it('processes a valid-JWT member during the sweep', async () => {
    const member = wire(makeMember([]));
    getAllLinks.mockReturnValue([{ discord_id: 'd1' }]);
    getLinkByDiscordId.mockReturnValue(validLink());
    getUserDashboard.mockResolvedValue(
      state({ completedCourses: [{ courseId: 'c1', claimedCredentials: ['s1'] }] }),
    );

    await reevaluateAll();

    expect(member!.roles.add).toHaveBeenCalledWith('r1', expect.any(String));
  });
});
