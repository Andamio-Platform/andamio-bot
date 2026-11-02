import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Mappings } from './mappings';

// --- module mocks ----------------------------------------------------------

const getDb = vi.fn(() => ({}) as unknown);
vi.mock('../db/handle', () => ({ getDb: () => getDb() }));

const getLinkByDiscordId = vi.fn();
const getAllLinks = vi.fn(() => [] as unknown[]);
const clearExpiredJwts = vi.fn();
const deleteMemberData = vi.fn();
const deleteStalePending = vi.fn();
vi.mock('../db/links', () => ({
  deleteStalePending: (...a: unknown[]) => deleteStalePending(...a),
  getLinkByDiscordId: (...a: unknown[]) => getLinkByDiscordId(...a),
  getAllLinks: () => getAllLinks(),
  clearExpiredJwts: (...a: unknown[]) => clearExpiredJwts(...a),
  deleteMemberData: (...a: unknown[]) => deleteMemberData(...a),
}));

const getDeniedRoleIds = vi.fn(() => new Set<string>());
vi.mock('../db/denials', () => ({
  getDeniedRoleIds: (...a: unknown[]) => getDeniedRoleIds(...a),
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
  gateMemberFromState,
  onMemberLeft,
  initGating,
  resetGating,
} from './triggers';
import { ApiError, type UserState } from '../andamio/dashboard-client';
import { PENDING_TTL_MS } from '../andamio/login';

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
  clearExpiredJwts.mockReset();
  deleteMemberData.mockReset();
  deleteStalePending.mockReset();
  getUserDashboard.mockReset();
  getDeniedRoleIds.mockReset().mockReturnValue(new Set());
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
    getUserDashboard.mockResolvedValue({
      partial: false,
      state: state({ completedCourses: [{ courseId: 'c1', claimedCredentials: ['s1'] }] }),
    });

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
    getUserDashboard.mockResolvedValue({ partial: false, state: state() }); // empty

    await reevaluateMember('d1');

    expect(member!.roles.remove).toHaveBeenCalledWith('r1', expect.any(String));
  });

  it('partial (206) read → roles unchanged, no churn on incomplete data', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const member = wire(makeMember(['r1']));
    getLinkByDiscordId.mockReturnValue(validLink());
    // Degraded upstream: empty state but flagged partial — must NOT strip roles.
    getUserDashboard.mockResolvedValue({ partial: true, state: state() });

    await reevaluateMember('d1');

    expect(member!.roles.add).not.toHaveBeenCalled();
    expect(member!.roles.remove).not.toHaveBeenCalled();
  });

  it('a failing role op is isolated inside applyDiff — no throw escapes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const member = wire(makeMember([]));
    member!.roles.add = vi.fn().mockRejectedValue(new Error('Missing Permissions'));
    getLinkByDiscordId.mockReturnValue(validLink());
    getUserDashboard.mockResolvedValue({
      partial: false,
      state: state({ completedCourses: [{ courseId: 'c1', claimedCredentials: ['s1'] }] }),
    });

    // applyDiff swallows the per-role failure so the evaluation still completes,
    // but now SURFACES the failed role id so an interactive caller can report it.
    await expect(reevaluateMember('d1')).resolves.toEqual({
      status: 'updated',
      failed: ['r1'],
    });
    expect(member!.roles.add).toHaveBeenCalledWith('r1', expect.any(String));
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

  it('not-found from the API → roles unchanged (404 is not authoritative-empty)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const member = wire(makeMember(['r1']));
    getLinkByDiscordId.mockReturnValue(validLink());
    getUserDashboard.mockRejectedValue(new ApiError('not-found', 'none', 404));

    await reevaluateMember('d1');

    // A genuine "no credentials" arrives as a successful 200 with empty state;
    // a 404 is treated as transient and must not strip earned roles.
    expect(member!.roles.remove).not.toHaveBeenCalled();
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

  it('a failed/hung Discord member fetch → skipped, no reads, no role changes', async () => {
    const member = makeMember(['r1']);
    const guild = {
      members: { fetch: vi.fn().mockRejectedValue(new Error('timed out')) },
    };
    const client = { guilds: { cache: { get: vi.fn(() => guild) } } };
    initGating({
      client,
      config: {
        guildId: 'g1',
        andamioApiBaseUrl: 'https://api.test',
        andamioApiKey: 'k',
      },
      mappings: CRED_MAPPINGS,
    } as never);
    getLinkByDiscordId.mockReturnValue(validLink());

    await expect(reevaluateMember('d1')).resolves.toMatchObject({ status: 'skipped' });
    expect(getUserDashboard).not.toHaveBeenCalled();
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(member.roles.remove).not.toHaveBeenCalled();
    // A failed fetch says nothing about whether they left: keep their data.
    expect(deleteMemberData).not.toHaveBeenCalled();
  });

  it('not initialised → safe no-op (skipped)', async () => {
    resetGating();
    await expect(reevaluateMember('d1')).resolves.toMatchObject({ status: 'skipped' });
  });
});

