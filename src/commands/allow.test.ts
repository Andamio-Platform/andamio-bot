import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { Denial } from '../db/denials';

// --- module mocks ----------------------------------------------------------

vi.mock('../config', () => ({
  loadConfig: () => ({ roleMappingsPath: '/tmp/rm.json', modRoleId: undefined }),
}));

const getDb = vi.fn(() => ({}) as unknown);
vi.mock('../db/handle', () => ({ getDb: () => getDb() }));

const reevaluateMember = vi
  .fn()
  .mockResolvedValue({ status: 'updated', failed: [] });
vi.mock('../gating/triggers', () => ({
  reevaluateMember: (...a: unknown[]) => reevaluateMember(...a),
}));

const deleteDenial = vi.fn();
const deleteAllDenials = vi.fn();
const listDenials = vi.fn<[], Denial[]>();
vi.mock('../db/denials', async (io) => {
  const actual = await io<typeof import('../db/denials')>();
  return {
    ...actual,
    deleteDenial: (...a: unknown[]) => deleteDenial(...a),
    deleteAllDenials: (...a: unknown[]) => deleteAllDenials(...a),
    listDenials: () => listDenials(),
  };
});

import { execute } from './allow';

// --- helpers ---------------------------------------------------------------

interface FakeInteraction {
  user: { id: string };
  memberPermissions: { has: () => boolean };
  member: { roles: { cache: Set<string> } };
  options: {
    getUser: () => { id: string; username: string };
    getRole: () => { id: string; name: string } | null;
  };
  reply: Mock;
}

function makeInteraction(opts: {
  manageRoles?: boolean;
  target?: string;
  role?: { id: string; name: string } | null;
}): FakeInteraction {
  return {
    user: { id: 'mod-1' },
    memberPermissions: { has: () => opts.manageRoles ?? true },
    member: { roles: { cache: new Set() } },
    options: {
      getUser: () => ({ id: opts.target ?? 'target-1', username: 'targetuser' }),
      getRole: () => opts.role ?? null,
    },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

const aDenial = (over: Partial<Denial> = {}): Denial => ({
  discord_id: 'target-1',
  role_id: 'r1',
  reason: null,
  created_by: 'mod-1',
  created_at: 0,
  ...over,
});

beforeEach(() => {
  deleteDenial.mockReset();
  deleteAllDenials.mockReset();
  reevaluateMember.mockReset().mockResolvedValue('updated');
  listDenials.mockReset().mockReturnValue([aDenial()]);
});

// --- tests -----------------------------------------------------------------

describe('/allow', () => {
  it('non-moderator → rejected, nothing deleted (R3)', async () => {
    const i = makeInteraction({ manageRoles: false });

    await execute(i as never);

    expect(i.reply.mock.calls[0][0].content).toMatch(/manage roles/i);
    expect(deleteDenial).not.toHaveBeenCalled();
    expect(deleteAllDenials).not.toHaveBeenCalled();
  });

  it('with a role → deletes that denial and re-evaluates (R2)', async () => {
    const i = makeInteraction({ role: { id: 'r1', name: 'Issuer' } });

    await execute(i as never);

    expect(deleteDenial).toHaveBeenCalledWith({}, 'target-1', 'r1');
    expect(deleteAllDenials).not.toHaveBeenCalled();
    expect(reevaluateMember).toHaveBeenCalledWith('target-1');
  });

  it('without a role → lifts all denials for the member', async () => {
    const i = makeInteraction({ role: null });

    await execute(i as never);

    expect(deleteAllDenials).toHaveBeenCalledWith({}, 'target-1');
    expect(deleteDenial).not.toHaveBeenCalled();
    expect(reevaluateMember).toHaveBeenCalledWith('target-1');
  });

  it('no active denial → friendly no-op, no delete, no re-evaluation', async () => {
    listDenials.mockReturnValue([]);
    const i = makeInteraction({ role: { id: 'r1', name: 'Issuer' } });

    await execute(i as never);

    expect(i.reply.mock.calls[0][0].content).toMatch(/no active moderator blocks/i);
    expect(deleteDenial).not.toHaveBeenCalled();
    expect(reevaluateMember).not.toHaveBeenCalled();
  });

  it('role X but member only has a FULL_BLOCK → no false success, points to full unblock', async () => {
    listDenials.mockReturnValue([aDenial({ role_id: '*' })]);
    const i = makeInteraction({ role: { id: 'r1', name: 'Issuer' } });

    await execute(i as never);

    expect(deleteDenial).not.toHaveBeenCalled();
    expect(reevaluateMember).not.toHaveBeenCalled();
    expect(i.reply.mock.calls[0][0].content).toMatch(/full block/i);
  });

  it('role X but member is denied a DIFFERENT role → no false success', async () => {
    listDenials.mockReturnValue([aDenial({ role_id: 'r2' })]);
    const i = makeInteraction({ role: { id: 'r1', name: 'Issuer' } });

    await execute(i as never);

    expect(deleteDenial).not.toHaveBeenCalled();
    expect(reevaluateMember).not.toHaveBeenCalled();
    expect(i.reply.mock.calls[0][0].content).toMatch(/no block on/i);
  });

  it('role X with a matching denial → deletes it and confirms', async () => {
    listDenials.mockReturnValue([aDenial({ role_id: 'r1' })]);
    const i = makeInteraction({ role: { id: 'r1', name: 'Issuer' } });

    await execute(i as never);

    expect(deleteDenial).toHaveBeenCalledWith({}, 'target-1', 'r1');
    expect(reevaluateMember).toHaveBeenCalledWith('target-1');
    expect(i.reply.mock.calls[0][0].content).toMatch(/lifted the block/i);
  });
});
