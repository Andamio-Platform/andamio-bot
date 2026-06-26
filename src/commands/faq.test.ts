import { MessageFlags } from 'discord.js';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { renderFaqEmbed } from './faq';
import type { Mappings, MappingRule } from '../gating/mappings';

// --- module mocks ----------------------------------------------------------

vi.mock('../config', () => ({
  loadConfig: () => ({
    andamioApiBaseUrl: 'https://api.test',
    andamioApiKey: 'ant_mn_test-key',
    appLoginBaseUrl: 'https://app.test',
    botCallbackBaseUrl: 'https://bot.test',
    roleMappingsPath: '/tmp/role-mappings.json',
  }),
}));

const loadMappings = vi.fn<[], Mappings>();
vi.mock('../gating/mappings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gating/mappings')>();
  return { ...actual, loadMappings: () => loadMappings() };
});

vi.mock('../andamio/course-names', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../andamio/course-names')>();
  return { ...actual, loadCourseDisplayNames: () => ({}) };
});

import { execute } from './faq';

// --- helpers ---------------------------------------------------------------

interface FakeInteraction {
  user: { id: string };
  reply: Mock;
}
function makeInteraction(discordId = 'discord-1'): FakeInteraction {
  return { user: { id: discordId }, reply: vi.fn().mockResolvedValue(undefined) };
}

const issuerRule: MappingRule = {
  type: 'credential',
  course_id: 'c1',
  slt_hash: 's1',
  role_id: 'r1',
  label: 'Andamio Issuer',
  earn_url: 'https://app.andamio.io/earn',
};
const mappingsOf = (rules: MappingRule[]): Mappings => ({
  rules,
  managedRoleIds: new Set(rules.map((r) => r.role_id)),
});

const fieldNames = (embed: { fields?: { name: string }[] }) =>
  (embed.fields ?? []).map((f) => f.name);
const fieldVal = (
  embed: { fields?: { name: string; value: string }[] },
  name: string,
) => embed.fields?.find((f) => f.name === name)?.value ?? '';
const stepValues = (embed: { fields?: { name: string; value: string }[] }) =>
  (embed.fields ?? [])
    .filter((f) => f.name !== 'What this server unlocks')
    .map((f) => f.value);

beforeEach(() => {
  loadMappings.mockReset();
  loadMappings.mockReturnValue(mappingsOf([issuerRule]));
});

// --- renderFaqEmbed --------------------------------------------------------

describe('renderFaqEmbed', () => {
  it('always shows the four get-started steps, in order', () => {
    const embed = renderFaqEmbed().toJSON();
    expect(embed.description).toMatch(/get.*started|four commands/i);
    const steps = stepValues(embed);
    expect(steps[0]).toMatch(/\/login/);
    expect(steps[1]).toMatch(/\/credentials/);
    expect(steps[2]).toMatch(/\/check/);
    expect(steps[3]).toMatch(/\/available/);
  });

  it('renders with no mappings (API/config absent) → steps only, no catalog', () => {
    const embed = renderFaqEmbed().toJSON();
    expect(fieldNames(embed)).not.toContain('What this server unlocks');
  });

  it('with gated rules → appends the unlock list with labels and earn links', () => {
    const embed = renderFaqEmbed(mappingsOf([issuerRule])).toJSON();
    const v = fieldVal(embed, 'What this server unlocks');
    expect(v).toContain('• **Andamio Issuer**');
    expect(v).toContain('https://app.andamio.io/earn');
    // No ✓/✗ claim — onboarding copy, no member state.
    expect(v).not.toContain('✅');
    expect(v).not.toContain('⬜');
  });

  it('credential without an earn_url → bare bullet, no "earn it" and no "undefined"', () => {
    const noLink: MappingRule = {
      type: 'credential',
      course_id: 'c2',
      slt_hash: 's2',
      role_id: 'r2',
      label: 'No Link Cred',
    };
    const v = fieldVal(
      renderFaqEmbed(mappingsOf([noLink])).toJSON(),
      'What this server unlocks',
    );
    expect(v).toContain('• **No Link Cred**');
    expect(v).not.toContain('earn it');
    expect(v).not.toContain('undefined');
  });

  it('mappings with zero rules → no unlock list', () => {
    const embed = renderFaqEmbed(mappingsOf([])).toJSON();
    expect(fieldNames(embed)).not.toContain('What this server unlocks');
  });
});

// --- execute() -------------------------------------------------------------

describe('/faq execute', () => {
  it('replies ephemeral with the guide (no API read)', async () => {
    const interaction = makeInteraction();

    await execute(interaction as never);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.embeds).toHaveLength(1);
    expect(stepValues(payload.embeds[0].toJSON())[0]).toMatch(/\/login/);
  });

  it('renders the same for a connected or unconnected member (local-only)', async () => {
    const a = makeInteraction('unconnected');
    const b = makeInteraction('connected');

    await execute(a as never);
    await execute(b as never);

    expect(a.reply.mock.calls[0][0].embeds[0].toJSON()).toEqual(
      b.reply.mock.calls[0][0].embeds[0].toJSON(),
    );
  });

  it('role-mappings fail to load → steps still ship, no crash', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    loadMappings.mockImplementation(() => {
      throw new Error('bad json');
    });
    const interaction = makeInteraction();

    await execute(interaction as never);

    const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(fieldNames(embed)).not.toContain('What this server unlocks');
    expect(stepValues(embed)[0]).toMatch(/\/login/);
  });
});