// --- deny-list (R1, R5) -----------------------------------------------------

describe('reevaluateMember with a deny-list (R1)', () => {
  it('denied role is removed even though the member holds the credential', async () => {
    const member = wire(makeMember(['r1']));
    getLinkByDiscordId.mockReturnValue(validLink());
    getUserDashboard.mockResolvedValue({
      partial: false,
      state: state({ completedCourses: [{ courseId: 'c1', claimedCredentials: ['s1'] }] }),
    });
    getDeniedRoleIds.mockReturnValue(new Set(['r1']));

    await reevaluateMember('d1');

    expect(member!.roles.remove).toHaveBeenCalledWith('r1', expect.any(String));
    expect(member!.roles.add).not.toHaveBeenCalled();
  });

  it('survives the tick AFTER removal: an absent denied role is never re-granted', async () => {
    // Models the real state change between ticks: tick 1 removes the role (member
    // held it); tick 2 sees the member NO LONGER holding it. The credential is
    // still satisfied, so without the deny subtraction tick 2 would re-ADD r1.
    // The denial must keep it out via the add-path, not just the remove-path.
    getLinkByDiscordId.mockReturnValue(validLink());
    getUserDashboard.mockResolvedValue({
      partial: false,
      state: state({ completedCourses: [{ courseId: 'c1', claimedCredentials: ['s1'] }] }),
    });
    getDeniedRoleIds.mockReturnValue(new Set(['r1']));

    const tick1 = wire(makeMember(['r1'])); // holds r1
    await reevaluateMember('d1');
    expect(tick1!.roles.remove).toHaveBeenCalledWith('r1', expect.any(String));

    const tick2 = wire(makeMember([])); // role already gone
    await reevaluateMember('d1');
    expect(tick2!.roles.add).not.toHaveBeenCalled();
    expect(tick2!.roles.remove).not.toHaveBeenCalled();
  });

  it('surfaces a failed role removal (e.g. role above the bot) in the outcome', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const member = wire(makeMember(['r1']));
    member!.roles.remove = vi.fn().mockRejectedValue(new Error('Missing Permissions'));
    getLinkByDiscordId.mockReturnValue(validLink());
    getUserDashboard.mockResolvedValue({
      partial: false,
      state: state({ completedCourses: [{ courseId: 'c1', claimedCredentials: ['s1'] }] }),
    });
    getDeniedRoleIds.mockReturnValue(new Set(['r1']));

    await expect(reevaluateMember('d1')).resolves.toEqual({
      status: 'updated',
      failed: ['r1'],
    });
  });

  it('lifting the denial → the earned role is added back (supports R2)', async () => {
    const member = wire(makeMember([])); // role already dropped
    getLinkByDiscordId.mockReturnValue(validLink());
    getUserDashboard.mockResolvedValue({
      partial: false,
      state: state({ completedCourses: [{ courseId: 'c1', claimedCredentials: ['s1'] }] }),
    });
    getDeniedRoleIds.mockReturnValue(new Set()); // denial lifted

    await reevaluateMember('d1');

    expect(member!.roles.add).toHaveBeenCalledWith('r1', expect.any(String));
  });
});

describe('gateMemberFromState with a deny-list (R5)', () => {
  it('a denied member cannot /check their way back into the role', async () => {
    const member = wire(makeMember(['r1']));
    getDeniedRoleIds.mockReturnValue(new Set(['r1']));

    await gateMemberFromState(
      'd1',
      state({ completedCourses: [{ courseId: 'c1', claimedCredentials: ['s1'] }] }),
    );

    expect(member!.roles.remove).toHaveBeenCalledWith('r1', expect.any(String));
    expect(member!.roles.add).not.toHaveBeenCalled();
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
    getUserDashboard.mockResolvedValue({
      partial: false,
      state: state({ completedCourses: [{ courseId: 'c1', claimedCredentials: ['s1'] }] }),
    });

    await reevaluateAll();

    expect(member!.roles.add).toHaveBeenCalledWith('r1', expect.any(String));
  });

  it('drops a re-entrant tick while a sweep is already running', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    wire(makeMember([]));
    // A slow per-member step lets us start a second sweep mid-flight.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    getAllLinks.mockReturnValue([{ discord_id: 'd1' }]);
    getLinkByDiscordId.mockReturnValue(validLink());
    getUserDashboard.mockReturnValue(
      gate.then(() => ({ partial: false, state: state() })),
    );

    const first = reevaluateAll();
    const second = reevaluateAll(); // re-entrant tick — must be dropped
    await second;
    release();
    await first;
    // Across both calls only ONE sweep ran (one member → one read); the dropped
    // re-entrant tick added nothing. Asserting the exact total after completion
    // is timing-robust (the first sweep awaits a member fetch before its read).
    expect(getUserDashboard).toHaveBeenCalledTimes(1);
  });
});

