import { MessageFlags } from 'discord.js';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { FULL_BLOCK, type Denial } from '../db/denials';

// --- module mocks ----------------------------------------------------------

vi.mock('../config', () => ({
  loadConfig: () => ({ roleMappingsPath: '/tmp/rm.json', modRoleId: undefined }),
}));

const getDb = vi.fn(() => ({}) as unknown);
vi.mock('../db/handle', () => ({ getDb: () => getDb() }));

const listDenials = vi.fn<[], Denial[]>();
vi.mock('../db/denials', async (io) => {
  const actual = await io<typeof import('../db/denials')>();
  return { ...actual, listDenials: (...a: unknown[]) => listDenials(...a) };
});

import { execute, renderDenialsEmbed } from './denials';

// --- helpers ---------------------------------------------------------------

interface FakeInteraction {
  user: { id: string };
  memberPermissions: { has: () => boolean };
  member: { roles: { cache: Set<string> } };
  options: { getUser: () => { id: string } | null };
  reply: Mock;
}

function makeInteraction(opts: {
  manageRoles?: boolean;
  target?: { id: string } | null;
}): FakeInteraction {
  return {
    user: { id: 'mod-1' },
    memberPermissions: { has: () => opts.manageRoles ?? true },
    member: { roles: { cache: new Set() } },
    options: { getUser: () => opts.target ?? null },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

const aDenial = (over: Partial<Denial> = {}): Denial => ({
  discord_id: 'u1',
  role_id: 'r1',
  reason: null,
  created_by: 'mod-1',
  created_at: 0,
  ...over,
});

const fieldVal = (embed: { fields?: { name: string; value: string }[] }) =>
  embed.fields?.find((f) => f.name === 'Denials')?.value ?? '';

beforeEach(() => {
  listDenials.mockReset().mockReturnValue([aDenial()]);
});

// --- renderDenialsEmbed ----------------------------------------------------

describe('renderDenialsEmbed', () => {
  it('no denials → "No active denials", no fields', () => {
    const embed = renderDenialsEmbed([]).toJSON();
    expect(embed.description).toMatch(/no active denials/i);
    expect(embed.fields ?? []).toHaveLength(0);
  });

  it('per-role denial → role mention, member mention, who set it', () => {
    const v = fieldVal(
      renderDenialsEmbed([aDenial({ reason: 'spam' })]).toJSON(),
    );
    expect(v).toContain('<@u1>');
    expect(v).toContain('<@&r1>');
    expect(v).toContain('spam');
    expect(v).toContain('by <@mod-1>');
  });

  it('full block renders as "all gated roles", not the raw sentinel', () => {
    const v = fieldVal(
      renderDenialsEmbed([aDenial({ role_id: FULL_BLOCK })]).toJSON(),
    );
    expect(v).toContain('all gated roles');
    // The sentinel is never rendered as a role mention.
    expect(v).not.toContain(`<@&${FULL_BLOCK}>`);
  });

  it('a long list stays within the 1024-char field limit (fitFieldValue)', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      aDenial({ discord_id: `user-${i}`, reason: 'x'.repeat(40) }),
    );
    const v = fieldVal(renderDenialsEmbed(many).toJSON());
    expect(v.length).toBeLessThanOrEqual(1024);
  });
});

// --- execute ---------------------------------------------------------------

describe('/denials execute', () => {
  it('non-moderator → rejected, no listing (R3)', async () => {
    const i = makeInteraction({ manageRoles: false });

    await execute(i as never);

    expect(i.reply.mock.calls[0][0].content).toMatch(/manage roles/i);
    expect(listDenials).not.toHaveBeenCalled();
  });

  it('moderator → ephemeral embed of denials', async () => {
    const i = makeInteraction({ manageRoles: true });

    await execute(i as never);

    const payload = i.reply.mock.calls[0][0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.embeds).toHaveLength(1);
  });

  it('scoped to a member → passes that id to listDenials', async () => {
    const i = makeInteraction({ manageRoles: true, target: { id: 'u9' } });

    await execute(i as never);

    expect(listDenials).toHaveBeenCalledWith({}, 'u9');
  });
});
