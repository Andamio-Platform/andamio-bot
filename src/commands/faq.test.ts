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
    faqPath: '/tmp/faq.json',
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

const loadFaq = vi.fn<[], FaqEntry[]>();
vi.mock('../faq/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../faq/config')>();
  return { ...actual, loadFaq: () => loadFaq() };
});

import { autocomplete, execute, renderAnswerEmbed } from './faq';
import type { FaqEntry } from '../faq/config';

// --- helpers ---------------------------------------------------------------

interface FakeInteraction {
  user: { id: string };
  reply: Mock;
  options: { getString: Mock };
}
/**
 * A chat-input interaction stand-in. `question` is the value `getString('question')`
 * returns — `null` (the default) drives the no-argument static-guide path.
 */
function makeInteraction(
  discordId = 'discord-1',
  question: string | null = null,
): FakeInteraction {
  return {
    user: { id: discordId },
    reply: vi.fn().mockResolvedValue(undefined),
    options: { getString: vi.fn().mockReturnValue(question) },
  };
}

interface FakeAutocomplete {
  commandName: string;
  options: { getFocused: Mock };
  respond: Mock;
}
function makeAutocomplete(focused = ''): FakeAutocomplete {
  return {
    commandName: 'faq',
    options: { getFocused: vi.fn().mockReturnValue(focused) },
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

const faqEntries: FaqEntry[] = [
  {
    id: 'connect-account',
    question: 'How do I connect my account?',
    answer: 'Run `/login` to connect.',
    aliases: ['login'],
  },
  {
    id: 'cant-see-channel',
    question: "Why can't I see a channel?",
    answer: 'Run `/check`, then `/available`.',
  },
];

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
  loadFaq.mockReset();
  loadFaq.mockReturnValue(faqEntries);
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

  it('no question → static guide; never reads the FAQ config', async () => {
    const interaction = makeInteraction();

    await execute(interaction as never);

    // The static floor must not depend on the Q&A config at all.
    expect(loadFaq).not.toHaveBeenCalled();
    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toBeUndefined();
    expect(stepValues(payload.embeds[0].toJSON())[0]).toMatch(/\/login/);
  });

  it('known question id → renders that answer embed, ephemeral', async () => {
    const interaction = makeInteraction('discord-1', 'cant-see-channel');

    await execute(interaction as never);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toBe("Why can't I see a channel?");
    expect(embed.description).toMatch(/\/check/);
    // It's the answer, not the get-started guide.
    expect(stepValues(embed)).toHaveLength(0);
  });

  it('unknown question id → friendly note + the static guide, ephemeral', async () => {
    const interaction = makeInteraction('discord-1', 'no-such-id');

    await execute(interaction as never);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.content).toMatch(/don't have an answer/i);
    expect(stepValues(payload.embeds[0].toJSON())[0]).toMatch(/\/login/);
  });

  it('FAQ config fails to load on an id lookup → static guide, no error to the user', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    loadFaq.mockImplementation(() => {
      throw new Error('malformed faq.json');
    });
    const interaction = makeInteraction('discord-1', 'connect-account');

    await execute(interaction as never);

    const payload = interaction.reply.mock.calls[0][0];
    // Falls back to the friendly note + guide rather than throwing.
    expect(payload.content).toMatch(/don't have an answer/i);
    expect(stepValues(payload.embeds[0].toJSON())[0]).toMatch(/\/login/);
  });
});

// --- renderAnswerEmbed -----------------------------------------------------

describe('renderAnswerEmbed', () => {
  it('uses the question as title and the answer as description', () => {
    const embed = renderAnswerEmbed(faqEntries[0]).toJSON();
    expect(embed.title).toBe('How do I connect my account?');
    expect(embed.description).toBe('Run `/login` to connect.');
  });
});

// --- autocomplete() --------------------------------------------------------

describe('/faq autocomplete', () => {
  it('responds with ranked choices for the focused query', async () => {
    const interaction = makeAutocomplete('connect');

    await autocomplete(interaction as never);

    expect(interaction.respond).toHaveBeenCalledTimes(1);
    const choices = interaction.respond.mock.calls[0][0];
    expect(choices).toEqual([
      { name: 'How do I connect my account?', value: 'connect-account' },
    ]);
  });

  it('empty focused query → all entries (capped), as {name,value}', async () => {
    const interaction = makeAutocomplete('');

    await autocomplete(interaction as never);

    const choices = interaction.respond.mock.calls[0][0];
    expect(choices).toHaveLength(2);
    expect(choices[0]).toEqual({
      name: 'How do I connect my account?',
      value: 'connect-account',
    });
  });

  it('FAQ config fails to load → responds with an empty list, never throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    loadFaq.mockImplementation(() => {
      throw new Error('malformed faq.json');
    });
    const interaction = makeAutocomplete('connect');

    await expect(autocomplete(interaction as never)).resolves.toBeUndefined();
    expect(interaction.respond).toHaveBeenCalledWith([]);
  });
});
