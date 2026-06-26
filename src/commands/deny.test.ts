import { MessageFlags } from 'discord.js';
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

const reevaluateMember = vi.fn().mockResolvedValue('updated');
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

interface FakeInteraction {
  user: { id: string };
  memberPermissions: { has: () => boolean };
  member: { roles: { cache: Set<string> } };
  options: {
    getUser: () => { id: string };
    getRole: () => { id: string; name: string } | null;
    getString: () => string | null;
  };
  reply: Mock;
}

function makeInteraction(opts: {
  manageRoles?: boolean;
  target?: string;
  role?: { id: string; name: string } | null;
  reason?: string | null;
}): FakeInteraction {
  return {
    user: { id: 'mod-1' },
    memberPermissions: { has: () => opts.manageRoles ?? true },
    member: { roles: { cache: new Set() } },
    options: {
      getUser: () => ({ id: opts.target ?? 'target-1' }),
      getRole: () => opts.role ?? null,
      getString: () => opts.reason ?? null,
    },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

const mappings = (): Mappings => ({
  rules: [],
  managedRoleIds: new Set(['r1']),
});

beforeEach(() => {
  upsertDenial.mockReset();
  reevaluateMember.mockReset().mockResolvedValue('updated');
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
    expect(i.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
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