// --- member left (#34) -------------------------------------------------------

function wireFetchError(err: unknown) {
  const guild = { members: { fetch: vi.fn().mockRejectedValue(err) } };
  const client = { guilds: { cache: { get: vi.fn(() => guild) } } };
  initGating({
    client,
    config: { guildId: 'g1', andamioApiBaseUrl: 'https://api.test', andamioApiKey: 'k' },
    mappings: CRED_MAPPINGS,
  } as never);
}

const discordError = (code: number) => Object.assign(new Error('discord'), { code });

describe('reevaluateMember for a member who left while the bot was offline', () => {
  it.each([10007, 10013])(
    'Discord code %i (unknown member/user) → deletes their data, no reads',
    async (code) => {
      wireFetchError(discordError(code));
      getLinkByDiscordId.mockReturnValue(validLink());

      await expect(reevaluateMember('d1')).resolves.toMatchObject({ status: 'skipped' });
      expect(deleteMemberData).toHaveBeenCalledWith(expect.anything(), 'd1');
      expect(getUserDashboard).not.toHaveBeenCalled();
    },
  );

  it('any other Discord error code → keeps their data', async () => {
    wireFetchError(discordError(50001)); // Missing Access
    await reevaluateMember('d1');
    expect(deleteMemberData).not.toHaveBeenCalled();
  });

  it('guild not cached → keeps their data', async () => {
    const client = { guilds: { cache: { get: vi.fn(() => undefined) } } };
    initGating({
      client,
      config: { guildId: 'g1', andamioApiBaseUrl: 'https://api.test', andamioApiKey: 'k' },
      mappings: CRED_MAPPINGS,
    } as never);
    await reevaluateMember('d1');
    expect(deleteMemberData).not.toHaveBeenCalled();
  });

  it('a gone member during the sweep has their data deleted', async () => {
    wireFetchError(discordError(10007));
    getAllLinks.mockReturnValue([{ discord_id: 'd1' }]);
    await reevaluateAll();
    expect(deleteMemberData).toHaveBeenCalledWith(expect.anything(), 'd1');
  });
});

describe('reevaluateAll clears expired tokens and stale logins', () => {
  it('clears expired JWTs as of now', async () => {
    wire(makeMember([]));
    const before = Date.now();
    await reevaluateAll();
    const after = Date.now();
    expect(clearExpiredJwts).toHaveBeenCalledTimes(1);
    const cutoff = clearExpiredJwts.mock.calls[0][1] as number;
    expect(cutoff).toBeGreaterThanOrEqual(before);
    expect(cutoff).toBeLessThanOrEqual(after);
  });

  it('a cleanup failure is logged and the sweep still visits links', async () => {
    wireFetchError(discordError(10007));
    clearExpiredJwts.mockImplementation(() => {
      throw new Error('SQLITE_BUSY');
    });
    getAllLinks.mockReturnValue([{ discord_id: 'd1' }]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await reevaluateAll();

    expect(errSpy).toHaveBeenCalledWith('Gating: sweep cleanup failed:', expect.any(Error));
    expect(deleteMemberData).toHaveBeenCalledWith(expect.anything(), 'd1');
    errSpy.mockRestore();
  });

  it('deletes pending logins older than the login TTL', async () => {
    wire(makeMember([]));
    const before = Date.now();
    await reevaluateAll();
    const after = Date.now();
    expect(deleteStalePending).toHaveBeenCalledTimes(1);
    const cutoff = deleteStalePending.mock.calls[0][1] as number;
    expect(cutoff).toBeGreaterThanOrEqual(before - PENDING_TTL_MS);
    expect(cutoff).toBeLessThanOrEqual(after - PENDING_TTL_MS);
  });

  it('not initialised → does not touch the db', async () => {
    resetGating();
    await reevaluateAll();
    expect(clearExpiredJwts).not.toHaveBeenCalled();
    expect(deleteStalePending).not.toHaveBeenCalled();
  });
});

describe('onMemberLeft', () => {
  it('a leave from the gated guild deletes their data', () => {
    wire(makeMember([]));
    onMemberLeft('g1', 'd1');
    expect(deleteMemberData).toHaveBeenCalledWith(expect.anything(), 'd1');
  });

  it('a leave from another guild is ignored', () => {
    wire(makeMember([]));
    onMemberLeft('other-guild', 'd1');
    expect(deleteMemberData).not.toHaveBeenCalled();
  });

  it('not initialised → no-op', () => {
    resetGating();
    onMemberLeft('g1', 'd1');
    expect(deleteMemberData).not.toHaveBeenCalled();
  });

  it('a db failure is logged, not thrown', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    wire(makeMember([]));
    deleteMemberData.mockImplementation(() => {
      throw new Error('disk');
    });
    expect(() => onMemberLeft('g1', 'd1')).not.toThrow();
  });
});
