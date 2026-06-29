import { MessageFlags, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { Mappings } from '../gating/mappings';

// --- module mocks ----------------------------------------------------------

vi.mock('../config', () => ({
  loadConfig: () => ({ roleMappingsPath: '/tmp/rm.json', modRoleId: undefined }),
}));

const getDb = vi.fn(() => ({}) as unknown);
vi.mock('../db/handle', () => ({ getDb: () => getDb() }));

const loadMappings = vi.fn<[], Mappings>();
vi.mock('../gating/mappings', async (io) => {
  const actual = await io<typeof import('../gating/mappings')>();
  return { ...actual, loadMappings: () => loadMappings() };
});

const reevaluateMember = vi
  .fn()
  .mockResolvedValue({ status: 'updated', failed: [] });
vi.mock('../gating/triggers', () => ({
  reevaluateMember: (...a: unknown[]) => reevaluateMember(...a),
}));

const upsertDenial = vi.fn();
vi.mock('../db/denials', async (io) => {
  const actual = await io<typeof import('../db/denials')>();
  return { ...actual, upsertDenial: (...a: unknown[]) => upsertDenial(...a) };
});

import { execute } from './deny';
import { FULL_BLOCK } from '../db/denials';

// --- helpers ---------------------------------------------------------------

/** A fake permission overwrite shaped like the bits the command reads. */
function fakeOverwrite(
  id: string,
  type: OverwriteType,
  allowsView: boolean,
): { id: string; type: OverwriteType; allow: { has: (flag: bigint) => boolean } } {
  return {
    id,
    type,
    allow: { has: (flag: bigint) => flag === PermissionFlagsBits.ViewChannel && allowsView },
  };
}

type FakeChannel = {
  id: string;
  permissionOverwrites: { cache: ReturnType<typeof fakeOverwrite>[] };
};

/** Build a fake channel with the given overwrites. */
function fakeChannel(
  overwrites: ReturnType<typeof fakeOverwrite>[],
  id = 'chan-1',
): FakeChannel {
  return { id, permissionOverwrites: { cache: overwrites } };
}

interface FakeInteraction {
  user: { id: string };
  memberPermissions: { has: () => boolean };
  member: { roles: { cache: Set<string> } };
  options: {
    getUser: () => { id: string };
    getRole: () => { id: string; name: string } | null;
    getChannel: () => FakeChannel | null;
    getString: () => string | null;
  };
  reply: Mock;
}

function makeInteraction(opts: {
  manageRoles?: boolean;
  target?: string;
  role?: { id: string; name: string } | null;
  channel?: FakeChannel | null;
  reason?: string | null;
}): FakeInteraction {
  return {
    user: { id: 'mod-1' },
    memberPermissions: { has: () => opts.manageRoles ?? true },
    member: { roles: { cache: new Set() } },
    options: {
      getUser: () => ({ id: opts.target ?? 'target-1' }),
      getRole: () => opts.role ?? null,
      getChannel: () => opts.channel ?? null,
      getString: () => opts.reason ?? null,
    },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

const mappings = (): Mappings => ({
  rules: [],
  managedRoleIds: new Set(['r1', 'r2']),
});

beforeEach(() => {
  upsertDenial.mockReset();
  reevaluateMember.mockReset().mockResolvedValue({ status: 'updated', failed: [] });
  loadMappings.mockReset().mockReturnValue(mappings());
});

// --- tests -----------------------------------------------------------------

describe('/deny', () => {
  it('non-moderator → rejected, no denial written, no re-evaluation (R3)', async () => {
    const i = makeInteraction({ manageRoles: false });

    await execute(i as never);

    expect(i.reply.mock.calls[0][0].content).toMatch(/manage roles/i);
    expect(upsertDenial).not.toHaveBeenCalled();
    expect(reevaluateMember).not.toHaveBeenCalled();
  });

  it('unmanaged role → rejected with a clear message, no row written (R6)', async () => {
    const i = makeInteraction({ role: { id: 'rX', name: 'Random' } });

    await execute(i as never);

    expect(i.reply.mock.calls[0][0].content).toMatch(/not a gated role/i);
    expect(upsertDenial).not.toHaveBeenCalled();
  });

  it('managed role → writes the denial and re-evaluates immediately (R1)', async () => {
    const i = makeInteraction({ role: { id: 'r1', name: 'Issuer' }, reason: 'spam' });

    await execute(i as never);

    expect(upsertDenial).toHaveBeenCalledWith({}, 'target-1', 'r1', 'spam', 'mod-1');
    expect(reevaluateMember).toHaveBeenCalledWith('target-1');
    const payload = i.reply.mock.calls[0][0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.content).toMatch(/live now/i);
  });

  it('member not reachable (skipped) → reports recorded-not-yet-applied, not success', async () => {
    reevaluateMember.mockResolvedValue({ status: 'skipped', failed: [] });
    const i = makeInteraction({ role: { id: 'r1', name: 'Issuer' } });

    await execute(i as never);

    // Denial still written; message must NOT claim the block is live.
    expect(upsertDenial).toHaveBeenCalled();
    const content = i.reply.mock.calls[0][0].content;
    expect(content).toMatch(/next time they log in|aren’t connected/i);
    expect(content).not.toMatch(/live now/i);
  });

  it('role above the bot (remove failed) → warns the role could not be removed', async () => {
    reevaluateMember.mockResolvedValue({ status: 'updated', failed: ['r1'] });
    const i = makeInteraction({ role: { id: 'r1', name: 'Issuer' } });

    await execute(i as never);

    const content = i.reply.mock.calls[0][0].content;
    expect(content).toMatch(/could not remove|above my own role/i);
    expect(content).not.toMatch(/live now/i);
  });

  it('no role → writes a FULL_BLOCK denial (R8)', async () => {
    const i = makeInteraction({ role: null });

    await execute(i as never);

    expect(upsertDenial).toHaveBeenCalledWith(
      {},
      'target-1',
      FULL_BLOCK,
      null,
      'mod-1',
    );
  });

  it('no reason → persists null', async () => {
    const i = makeInteraction({ role: { id: 'r1', name: 'Issuer' } });

    await execute(i as never);

    expect(upsertDenial).toHaveBeenCalledWith({}, 'target-1', 'r1', null, 'mod-1');
  });

  it('mappings fail to load → reject, no row written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    loadMappings.mockImplementation(() => {
      throw new Error('bad json');
    });
    const i = makeInteraction({ role: { id: 'r1', name: 'Issuer' } });

    await execute(i as never);

    expect(i.reply.mock.calls[0][0].content).toMatch(/could not load/i);
    expect(upsertDenial).not.toHaveBeenCalled();
  });
});

