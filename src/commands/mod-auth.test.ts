import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { isModerator, requireModerator } from './mod-auth';

// --- fakes -----------------------------------------------------------------

interface FakeInteraction {
  memberPermissions: { has: (p: bigint) => boolean } | null;
  member: { roles: { cache: Set<string> } | string[] } | null;
  reply: Mock;
}

function makeInteraction(opts: {
  manageRoles?: boolean;
  roleIds?: string[];
  rawRoles?: string[]; // raw API member shape (string[])
  noMember?: boolean;
}): FakeInteraction {
  return {
    memberPermissions:
      opts.manageRoles === undefined
        ? null
        : { has: (p: bigint) => p === PermissionFlagsBits.ManageRoles && !!opts.manageRoles },
    member: opts.noMember
      ? null
      : opts.rawRoles
        ? { roles: opts.rawRoles }
        : { roles: { cache: new Set(opts.roleIds ?? []) } },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

// --- isModerator -----------------------------------------------------------

describe('isModerator', () => {
  it('Manage Roles permission, no MOD_ROLE_ID → true', () => {
    expect(isModerator(makeInteraction({ manageRoles: true }) as never)).toBe(true);
  });

  it('no Manage Roles, no MOD_ROLE_ID → false', () => {
    expect(isModerator(makeInteraction({ manageRoles: false }) as never)).toBe(false);
  });

  it('no Manage Roles but holds the configured mod role → true', () => {
    const i = makeInteraction({ manageRoles: false, roleIds: ['mod-role'] });
    expect(isModerator(i as never, 'mod-role')).toBe(true);
  });

  it('no Manage Roles, MOD_ROLE_ID set but member lacks it → false', () => {
    const i = makeInteraction({ manageRoles: false, roleIds: ['other'] });
    expect(isModerator(i as never, 'mod-role')).toBe(false);
  });

  it('resolves the mod role on the raw API member shape (string[])', () => {
    const i = makeInteraction({ manageRoles: false, rawRoles: ['mod-role'] });
    expect(isModerator(i as never, 'mod-role')).toBe(true);
  });

  it('null memberPermissions (outside a guild) → false, no crash', () => {
    const i = makeInteraction({ noMember: true });
    expect(isModerator(i as never, 'mod-role')).toBe(false);
  });
});

// --- requireModerator ------------------------------------------------------

describe('requireModerator', () => {
  it('moderator → true, no reply', async () => {
    const i = makeInteraction({ manageRoles: true });
    await expect(requireModerator(i as never)).resolves.toBe(true);
    expect(i.reply).not.toHaveBeenCalled();
  });

  it('non-moderator → false, ephemeral refusal sent', async () => {
    const i = makeInteraction({ manageRoles: false });
    await expect(requireModerator(i as never, 'mod-role')).resolves.toBe(false);
    const payload = i.reply.mock.calls[0][0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.content).toMatch(/manage roles/i);
  });
});