describe('/deny #channel', () => {
  it('channel AND role both given → reject "pick one", no write, no re-eval (R1)', async () => {
    const i = makeInteraction({
      role: { id: 'r1', name: 'Issuer' },
      channel: fakeChannel([fakeOverwrite('r1', OverwriteType.Role, true)]),
    });

    await execute(i as never);

    expect(i.reply.mock.calls[0][0].content).toMatch(/pick one/i);
    expect(upsertDenial).not.toHaveBeenCalled();
    expect(reevaluateMember).not.toHaveBeenCalled();
  });

  it('channel gated by no managed role → no-op with a clear message (R4)', async () => {
    const i = makeInteraction({
      channel: fakeChannel([
        fakeOverwrite('rX', OverwriteType.Role, true), // unmanaged
        fakeOverwrite('r1', OverwriteType.Member, true), // member-type
        fakeOverwrite('r2', OverwriteType.Role, false), // View not allowed
      ]),
    });

    await execute(i as never);

    expect(i.reply.mock.calls[0][0].content).toMatch(
      /isn’t gated by any role I manage/i,
    );
    expect(upsertDenial).not.toHaveBeenCalled();
    expect(reevaluateMember).not.toHaveBeenCalled();
  });

  it('channel gated by one managed role → denies it and re-evaluates once (R3)', async () => {
    const i = makeInteraction({
      channel: fakeChannel([fakeOverwrite('r1', OverwriteType.Role, true)]),
      reason: 'off-topic',
    });

    await execute(i as never);

    expect(upsertDenial).toHaveBeenCalledTimes(1);
    expect(upsertDenial).toHaveBeenCalledWith(
      {},
      'target-1',
      'r1',
      'off-topic',
      'mod-1',
    );
    expect(reevaluateMember).toHaveBeenCalledTimes(1);
    expect(reevaluateMember).toHaveBeenCalledWith('target-1');
    const content = i.reply.mock.calls[0][0].content;
    expect(content).toMatch(/<@&r1>/);
    expect(content).toMatch(/live now/i);
  });

  it('channel gated by multiple managed roles → denies each, one re-eval (R5)', async () => {
    const i = makeInteraction({
      channel: fakeChannel([
        fakeOverwrite('r1', OverwriteType.Role, true),
        fakeOverwrite('r2', OverwriteType.Role, true),
      ]),
    });

    await execute(i as never);

    expect(upsertDenial).toHaveBeenCalledTimes(2);
    expect(upsertDenial).toHaveBeenNthCalledWith(1, {}, 'target-1', 'r1', null, 'mod-1');
    expect(upsertDenial).toHaveBeenNthCalledWith(2, {}, 'target-1', 'r2', null, 'mod-1');
    expect(reevaluateMember).toHaveBeenCalledTimes(1);
    const content = i.reply.mock.calls[0][0].content;
    expect(content).toMatch(/<@&r1>/);
    expect(content).toMatch(/<@&r2>/);
  });

  it('channel path, a denied role sits above the bot → warns it could not be removed', async () => {
    reevaluateMember.mockResolvedValue({ status: 'updated', failed: ['r1'] });
    const i = makeInteraction({
      channel: fakeChannel([fakeOverwrite('r1', OverwriteType.Role, true)]),
    });

    await execute(i as never);

    expect(upsertDenial).toHaveBeenCalledWith({}, 'target-1', 'r1', null, 'mod-1');
    const content = i.reply.mock.calls[0][0].content;
    expect(content).toMatch(/could not remove|above my own role/i);
    expect(content).not.toMatch(/live now/i);
  });

  it('non-moderator on the channel path → rejected, nothing written (R6)', async () => {
    const i = makeInteraction({
      manageRoles: false,
      channel: fakeChannel([fakeOverwrite('r1', OverwriteType.Role, true)]),
    });

    await execute(i as never);

    expect(i.reply.mock.calls[0][0].content).toMatch(/manage roles/i);
    expect(upsertDenial).not.toHaveBeenCalled();
    expect(reevaluateMember).not.toHaveBeenCalled();
  });

  it('channel given but mappings fail to load → "try again", no row written (R6)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    loadMappings.mockImplementation(() => {
      throw new Error('bad json');
    });
    const i = makeInteraction({
      channel: fakeChannel([fakeOverwrite('r1', OverwriteType.Role, true)]),
    });

    await execute(i as never);

    expect(i.reply.mock.calls[0][0].content).toMatch(/could not load/i);
    expect(upsertDenial).not.toHaveBeenCalled();
  });
});
